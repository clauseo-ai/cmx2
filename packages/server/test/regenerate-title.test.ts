/**
 * POST /session/:id/title, additive: a client asks for a new title from what the session is about now.
 * a daemon in this process whose provider is a scripted stand-in on loopback speaking anthropic's
 * stream; title requests are told apart by their output_config.format (the structured title request),
 * turns by their tools.
 *
 * run: bun test packages/server/test/regenerate-title.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-regen-title-"));
const ROOT = join(SCRATCH, `regen-${nonce()}`);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4848);
const BASE = `http://127.0.0.1:${PORT}`;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** what the title requests saw, and what the next one answers: a json title, or a 400 */
const asked: string[] = [];
let titleReply: string | number = '{"title":"Fix Double Login Submit"}';

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const isTitle = !!body.output_config?.format;
		let text = "done, the form now submits once";
		if (isTitle) {
			asked.push(JSON.stringify(body.messages));
			if (typeof titleReply === "number") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }), { status: titleReply, headers: { "content-type": "application/json" } });
			text = titleReply;
		} else if (!body.tools?.length) {
			// the plain text fallback request
			if (typeof titleReply === "number") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }), { status: titleReply, headers: { "content-type": "application/json" } });
		}
		const out =
			sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }) +
			sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
			sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
			sse("content_block_stop", { index: 0 }) +
			sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }) +
			sse("message_stop", {});
		return new Response(out, { headers: { "content-type": "text/event-stream" } });
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

const call = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: (await res.json()) as any };
};

async function settled(id: string) {
	const t0 = Date.now();
	for (;;) {
		const status = (await call("/session/status")).json;
		if (!status[id] || status[id].type === "idle") {
			const msgs = (await call(`/session/${id}/message`)).json as any[];
			if (msgs.some((m) => m.info.role === "assistant" && m.parts.some((p: any) => p.type === "text" && p.text.startsWith("done")))) return;
		}
		if (Date.now() - t0 > 30_000) throw new Error("the turn did not settle");
		await Bun.sleep(50);
	}
}

describe("POST /session/:id/title", () => {
	test("replaces a given title with a structured one over the first message and the latest text", async () => {
		const given = `it-regen-${nonce()}`;
		const id = (await call("/session", { directory: WORK, title: given })).json.id as string;
		await call(`/session/${id}/prompt`, { text: "the login form submits twice when you press enter" });
		await settled(id);
		asked.length = 0;
		titleReply = '{"title":"Fix Double Login Submit"}';
		const r = await call(`/session/${id}/title`, {});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ id, title: "fix double login submit" });
		expect((await call(`/session/${id}`)).json.title).toBe("fix double login submit");
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("the login form submits twice");
		expect(asked[0]).toContain("done, the form now submits once");
	});

	test("502 and the title unchanged when no title model gives one", async () => {
		const given = `it-regen-${nonce()}`;
		const id = (await call("/session", { directory: WORK, title: given })).json.id as string;
		await call(`/session/${id}/prompt`, { text: "rename the helper module" });
		await settled(id);
		titleReply = 400;
		const r = await call(`/session/${id}/title`, {});
		titleReply = '{"title":"Fix Double Login Submit"}';
		expect(r.status).toBe(502);
		expect(r.json.name).toBe("TitleError");
		expect((await call(`/session/${id}`)).json.title).toBe(given);
	});

	test("404 for a session that does not exist", async () => {
		expect((await call("/session/ses_nope/title", {})).status).toBe(404);
	});
});
