/**
 * contract version 5, additive: an agent tool part is titled by what it started
 * ("agent helper", "wait for agents", "note to helper"), and a `run` part's nested entries carry the
 * helper's title and the tool's own answer (an `agents.spawn` inside a script leaves the child's id,
 * name and path on the part). a daemon in this process whose provider is a scripted stand-in on
 * loopback speaking anthropic's stream, so the whole path runs (pi's adapter, the engine, the agent
 * verbs, the projection, the route) without a model.
 *
 * run: bun test packages/server/test/titles.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-titles-"));
const ROOT = join(SCRATCH, `titles-${nonce()}`);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4831);
const BASE = `http://127.0.0.1:${PORT}`;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** the root's first user message carries a marker; the number of tool results so far picks the step */
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = (JSON.stringify(messages).match(/"type":"tool_result"/g) ?? []).length;
	if (first.includes("[verbs]")) {
		const steps: Block[] = [
			{ type: "tool_use", name: "spawn", input: { name: "helper", brief: "say hi and stop", model: "sonnet" } },
			{ type: "tool_use", name: "message", input: { to: "helper", body: "one more thing", wake: false } },
			{ type: "tool_use", name: "wait", input: { timeout_ms: 1000 } },
			{ type: "tool_use", name: "wait", input: { timeout_ms: 1000, correlation_id: "nobody" } },
			{ type: "tool_use", name: "agents", input: { action: "close", target: "helper" } },
		];
		return [steps[answered] ?? { type: "text", text: "done" }];
	}
	if (first.includes("[script]")) {
		if (answered > 0) return [{ type: "text", text: "done" }];
		const code = `const a = await agents.spawn({ brief: "say hi and stop", name: "scripted", model: "sonnet" });
const b = await agents.spawn({ brief: "say hi and stop", name: "other", model: "sonnet" });
await agents.message({ to: "scripted", body: "one more thing", wake: false });
await agents.wait({ timeout_ms: 1000 });
return [a.child_session_id, b.child_session_id];`;
		return [{ type: "tool_use", name: "run", input: { code } }];
	}
	if (first.includes("[files]")) {
		if (answered > 0) return [{ type: "text", text: "done" }];
		const code = 'await fs.write({ path: "note.txt", content: "hi" }); await fs.read({ path: "note.txt" }); return (await shell.exec({ command: "echo hi" })).output;';
		return [{ type: "tool_use", name: "run", input: { code } }];
	}
	return [{ type: "text", text: "hi" }];
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
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
});

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return (await res.json()) as any;
};

async function turn(text: string) {
	const id = (await api("/session", { directory: WORK, title: `it-titles-${nonce()}` })).id as string;
	await api(`/session/${id}/prompt`, { text });
	const t0 = Date.now();
	for (;;) {
		const status = await api("/session/status");
		if (!status[id] || status[id].type === "idle") {
			const msgs = (await api(`/session/${id}/message`)) as any[];
			if (msgs.some((m) => m.info.role === "assistant" && m.parts.some((p: any) => p.type === "text" && p.text === "done"))) return { id, msgs };
		}
		if (Date.now() - t0 > 30_000) throw new Error("the turn did not settle");
		await Bun.sleep(50);
	}
}

const toolParts = (msgs: any[], tool: string) => msgs.flatMap((m) => m.parts).filter((p: any) => p.type === "tool" && p.tool === tool);

describe("a24: an agent tool part is titled by what it started", () => {
	test("spawn, message, wait and agents carry titles that name the thing", async () => {
		const { msgs } = await turn("[verbs] start a helper");
		const titles = (tool: string) => toolParts(msgs, tool).map((p: any) => p.state.title);
		expect(titles("spawn")).toEqual(["agent helper"]);
		expect(titles("message")).toEqual(["note to helper"]);
		expect(titles("wait")).toEqual(["wait for agents", "wait for nobody"]);
		expect(titles("agents")).toEqual(["close helper"]);
		// the metadata is what it was: the spawn part still names the child
		const spawn = toolParts(msgs, "spawn")[0];
		expect(spawn.state.metadata).toMatchObject({ path: "/root/helper" });
		expect(typeof spawn.state.metadata.child_session_id).toBe("string");
	});
});

describe("a27: a run script's nested calls record what the direct tool would", () => {
	test("agents.spawn inside a script leaves the child's id, name and path, and a title", async () => {
		const { msgs } = await turn("[script] start two helpers from one script");
		const run = toolParts(msgs, "run")[0];
		expect(run.state.status).toBe("completed");
		const nested = run.state.metadata.nested as any[];
		expect(nested.map((n) => n.helper)).toEqual(["agents.spawn", "agents.spawn", "agents.message", "agents.wait"]);
		expect(nested.map((n) => n.title)).toEqual(["agent scripted", "agent other", "note to scripted", "wait for agents"]);
		const [a, b] = nested as [any, any];
		// what a direct spawn records as metadata: child_session_id, id, path, agents
		expect(a.details).toMatchObject({ path: "/root/scripted" });
		expect(b.details).toMatchObject({ path: "/root/other" });
		expect(a.details.child_session_id).toMatch(/^ses_/);
		expect(a.details.agents[0]).toMatchObject({ id: a.details.child_session_id, name: "scripted", path: "/root/scripted" });
		expect(a.details.child_session_id).not.toBe(b.details.child_session_id);
		// the id on the part is a session that exists
		const child = await api(`/session/${a.details.child_session_id}`);
		expect(child.id).toBe(a.details.child_session_id);
		// the entries still hold what they held
		expect(a).toMatchObject({ tool: "spawn", ok: true });
	});

	test("a helper that is not an agent verb is titled by its path or command and carries its details", async () => {
		const { msgs } = await turn("[files] write, read and echo");
		const nested = toolParts(msgs, "run")[0].state.metadata.nested as any[];
		expect(nested.map((n) => n.title)).toEqual(["note.txt", "note.txt", "echo hi"]);
		expect(nested[1].details).toMatchObject({ startLine: 1, totalLines: 1 });
		expect(nested[2].details).toMatchObject({ exit_code: 0 });
	});
});
