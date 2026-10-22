/**
 * btw: side questions about a session. a daemon in this process (port 4846, shifted by CMX2_PORT_SHIFT) whose provider
 * is a scripted stand-in on loopback speaking anthropic's stream, recording every request body. it drives the routes,
 * the dismiss and promote rules, the events (plain, coalesced, compact replay, the resume seam) and a restart, and checks
 * on the recorded bodies that a btw request is the session's own request with one user message after it (same system,
 * tools, options and messages, breakpoints where the session's were) and that no later session request carries it.
 *
 * run: bun test packages/server/test/btw.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { BTW_FRAMING, BTW_NO_TOOLS } from "@cmx2/engine/session";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";
import { BTW_RESTARTED } from "../src/btw.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-btw-"));
const WORK = join(SCRATCH, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4846);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- the scripted provider ----------

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} `);
type Block = { type: "thinking" | "text"; deltas: string[]; gapMs: number } | { type: "tool_use"; input: unknown };
type Req = { body: any; btw: boolean; title: boolean; at: number };
const reqs: Req[] = [];

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const isBtw = (body: any) => (body.messages ?? []).some((m: any) => m.role === "user" && textOf(m).includes(BTW_FRAMING.slice(0, 40)));

function script(body: any): Block[] | "fail" {
	const messages: any[] = body.messages ?? [];
	if (!body.tools?.length) return [{ type: "text", deltas: ["a title"], gapMs: 0 }];
	const last = textOf(messages.findLast((m) => m.role === "user"));
	const answered = last.includes('"tool_result"');
	if (isBtw(body)) {
		const q = textOf(messages.findLast((m) => m.role === "user" && textOf(m).includes(BTW_FRAMING.slice(0, 40))));
		if (q.includes("[fail]")) return "fail";
		if (q.includes("[tool]") && !answered) return [{ type: "tool_use", input: { command: "echo from-a-btw" } }];
		if (q.includes("[tool]")) return [{ type: "text", deltas: words(4, "worded"), gapMs: 5 }];
		if (q.includes("[slow]")) return [{ type: "text", deltas: words(80, "s"), gapMs: 25 }];
		return [
			{ type: "thinking", deltas: words(3, "bt"), gapMs: 5 },
			{ type: "text", deltas: words(6, "btwanswer"), gapMs: 5 },
		];
	}
	if (last.includes("[tool]") && !answered) return [{ type: "tool_use", input: { command: "echo turn" } }];
	const slow = last.includes("[slow]");
	return [
		{ type: "thinking", deltas: words(4, "r"), gapMs: 5 },
		{ type: "text", deltas: words(slow ? 60 : 8, "a"), gapMs: slow ? 30 : 5 },
	];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		reqs.push({ body, btw: isBtw(body), title: !body.tools?.length, at: Date.now() });
		const blocks = script(body);
		if (blocks === "fail") return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Scripted refusal for this btw" } }, { status: 400 });
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const put = (s: string) => {
					try {
						c.enqueue(new TextEncoder().encode(s));
					} catch {}
				};
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "tool_use") {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: "shell", input: {} } }));
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
					} else {
						put(sse("content_block_start", { index, content_block: b.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } }));
						for (const t of b.deltas) {
							put(sse("content_block_delta", { index, delta: b.type === "thinking" ? { type: "thinking_delta", thinking: t } : { type: "text_delta", text: t } }));
							await Bun.sleep(b.gapMs);
						}
						if (b.type === "thinking") put(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }));
					}
					put(sse("content_block_stop", { index }));
				}
				put(sse("message_delta", { delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				try {
					c.close();
				} catch {}
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
const DATA = join(SCRATCH, "data");
let d: ReturnType<typeof serve>;
const start = () => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: DATA, checkEvents: true, reload: () => c });
};
let violations = 0;
beforeAll(start);
afterAll(async () => {
	violations += d.violations();
	await d.stop();
	provider.stop(true);
	rmSync(SCRATCH, { recursive: true, force: true });
	expect(violations).toBe(0);
});

// ---------- helpers ----------

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined, seq: res.headers.get("x-cmx2-seq") };
};
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);

/** an event stream, its frames parsed as they come */
class Tap {
	frames: Array<{ id?: string; p: any }> = [];
	private ctl = new AbortController();
	ready: Promise<void>;
	constructor(path: string) {
		let ok!: () => void;
		this.ready = new Promise((r) => (ok = r));
		void (async () => {
			try {
				const res = await fetch(BASE + path, { signal: this.ctl.signal, headers: { "accept-encoding": "identity" } });
				const reader = res.body!.getReader();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += new TextDecoder().decode(value);
					let at: number;
					while ((at = buf.indexOf("\n\n")) >= 0) {
						const raw = buf.slice(0, at);
						buf = buf.slice(at + 2);
						const id = raw.split("\n").find((l) => l.startsWith("id: "))?.slice(4);
						const data = raw.split("\n").find((l) => l.startsWith("data: "));
						if (!data) continue;
						const j = JSON.parse(data.slice(6));
						const p = j.payload ?? j;
						if (p.type === "server.connected") ok();
						if (p.type !== "server.heartbeat") this.frames.push({ ...(id ? { id } : {}), p });
					}
				}
			} catch {}
		})();
	}
	of(type: string, pred: (props: any) => boolean = () => true) {
		return this.frames.filter((f) => f.p.type === type && pred(f.p.properties)).map((f) => f.p.properties);
	}
	close() {
		this.ctl.abort();
	}
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
	const t0 = Date.now();
	while (!(await pred())) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(15);
	}
}

const info = async (sid: string) => (await get(`/session/${sid}`)).json;
const messages = async (sid: string) => (await get(`/session/${sid}/message`)).json as any[];
async function idle(sid: string) {
	await until(async () => {
		const i = await info(sid);
		if (i.status?.type === "busy") return false;
		const m = await messages(sid);
		const last = m.at(-1)?.info;
		return last?.role === "assistant" && !!last.time?.completed;
	}, `${sid} idle`);
}
async function finished(sid: string, id: string) {
	let b: any;
	await until(async () => {
		b = ((await get(`/session/${sid}/btw`)).json as any[]).find((x) => x.id === id);
		return b && b.status !== "running";
	}, `btw ${id}`);
	return b;
}
const newSession = async () => (await post("/session", { directory: WORK, title: `it-btw-${nonce()}` })).json.id as string;

/** a body without its cache breakpoints */
const strip = (v: any): any => JSON.parse(JSON.stringify(v), (k, x) => (k === "cache_control" ? undefined : x));
/** where a body's breakpoints sit: system blocks, tools, message blocks */
function marks(body: any): string[] {
	const out: string[] = [];
	(Array.isArray(body.system) ? body.system : []).forEach((b: any, i: number) => b?.cache_control && out.push(`system:${i}`));
	(body.tools ?? []).forEach((t: any, i: number) => t?.cache_control && out.push(`tool:${i}`));
	(body.messages ?? []).forEach((m: any, i: number) => Array.isArray(m.content) && m.content.forEach((b: any, j: number) => b?.cache_control && out.push(`msg:${i}:${j}:${JSON.stringify(b.cache_control)}`)));
	return out;
}
const rest = (body: any) => {
	const { messages: _m, ...r } = body;
	return r;
};

// ---------- the tests ----------

describe("btw", () => {
	let tap: Tap;
	let coalesced: Tap;
	beforeAll(async () => {
		tap = new Tap("/global/event");
		coalesced = new Tap("/global/event?coalesce=100");
		await Promise.all([tap.ready, coalesced.ready]);
	});
	afterAll(() => {
		tap.close();
		coalesced.close();
	});

	let sid = "";
	let first: any;

	test("an idle session: the btw runs at once, streams, finishes, and leaves the session's transcript, status and context alone", async () => {
		sid = await newSession();
		expect((await post(`/session/${sid}/prompt`, { text: "hello there" })).status).toBe(202);
		await idle(sid);
		const before = { info: await info(sid), messages: await messages(sid) };
		const turnReq = reqs.findLast((r) => !r.btw && !r.title)!;
		const statusBefore = tap.of("session.status", (p) => p.sessionID === sid).length;
		const cursor = (await get(`/session/${sid}/btw`)).seq!;

		const asked = await post(`/session/${sid}/btw`, { text: "what did you say?" });
		expect(asked.status).toBe(200);
		first = asked.json;
		expect(first).toMatchObject({ sessionID: sid, text: "what did you say?", answer: "", status: "running", afterMessageID: before.messages.at(-1).info.id });
		expect(first.id).toMatch(/^btw_/);
		expect(first.time.created).toBeGreaterThan(0);
		const done = await finished(sid, first.id);
		expect(done.status).toBe("done");
		expect(done.answer).toBe(words(6, "btwanswer").join(""));
		expect(done.time.completed).toBeGreaterThanOrEqual(done.time.created);
		expect(done.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5" });
		expect(done.tokens).toEqual({ input: 20, output: 10, cache: { read: 1000, write: 5 } });
		expect(typeof done.cost).toBe("number");

		// events: running, deltas that add up to the answer, done
		await until(() => tap.of("btw.updated", (p) => p.btw.id === first.id && p.btw.status === "done").length === 1, "btw.updated done");
		const ups = tap.of("btw.updated", (p) => p.btw.id === first.id);
		expect(ups.map((u) => u.btw.status)).toEqual(["running", "done"]);
		expect(ups[1].btw).toEqual(done);
		const deltas = tap.of("btw.delta", (p) => p.btwID === first.id);
		expect(deltas.length).toBe(6);
		expect(deltas.map((x) => x.delta).join("")).toBe(done.answer);
		expect(deltas.every((x) => x.sessionID === sid)).toBe(true);
		// deltas are not logged: no id line
		expect(tap.frames.filter((f) => f.p.type === "btw.delta").every((f) => !f.id)).toBe(true);
		expect(tap.frames.filter((f) => f.p.type === "btw.updated").every((f) => !!f.id)).toBe(true);
		// a coalescing stream gets the same text in fewer frames
		await until(() => coalesced.of("btw.updated", (p) => p.btw.id === first.id && p.btw.status === "done").length === 1, "coalesced done");
		const merged = coalesced.of("btw.delta", (p) => p.btwID === first.id);
		expect(merged.map((x) => x.delta).join("")).toBe(done.answer);
		expect(merged.length).toBeLessThan(deltas.length);

		// the session: no status change, no new message, the same revision and context fill; the totals moved by the btw's spend
		const after = { info: await info(sid), messages: await messages(sid) };
		expect(tap.of("session.status", (p) => p.sessionID === sid).length).toBe(statusBefore);
		expect(after.messages.map((m) => m.info.id)).toEqual(before.messages.map((m) => m.info.id));
		expect(after.info.transcriptRev).toBe(before.info.transcriptRev);
		expect(after.info.context).toEqual(before.info.context);
		expect(after.info.tokens.input).toBe(before.info.tokens.input + 20);
		expect(after.info.tokens.output).toBe(before.info.tokens.output + 10);
		expect(after.info.tokens.cache.read).toBe(before.info.tokens.cache.read + 1000);
		expect(after.info.tokens.cache.write).toBe(before.info.tokens.cache.write + 5);
		expect(after.info.cost).toBeCloseTo(before.info.cost + done.cost, 9);
		expect(JSON.stringify(after.messages)).not.toContain("what did you say?");

		// the request: the session's own, one user message after it, breakpoints where the session had them
		const btwReq = reqs.findLast((r) => r.btw)!;
		expect(rest(btwReq.body)).toEqual(rest(turnReq.body));
		const n = turnReq.body.messages.length;
		// the session's next request would carry the turn's messages and the reply; the btw carries exactly those, then the question
		expect(strip(btwReq.body.messages.slice(0, n))).toEqual(strip(turnReq.body.messages));
		// then the reply, the question, and the effort marker every request ends with (as the turn's did)
		expect(btwReq.body.messages.length).toBe(n + 3);
		expect(btwReq.body.messages[n].role).toBe("assistant");
		const q = btwReq.body.messages[n + 1];
		expect(q.role).toBe("user");
		expect(q.content).toEqual([{ type: "text", text: `${BTW_FRAMING}\n\nwhat did you say?` }]);
		expect(btwReq.body.messages[n + 2]).toEqual(turnReq.body.messages[n - 1]);
		// every breakpoint the turn's request had is there; the one pi puts on the last message sits on the reply instead of the question
		const tm = marks(turnReq.body);
		const bm = marks(btwReq.body);
		for (const m of tm) expect(bm).toContain(m);
		const extra = bm.filter((m) => !tm.includes(m));
		expect(extra.length).toBe(1);
		expect(extra[0]!.startsWith(`msg:${n}:`)).toBe(true);
		expect(bm.some((m) => m.startsWith(`msg:${n + 1}:`))).toBe(false);

		// a compact replay from before the btw keeps its first and last state
		expect((await post(`/session/${sid}/btw/${first.id}/dismiss`)).status).toBe(200);
		const replay = new Tap(`/global/event?after=${cursor}&compact=1`);
		await replay.ready;
		await until(() => replay.of("btw.updated", (p) => p.btw.id === first.id && !!p.btw.time.dismissed).length === 1, "compact replay");
		expect(replay.of("btw.updated", (p) => p.btw.id === first.id).map((u) => [u.btw.status, !!u.btw.time.dismissed])).toEqual([
			["running", false],
			["done", true],
		]);
		replay.close();
	}, 30_000);

	test("the session's next request does not carry the btw", async () => {
		const n0 = reqs.length;
		await post(`/session/${sid}/prompt`, { text: "go on" });
		await idle(sid);
		const next = reqs.slice(n0).filter((r) => !r.btw && !r.title);
		expect(next.length).toBeGreaterThan(0);
		for (const r of next) {
			const s = JSON.stringify(r.body);
			expect(s).not.toContain("what did you say?");
			expect(s).not.toContain("btwanswer");
			expect(s).not.toContain(BTW_FRAMING.slice(0, 40));
		}
	}, 30_000);

	test("mid-turn: the btw carries the request already sent, with its breakpoints, and the turn goes on untouched", async () => {
		const n0 = reqs.length;
		await post(`/session/${sid}/prompt`, { text: "[slow] tell me a long story" });
		await until(() => reqs.slice(n0).some((r) => !r.btw && !r.title), "the turn's request");
		const inflight = reqs.slice(n0).find((r) => !r.btw && !r.title)!;
		expect((await info(sid)).status?.type).toBe("busy");
		const statusBefore = tap.of("session.status", (p) => p.sessionID === sid).length;
		const asked = await post(`/session/${sid}/btw`, { text: "while you write: which file?" });
		expect(asked.status).toBe(200);
		const done = await finished(sid, asked.json.id);
		expect(done.status).toBe("done");
		// still the same turn: the btw finished while the turn streamed
		expect((await info(sid)).status?.type).toBe("busy");
		expect(tap.of("session.status", (p) => p.sessionID === sid).length).toBe(statusBefore);
		const btwReq = reqs.findLast((r) => r.btw)!;
		expect(rest(btwReq.body)).toEqual(rest(inflight.body));
		// the request on the wire ends with its effort marker; the question goes before that marker
		const sent = strip(inflight.body.messages);
		expect(strip(btwReq.body.messages)).toEqual([...sent.slice(0, -1), { role: "user", content: [{ type: "text", text: `${BTW_FRAMING}\n\nwhile you write: which file?` }] }, sent.at(-1)]);
		expect(marks(btwReq.body)).toEqual(marks(inflight.body));
		await idle(sid);
		for (const r of reqs.slice(n0).filter((x) => !x.btw && !x.title)) expect(JSON.stringify(r.body)).not.toContain("which file?");
	}, 30_000);

	test("a tool call is not run: it gets an error result, one more step answers in words", async () => {
		const before = await messages(sid);
		const asked = await post(`/session/${sid}/btw`, { text: "[tool] check it" });
		const done = await finished(sid, asked.json.id);
		expect(done.status).toBe("done");
		expect(done.answer).toBe(words(4, "worded").join(""));
		const steps = reqs.filter((r) => r.btw && JSON.stringify(r.body).includes("[tool] check it"));
		expect(steps.length).toBe(2);
		const result = steps[1]!.body.messages.findLast((m: any) => m.role === "user");
		expect(result.role).toBe("user");
		expect(result.content[0]).toMatchObject({ type: "tool_result", is_error: true });
		expect(JSON.stringify(result.content[0].content)).toContain(BTW_NO_TOOLS);
		const qAt = steps[1]!.body.messages.findIndex((m: any) => textOf(m).includes("[tool] check it"));
		expect(marks(steps[1]!.body).filter((m) => m.startsWith("msg:") && Number(m.split(":")[1]) >= qAt)).toEqual([]);
		// two steps' spend
		expect(done.tokens.input).toBe(40);
		expect((await messages(sid)).length).toBe(before.length);
	}, 30_000);

	test("a provider error ends the btw as an error with a short lowercase message", async () => {
		const asked = await post(`/session/${sid}/btw`, { text: "[fail] this one" });
		const done = await finished(sid, asked.json.id);
		expect(done.status).toBe("error");
		expect(done.error).toBeTruthy();
		expect(done.error).toBe(done.error.toLowerCase());
		expect(done.error.length).toBeLessThanOrEqual(300);
	}, 30_000);

	test("dismiss: a flag, a second call is a no-op; a running btw stops; the resume seam sends a running btw whole", async () => {
		const ups = () => tap.of("btw.updated", (p) => p.btw.id === first.id).length;
		const n = ups();
		const again = await post(`/session/${sid}/btw/${first.id}/dismiss`);
		expect(again.status).toBe(200);
		expect(again.json.time.dismissed).toBeGreaterThan(0);
		await Bun.sleep(100);
		expect(ups()).toBe(n);
		// still listed, flagged
		const listed = ((await get(`/session/${sid}/btw`)).json as any[]).find((b) => b.id === first.id);
		expect(listed.time.dismissed).toBe(again.json.time.dismissed);

		const asked = await post(`/session/${sid}/btw`, { text: "[slow] a long one" });
		const cursor = (await get(`/session/${sid}/btw`)).seq!;
		await until(() => tap.of("btw.delta", (p) => p.btwID === asked.json.id).length >= 5, "some deltas");
		// a stream that resumes now gets the running btw with its answer so far, then the deltas
		const resumed = new Tap(`/global/event?after=${cursor}`);
		await until(() => resumed.of("btw.updated", (p) => p.btw.id === asked.json.id && p.btw.answer.length > 0).length > 0, "the seam's btw");
		const seam = resumed.of("btw.updated", (p) => p.btw.id === asked.json.id && p.btw.answer.length > 0)[0];
		expect(seam.btw.status).toBe("running");
		expect(seam.btw.answer.startsWith("s0 s1 ")).toBe(true);
		resumed.close();
		const dismissed = await post(`/session/${sid}/btw/${asked.json.id}/dismiss`);
		expect(dismissed.status).toBe(200);
		const done = await finished(sid, asked.json.id);
		expect(done.status).toBe("error");
		expect(done.error).toBe("dismissed before it answered");
		expect(done.time.dismissed).toBeGreaterThan(0);
		expect(done.answer.length).toBeLessThan(words(80, "s").join("").length);
	}, 30_000);

	test("routes refuse what they should: empty text, an unknown btw or session; a client id acts once", async () => {
		expect((await post(`/session/${sid}/btw`, { text: "" })).status).toBe(400);
		expect((await post(`/session/${sid}/btw`, {})).status).toBe(400);
		expect((await post(`/session/${sid}/btw/btw_nope/dismiss`)).status).toBe(404);
		expect((await post(`/session/${sid}/btw/btw_nope/promote`)).status).toBe(404);
		expect((await post("/session/ses_nope/btw", { text: "x" })).status).toBe(404);
		expect((await get("/session/ses_nope/btw")).status).toBe(404);
		const other = await newSession();
		expect((await post(`/session/${other}/btw/${first.id}/dismiss`)).status).toBe(404);
		const clientID = `c-${nonce()}`;
		const a = await post(`/session/${sid}/btw`, { text: "once please", clientID });
		const b = await post(`/session/${sid}/btw`, { text: "once please", clientID });
		expect(b.json.id).toBe(a.json.id);
		await finished(sid, a.json.id);
		expect(((await get(`/session/${sid}/btw`)).json as any[]).filter((x) => x.text === "once please").length).toBe(1);
		// oldest first
		const list = (await get(`/session/${sid}/btw`)).json as any[];
		expect(list.map((x) => x.time.created)).toEqual([...list.map((x) => x.time.created)].sort((x, y) => x - y));
	}, 30_000);

	test("promote: only a done btw, once; idle it is a prompt, the message marked with the btw's id", async () => {
		const failed = ((await get(`/session/${sid}/btw`)).json as any[]).find((b) => b.status === "error");
		expect((await post(`/session/${sid}/btw/${failed.id}/promote`)).status).toBe(409);
		const running = await post(`/session/${sid}/btw`, { text: "[slow] not yet" });
		expect((await post(`/session/${sid}/btw/${running.json.id}/promote`)).status).toBe(409);
		await post(`/session/${sid}/btw/${running.json.id}/dismiss`);
		await finished(sid, running.json.id);

		const asked = await post(`/session/${sid}/btw`, { text: "promote me" });
		const done = await finished(sid, asked.json.id);
		expect((await info(sid)).status?.type).not.toBe("busy");
		const p = await post(`/session/${sid}/btw/${asked.json.id}/promote`);
		expect(p.status).toBe(200);
		expect(p.json.messageID).toMatch(/^msg_/);
		await idle(sid);
		const m = (await messages(sid)).find((x) => x.info.btw === asked.json.id);
		expect(m.info.id).toBe(p.json.messageID);
		expect(m.info.role).toBe("user");
		const text = m.parts.map((x: any) => x.text).join("\n");
		expect(text).toContain("promote me");
		expect(text).toContain(done.answer);
		expect(text).toContain("btw");
		const after = ((await get(`/session/${sid}/btw`)).json as any[]).find((b) => b.id === asked.json.id);
		expect(after.promotedMessageID).toBe(p.json.messageID);
		expect(tap.of("btw.updated", (x) => x.btw.id === asked.json.id && x.btw.promotedMessageID === p.json.messageID).length).toBeGreaterThan(0);
		expect((await post(`/session/${sid}/btw/${asked.json.id}/promote`)).status).toBe(409);
		// the model reads it from here on
		const last = reqs.findLast((r) => !r.btw && !r.title)!;
		expect(JSON.stringify(last.body)).toContain("promote me");
	}, 30_000);

	test("promote mid-turn is a steer; the btw then names the message it landed as", async () => {
		const asked = await post(`/session/${sid}/btw`, { text: "steer me in" });
		await finished(sid, asked.json.id);
		await post(`/session/${sid}/prompt`, { text: "[tool] run something" });
		await until(async () => (await info(sid)).status?.type === "busy", "busy");
		const p = await post(`/session/${sid}/btw/${asked.json.id}/promote`);
		expect(p.status).toBe(200);
		await idle(sid);
		const m = (await messages(sid)).find((x) => x.info.btw === asked.json.id);
		expect(m).toBeTruthy();
		await until(async () => ((await get(`/session/${sid}/btw`)).json as any[]).find((b) => b.id === asked.json.id).promotedMessageID === m.info.id, "the landed id");
	}, 30_000);

	test("a btw left running by a stopped daemon is an error after the restart", async () => {
		d.store.putBtw({ id: "btw_leftover", session_id: sid, text: "cut off", after_message_id: null, created_at: Date.now(), model: null });
		violations += d.violations();
		await d.stop();
		start();
		const b = ((await get(`/session/${sid}/btw`)).json as any[]).find((x) => x.id === "btw_leftover");
		expect(b.status).toBe("error");
		expect(b.error).toBe(BTW_RESTARTED);
		expect(b.time.completed).toBeGreaterThan(0);
	}, 30_000);
});
