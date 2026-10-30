/**
 * the caller a session sends to a `caller: true` mcp server, as the daemon builds it from the agent tree: a root,
 * its helper and the helper's own helper each call a real stdio server (tools/test/fixtures/mcp-echo.ts) that
 * answers with the params it got. a daemon in this process whose provider is a scripted stand-in on loopback
 * speaking anthropic's stream, so the whole path runs without a model.
 *
 * run: bun test packages/server/test/mcp-caller.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const ROOT = realpathSync(mkdtempSync("/tmp/cmx2-mcp-caller-"));
const WORK = join(ROOT, "work");
const CONFIG = join(ROOT, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const PORT = port(4847);
const BASE = `http://127.0.0.1:${PORT}`;
const ECHO = [process.execPath, join(import.meta.dir, "../../tools/test/fixtures/mcp-echo.ts")];

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** each session's first user message names its role; the number of tool results so far picks the step */
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = (JSON.stringify(messages).match(/"type":"tool_result"/g) ?? []).length;
	const call: Block[] = [
		{ type: "tool_use", name: "tool_search", input: { query: "echo" } },
		{ type: "tool_use", name: "box_echo", input: {} },
	];
	const steps: Block[] = first.includes("[grand]")
		? call
		: first.includes("[kid]")
			? [...call, { type: "tool_use", name: "spawn", input: { name: "grand", model: "sonnet", brief: "[grand] call the echo tool" } }, { type: "tool_use", name: "wait", input: { timeout_ms: 20000 } }]
			: first.includes("[top]")
				? [...call, { type: "tool_use", name: "spawn", input: { name: "kid", model: "sonnet", brief: "[kid] call the echo tool" } }, { type: "tool_use", name: "wait", input: { timeout_ms: 20000 } }]
				: [];
	return [steps[answered] ?? { type: "text", text: "done" }];
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

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, mcp: { box: { command: ECHO, caller: true } }, sources: [] });
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
	rmSync(ROOT, { recursive: true, force: true });
	if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
});

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return (await res.json()) as any;
};

/** the _meta caller the echo server saw on a session's box_echo call, with that call's id */
async function callerOf(id: string): Promise<{ caller: Record<string, unknown>; callID: string } | undefined> {
	const msgs = (await api(`/session/${id}/message`)) as any[];
	const part = msgs.flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.tool === "box_echo" && p.state.status === "completed");
	if (!part) return undefined;
	return { caller: JSON.parse(String(part.state.output))._meta["cmx2/caller"], callID: part.callID };
}

async function until<T>(what: string, get: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

test("the caller is built from the agent tree: a root, its helper and the helper's helper each name themselves, their parent and their root", async () => {
	await until("the echo server", async () => ((await api("/mcp")) as any[]).find((m) => m.name === "box" && m.status === "connected"));
	const top = (await api("/session", { directory: WORK, title: `it-mcp-caller-${nonce()}`, model: "anthropic/claude-opus-5-5" })).id as string;
	await api(`/session/${top}/prompt`, { text: "[top] call the echo tool" });
	const kid = await until("the helper", async () => ((await api(`/session/${top}/children`)) as any[])[0]?.id as string | undefined);
	const grand = await until("the helper's helper", async () => ((await api(`/session/${kid}/children`)) as any[])[0]?.id as string | undefined);
	const [a, b, c] = await Promise.all([top, kid, grand].map((id) => until(`${id}'s echo call`, () => callerOf(id))));
	const host = hostname().split(".")[0]!.toLowerCase();
	expect(a!.caller).toEqual({ sessionID: top, rootID: top, parentID: null, depth: 0, path: "/root", directory: WORK, host, callID: a!.callID });
	expect(b!.caller).toEqual({ sessionID: kid, rootID: top, parentID: top, depth: 1, path: "/root/kid", directory: WORK, host, callID: b!.callID });
	expect(c!.caller).toEqual({ sessionID: grand, rootID: top, parentID: kid, depth: 2, path: "/root/kid/grand", directory: WORK, host, callID: c!.callID });
}, 90_000);
