import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
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

const isSummary = (body: any) => JSON.stringify(body?.messages?.slice(-3) ?? "").includes("the context is about to be compacted");

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
		expect(compacted.properties.cold).toBe(false);
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

	/** two turns put the context past the prefire line (8,000 of 10,000); the summary is ready after them */
	async function readyPrefire(over: Partial<Config["compaction"]> = {}) {
		const x = await session(over);
		turns = [
			{ text: "one", input: 4000 },
			{ text: "two", input: 8500 },
		];
		await turn(x.s, "first");
		await turn(x.s, "second");
		await Bun.sleep(100);
		return x;
	}

	const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
	const compactions = (events: EngineEvent[]) => events.filter((e) => e.type === "session.compacted");
	const prefires = (events: EngineEvent[], state: string) => events.filter((e) => e.type === "compaction.prefire" && e.properties.state === state);

	test("a cold cache with a summary ready compacts under the threshold, from that summary", async () => {
		const { s, events } = await readyPrefire();
		expect(prefires(events, "ready").length).toBe(1);
		const before = requests.filter(isSummary).length;
		try {
			// the short ttl and its grace have passed since the last request
			later(331_000);
			turns = [{ text: "three", input: 3000 }];
			await turn(s, "third");
		} finally {
			setSystemTime();
		}
		const c = compactions(events);
		expect(c.length).toBe(1);
		expect(c[0]!.properties).toMatchObject({ trigger: "auto", prefire: true, cold: true });
		expect(c[0]!.properties.tokensBefore).toBeLessThan(10_000);
		expect(requests.filter(isSummary).length).toBe(before);
		expect(JSON.stringify(requests.at(-1)!.messages[0])).toContain("<compaction-summary>");
		const lines = readFileSync(s.transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).message);
		expect(lines.find((m) => m?.role === "compaction")?.cold).toBe(true);
		s.dispose();
	});

	test("within the ttl a ready summary waits for the threshold", async () => {
		const { s, events } = await readyPrefire();
		try {
			later(60_000);
			turns = [{ text: "three", input: 3000 }];
			await turn(s, "third");
		} finally {
			setSystemTime();
		}
		expect(compactions(events).length).toBe(0);
		s.dispose();
	});

	test("a cold cache with a stale summary does not compact and asks for no summary", async () => {
		const { s, events } = await readyPrefire();
		// the summary no longer ends where the context's head does
		(s as any).prefire.last = { role: "user", content: "something else", timestamp: 0 };
		const before = requests.filter(isSummary).length;
		try {
			later(331_000);
			// a small reply: the turn's end stays under the prefire line, so no new summary starts there either
			turns = [{ text: "three", input: 3000 }];
			await turn(s, "third");
		} finally {
			setSystemTime();
		}
		expect(compactions(events).length).toBe(0);
		expect(prefires(events, "stale").length).toBe(1);
		expect(requests.filter(isSummary).length).toBe(before);
		s.dispose();
	});

	test("a cold cache with the summary still being written, or none, does not compact", async () => {
		summaryDelayMs = 400;
		const a = await session();
		turns = [
			{ text: "one", input: 4000 },
			{ text: "two", input: 8500 },
		];
		await turn(a.s, "first");
		await turn(a.s, "second");
		expect(prefires(a.events, "started").length).toBe(1);
		expect(prefires(a.events, "ready").length).toBe(0);
		const b = await readyPrefire({ prefire: false });
		try {
			later(331_000);
			turns = [
				{ text: "three", input: 3000 },
				{ text: "three", input: 3000 },
			];
			await turn(a.s, "third");
			await turn(b.s, "third");
		} finally {
			setSystemTime();
		}
		expect(compactions(a.events).length).toBe(0);
		expect(compactions(b.events).length).toBe(0);
		await Bun.sleep(500);
		summaryDelayMs = 0;
		a.s.dispose();
		b.s.dispose();
	});

	test("a model switch with a summary ready compacts: the new model has no cache to keep", async () => {
		const { s, events } = await readyPrefire();
		await s.setModel("anthropic/claude-haiku-5-5");
		turns = [{ text: "three", input: 3000 }];
		await turn(s, "third");
		const c = compactions(events);
		expect(c.length).toBe(1);
		expect(c[0]!.properties).toMatchObject({ prefire: true, cold: true });
		s.dispose();
	});

	/**
	 * at 100,000 with the prefire at half: the first turn's 60,000 starts the summary, the second prompt's
	 * ~25,000 tokens pass the refresh line (max(10% of 100,000, 20,000)), the third crosses the threshold
	 */
	async function grownTail() {
		const x = await session({ at: 100_000, prefire: 0.5 });
		turns = [{ text: "one", input: 60_000 }];
		await turn(x.s, "first");
		await Bun.sleep(100);
		expect(prefires(x.events, "ready").length).toBe(1);
		return x;
	}
	const assistantSeqs = (events: EngineEvent[]) => events.filter((e) => e.type === "message.started").map((e) => e.properties.seq as number);

	test("a summary whose tail grew is refreshed, and the threshold uses the newer one", async () => {
		const { s, events } = await grownTail();
		turns = [{ text: "two", input: 97_000 }];
		await turn(s, "x".repeat(100_000));
		await Bun.sleep(100);
		expect(prefires(events, "started").map((e) => e.properties.refresh ?? false)).toEqual([false, true]);
		expect(prefires(events, "ready").at(-1)!.properties.refresh).toBe(true);
		const summaries = events.filter((e) => e.type === "compaction.prefire" && e.properties.state === "started").length;
		turns = [{ text: "three", input: 3000 }];
		await turn(s, "y".repeat(16_000));
		const c = compactions(events);
		expect(c.length).toBe(1);
		expect(c[0]!.properties).toMatchObject({ prefire: true, cold: false });
		// the first summary's tail began at the second prompt; the refresh's after it, at the second reply
		expect(c[0]!.properties.tailFrom).toBe(assistantSeqs(events)[1]!);
		expect(JSON.stringify(requests.at(-1))).not.toContain("x".repeat(1000));
		expect(prefires(events, "started").length).toBe(summaries);
		s.dispose();
	});

	test("a refresh that fails leaves the older summary in use", async () => {
		const { s, events } = await grownTail();
		summary = "";
		turns = [{ text: "two", input: 97_000 }];
		await turn(s, "x".repeat(100_000));
		await Bun.sleep(100);
		summary = GOOD;
		const failed = prefires(events, "failed");
		expect(failed.length).toBe(1);
		expect(failed[0]!.properties.refresh).toBe(true);
		const asked = requests.filter(isSummary).length;
		turns = [{ text: "three", input: 3000 }];
		await turn(s, "y".repeat(16_000));
		const c = compactions(events);
		expect(c.length).toBe(1);
		expect(c[0]!.properties.prefire).toBe(true);
		// the first summary's tail: the second prompt is kept word for word
		expect(c[0]!.properties.tailFrom).toBeLessThan(assistantSeqs(events)[1]!);
		expect(JSON.stringify(requests.at(-1))).toContain("x".repeat(1000));
		// no second refresh after the failure, and no summary asked for at the threshold
		expect(requests.filter(isSummary).length).toBe(asked);
		s.dispose();
	});

	test("a compaction while a refresh runs: the refresh lands on nothing", async () => {
		const { s, events } = await grownTail();
		summaryDelayMs = 500;
		try {
			turns = [{ text: "two", input: 97_000 }];
			await turn(s, "x".repeat(100_000));
			expect(prefires(events, "started").at(-1)!.properties.refresh).toBe(true);
			turns = [{ text: "three", input: 3000 }];
			await turn(s, "y".repeat(16_000));
			const c = compactions(events);
			expect(c.length).toBe(1);
			// the older summary, without waiting on the refresh
			expect(c[0]!.properties).toMatchObject({ prefire: true, waitedMs: 0 });
			expect(c[0]!.properties.tailFrom).toBeLessThan(assistantSeqs(events)[1]!);
			await Bun.sleep(600);
		} finally {
			summaryDelayMs = 0;
		}
		const stale = prefires(events, "stale").at(-1)!;
		expect(stale.properties.refresh).toBe(true);
		expect(prefires(events, "ready").filter((e) => e.properties.refresh).length).toBe(0);
		expect((s as any).prefire).toBeUndefined();
		expect((s as any).refresh).toBeUndefined();
		s.dispose();
	});

	/** compaction.cold at 5,000 with no prefire line: what happens is the floor's doing alone */
	const COLD = { cold: 5000, prefire: false } as const;
	const idleMs = (ms: number | undefined) => {
		if (ms === undefined) delete process.env.CMX2_IDLE_SUMMARY_MS;
		else process.env.CMX2_IDLE_SUMMARY_MS = String(ms);
	};
	const summaryRequests = () => requests.filter(isSummary);

	test("an idle session past the cold floor makes its summary before the cache expires, and does not compact", async () => {
		idleMs(60);
		try {
			const { s, events } = await session(COLD);
			turns = [{ text: "one", input: 6000 }];
			const before = summaryRequests().length;
			await turn(s, "first");
			// scheduled, and the residency cache keeps the session for it
			expect(s.warming).toBe(true);
			expect(prefires(events, "started").length).toBe(0);
			await Bun.sleep(250);
			expect(prefires(events, "ready").length).toBe(1);
			expect(summaryRequests().length).toBe(before + 1);
			// the summary reads the cache like a turn does
			expect(JSON.stringify(summaryRequests().at(-1))).toContain("cache_control");
			expect(compactions(events).length).toBe(0);
			expect(s.warming).toBe(false);

			// back within the ttl the summary made (it read the cache): no compaction, the summary is kept
			turns = [{ text: "two", input: 6100 }];
			await turn(s, "second");
			expect(compactions(events).length).toBe(0);
			expect((s as any).prefire?.result).toBeDefined();
			// a fresh summary is not made again
			await Bun.sleep(250);
			expect(summaryRequests().length).toBe(before + 1);

			// back after it expired: compacted from that summary, with no new summary request
			try {
				later(331_000);
				turns = [{ text: "three", input: 2000 }];
				await turn(s, "third");
			} finally {
				setSystemTime();
			}
			const c = compactions(events);
			expect(c.length).toBe(1);
			expect(c[0]!.properties).toMatchObject({ trigger: "auto", prefire: true, cold: true });
			expect(summaryRequests().length).toBe(before + 1);
			expect(JSON.stringify(requests.at(-1)!.messages[0])).toContain("<compaction-summary>");
			s.dispose();
		} finally {
			idleMs(undefined);
		}
	});

	test("under the cold floor, with it off, or once disposed, no idle summary is made", async () => {
		idleMs(60);
		try {
			const before = summaryRequests().length;
			const under = await session(COLD);
			turns = [{ text: "one", input: 3000 }];
			await turn(under.s, "first");
			expect(under.s.warming).toBe(false);
			const off = await session({ cold: false, prefire: false });
			turns = [{ text: "one", input: 6000 }];
			await turn(off.s, "first");
			expect(off.s.warming).toBe(false);
			// a closed helper's session is disposed: its timer goes with it
			const closed = await session(COLD);
			turns = [{ text: "one", input: 6000 }];
			await turn(closed.s, "first");
			expect(closed.s.warming).toBe(true);
			closed.s.dispose();
			expect(closed.s.warming).toBe(false);
			await Bun.sleep(250);
			expect(summaryRequests().length).toBe(before);
			for (const x of [under, off, closed]) expect(prefires(x.events, "started").length).toBe(0);
			under.s.dispose();
			off.s.dispose();
		} finally {
			idleMs(undefined);
		}
	});

	test("a cold cache past the floor with no summary ready makes one without cache marks, then compacts", async () => {
		const { s, events } = await session(COLD);
		turns = [{ text: "one", input: 6000 }];
		await turn(s, "first");
		const before = summaryRequests().length;
		try {
			later(331_000);
			turns = [{ text: "two", input: 2000 }];
			await turn(s, "second");
		} finally {
			setSystemTime();
		}
		const asked = summaryRequests().slice(before);
		expect(asked.length).toBe(1);
		// nothing to write: the prefix it would cache is replaced by the compaction
		expect(JSON.stringify(asked[0])).not.toContain("cache_control");
		const c = compactions(events);
		expect(c.length).toBe(1);
		expect(c[0]!.properties).toMatchObject({ trigger: "auto", prefire: false, cold: true });
		// the turn goes on, from the summary, and its own request caches again
		const sent = requests.at(-1)!;
		expect(isSummary(sent)).toBe(false);
		expect(JSON.stringify(sent.messages[0])).toContain("<compaction-summary>");
		expect(JSON.stringify(sent)).toContain("cache_control");
		s.dispose();
	});

	test("cold past the floor with the floor off, or under it with no summary, compacts nothing", async () => {
		const off = await session({ cold: false, prefire: false });
		const under = await session(COLD);
		turns = [
			{ text: "one", input: 6000 },
			{ text: "one", input: 3000 },
		];
		await turn(off.s, "first");
		await turn(under.s, "first");
		const before = summaryRequests().length;
		try {
			later(331_000);
			turns = [
				{ text: "two", input: 6100 },
				{ text: "two", input: 3100 },
			];
			await turn(off.s, "second");
			await turn(under.s, "second");
		} finally {
			setSystemTime();
		}
		expect(compactions(off.events).length).toBe(0);
		expect(compactions(under.events).length).toBe(0);
		expect(summaryRequests().length).toBe(before);
		off.s.dispose();
		under.s.dispose();
	});

	test("a session evicted with its summary ready compacts from it when reloaded cold; a restart reads the last reply's time", async () => {
		idleMs(60);
		let first: Awaited<ReturnType<typeof session>>;
		try {
			first = await session(COLD);
			turns = [{ text: "one", input: 6000 }];
			await turn(first.s, "first");
			await Bun.sleep(250);
			expect(prefires(first.events, "ready").length).toBe(1);
		} finally {
			idleMs(undefined);
		}
		const { s, dataDir } = first;
		s.dispose();
		// a copy of the transcript under another id has nothing left behind: as after a daemon restart
		const copyId = `${s.id}x`;
		writeFileSync(join(dataDir, "sessions", `${copyId}.jsonl`), readFileSync(s.transcriptPath));
		const before = summaryRequests().length;
		try {
			later(331_000);
			const again = await session(COLD, dataDir, s.id, true);
			turns = [{ text: "two", input: 2000 }];
			await turn(again.s, "second");
			expect(compactions(again.events)[0]?.properties).toMatchObject({ prefire: true, cold: true });
			expect(summaryRequests().length).toBe(before);
			again.s.dispose();

			const restarted = await session(COLD, dataDir, copyId, true);
			turns = [{ text: "two", input: 2000 }];
			await turn(restarted.s, "second");
			expect(compactions(restarted.events)[0]?.properties).toMatchObject({ prefire: false, cold: true });
			expect(summaryRequests().length).toBe(before + 1);
			restarted.s.dispose();
		} finally {
			setSystemTime();
		}
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
