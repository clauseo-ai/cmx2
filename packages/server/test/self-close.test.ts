/**
 * an agent that names itself or an ancestor in close is refused at once and its turn ends; a helper in wait is closed
 * by its spawner without waiting out anything. a daemon in this process whose provider is a scripted stand-in on
 * loopback speaking anthropic's stream, so the agents tool runs inside real turns.
 *
 * run: bun test packages/server/test/self-close.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
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

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c, warmHorizonMs: 0 });
});
afterAll(async () => {
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

/** a root turn on the tagged script, settled once it said done */
async function turn(text: string) {
	const id = (await api("/session", { directory: WORK, title: `it-self-close-${nonce()}`, model: "anthropic/claude-opus-5-5" })).id as string;
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
