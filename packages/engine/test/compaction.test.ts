import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_DEFAULTS, contextOf, degenerate, tailStart, toClear } from "../src/compaction.ts";
import { type Config, DEFAULTS } from "../src/config.ts";
import { type EngineEvent, EngineSession } from "../src/session.ts";

/**
 * compaction against a local stand-in for the provider (wire format only, as in retry.test.ts): when it
 * runs, what the summary request carries, prefire, the sanity checks, and that a resumed session rebuilds
 * the same context from its transcript. the real provider path is the m7 eval.
 */

const GOOD = `## goal\n- keep the parser fast\n\n## constraints and preferences\n- (none)\n\n## done\n- read src/parse.ts and measured it\n\n## in progress\n- the tokenizer rewrite\n\n## blocked\n- (none)\n\n## key decisions\n- keep the old api\n\n## ruled out\n- a regex tokenizer, too slow\n\n## live state\n- (none)\n\n## next steps\n- finish the tokenizer, then rerun the benchmark\n\n## critical context\n- the benchmark is bench/parse.ts\n\n## relevant files\n- src/parse.ts: the parser\n- src/tokenize.ts: the tokenizer being rewritten\n- bench/parse.ts: the benchmark that decides it`;

function sse(text: string, input: number): string {
	const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return [
		ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: input - 10, output_tokens: 1 } } }),
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
}

const isSummary = (body: any) => JSON.stringify(body?.messages?.at(-2) ?? "").includes("the context is about to be compacted") || JSON.stringify(body?.messages?.at(-1) ?? "").includes("the context is about to be compacted");

/** turn replies in order, each with the context size the provider reports; summaries answer with `summary` */
let turns: Array<{ text: string; input: number }> = [];
let summary = GOOD;
let summaryDelayMs = 0;
const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json().catch(() => null);
			requests.push(body);
			if (isSummary(body)) {
				if (summaryDelayMs) await Bun.sleep(summaryDelayMs);
				return new Response(sse(summary, 9000), { headers: { "content-type": "text/event-stream" } });
			}
			const t = turns.shift() ?? { text: "fallback", input: 100 };
			return new Response(sse(t.text, t.input), { headers: { "content-type": "text/event-stream" } });
		},
	});
});

afterAll(() => server.stop(true));

function config(over: Partial<Config["compaction"]> = {}): Config {
	return {
		...structuredClone(DEFAULTS),
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } },
		compaction: { ...COMPACTION_DEFAULTS, at: 10_000, prefire: 0.8, ...over },
		sources: [],
	};
}

const ROSTER = "agents under you (message(id) continues one; the agents tool lists more):\n- kid · scout · low · parked · id ses_kid\n- kid/sub · scout · low · working · id ses_sub";

async function session(over: Partial<Config["compaction"]> = {}, dataDir = mkdtempSync(join(tmpdir(), "cmx2-compact-data-")), id?: string, resume = false) {
	const events: EngineEvent[] = [];
	const s = await EngineSession.create({
		...(id ? { id } : {}),
		cwd: mkdtempSync(join(tmpdir(), "cmx2-compact-")),
		config: config(over),
		dataDir,
		...(resume ? { resume: {} } : {}),
		// the daemon's wiring: a turn carries one line about helpers, a compaction carries the compact roster
		appendix: () => [["agents", "helpers: 1 working, 1 parked; agents lists them."]],
		roster: () => ROSTER,
		onEvent: (e) => events.push(e),
		onStep: () => {},
	});
	return { s, events, dataDir };
}

async function turn(s: EngineSession, text: string) {
	await s.prompt(text);
	await s.idle();
	// a prefire runs beside the turn; give it its moment
	await Bun.sleep(30);
}

describe("compaction", () => {
	test("pure pieces: degenerate summaries, the kept tail, cleared outputs", () => {
		expect(degenerate("", 2)).toBe("the summary came back empty");
		expect(degenerate("short", 3)).toBeUndefined();
		expect(degenerate("short", 10)).toBe("the summary is missing its goal section");
		expect(degenerate("## goal\n- x", 10)).toContain("characters for 10 messages");
		expect(degenerate(GOOD, 40)).toBeUndefined();
		const msgs: any[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "a".repeat(400) },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "x".repeat(8000) }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "y".repeat(8000) }] },
		];
		// a budget that would start on a tool result moves forward to the next assistant message
		expect(tailStart(msgs, 1, 1000)).toBe(6);
		expect(tailStart(msgs, 1, 2700)).toBe(4);
		expect(tailStart(msgs, 1, 5500)).toBe(2);
		expect(tailStart(msgs, 1, Number.POSITIVE_INFINITY)).toBe(1);
		expect(toClear(msgs.slice(1), 3300)).toEqual(["c1"]);
	});

	test("prefire summarises ahead; past the threshold the context becomes summary, state block and tail without waiting", async () => {
		const { s, events, dataDir } = await session();
		mkdirSync(join(dataDir, "notes"), { recursive: true });
		writeFileSync(s.notesFile, "the code word is heliotrope");
		requests.length = 0;
		turns = [
			{ text: "one", input: 4000 },
			{ text: "two", input: 8500 },
			{ text: "three", input: 3000 },
		];
		await turn(s, "first");
		expect(events.some((e) => e.type === "compaction.prefire")).toBe(false);
		await turn(s, "second");
		// 8,500 is past 80% of 10,000: the summary started when the turn settled
		const started = events.find((e) => e.type === "compaction.prefire" && e.properties.state === "started");
		expect(started).toBeDefined();
		await Bun.sleep(100);
		expect(events.some((e) => e.type === "compaction.prefire" && e.properties.state === "ready")).toBe(true);

		const summaryReq = requests.find(isSummary)!;
		const turnReq = requests.filter((r) => !isSummary(r)).at(-1)!;
		// the summary request is the session's own request: same system prompt, same tools, same history
		expect(JSON.stringify(summaryReq.system)).toBe(JSON.stringify(turnReq.system));
		expect(JSON.stringify(summaryReq.tools)).toBe(JSON.stringify(turnReq.tools));
		// a breakpoint turns string content into its one-block form; both render the same prompt
		const strip = (m: any) => JSON.stringify(typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m).replace(/,"cache_control":\{"type":"ephemeral"\}/g, "");
		const n = turnReq.messages.filter((m: any) => m.role !== "system").length;
		expect(summaryReq.messages.filter((m: any) => m.role !== "system").slice(0, n).map(strip)).toEqual(turnReq.messages.filter((m: any) => m.role !== "system").map(strip));

		// third turn: the context is over 10,000 with the new prompt; the prefired summary is used
		turns = [{ text: "three", input: 3000 }];
		const before = requests.filter(isSummary).length;
		await turn(s, "third ".repeat(1200));
		expect(requests.filter(isSummary).length).toBe(before);
		const compacted = events.find((e) => e.type === "session.compacted")!;
		expect(compacted.properties.prefire).toBe(true);
		expect(compacted.properties.trigger).toBe("auto");
		const sent = requests.at(-1)!;
		const first = JSON.stringify(sent.messages[0]);
		expect(first).toContain("<compaction-summary>");
		expect(first).toContain("keep the parser fast");
		expect(first).toContain("<post-compaction-state>");
		expect(first).toContain("the code word is heliotrope");
		expect(first).toContain("recall searches everything");
		// the roster does not ride the turns, so the compaction is where the model gets the live agents back
		expect(first).toContain(ROSTER.replace(/\n/g, "\\n"));
		expect(first).toContain("helpers: 1 working, 1 parked; agents lists them.");
		// the system prompt and tools did not change: the next request reads them from cache
		expect(JSON.stringify(sent.system)).toBe(JSON.stringify(turnReq.system));
		expect(JSON.stringify(sent.tools)).toBe(JSON.stringify(turnReq.tools));

		// the transcript kept everything and a resume rebuilds the same context
		const lines = readFileSync(join(dataDir, "sessions", `${s.id}.jsonl`), "utf8").trim().split("\n");
		expect(lines.some((l) => l.includes('"role":"compaction"'))).toBe(true);
		const live = JSON.stringify(s.messages);
		s.dispose();
		const again = await session({}, dataDir, s.id, true);
		expect(JSON.stringify(again.s.messages)).toBe(live);
		again.s.dispose();
	});

	test("a degenerate summary is retried once, then compaction stops trying on this model", async () => {
		const { s, events } = await session({ prefire: false });
		summary = "ok";
		turns = Array.from({ length: 8 }, (_, i) => ({ text: `t${i}`, input: i < 4 ? 1000 : 12_000 }));
		for (let i = 0; i < 4; i++) await turn(s, `warm ${i}`);
		// this reply reports 12,000 tokens; the next request is past the threshold
		await turn(s, "over the line");
		requests.length = 0;
		await turn(s, "past it");
		const failed = events.find((e) => e.type === "compaction.failed")!;
		expect(failed.properties.reason).toBe("degenerate");
		expect(failed.properties.sticky).toBe(true);
		expect(requests.filter(isSummary).length).toBe(2);
		// the next turns do not ask again
		await turn(s, "again");
		await turn(s, "and again");
		expect(requests.filter(isSummary).length).toBe(2);
		// a manual compact clears the suppression and runs
		summary = GOOD;
		expect(await s.compact()).toBe(true);
		expect(events.filter((e) => e.type === "session.compacted").at(-1)!.properties.trigger).toBe("manual");
		s.dispose();
		summary = GOOD;
	});

	test("contextOf skips reverted ranges and keeps tool changes made before the tail", () => {
		const all: any[] = [
			{ role: "system", content: "sys", toolsAdded: [{ name: "read" }] },
			{ role: "user", content: "a" },
			{ role: "system", content: "turn words", toolsAdded: [{ name: "webfetch" }] },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: "c" },
			{ role: "assistant", content: [{ type: "text", text: "d" }] },
			{ role: "compaction", summary: "s", state: "st", tailFrom: 5, cleared: [], timestamp: 1 },
			{ role: "user", content: "e" },
			{ role: "assistant", content: [{ type: "text", text: "f" }] },
			{ role: "revert", from: 8, timestamp: 2 },
			{ role: "user", content: "g" },
		];
		const ctx = contextOf(all);
		expect(ctx.map((m: any) => m.role)).toEqual(["system", "system", "compaction", "user", "assistant", "user"]);
		expect((ctx[1] as any).content).toBe("");
		expect((ctx[1] as any).toolsAdded).toEqual([{ name: "webfetch" }]);
		expect((ctx[3] as any).content).toBe("c");
		expect((ctx[5] as any).content).toBe("g");
	});
});
