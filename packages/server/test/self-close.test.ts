/**
 * an agent that names itself or an ancestor in close is refused at once and its turn ends; a helper in wait is closed
 * by its spawner without waiting out anything; a turn held by a tool that ignores the abort is ended after the limit
 * (shortened here) by abort and archive, and what it does late reaches nothing. a daemon in this process whose
 * provider is a scripted stand-in on loopback speaking anthropic's stream, so the tools run inside real turns.
 *
 * run: bun test packages/server/test/self-close.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { Type } from "typebox";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-self-close-"));
const ROOT = join(SCRATCH, `self-close-${nonce()}`);
const WORK = join(ROOT, "work");
const CONFIG = join(ROOT, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const PORT = port(4847);
const BASE = `http://127.0.0.1:${PORT}`;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** the tag in a session's first user message picks its script; the number of tool results so far picks the step */
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = (JSON.stringify(messages).match(/"type":"tool_result"/g) ?? []).length;
	const plans: Record<string, Block[]> = {
		// a helper that tries to close itself, then its spawner, then ends its turn
		"[selfie]": [
			{ type: "tool_use", name: "agents", input: { action: "close", target: "/root/selfie" } },
			{ type: "tool_use", name: "agents", input: { action: "close", target: "/root" } },
			{ type: "tool_use", name: "agents", input: { action: "interrupt", target: "/root" } },
		],
		// a helper that waits on its mailbox for ten minutes
		"[napper]": [{ type: "tool_use", name: "wait", input: { timeout_ms: 600000 } }],
		"[selfclose]": [
			{ type: "tool_use", name: "spawn", input: { name: "selfie", model: "sonnet", brief: "[selfie] close yourself" } },
			{ type: "tool_use", name: "wait", input: { timeout_ms: 30000 } },
		],
		// a root that reads a helper's question, then sits in a tool that ignores the abort
		"[stuckroot]": [
			{ type: "tool_use", name: "spawn", input: { name: "asker", model: "sonnet", brief: "[asker] ask" } },
			{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
			{ type: "tool_use", name: "stuck", input: {} },
		],
		"[asker]": [{ type: "tool_use", name: "question", input: { questions: [{ question: "which one?", header: "pick", options: [{ label: "a", description: "the first" }] }] } }],
		"[stuckonly]": [{ type: "tool_use", name: "stuck", input: {} }],
		"[napclose]": [
			{ type: "tool_use", name: "spawn", input: { name: "napper", model: "sonnet", brief: "[napper] wait" } },
			// nothing reports in a second; by then the helper sits in wait
			{ type: "tool_use", name: "wait", input: { timeout_ms: 1000 } },
			{ type: "tool_use", name: "agents", input: { action: "close", target: "/root/napper" } },
		],
	};
	const tag = Object.keys(plans).find((t) => first.includes(t));
	if (!tag) return [{ type: "text", text: "hi" }];
	return [plans[tag]![answered] ?? { type: "text", text: "done" }];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				const put = (s: string) => c.enqueue(enc.encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "tool_use") {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: b.name, input: {} } }));
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
					} else {
						put(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
						put(sse("content_block_delta", { index, delta: { type: "text_delta", text: b.text } }));
					}
					put(sse("content_block_stop", { index }));
				}
				put(sse("message_delta", { delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

/** a tool that ignores the abort signal: it returns only when the test releases it */
const held: Array<() => void> = [];
let entered: Array<() => void> = [];
const inStuck = () => new Promise<void>((r) => entered.push(r));
const stuck = {
	name: "stuck",
	label: "stuck",
	description: "a call that returns only when released",
	parameters: Type.Object({}),
	async execute() {
		for (const r of entered.splice(0)) r();
		await new Promise<void>((r) => held.push(r));
		return { content: [{ type: "text" as const, text: "late result" }], details: {} };
	},
};
const IDLE_WAIT = 300;

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c, warmHorizonMs: 0, idleWaitMs: IDLE_WAIT, extraTools: () => [stuck as never] });
});
afterAll(async () => {
	for (const r of held.splice(0)) r();
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
	if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
});

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return (await res.json()) as any;
};

const newSession = async () => (await api("/session", { directory: WORK, title: `it-self-close-${nonce()}`, model: "anthropic/claude-opus-5-5" })).id as string;

/** a root turn on the tagged script, settled once it said done */
async function turn(text: string, session?: string) {
	const id = session ?? (await newSession());
	await api(`/session/${id}/prompt`, { text });
	const t0 = Date.now();
	for (;;) {
		const status = await api("/session/status");
		if (!status[id] || status[id].type === "idle") {
			const msgs = (await api(`/session/${id}/message`)) as any[];
			if (msgs.some((m) => m.info.role === "assistant" && m.parts.some((p: any) => p.type === "text" && p.text === "done"))) return { id, msgs, took: Date.now() - t0 };
		}
		if (Date.now() - t0 > 30_000) throw new Error("the turn did not settle");
		await Bun.sleep(50);
	}
}

const toolParts = (msgs: any[], tool: string) => msgs.flatMap((m) => m.parts).filter((p: any) => p.type === "tool" && p.tool === tool);
const out = (p: any) => String(p.state.output ?? p.state.error ?? "");

test("a helper that closes itself or its spawner gets an error at once, its turn ends, and it reports as parked", async () => {
	const { id, msgs } = await turn("[selfclose] go");
	// the spawner's wait got the helper's report
	const waited = toolParts(msgs, "wait").map(out).join("\n");
	expect(waited).toContain("report from /root/selfie");
	const roster = (await api(`/session/${id}/agents`)) as any;
	const selfie = (roster.agents ?? roster).find((a: any) => a.name === "selfie");
	expect(selfie.state).toBe("parked");
	const theirs = (await api(`/session/${selfie.id}/message`)) as any[];
	const answers = toolParts(theirs, "agents").map(out);
	expect(answers).toHaveLength(3);
	expect(answers[0]).toContain("you can't close yourself or an ancestor; end your turn instead.");
	// the root is refused for its own reason before the ancestor rule
	expect(answers[1]).toContain("archive the session to end it");
	expect(answers[2]).toContain("you can't interrupt yourself or an ancestor; end your turn instead.");
}, 40_000);

test("a helper in wait is closed by its spawner without waiting out its wait", async () => {
	const { id, msgs } = await turn("[napclose] go");
	const closed = toolParts(msgs, "agents").map(out);
	expect(closed).toHaveLength(1);
	expect(closed[0]).toContain("closed /root/napper");
	const roster = (await api(`/session/${id}/agents`)) as any;
	expect((roster.agents ?? roster).find((a: any) => a.name === "napper").state).toBe("closed");
	const status = await api("/session/status");
	expect(status[id]).toBeUndefined();
}, 40_000);

async function until(what: string, ok: () => Promise<boolean>, ms = 15_000) {
	const t0 = Date.now();
	while (!(await ok())) {
		if (Date.now() - t0 > ms) throw new Error(`never: ${what}`);
		await Bun.sleep(50);
	}
}
const transcriptLines = (id: string) => readFileSync(join(ROOT, "data", "sessions", `${id}.jsonl`), "utf8").trim().split("\n").length;

test("a root stuck in a tool that ignores the abort: abort ends it after the limit, settles the question it read, frees its lock, and the late result writes nothing", async () => {
	const id = await newSession();
	const entered = inStuck();
	await api(`/session/${id}/prompt`, { text: "[stuckroot] go" });
	await entered;
	const roster = (await api(`/session/${id}/agents`)) as any;
	const asker = roster.agents.find((a: any) => a.name === "asker");
	// the helper's question waits on the root, which read it in its wait and then got stuck
	expect(asker.state).toBe("working");
	const t0 = Date.now();
	expect(await api(`/session/${id}/abort`, {})).toBe(true);
	const took = Date.now() - t0;
	expect(took).toBeGreaterThanOrEqual(IDLE_WAIT);
	expect(took).toBeLessThan(IDLE_WAIT + 2_000);
	expect((await api("/session/status"))[id]).toBeUndefined();
	// the question the root read and never answered is settled: the helper goes on and parks
	await until("the asker parks", async () => (await api(`/session/${id}/agents`)).agents.find((a: any) => a.name === "asker").state === "parked");
	const askerTools = toolParts(await api(`/session/${asker.id}/message`), "question").map(out);
	expect(askerTools.join("\n")).toContain("ended its turn without answering");
	// the next prompt reopens the session from its transcript (the lock is free) and its turn completes
	const { msgs } = await turn("carry on", id);
	const lines = transcriptLines(id);
	const count = msgs.length;
	// the stuck call returns now, into a session that was ended: nothing reaches the transcript or the projection
	for (const r of held.splice(0)) r();
	await Bun.sleep(200);
	expect(transcriptLines(id)).toBe(lines);
	expect(((await api(`/session/${id}/message`)) as any[]).length).toBe(count);
	expect(JSON.stringify(await api(`/session/${id}/message`))).not.toContain("late result");
	expect((await api("/session/status"))[id]).toBeUndefined();
}, 40_000);

test("archiving a session stuck in a tool that ignores the abort finishes after the limit", async () => {
	const id = await newSession();
	const entered = inStuck();
	await api(`/session/${id}/prompt`, { text: "[stuckonly] go" });
	await entered;
	const t0 = Date.now();
	const res = await fetch(`${BASE}/session/${id}`, { method: "DELETE", headers: { "x-cmx2-directory": WORK } });
	expect(res.status).toBe(200);
	expect(Date.now() - t0).toBeLessThan(IDLE_WAIT + 2_000);
	expect((await api("/session/status"))[id]).toBeUndefined();
	for (const r of held.splice(0)) r();
}, 20_000);
