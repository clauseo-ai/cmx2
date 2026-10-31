/**
 * session export and import over http: GET /session/:id/export streams the cli's bundle, POST /session/import writes it
 * into another daemon's store. two daemons in this process (ports 4961 and 4962, shifted by CMX2_PORT_SHIFT), each
 * with its own data dir; the provider is a scripted stand-in on loopback speaking anthropic's stream, so the turns are
 * real turns with a real tool call. counts of sessions and messages are checked around every import (rule 14).
 *
 * run: bun test packages/server/test/transfer.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { exportSession, exportStream } from "@cmx2/store";
import { Type } from "typebox";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const ROOT = realpathSync(mkdtempSync("/tmp/cmx2-transfer-"));
const WORK = join(ROOT, "work");
const WORK2 = join(ROOT, "elsewhere");
const CONFIG = join(ROOT, "config");
for (const d of [WORK, WORK2, CONFIG]) mkdirSync(d, { recursive: true });
writeFileSync(join(WORK, "notes.txt"), "the answer is 42\n");
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const A = `http://127.0.0.1:${port(4961)}`;
const B = `http://127.0.0.1:${port(4962)}`;
const SMALL_CAP = 2 * 1024 * 1024;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** every request the provider saw, for checking what the model read */
const seen: any[] = [];

function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	const all = JSON.stringify(messages);
	const answered = (all.match(/"type":"tool_result"/g) ?? []).length;
	if (all.includes("[stuck]") && answered === 0) return [{ type: "tool_use", name: "stuck", input: {} }];
	if (all.includes("[read]") && answered === 0) return [{ type: "tool_use", name: "read", input: { path: "notes.txt" } }];
	return [{ type: "text", text: "done" }];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		if (body.tools?.length) seen.push(body);
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

/** a tool that holds its turn open until the test releases it */
const held: Array<() => void> = [];
const stuck = {
	name: "stuck",
	label: "stuck",
	description: "a call that returns only when released",
	parameters: Type.Object({}),
	async execute() {
		await new Promise<void>((r) => held.push(r));
		return { content: [{ type: "text" as const, text: "released" }], details: {} };
	},
};

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
let a: ReturnType<typeof serve>;
let b: ReturnType<typeof serve>;

beforeAll(() => {
	const ca = config();
	const cb = config();
	a = serve({ config: ca, port: port(4961), hostname: "127.0.0.1", dataDir: join(ROOT, "data-a"), checkEvents: true, reload: () => ca, warmHorizonMs: 0, extraTools: () => [stuck as never] });
	b = serve({ config: cb, port: port(4962), hostname: "127.0.0.1", dataDir: join(ROOT, "data-b"), checkEvents: true, reload: () => cb, warmHorizonMs: 0, importMaxBytes: SMALL_CAP });
});
afterAll(async () => {
	for (const r of held.splice(0)) r();
	try {
		expect(a.violations()).toBe(0);
		expect(b.violations()).toBe(0);
	} finally {
		await a.stop();
		await b.stop();
		provider.stop(true);
		if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
		else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
		rmSync(ROOT, { recursive: true, force: true });
	}
});

async function call(base: string, method: string, path: string, body?: unknown) {
	const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
	const text = await res.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = text;
	}
	return { status: res.status, json, headers: res.headers, text };
}

async function settle(base: string, id: string) {
	const t0 = Date.now();
	for (;;) {
		const status = (await call(base, "GET", "/session/status")).json;
		if (!status[id] || status[id].type === "idle") return;
		if (Date.now() - t0 > 20_000) throw new Error("the turn did not settle");
		await Bun.sleep(30);
	}
}

async function turn(base: string, id: string, text: string) {
	const r = await call(base, "POST", `/session/${id}/prompt`, { text });
	expect(r.status).toBe(202);
	await Bun.sleep(30);
	await settle(base, id);
}

const counts = (d: ReturnType<typeof serve>) => ({ sessions: d.store.sessionCount(), messages: d.store.messageCount() });
const exported = async (id: string) => {
	const r = await fetch(`${A}/session/${id}/export`);
	return { status: r.status, type: r.headers.get("content-type"), disposition: r.headers.get("content-disposition"), length: r.headers.get("content-length"), text: await r.text() };
};
const importTo = (base: string, bundle: string, q = "") => call(base, "POST", `/session/import${q}`, bundle);

let source = "";
let bundle = "";

test("a real session on daemon a: one turn with a read call, a title, a model and an effort", async () => {
	const s = await call(A, "POST", "/session", { directory: WORK, title: `transfer-${nonce()}`, model: "anthropic/claude-opus-5-5", effort: "high" });
	expect(s.status).toBe(201);
	source = s.json.id;
	await turn(A, source, "[read] what does notes.txt say?");
	await call(A, "PATCH", `/session/${source}`, { title: "the notes thread" });
	const msgs = (await call(A, "GET", `/session/${source}/message`)).json as any[];
	const tool = msgs.flatMap((m) => m.parts).find((p: any) => p.type === "tool");
	expect(tool.tool).toBe("read");
	expect(String(tool.state.output)).toContain("the answer is 42");
});

test("GET /session/:id/export streams the cli's bundle with a content type and a filename", async () => {
	const r = await exported(source);
	expect(r.status).toBe(200);
	expect(r.type).toBe("application/vnd.cmx2.session+json");
	expect(r.disposition).toBe(`attachment; filename="${source}.cmx2.json"`);
	expect(r.length).toBeNull();
	bundle = r.text;
	const e = JSON.parse(bundle);
	// the same file the cli writes, field for field, but for when it was written
	const cli = exportSession(a.store, source, { cmx2: e.cmx2 });
	expect({ ...e, exported_at: 0 }).toEqual({ ...JSON.parse(JSON.stringify(cli)), exported_at: 0 });
	expect(e.origin).toMatchObject({ machine: hostname().split(".")[0], directory: WORK });
	expect(e.transcript).toBe(readFileSync(a.store.session(source)!.session_file!, "utf8"));
	// and the stream joined is the same as exportSession for a session with more than one page of messages too
	let joined = "";
	for await (const c of exportStream(a.store, source)) joined += c;
	expect({ ...JSON.parse(joined), exported_at: 0 }).toEqual({ ...JSON.parse(JSON.stringify(cli)), exported_at: 0, cmx2: undefined });
	expect((await call(A, "GET", "/session/ses_nosuchsession/export")).status).toBe(404);
});

test("import into another daemon's data dir round-trips the transcript exactly and announces the session", async () => {
	const events = await fetch(`${B}/event`, { headers: { "x-cmx2-directory": WORK } });
	const reader = events.body!.getReader();
	const before = counts(b);
	const r = await importTo(B, bundle);
	expect(r.status).toBe(201);
	expect(r.json.id).toBe(source);
	const after = counts(b);
	const want = JSON.parse(bundle).messages.length;
	expect(after).toEqual({ sessions: before.sessions + 1, messages: before.messages + want });
	// the same folder on the same machine: not a move
	expect(r.json.movedFrom).toBeUndefined();
	const ga = (await call(A, "GET", `/session/${source}`)).json;
	expect(r.json.title).toBe("the notes thread");
	expect(r.json.model).toEqual(ga.model);
	expect(r.json.effort).toBe("high");
	expect(r.json.effort).toBe(ga.effort);
	const ma = (await call(A, "GET", `/session/${source}/message`)).json;
	const mb = (await call(B, "GET", `/session/${source}/message`)).json;
	expect(mb).toEqual(ma);
	const tool = mb.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool");
	expect(tool.state.input).toEqual({ path: "notes.txt" });
	const assistant = mb.find((m: any) => m.info.role === "assistant").info;
	expect(`${assistant.providerID}/${assistant.modelID}`).toBe("anthropic/claude-opus-5-5");
	expect(assistant.variant).toBe("high");
	expect(readFileSync(b.store.session(source)!.session_file!, "utf8")).toBe(readFileSync(a.store.session(source)!.session_file!, "utf8"));
	// session.created and session.updated reached a stream that was open before the import
	const dec = new TextDecoder();
	let got = "";
	const t0 = Date.now();
	while (!(got.includes('"session.created"') && got.includes('"session.updated"') && got.includes(source)) && Date.now() - t0 < 5000) {
		const { value, done } = await reader.read();
		if (done) break;
		got += dec.decode(value);
	}
	await reader.cancel();
	expect(got).toContain('"type":"session.created"');
	expect(got).toContain('"type":"session.updated"');
	expect(got).toContain(source);
	// it lists at once
	const list = (await call(B, "GET", "/session")).json as any[];
	expect(list.some((s) => s.id === source)).toBe(true);
});

test("the same bundle again is an id clash: 409 and nothing changes; asNew imports a copy", async () => {
	const before = counts(b);
	const r = await importTo(B, bundle);
	expect(r.status).toBe(409);
	expect(r.json.name).toBe("ConflictError");
	expect(r.json.data.message).toContain("asNew=true");
	expect(counts(b)).toEqual(before);
});

let moved = "";

test("import into another folder: a fresh id with asNew, a new title, movedFrom, a moved notice, and the model reads the move once", async () => {
	const before = counts(b);
	const r = await importTo(B, bundle, `?asNew=true&title=${encodeURIComponent("moved notes")}&directory=${encodeURIComponent(WORK2)}`);
	expect(r.status).toBe(201);
	moved = r.json.id;
	expect(moved).not.toBe(source);
	expect(r.json.title).toBe("moved notes");
	expect(r.json.directory).toBe(WORK2);
	expect(r.json.movedFrom).toMatchObject({ machine: hostname().split(".")[0], directory: WORK });
	expect(typeof r.json.movedFrom.at).toBe("number");
	const want = JSON.parse(bundle).messages.length;
	// the copied messages plus the one moved notice
	expect(counts(b)).toEqual({ sessions: before.sessions + 1, messages: before.messages + want + 1 });
	const msgs = (await call(B, "GET", `/session/${moved}/message`)).json as any[];
	const last = msgs.at(-1);
	expect(last.info.notice).toEqual({ source: "moved" });
	expect(last.info.moved.from.directory).toBe(WORK);
	expect(last.info.moved.to.directory).toBe(WORK2);
	expect(last.parts).toHaveLength(1);
	expect(last.parts[0].synthetic).toBe(true);
	expect(last.parts[0].moved.to.directory).toBe(WORK2);
	expect(last.parts[0].text).toContain(`a path under ${WORK} is under ${WORK2} now`);
	// the copy's messages carry its own ids
	expect(msgs.every((m) => m.info.sessionID === moved && m.info.id.includes(moved.slice(4)))).toBe(true);

	seen.length = 0;
	await turn(B, moved, "carry on");
	const first = JSON.stringify(seen.at(-1).messages);
	const line = "this thread moved from";
	expect(first.split(line).length - 1).toBe(1);
	expect(first).toContain(`runtime-notice source=\\"moved\\"`);
	// the turn context says where it runs now
	expect(first).toContain(`cwd: ${WORK2}`);
	await turn(B, moved, "and again");
	const second = JSON.stringify(seen.at(-1).messages);
	expect(second.split(line).length - 1).toBe(1);
	const answers = ((await call(B, "GET", `/session/${moved}/message`)).json as any[]).filter((m) => m.info.role === "assistant");
	expect(answers.at(-1).parts.some((p: any) => p.type === "text" && p.text === "done")).toBe(true);
});

test("a session running a turn is not exported: 409 BusyError", async () => {
	const s = await call(A, "POST", "/session", { directory: WORK, title: `busy-${nonce()}`, model: "anthropic/claude-opus-5-5" });
	await call(A, "POST", `/session/${s.json.id}/prompt`, { text: "[stuck] hold" });
	const t0 = Date.now();
	while (!held.length && Date.now() - t0 < 10_000) await Bun.sleep(20);
	const r = await call(A, "GET", `/session/${s.json.id}/export`);
	expect(r.status).toBe(409);
	expect(r.json.name).toBe("BusyError");
	for (const h of held.splice(0)) h();
	await settle(A, s.json.id);
	expect((await exported(s.json.id)).status).toBe(200);
}, 20_000);

test("an oversized, corrupt, cut-short or newer bundle is refused with a plain error and writes nothing", async () => {
	const before = counts(b);
	const big = JSON.stringify({ ...JSON.parse(bundle), padding: "x".repeat(SMALL_CAP) });
	const over = await importTo(B, big);
	expect(over.status).toBe(413);
	expect((await importTo(B, "{not json")).json.data.message).toContain("not json");
	expect((await importTo(B, bundle.slice(0, Math.floor(bundle.length / 2)))).status).toBe(400);
	expect((await importTo(B, JSON.stringify({ format: "something else" }))).status).toBe(400);
	const newer = await importTo(B, JSON.stringify({ ...JSON.parse(bundle), version: 99 }));
	expect(newer.status).toBe(400);
	expect(newer.json.data.message).toContain("upgrade");
	const badDir = await importTo(B, bundle, `?asNew=true&directory=${encodeURIComponent(join(ROOT, "nope"))}`);
	expect(badDir.status).toBe(400);
	const gone = JSON.parse(bundle);
	gone.session.directory = join(ROOT, "not-on-this-machine");
	const noDir = await importTo(B, JSON.stringify(gone), "?asNew=true");
	expect(noDir.status).toBe(400);
	expect(noDir.json.data.message).toContain("send directory");
	expect(counts(b)).toEqual(before);
});

/** a request body sent in pieces, with no content-length, released by the test */
function piecewise(text: string) {
	const enc = new TextEncoder().encode(text);
	const half = Math.floor(enc.length / 2);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let step = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			if (step === 0) c.enqueue(enc.slice(0, half));
			else if (step === 1) {
				await gate;
				c.enqueue(enc.slice(half));
			} else c.close();
			step++;
		},
	});
	return { body, release };
}

test("one import at a time: a second while the first is streaming gets 409 BusyError, the first then lands", async () => {
	const before = counts(b);
	const slow = piecewise(bundle);
	const first = fetch(`${B}/session/import?asNew=true`, { method: "POST", headers: { "content-type": "application/json" }, body: slow.body, duplex: "half" } as RequestInit);
	await Bun.sleep(150);
	const second = await importTo(B, bundle, "?asNew=true");
	expect(second.status).toBe(409);
	expect(second.json.name).toBe("BusyError");
	slow.release();
	const r = await first;
	expect(r.status).toBe(201);
	expect(counts(b).sessions).toBe(before.sessions + 1);
	// the temporary body is gone once the import is done
	expect(readdirSync(join(ROOT, "data-b", "import"))).toEqual([]);
});

test("a streamed body past the cap with no content-length is cut off with 413 and writes nothing", async () => {
	const before = counts(b);
	const big = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(bundle), padding: "x".repeat(SMALL_CAP) }));
	let at = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(c) {
			if (at >= big.length) return c.close();
			c.enqueue(big.slice(at, at + 256 * 1024));
			at += 256 * 1024;
		},
	});
	const r = await fetch(`${B}/session/import?asNew=true`, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit).catch((e) => e as Error);
	if (r instanceof Error) throw r;
	expect(r.status).toBe(413);
	expect(counts(b)).toEqual(before);
	expect(readdirSync(join(ROOT, "data-b", "import"))).toEqual([]);
	// the daemon still takes the next import
	expect((await importTo(B, bundle, "?asNew=true")).status).toBe(201);
});

test("a relative directory is refused", async () => {
	const r = await importTo(B, bundle, `?asNew=true&directory=${encodeURIComponent("elsewhere")}`);
	expect(r.status).toBe(400);
	expect(r.json.data.message).toContain("not an absolute path");
});
