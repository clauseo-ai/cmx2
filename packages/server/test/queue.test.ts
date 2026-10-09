/**
 * contract version 6: the queue. a prompt sent during a busy turn keeps its model,
 * effort and agent and applies them when it runs (a18); the waiting prompts can be read back, and an idle
 * session says what an abort left (a19); a steer says it is one (a20); loop says what it ran (a21). a daemon
 * in this process (port 4840, shifted by CMX2_PORT_SHIFT) whose provider is a scripted stand-in on loopback
 * speaking anthropic's stream and recording each request's model and effort, so the whole path runs (pi's
 * adapter, the engine's queues, the projection, the listener) without a model.
 *
 * run: bun test packages/server/test/queue.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-queue-"));
const ROOT = join(SCRATCH, `queue-${nonce()}`);
const WORK = join(ROOT, "work");
const CONFIG = join(ROOT, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
// sonnet never runs at max here, so a queued prompt that asks for it is refused at send time
writeFileSync(join(CONFIG, "routing.jsonc"), JSON.stringify({ never: { "anthropic/claude-sonnet-5-5": ["max"] } }));
// restored after the file: in one `bun test packages` process the tests after this one read the user's profile again
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
// an agent that runs on sonnet: a queued prompt sent for it keeps the model the agent names
mkdirSync(join(WORK, ".cmx2", "agent"), { recursive: true });
writeFileSync(join(WORK, ".cmx2", "agent", "pal.md"), "---\ndescription: a pal on sonnet\nmodel: anthropic/claude-sonnet-5-5\n---\nyou are a pal\n");
const PORT = port(4840);
const BASE = `http://127.0.0.1:${PORT}`;
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";

// ---------- the scripted provider ----------

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** every request the daemon's model calls made, in order: what the session asked for each */
const requests: Array<{ model: string; effort: string; first: string; last: string; ttls: string[]; convo: string }> = [];

/** the ttl of every cache breakpoint in a request, in the order the api reads them (tools, system, messages): "5m" for a bare marker */
function ttlsOf(body: any): string[] {
	const out: string[] = [];
	const mark = (b: any) => {
		if (b?.cache_control) out.push(b.cache_control.ttl ?? "5m");
	};
	for (const t of body.tools ?? []) mark(t);
	for (const b of body.system ?? []) mark(b);
	for (const m of body.messages ?? []) if (Array.isArray(m.content)) for (const b of m.content) mark(b);
	return out;
}

/**
 * the [wait] and [thrice] prompts the model has already asked its tool for: its first request on a [wait] one holds the turn
 * open (a tool call after a pause), on a [thrice] one asks for the same call three times (the engine's signal to escalate
 * the effort); the rest answer at once
 */
const held = new Set<string>();
type Block = { type: "text"; text: string } | { type: "tool_use"; gapMs: number; name?: string; input?: unknown };
type Call = { name: string; input: unknown };
const shell = (command: string): Call => ({ name: "shell", input: { command } });
/**
 * tagged prompts that walk a script, one model step per entry (the step is how many assistant messages came after the
 * tag): the tool calls that step asks for, none meaning the closing text. a check is a command the engine reads as one
 * (`# test`); the edit before it is a redirection it reads as a write
 */
const PLANS: Record<string, Call[][]> = {
	// one failing check after an edit: the normal red half of red-green
	checkonce: [[shell("echo edit > check-edit.txt")], [shell("false # test once")], []],
	// the same check failing twice in one turn, with the same words each time: the repeated-error signal leaves checks to their own rule
	checktwice: [[shell("echo edit > check-edit.txt")], [shell("false # test twice")], [shell("false # test twice")], []],
	// the same check red, green, red: a pass of it starts the count over
	checkreset: [[shell("echo edit > check-edit.txt")], [shell("[ -e check-flag ] # test reset")], [shell("touch check-flag")], [shell("[ -e check-flag ] # test reset")], [shell("rm check-flag")], [shell("[ -e check-flag ] # test reset")], []],
	// a spawn in the middle of a turn, then the turn goes on
	spawnmid: [[{ name: "spawn", input: { brief: "mid turn kid", name: "mid_kid", model: "sonnet" } }], []],
	// a job that will notify the session when it exits
	bgjob: [[{ name: "shell", input: { command: "sleep 30", background: true, notify: { on_exit: true } } }], []],
	// a parent waiting on its helpers asks for the same wait again and again
	waits: [[{ name: "wait", input: { timeout_ms: 1000 } }], [{ name: "wait", input: { timeout_ms: 1000 } }], [{ name: "wait", input: { timeout_ms: 1000 } }], []],
};
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	// the newest tag in the conversation
	const planned = (JSON.stringify(messages).match(/\[(checkonce|checktwice|checkreset|waits|bgjob|spawnmid)\] [\w-]+/g) ?? []).at(-1);
	if (planned) {
		const at = messages.map((m) => JSON.stringify(m)).findLastIndex((t) => t.includes(planned));
		const step = messages.slice(at + 1).filter((m) => m.role === "assistant").length;
		const calls = PLANS[planned.slice(1, planned.indexOf("]"))]![step] ?? [];
		return calls.length ? calls.map((c) => ({ type: "tool_use" as const, gapMs: 5, ...c })) : [{ type: "text", text: "ok" }];
	}
	const tag = (JSON.stringify(messages).match(/\[(?:wait|thrice)\] [\w-]+/g) ?? []).at(-1);
	if (tag && !held.has(tag)) {
		held.add(tag);
		return tag.startsWith("[thrice]") ? [{ type: "tool_use", gapMs: 10 }, { type: "tool_use", gapMs: 10 }, { type: "tool_use", gapMs: 10 }] : [{ type: "tool_use", gapMs: 1200 }];
	}
	return [{ type: "text", text: "ok" }];
}

const textOfLast = (body: any): string => {
	const users = (body.messages ?? []).filter((m: any) => m.role === "user");
	const c = users.at(-1)?.content;
	return typeof c === "string" ? c : JSON.stringify(c);
};

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		if (body.tools?.length) {
			const users = (body.messages ?? []).filter((m: any) => m.role === "user");
			requests.push({
				model: body.model,
				// the effort the request runs at: the newest per-message marker (anthropic's output_config on a system message), else the request's own
				effort: String([...(body.messages ?? [])].reverse().find((m: any) => m.role === "system" && m.output_config?.effort)?.output_config.effort ?? body.output_config?.effort),
				first: JSON.stringify(users[0]?.content ?? ""),
				last: textOfLast(body),
				ttls: ttlsOf(body),
				convo: JSON.stringify(body.messages ?? []),
			});
		}
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const enc = new TextEncoder();
				const put = (s: string) => c.enqueue(enc.encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: JSON.stringify(body.messages ?? []).includes("[big]") ? 150_000 : 20, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "tool_use") {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: b.name ?? "shell", input: {} } }));
						await Bun.sleep(b.gapMs);
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? { command: "echo queue" }) } }));
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
	try {
		// every event the daemon published in this file matched its schema in the manifest
		expect(d.violations()).toBe(0);
	} finally {
		// whatever that check says, the next file gets its own config directory back
		if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
		else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
		await d.stop();
		provider.stop(true);
	}
});

// ---------- helpers ----------

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined, seq: res.headers.get("x-cmx2-seq") };
};
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);

class Tap {
	frames: Array<{ p: any }> = [];
	private ctl = new AbortController();
	constructor() {
		void (async () => {
			try {
				const res = await fetch(`${BASE}/global/event`, { signal: this.ctl.signal });
				const reader = res.body!.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const block = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = block.split("\n").find((l) => l.startsWith("data: "));
						if (!data) continue;
						const j = JSON.parse(data.slice(6));
						this.frames.push({ p: j.payload ?? j });
					}
				}
			} catch {}
		})();
	}
	of(sessionID: string) {
		return this.frames.filter((f) => f.p.properties?.sessionID === sessionID || f.p.properties?.info?.sessionID === sessionID);
	}
	async until(pred: () => boolean, what: string, ms = 20_000) {
		const t0 = Date.now();
		while (!pred()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}
	close() {
		this.ctl.abort();
	}
}

let tap: Tap;
beforeAll(async () => {
	tap = new Tap();
	await tap.until(() => tap.frames.length > 0, "the stream");
});
afterAll(() => tap.close());

const newSession = async (tag: string, model?: string) => (await post("/session", { directory: WORK, title: `it-queue-${tag}-${nonce()}`, ...(model ? { model } : {}) })).json.id as string;
const idleOf = (id: string, n = 1) => tap.until(() => tap.of(id).filter((f) => f.p.type === "session.idle").length >= n, "the turn to settle");
const busyOf = (id: string) => tap.until(() => tap.of(id).some((f) => f.p.type === "session.status" && f.p.properties.status.type === "busy"), "the turn to start");
const textOf = (m: any) => (m.parts as any[]).filter((p) => p.type === "text").map((p) => p.text).join("");
const userMessages = async (id: string) => ((await get(`/session/${id}/message`)).json as any[]).filter((m) => m.info.role === "user");
const since = (mark: number) => requests.slice(mark);

/**
 * a helper (a child of a fresh root, over the same REST verb the model uses) on opus at an effort, parked after its first
 * turn. escalation is for helpers: the main session's effort is the user's dial
 */
async function child(tag: string, effort: string, brief = `${tag} start`) {
	const root = await newSession(`${tag}-root`);
	const spawned = await post(`/session/${root}/agents`, { brief, name: `kid_${tag.replace(/\W/g, "_")}`, model: OPUS, effort });
	expect(spawned.status).toBe(201);
	const id = spawned.json.agents[0].id as string;
	await idleOf(id);
	return id;
}

/** a helper whose first turn the model holds open for a second */
const busyChild = async (tag: string, effort: string) => {
	const root = await newSession(`${tag}-root`);
	const spawned = await post(`/session/${root}/agents`, { brief: `[wait] ${tag}`, name: `kid_${tag.replace(/\W/g, "_")}`, model: OPUS, effort });
	expect(spawned.status).toBe(201);
	const id = spawned.json.agents[0].id as string;
	await busyOf(id);
	return id;
};

/** a turn the model holds open for a second (it asks for a tool, answered after a pause), so the session is busy while the test sends */
async function busySession(tag: string) {
	const id = await newSession(tag);
	const r = await post(`/session/${id}/prompt_async`, { text: `[wait] ${tag}` });
	expect(r.status).toBe(202);
	await busyOf(id);
	// the busy frame can reach the tap before the provider has the turn's first request (an event stream answered
	// by the listener's front has no hop to cross), and the tests mark requests from here
	await tap.until(() => requests.some((q) => q.last.includes(`"[wait] ${tag}"`)), "the busy turn's first request");
	return id;
}

// ---------- a20: a steer says it is a steer ----------

describe("a20: a steer says it is a steer", () => {
	test("the provisional and the landed message carry steer: true, a queued prompt neither, and session.steered names the message", async () => {
		const id = await busySession("a20");
		const st = await post(`/session/${id}/steer`, { text: "steer me", clientID: `c-steer-${nonce()}` });
		const q = await post(`/session/${id}/queue`, { text: "queue me", clientID: `c-queue-${nonce()}` });
		expect(st.json.result).toBe("steered");
		expect(q.json.result).toBe("queued");
		await idleOf(id);

		const frames = tap.of(id);
		const prov = (mid: string) => frames.find((f) => f.p.type === "message.updated" && f.p.properties.info.id === mid && f.p.properties.info.queued)!.p.properties.info;
		expect(prov(st.json.messageID).steer).toBe(true);
		expect(prov(q.json.messageID).steer).toBeUndefined();
		// session.steered and session.queued name the provisional message
		expect(frames.find((f) => f.p.type === "session.steered")!.p.properties.messageID).toBe(st.json.messageID);
		expect(frames.find((f) => f.p.type === "session.queued")!.p.properties.messageID).toBe(q.json.messageID);

		// landed: the steer reads as a steer, the queued prompt does not
		const users = await userMessages(id);
		const steered = users.find((m) => textOf(m) === "steer me")!;
		const queued = users.find((m) => textOf(m) === "queue me")!;
		expect(steered.info.steer).toBe(true);
		expect(queued.info.steer).toBeUndefined();
		// and the steer landed before the queued prompt: it was read at a tool boundary, the queued one after the turn
		expect(users.indexOf(steered)).toBeLessThan(users.indexOf(queued));
	}, 30_000);
});

// ---------- a21: loop says what it ran ----------

describe("a21: loop says what it ran", () => {
	test("{ran: 0} when nothing waits, 409 while a turn runs", async () => {
		const idle = await newSession("a21-idle");
		await post(`/session/${idle}/prompt_async`, { text: "hello" });
		await idleOf(idle);
		const none = await post(`/session/${idle}/loop`);
		expect(none.status).toBe(200);
		expect(none.json).toEqual({ ran: 0 });

		const busy = await busySession("a21-busy");
		const res = await post(`/session/${busy}/loop`);
		expect(res.status).toBe(409);
		expect(res.json.name).toBe("BusyError");
		await idleOf(busy);
	}, 30_000);

	test("{ran: n} after an abort left n waiting, and they run", async () => {
		const id = await busySession("a21-abort");
		await post(`/session/${id}/queue`, { text: "left one" });
		await post(`/session/${id}/queue`, { text: "left two" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		const res = await post(`/session/${id}/loop`);
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ ran: 2 });
		await idleOf(id, 2);
		const users = (await userMessages(id)).map(textOf);
		expect(users.some((t) => t === "left one")).toBe(true);
		expect(users.some((t) => t === "left two")).toBe(true);
		expect(since(mark).length).toBeGreaterThan(0);
		// nothing waits now
		expect(await post(`/session/${id}/loop`)).toMatchObject({ status: 200, json: { ran: 0 } });
	}, 30_000);
});

// ---------- a19: the queue can be read back ----------

describe("a19: the queue can be read back", () => {
	test("GET /queue lists what waits, in order, with its seq; unsend takes one out; the idle status counts what an abort left", async () => {
		const id = await busySession("a19");
		const a = await post(`/session/${id}/queue`, { text: "first waits", clientID: `c-a-${nonce()}` });
		const b = await post(`/session/${id}/steer`, { text: "second steers", clientID: `c-b-${nonce()}` });
		const c = await post(`/session/${id}/queue`, { text: "third waits" });

		const read = await get(`/session/${id}/queue`);
		expect(read.status).toBe(200);
		expect(read.seq).toMatch(/^[^:]+:\d+$/);
		const items = read.json as any[];
		expect(items.map((m) => m.info.id)).toEqual([a.json.messageID, b.json.messageID, c.json.messageID]);
		expect(items.map(textOf)).toEqual(["first waits", "second steers", "third waits"]);
		expect(items.every((m) => m.info.queued === true && m.info.role === "user")).toBe(true);
		expect(items[0].info.clientID).toMatch(/^c-a-/);
		expect(items.map((m) => m.info.steer === true)).toEqual([false, true, false]);
		// the same shape the stream announced: a client holding this read and the events after its seq draws the same queue
		const announced = tap.of(id).find((f) => f.p.type === "message.updated" && f.p.properties.info.id === a.json.messageID)!.p.properties.info;
		expect(items[0].info).toEqual(announced);

		// the busy status counts them; the session read carries the same
		expect((await get(`/session/${id}`)).json.status).toMatchObject({ type: "busy", queued: 3 });

		// unsend the third: it leaves the read
		expect((await call("DELETE", `/session/${id}/message/${c.json.messageID}`)).json).toBe(true);
		expect(((await get(`/session/${id}/queue`)).json as any[]).map((m) => m.info.id)).toEqual([a.json.messageID, b.json.messageID]);

		// abort: the turn stops, the prompts stay, and an idle session says so
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const info = (await get(`/session/${id}`)).json;
		expect(info.status.type).toBe("idle");
		expect(info.status.queued).toBeGreaterThan(0);
		const left = (await get(`/session/${id}/queue`)).json as any[];
		expect(left.length).toBe(info.status.queued);
		expect(left.map(textOf)).toContain("first waits");
		// the status map lists an idle session with a queue when idle entries are asked for (boxbox v1 reads any entry as busy, so the default map leaves it out)
		expect((await get(`/session/status`)).json[id]).toBeUndefined();
		expect((await get(`/session/status?parked=true`)).json[id]).toMatchObject({ type: "idle", queued: left.length });
		const idleFrame = tap.of(id).filter((f) => f.p.type === "session.status" && f.p.properties.status.type === "idle").at(-1)!;
		expect(idleFrame.p.properties.status.queued).toBe(left.length);

		// run now: loop starts them, and the read is empty
		const ran = await post(`/session/${id}/loop`);
		expect(ran.json.ran).toBe(left.length);
		await idleOf(id, 2);
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
	}, 40_000);

	test("an empty queue reads as an empty list, an unknown session 404s", async () => {
		const id = await newSession("a19-empty");
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
		expect((await get(`/session/ses_nope/queue`)).status).toBe(404);
	});
});

// ---------- a18: a queued or steered prompt keeps its model, effort and agent ----------

describe("a18: a queued prompt keeps its model, effort and agent", () => {
	test("a queued prompt runs on the model and effort it asked for, a prompt behind it with none inherits them, and the session keeps them", async () => {
		const id = await busySession("a18-run");
		const mark = requests.length;
		const q1 = await post(`/session/${id}/queue`, { text: "on sonnet please", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "low" });
		expect(q1.status).toBe(202);
		expect(q1.json).toMatchObject({ result: "queued", model: SONNET, effort: "low" });
		const q2 = await post(`/session/${id}/queue`, { text: "and then this one" });
		expect(q2.json.model).toBeUndefined();

		// the provisional message carries the choice, on the stream and in the read
		const announced = tap.of(id).find((f) => f.p.type === "message.updated" && f.p.properties.info.id === q1.json.messageID)!.p.properties.info;
		expect(announced).toMatchObject({ queued: true, model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "low" });
		const read = ((await get(`/session/${id}/queue`)).json as any[])[0].info;
		expect(read).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "low" });

		await idleOf(id, 2);
		const seen = since(mark);
		// the running turn's remaining request stayed on opus; the queued prompt ran on sonnet, at low, and the prompt behind it, which asked for nothing, went with it
		expect(seen.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		const onSonnet = seen.filter((r) => r.model === "claude-sonnet-5-5");
		expect(onSonnet[0]!.last).toContain("and then this one");
		const first = seen.find((r) => r.model === "claude-opus-5-5")!;
		expect(onSonnet[0]!.effort).toBe("low");
		expect(first.effort).not.toBe("low");

		// the session now stands on the model and effort the prompt chose
		const info = (await get(`/session/${id}`)).json;
		expect(info.model ?? info.modelID).toBeDefined();
		expect(info.effort).toBe("low");
		const users = await userMessages(id);
		const landed = users.find((m) => textOf(m) === "on sonnet please")!;
		expect(landed.info).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "low" });
		// a later prompt with nothing asked stays where the queue left the session
		const mark2 = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "a plain one after" });
		await idleOf(id, 3);
		expect(since(mark2).map((r) => [r.model, r.effort])).toEqual([["claude-sonnet-5-5", "low"]]);
	}, 40_000);

	test("unsending the prompt that asked for another model lets the ones behind it ride the running turn", async () => {
		const id = await busySession("a18-unsend");
		const mark = requests.length;
		const q1 = await post(`/session/${id}/queue`, { text: "never ran", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
		await post(`/session/${id}/queue`, { text: "stays on opus" });
		expect((await call("DELETE", `/session/${id}/message/${q1.json.messageID}`)).json).toBe(true);
		await idleOf(id);
		const seen = since(mark);
		expect(seen.every((r) => r.model === "claude-opus-5-5")).toBe(true);
		expect(seen.some((r) => r.last.includes("stays on opus"))).toBe(true);
		expect(seen.some((r) => r.last.includes("never ran"))).toBe(false);
	}, 30_000);

	test("an effort the model does not allow answers 400 at send time, and nothing waits", async () => {
		const id = await busySession("a18-refuse");
		const res = await post(`/session/${id}/queue`, { text: "too much", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "max" });
		expect(res.status).toBe(400);
		expect(res.json.name).toBe("EffortNotAllowedError");
		const steer = await post(`/session/${id}/steer`, { text: "too much", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "max" });
		expect(steer.status).toBe(400);
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
		await idleOf(id);
	}, 30_000);

	test("a model that cannot be set answers 400 at send time; a steer asking for another model answers 400 and says to queue", async () => {
		const id = await busySession("a18-model");
		const bad = await post(`/session/${id}/queue`, { text: "no such model", model: { providerID: "anthropic", modelID: "claude-nope-0" } });
		expect(bad.status).toBe(400);
		const steer = await post(`/session/${id}/steer`, { text: "switch mid turn", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
		expect(steer.status).toBe(400);
		expect(steer.json.data.message).toContain("queue it");
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
		await idleOf(id);
	}, 30_000);

	test("a steer keeps its agent and effort: the effort applies from the next turn", async () => {
		const id = await busySession("a18-steer");
		const st = await post(`/session/${id}/steer`, { text: "steer with a dial", effort: "low" });
		expect(st.status).toBe(202);
		expect(st.json).toMatchObject({ result: "steered", effort: "low" });
		await tap.until(() => tap.of(id).some((f) => f.p.type === "message.updated" && f.p.properties.info.id === st.json.messageID), "the provisional message");
		const announced = tap.of(id).find((f) => f.p.type === "message.updated" && f.p.properties.info.id === st.json.messageID)!.p.properties.info;
		expect(announced).toMatchObject({ steer: true, variant: "low" });
		await idleOf(id);
		expect((await get(`/session/${id}`)).json.effort).toBe("low");
		// the next turn runs at it
		const mark = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "after the steer" });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.effort)).toEqual(["low"]);
	}, 30_000);

	test("an agent on a queued prompt is checked at send time; the agent's model and the agent itself apply when it runs", async () => {
		const bad = await busySession("a18-agent-bad");
		const refused = await post(`/session/${bad}/queue`, { text: "who", agent: "no-such-agent" });
		expect(refused.status).toBe(400);
		await idleOf(bad);

		const id = await busySession("a18-agent");
		const mark = requests.length;
		const q = await post(`/session/${id}/queue`, { text: "as the pal", agent: "pal" });
		expect(q.json).toMatchObject({ result: "queued", agent: "pal", model: SONNET });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		const all = (await get(`/session/${id}/message`)).json as any[];
		expect(all.find((m) => m.info.role === "user" && textOf(m) === "as the pal")!.info.agent).toBe("pal");
		expect(all.filter((m) => m.info.role === "assistant").at(-1)!.info.agent).toBe("pal");
	}, 40_000);

	test("a prompt held for another model survives an abort, and loop runs it on that model", async () => {
		const id = await busySession("a18-loop");
		await post(`/session/${id}/queue`, { text: "held across an abort", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		expect((await get(`/session/${id}`)).json.status).toMatchObject({ type: "idle", queued: 1 });
		// an aborted turn does not run the queue by itself
		await Bun.sleep(200);
		expect((await get(`/session/${id}/queue`)).json).toHaveLength(1);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		expect(since(mark).map((r) => [r.model, r.effort])).toEqual([["claude-sonnet-5-5", "low"]]);
	}, 40_000);

	test("a prompt sent to an idle session after an abort goes first, and the held one still runs after it on its own model", async () => {
		const id = await busySession("a18-after");
		await post(`/session/${id}/queue`, { text: "held for sonnet", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "fresh on opus" });
		await idleOf(id, 3);
		const seen = since(mark);
		expect(seen.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		expect(seen[0]!.last).toContain("fresh on opus");
		expect(seen[1]!.last).toContain("held for sonnet");
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
	}, 40_000);
});

// ---------- the review's repros ----------

const statusFrames = (id: string) => tap.of(id).filter((f) => f.p.type === "session.status").map((f) => f.p.properties.status);
const idles = (id: string) => tap.of(id).filter((f) => f.p.type === "session.idle").length;

describe("the queue after a held prompt has run", () => {
	test("a plain prompt queued while the held one's turn runs rides that turn: no idle between", async () => {
		const id = await busySession("r1");
		const mark = requests.length;
		await post(`/session/${id}/queue`, { text: "[wait] r1-sonnet", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
		await idleOf(id, 1);
		// the held one starts on its own and holds its turn open
		await tap.until(() => statusFrames(id).filter((s) => s.type === "busy").length >= 2 && requests.slice(mark).some((r) => r.model === "claude-sonnet-5-5"), "the held turn");
		const q = await post(`/session/${id}/queue`, { text: "plain rider" });
		expect(q.json.result).toBe("queued");
		await tap.until(() => idles(id) >= 2, "the held turn to end");
		await Bun.sleep(1500);
		expect(idles(id)).toBe(2);
		expect(requests.slice(mark).map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]);
		expect((await get(`/session/${id}`)).json.status).toBeUndefined();
	}, 40_000);

	test("two loops at once after an abort left a held prompt and a rider: each prompt runs once, and the next busy turn queues plain prompts as riders", async () => {
		const id = await busySession("r4");
		await post(`/session/${id}/queue`, { text: "R4 A sonnet", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
		await post(`/session/${id}/queue`, { text: "R4 B rider" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		const loops = await Promise.all([post(`/session/${id}/loop`), post(`/session/${id}/loop`)]);
		// one runs both prompts; the other finds nothing waiting (200, ran 0) or the turn already running (409), whichever got there second
		const won = loops.filter((l) => l.status === 200 && l.json.ran === 2);
		const lost = loops.filter((l) => l !== won[0]);
		expect(won).toHaveLength(1);
		expect(lost[0]!.status === 409 || (lost[0]!.status === 200 && lost[0]!.json.ran === 0)).toBe(true);
		await tap.until(() => idles(id) >= 2, "the loop turn");
		await Bun.sleep(1500);
		const users = (await userMessages(id)).map(textOf).filter((t) => t.startsWith("R4"));
		expect(users).toEqual(["R4 A sonnet", "R4 B rider"]);
		expect(requests.slice(mark).every((r) => r.model === "claude-sonnet-5-5")).toBe(true);
		// a later busy turn: a plain prompt rides it, one idle for both
		const n = statusFrames(id).filter((s) => s.type === "busy").length;
		await post(`/session/${id}/prompt_async`, { text: "[wait] r4-next" });
		await tap.until(() => statusFrames(id).filter((s) => s.type === "busy").length > n, "busy again");
		await post(`/session/${id}/queue`, { text: "R4 later rider" });
		const before = idles(id);
		await tap.until(() => idles(id) > before, "the later turn");
		await Bun.sleep(1500);
		expect(idles(id) - before).toBe(1);
	}, 60_000);
});

describe("a steer's effort", () => {
	test("a steer taken back never moves the dial; one that lands does, from the next turn", async () => {
		const id = await busySession("r5");
		const e0 = (await get(`/session/${id}`)).json.effort as string;
		const other = e0 === "low" ? "high" : "low";
		const st = await post(`/session/${id}/steer`, { text: "steer then unsend", effort: other });
		expect((await call("DELETE", `/session/${id}/message/${st.json.messageID}`)).json).toBe(true);
		await idleOf(id);
		expect((await get(`/session/${id}`)).json.effort).toBe(e0);

		// one that lands: the effort follows it
		const id2 = await busySession("r5-lands");
		const st2 = await post(`/session/${id2}/steer`, { text: "steer that stays", effort: other });
		expect(st2.status).toBe(202);
		await idleOf(id2);
		expect((await get(`/session/${id2}`)).json.effort).toBe(other);
	}, 40_000);

	test("a steer asking for the effort the session has cancels a dial change that was pending", async () => {
		const id = await busySession("r5-pending");
		const e0 = (await get(`/session/${id}`)).json.effort as string;
		const other = e0 === "low" ? "high" : "low";
		expect((await post(`/session/${id}/effort`, { effort: other })).json.result).toBe("pending");
		await post(`/session/${id}/steer`, { text: "steer back", effort: e0 });
		await idleOf(id);
		expect((await get(`/session/${id}`)).json.effort).toBe(e0);
	}, 30_000);

	test("a steer whose agent runs on another model answers 400 and says to queue it instead", async () => {
		const id = await busySession("steer-agent");
		const res = await post(`/session/${id}/steer`, { text: "as the pal", agent: "pal" });
		expect(res.status).toBe(400);
		expect(res.json.data.message).toContain("agent pal runs on anthropic/claude-sonnet-5-5");
		expect(res.json.data.message).toContain("queue it instead");
		await idleOf(id);
	}, 30_000);
});

describe("the newest explicit effort wins", () => {
	const effortOf = async (id: string) => (await get(`/session/${id}`)).json.effort as string;

	test("a steer left by an abort runs the loop turn at its effort", async () => {
		const id = await busySession("r7");
		expect(await effortOf(id)).not.toBe("low");
		await post(`/session/${id}/steer`, { text: "r7 steer low", effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.effort)).toEqual(["low"]);
		expect(await effortOf(id)).toBe("low");
	}, 30_000);

	test("an effort sent with a fresh prompt beats an older steer left by an abort", async () => {
		const id = await busySession("r8");
		await post(`/session/${id}/steer`, { text: "r8 steer low", effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "r8 fresh high", effort: "high" });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.effort)).toEqual(["high"]);
		// the steer was read in that turn and did not move the dial
		expect(await effortOf(id)).toBe("high");
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
	}, 30_000);

	test("a prompt sent without an effort after an abort runs at what the waiting steer asked", async () => {
		const id = await busySession("r8b");
		await post(`/session/${id}/steer`, { text: "r8b steer low", effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "r8b fresh" });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.effort)).toEqual(["low"]);
		expect(await effortOf(id)).toBe("low");
	}, 30_000);

	test("the dial moved after a steer was sent wins over the steer when it lands", async () => {
		const id = await busySession("r9");
		await post(`/session/${id}/steer`, { text: "r9 steer low", effort: "low" });
		expect((await post(`/session/${id}/effort`, { effort: "high" })).json).toMatchObject({ result: "pending", effort: "high" });
		await idleOf(id);
		await Bun.sleep(300);
		expect(await effortOf(id)).toBe("high");
	}, 30_000);

	test("the dial moved after a steer was sent also wins over it in the turn an abort left it for", async () => {
		const id = await busySession("r9b");
		await post(`/session/${id}/steer`, { text: "r9b steer low", effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		expect((await post(`/session/${id}/effort`, { effort: "high" })).json.result).toBe("applied");
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		expect(since(mark).map((r) => r.effort)).toEqual(["high"]);
		expect(await effortOf(id)).toBe("high");
	}, 30_000);

	test("a steer that calls off a pending dial move is heard: the stored effort and the stream agree with the live one", async () => {
		const id = await busySession("r11");
		const e0 = await effortOf(id);
		const other = e0 === "low" ? "high" : "low";
		expect((await post(`/session/${id}/effort`, { effort: other })).json.result).toBe("pending");
		// the dial wrote the pending value to the store when it was said
		expect(d.store.session(id)!.effort).toBe(other);
		await post(`/session/${id}/steer`, { text: "r11 back", effort: e0 });
		await idleOf(id);
		await Bun.sleep(200);
		expect(await effortOf(id)).toBe(e0);
		expect(d.store.session(id)!.effort).toBe(e0);
		const heard = tap.of(id).filter((f) => f.p.type === "session.effort").map((f) => f.p.properties.effort);
		expect(heard.at(-1)).toBe(e0);
	}, 30_000);

	test("a waiting prompt's older effort runs its own turn, and a dial move said after it comes back at the turn's end", async () => {
		const id = await busySession("r12");
		const e0 = await effortOf(id);
		const other = e0 === "low" ? "high" : "low";
		await post(`/session/${id}/queue`, { text: "r12 P", effort: e0 });
		await post(`/session/${id}/effort`, { effort: other });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		expect(await effortOf(id)).toBe(other);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		await Bun.sleep(200);
		// the prompt ran at the effort it asked for; the dial, moved after it was sent, is where the session stands again
		expect(since(mark).map((r) => r.effort)).toEqual([e0]);
		expect(await effortOf(id)).toBe(other);
		expect(d.store.session(id)!.effort).toBe(other);
		const next = requests.length;
		await post(`/session/${id}/prompt_async`, { text: "r12 next" });
		await idleOf(id, 3);
		expect(since(next).map((r) => r.effort)).toEqual([other]);
	}, 40_000);

	test("a prompt's effort sent after the dial moved is the newer word, and stays", async () => {
		const id = await busySession("r12b");
		const e0 = await effortOf(id);
		const other = e0 === "low" ? "high" : "low";
		await post(`/session/${id}/effort`, { effort: other });
		await post(`/session/${id}/queue`, { text: "r12b P", effort: e0 });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		await Bun.sleep(200);
		expect(since(mark).map((r) => r.effort)).toEqual([e0]);
		expect(await effortOf(id)).toBe(e0);
	}, 40_000);

	test("the dial's effort is not carried to a model that never runs at it: the held prompt's own effort stands", async () => {
		const id = await busySession("r13");
		// sonnet never runs at max here; opus does, so the dial takes it
		await post(`/session/${id}/queue`, { text: "r13 P", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "low" });
		expect((await post(`/session/${id}/effort`, { effort: "max" })).json.result).toBe("pending");
		await post(`/session/${id}/abort`);
		await idleOf(id);
		expect(await effortOf(id)).toBe("max");
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
		await Bun.sleep(200);
		expect(since(mark).map((r) => [r.model, r.effort])).toEqual([["claude-sonnet-5-5", "low"]]);
		// max on sonnet would be refused at send time; the session does not end there
		expect(await effortOf(id)).toBe("low");
		expect(d.store.session(id)!.effort).toBe("low");
		expect(d.store.session(id)!.model).toBe(SONNET);
	}, 40_000);

	test("an escalation that happened while the prompt waited does not decide where the prompt's turn leaves the session: the dial's baseline does, and nothing is stored", async () => {
		const id = await busyChild("r14", "medium");
		expect(await effortOf(id)).toBe("medium");
		// held: it asks for high, the session is at medium
		await post(`/session/${id}/queue`, { text: "r14 P", effort: "high" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		// the dial moves to low after the prompt was sent
		expect((await post(`/session/${id}/effort`, { effort: "low" })).json.result).toBe("applied");
		// a fresh prompt runs first; the same call three times in one step makes the engine escalate at its end
		await post(`/session/${id}/prompt_async`, { text: "[thrice] r14-q" });
		await idleOf(id, 3);
		await Bun.sleep(300);
		const escalated = tap.of(id).filter((f) => f.p.type === "session.escalated").map((f) => f.p.properties);
		expect(escalated).toHaveLength(1);
		expect(escalated[0]).toMatchObject({ from: "low" });
		expect(escalated[0].to).not.toBe("low");
		// the held prompt ran at high (its own word, after the dial); the session comes back to the dial's low, not to the escalation
		expect(await effortOf(id)).toBe("low");
		expect(d.store.session(id)!.effort).toBe("low");
		expect((await get(`/session/${id}/queue`)).json).toEqual([]);
		// and nothing the escalation did was ever said as the session's effort
		expect(tap.of(id).filter((f) => f.p.type === "session.effort").map((f) => f.p.properties.effort)).not.toContain(escalated[0].to);
	}, 60_000);

	test("a held prompt (sonnet, high) and a later steer (low) left by an abort: one turn, on sonnet, at the later word", async () => {
		const id = await busySession("r10");
		await post(`/session/${id}/queue`, { text: "r10 A sonnet high", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "high" });
		await post(`/session/${id}/steer`, { text: "r10 S low", effort: "low" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 2 });
		await idleOf(id, 2);
		expect(since(mark).map((r) => [r.model, r.effort])).toEqual([["claude-sonnet-5-5", "low"]]);
		expect(await effortOf(id)).toBe("low");
	}, 30_000);

	test("the same steer sent before the held prompt: the prompt's effort is the later word", async () => {
		const id = await busySession("r10b");
		await post(`/session/${id}/steer`, { text: "r10b S low", effort: "low" });
		await post(`/session/${id}/queue`, { text: "r10b A sonnet high", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, effort: "high" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		const mark = requests.length;
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 2 });
		await idleOf(id, 2);
		expect(since(mark).map((r) => [r.model, r.effort])).toEqual([["claude-sonnet-5-5", "high"]]);
		expect(await effortOf(id)).toBe("high");
	}, 30_000);
});

describe("escalation is per turn and only for helpers", () => {
	const effortOf = async (id: string) => (await get(`/session/${id}`)).json.effort as string;
	const heard = (id: string, type: string) => tap.of(id).filter((f) => f.p.type === type).map((f) => f.p.properties);
	/** the efforts a helper's steps ran at */
	const stepEfforts = (id: string) => (d.store.steps(id) as Array<{ effort: string }>).map((x) => x.effort);
	/** sends a prompt and waits for the turn after the ones counted so far; what comes back is the efforts of the helper's steps it took */
	const ask = async (id: string, text: string) => {
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		const mark = stepEfforts(id).length;
		expect((await post(`/session/${id}/prompt_async`, { text })).status).toBe(202);
		await idleOf(id, n + 1);
		await Bun.sleep(150);
		return stepEfforts(id).slice(mark);
	};

	test("a helper's escalation runs its next turn one rung up, a turn without signals brings it back, and the stored effort never moves", async () => {
		const id = await child("esc", "low");
		expect(await effortOf(id)).toBe("low");
		// the same call three times in one step: the turn after this one runs a rung higher
		expect(await ask(id, "[thrice] esc-a")).toEqual(["low", "low"]);
		const up = heard(id, "session.escalated");
		expect(up).toHaveLength(1);
		expect(up[0]).toMatchObject({ from: "low", to: "medium" });
		expect(await effortOf(id)).toBe("low");
		expect(d.store.session(id)!.effort).toBe("low");
		// the next turn runs at medium; it shows no signals, so it ends by putting the effort back
		expect(await ask(id, "esc-b")).toEqual(["medium"]);
		expect(heard(id, "session.deescalated")).toEqual([{ sessionID: id, from: "medium", to: "low", reason: "a turn without failure signals" }]);
		expect(await ask(id, "esc-c")).toEqual(["low"]);
		expect(heard(id, "session.deescalated")).toHaveLength(1);
		expect(heard(id, "session.escalated")).toHaveLength(1);
		// the stored effort was only ever said by the spawn itself: no session.effort carried an escalated value
		expect(heard(id, "session.effort").map((p) => p.effort).filter((e) => e !== "low")).toEqual([]);
		expect(d.store.session(id)!.effort).toBe("low");
		// the step that followed an escalation carries it in telemetry; the way back down does not
		const steps = d.store.steps(id) as Array<{ escalation: string | null }>;
		expect(steps.filter((x) => x.escalation).length).toBe(1);
	}, 60_000);

	test("the dial moved while a helper stands escalated is the new baseline", async () => {
		const id = await child("esc-dial", "low");
		await ask(id, "[thrice] esc-dial-a");
		expect(heard(id, "session.escalated")).toHaveLength(1);
		expect((await post(`/session/${id}/effort`, { effort: "high" })).json.result).toBe("applied");
		expect(await ask(id, "esc-dial-b")).toEqual(["high"]);
		// nothing to come back from: the dial's high is where it stands
		expect(heard(id, "session.deescalated")).toEqual([]);
		expect(await effortOf(id)).toBe("high");
	}, 60_000);

	test("the main session does not escalate: the same call three times leaves its effort alone", async () => {
		const id = await busySession("esc-root");
		await idleOf(id);
		const e0 = await effortOf(id);
		const mark = requests.length;
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		await post(`/session/${id}/prompt_async`, { text: "[thrice] esc-root-q" });
		await idleOf(id, n + 1);
		await Bun.sleep(150);
		expect(heard(id, "session.escalated")).toEqual([]);
		expect(since(mark).map((r) => r.effort)).toEqual([e0, e0]);
		expect(await effortOf(id)).toBe(e0);
		expect(await ask(id, "esc-root-next")).toEqual([e0]);
	}, 60_000);

	test("a helper asking for the same wait again and again is not failing", async () => {
		const id = await child("esc-wait", "low");
		expect(await ask(id, "[waits] esc-wait-a")).toEqual(["low", "low", "low", "low"]);
		expect(heard(id, "session.escalated")).toEqual([]);
		expect(await ask(id, "esc-wait-b")).toEqual(["low"]);
	}, 60_000);

	test("a check that fails once after an edit is the red half of red-green; the same check failing twice escalates, and a pass in between starts the count over", async () => {
		const once = await child("esc-c1", "low");
		await ask(once, "[checkonce] esc-c1-a");
		expect(heard(once, "session.escalated")).toEqual([]);
		const reset = await child("esc-c3", "low");
		await ask(reset, "[checkreset] esc-c3-a");
		// the same command three times is the repeated-call signal; the check signal, which a pass of the command reset, stays out of its reason
		const resetReasons = heard(reset, "session.escalated").map((p) => p.reason);
		expect(resetReasons).toEqual(["the same shell call three times"]);
		const twice = await child("esc-c2", "low");
		await ask(twice, "[checktwice] esc-c2-a");
		const up = heard(twice, "session.escalated");
		expect(up).toHaveLength(1);
		expect(up[0]).toMatchObject({ from: "low", to: "medium" });
		expect(up[0].reason).toBe("the same check failed twice after an edit (false # test twice)");
	}, 60_000);

	test("a steer that names the effort in force during an escalated turn is a word of the session's own: it becomes where the session stands", async () => {
		const id = await child("esc-steer", "low");
		await ask(id, "[thrice] esc-steer-a");
		expect(heard(id, "session.escalated")).toHaveLength(1);
		// the next turn runs escalated (medium) and is held open; a steer for medium arrives during it
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		await post(`/session/${id}/prompt_async`, { text: "[wait] esc-steer-b" });
		await busyOf(id);
		await post(`/session/${id}/steer`, { text: "esc-steer-c", effort: "medium" });
		await idleOf(id, n + 1);
		await Bun.sleep(200);
		expect(await effortOf(id)).toBe("medium");
		expect(d.store.session(id)!.effort).toBe("medium");
		expect(heard(id, "session.deescalated")).toEqual([]);
		// and a steer for the baseline in a later escalated turn does not move it either way
	}, 60_000);

	test("a queued prompt that asks for the escalated effort runs its own turn and leaves the session there", async () => {
		const id = await child("esc-queue", "low");
		await ask(id, "[thrice] esc-queue-a");
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		await post(`/session/${id}/prompt_async`, { text: "[wait] esc-queue-b" });
		await busyOf(id);
		await post(`/session/${id}/queue`, { text: "esc-queue-c", effort: "medium" });
		await idleOf(id, n + 2);
		await Bun.sleep(200);
		expect(await effortOf(id)).toBe("medium");
		expect(d.store.session(id)!.effort).toBe("medium");
		// the escalated turn ended clean and went back down; the queued prompt's own turn then left the session at medium. had it ridden
		// the escalated turn, nothing would have made medium the baseline and the session would have stood at low
		expect(heard(id, "session.deescalated")).toHaveLength(1);
	}, 60_000);

	test("a helper that was evicted and reopened still escalates, and a reopened main session still does not", async () => {
		const root = await newSession("esc-reopen-root");
		await ask(root, "esc-reopen-root-a");
		const spawned = await post(`/session/${root}/agents`, { brief: "esc reopen kid", name: "esc_reopen_kid", model: OPUS, effort: "low", warm: false });
		const kid = spawned.json.agents[0].id as string;
		await idleOf(kid);
		await Bun.sleep(300);
		// ten newer sessions push both out of the residency lru
		const before = (await get("/global/memory")).json.live_sessions as number;
		for (let i = 0; i < 10; i++) {
			const other = await newSession(`esc-reopen-${i}`);
			await post(`/session/${other}/prompt_async`, { text: `churn ${i}` });
			await idleOf(other);
		}
		await Bun.sleep(200);
		expect(((await get("/global/memory")).json.live_sessions as number) - before).toBeLessThan(10);
		await ask(kid, "[thrice] esc-reopen-kid-b");
		expect(heard(kid, "session.escalated")).toHaveLength(1);
		const roots = heard(root, "session.escalated").length;
		await ask(root, "[thrice] esc-reopen-root-c");
		expect(heard(root, "session.escalated")).toHaveLength(roots);
	}, 120_000);
});

describe("the prompt cache ttl follows the session's waits", () => {
	/** the ttls of the requests a prompt made (its text is in the first message of every one of them, for a fresh session) */
	const ttlsFor = (tag: string) => requests.filter((r) => r.first.includes(tag)).map((r) => r.ttls);
	const prompt = async (id: string, text: string) => {
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		expect((await post(`/session/${id}/prompt_async`, { text })).status).toBe(202);
		await idleOf(id, n + 1);
		await Bun.sleep(100);
	};
	const all = (ttls: string[][], t: string) => ttls.every((x) => x.length > 0 && x.every((y) => y === t));

	test("a root's requests carry 1h on every breakpoint once it has a helper that is not closed, and not before; closing the helper does not undo it", async () => {
		const tag = `ttl-${nonce()}`;
		const root = await newSession("ttl-root");
		await prompt(root, `${tag} first`);
		const before = ttlsFor(tag);
		expect(before.length).toBeGreaterThan(0);
		expect(all(before, "5m")).toBe(true);
		const spawned = await post(`/session/${root}/agents`, { brief: "ttl kid", name: "ttl_kid", model: OPUS, effort: "low" });
		expect(spawned.status).toBe(201);
		const kid = spawned.json.agents[0].id as string;
		await idleOf(kid);
		await prompt(root, `${tag} second`);
		const during = ttlsFor(tag).slice(before.length);
		expect(during.length).toBeGreaterThan(0);
		// one request is internally consistent: every breakpoint the same ttl, so the api never sees a 1h block after a 5m one
		expect(all(during, "1h")).toBe(true);
		// the helper closes: the session stays long
		expect((await post(`/session/${root}/agents/close`, { target: kid })).status).toBe(200);
		await prompt(root, `${tag} third`);
		expect(all(ttlsFor(tag).slice(before.length + during.length), "1h")).toBe(true);
		// the helper itself had nothing to wait for
		expect(all(requests.filter((r) => r.first.includes("ttl kid")).map((r) => r.ttls), "5m")).toBe(true);
	}, 60_000);

	test("a background job that will notify switches a session to 1h; a plain session stays 5m", async () => {
		const tag = `ttl-${nonce()}`;
		const plain = await newSession("ttl-plain");
		await prompt(plain, `${tag}-plain one`);
		await prompt(plain, `${tag}-plain two`);
		expect(all(ttlsFor(`${tag}-plain`), "5m")).toBe(true);
		const job = await newSession("ttl-job");
		await prompt(job, `[bgjob] ${tag}-job one`);
		await prompt(job, `${tag}-job two`);
		const ttls = ttlsFor(`${tag}-job`);
		expect(ttls[0]!.every((t) => t === "5m")).toBe(true);
		expect(all(ttls.slice(-1), "1h")).toBe(true);
	}, 60_000);

	test("a context past 100k tokens switches a session to 1h", async () => {
		const tag = `ttl-${nonce()}`;
		const id = await newSession("ttl-big");
		await prompt(id, `[big] ${tag} one`);
		await prompt(id, `${tag} two`);
		const ttls = ttlsFor(tag);
		expect(ttls[0]!.every((t) => t === "5m")).toBe(true);
		expect(all(ttls.slice(-1), "1h")).toBe(true);
	}, 60_000);

	test("an explicit cache_ttl wins over the rule: a 5m session with a helper stays 5m", async () => {
		const tag = `ttl-${nonce()}`;
		const id = (await post("/session", { directory: WORK, title: `it-queue-ttl-explicit-${nonce()}`, cache_ttl: "5m" })).json.id as string;
		const spawned = await post(`/session/${id}/agents`, { brief: "ttl explicit kid", name: "ttl_kid2", model: OPUS, effort: "low" });
		await idleOf(spawned.json.agents[0].id);
		await prompt(id, `${tag} one`);
		expect(all(ttlsFor(tag), "5m")).toBe(true);
	}, 60_000);

	test("a spawn in the middle of a turn makes every later request of that turn 1h, and the first ones stay 5m", async () => {
		const tag = `ttl-${nonce()}`;
		const root = await newSession("ttl-mid");
		await prompt(root, `[spawnmid] ${tag}`);
		const reqs = ttlsFor(tag);
		expect(reqs.length).toBeGreaterThanOrEqual(2);
		expect(all(reqs.slice(0, 1), "5m")).toBe(true);
		expect(all(reqs.slice(1), "1h")).toBe(true);
	}, 60_000);

	test("the switch is stored on the session and survives the session leaving memory: a reopened session is 1h from its first request, and a fork starts at 1h", async () => {
		const tag = `ttl-${nonce()}`;
		const root = await newSession("ttl-persist");
		await prompt(root, `${tag} one`);
		expect(d.store.session(root)!.cache_ttl).toBeFalsy();
		const spawned = await post(`/session/${root}/agents`, { brief: "ttl persist kid", name: "ttl_pkid", model: OPUS, effort: "low", warm: false });
		await idleOf(spawned.json.agents[0].id);
		await prompt(root, `${tag} two`);
		expect(d.store.session(root)!.cache_ttl).toBe("1h");
		// the helper closes, then the session is pushed out of memory by newer ones
		await post(`/session/${root}/agents/close`, { target: spawned.json.agents[0].id });
		for (let i = 0; i < 10; i++) {
			const other = await newSession(`ttl-persist-${i}`);
			await post(`/session/${other}/prompt_async`, { text: `churn ${i}` });
			await idleOf(other);
		}
		const mark = ttlsFor(tag).length;
		await prompt(root, `${tag} three`);
		expect(all(ttlsFor(tag).slice(mark), "1h")).toBe(true);
		const forked = (await post(`/session/${root}/fork`, {})).json.id as string;
		expect(d.store.session(forked)!.cache_ttl).toBe("1h");
	}, 120_000);
});

describe("the roster stays out of the turn context", () => {
	const lines = (convo: string): string[] => convo.match(/helpers: \d+ working, \d+ parked; agents lists them\./g)?.slice() ?? [];
	const prompt = async (id: string, text: string) => {
		const n = tap.of(id).filter((f) => f.p.type === "session.idle").length;
		expect((await post(`/session/${id}/prompt_async`, { text })).status).toBe(202);
		await idleOf(id, n + 1);
		await Bun.sleep(100);
	};
	const spawn = async (root: string, name: string) => {
		const r = await post(`/session/${root}/agents`, { brief: `roster kid ${name}`, name, model: OPUS, effort: "low" });
		expect(r.status).toBe(201);
		await idleOf(r.json.agents[0].id);
		return r.json.agents[0].id as string;
	};

	test("four helpers never put a roster in a turn: one line says how many work and how many are parked, sent when the counts change", async () => {
		const tag = `roster-${nonce()}`;
		const root = await newSession("roster");
		const convo = () => requests.filter((r) => r.first.includes(tag)).at(-1)!.convo;
		await prompt(root, `${tag} one`);
		expect(lines(convo())).toEqual([]);
		const kids: string[] = [];
		for (const n of ["ann", "bob", "cat", "dee"]) kids.push(await spawn(root, n));
		// each report wakes the root, and a wake whose counts changed says so once; let the last one settle
		await Bun.sleep(1500);
		await prompt(root, `${tag} two`);
		const during = lines(convo());
		expect(during.at(-1)).toBe("helpers: 0 working, 4 parked; agents lists them.");
		// a line is only ever sent when it differs from the one before it
		expect(during.every((l, i) => l !== during[i - 1])).toBe(true);
		// the same counts are not said again
		await prompt(root, `${tag} three`);
		expect(lines(convo())).toEqual(during);
		// two close: the counts changed, so the line comes again
		for (const k of kids.slice(0, 2)) expect((await post(`/session/${root}/agents/close`, { target: k })).status).toBe(200);
		await prompt(root, `${tag} four`);
		expect(lines(convo())).toEqual([...during, "helpers: 0 working, 2 parked; agents lists them."]);
		// no request of this session, from the first to the last, carried the old roster
		expect(requests.filter((r) => r.first.includes(tag)).some((r) => r.convo.includes("agents under you"))).toBe(false);
		// the agents verb still lists all four (closed ones as tombstones)
		const roster = (await get(`/session/${root}/agents`)).json.agents as any[];
		expect(roster.filter((a) => a.state !== "closed" && a.name !== "root").map((a) => a.name).sort()).toEqual(["cat", "dee"]);
	}, 90_000);

	test("a session that never had a helper carries no line at all", async () => {
		const tag = `roster-${nonce()}`;
		const id = await newSession("roster-none");
		await prompt(id, `${tag} one`);
		await prompt(id, `${tag} two`);
		expect(requests.filter((r) => r.first.includes(tag)).every((r) => !r.convo.includes("helpers:") && !r.convo.includes("agents under you"))).toBe(true);
	}, 30_000);
});

describe("a session with prompts waiting stays in memory", () => {
	test("nine more sessions settle after an abort left a prompt: the queue still reads, and loop runs it", async () => {
		const id = await busySession("evict");
		await post(`/session/${id}/queue`, { text: "kept through the lru" });
		await post(`/session/${id}/abort`);
		await idleOf(id);
		for (let i = 0; i < 9; i++) {
			const other = await newSession(`evict-${i}`);
			await post(`/session/${other}/prompt_async`, { text: `hello ${i}` });
			await idleOf(other);
		}
		const read = (await get(`/session/${id}/queue`)).json as any[];
		expect(read.map(textOf)).toEqual(["kept through the lru"]);
		expect((await get(`/session/${id}`)).json.status).toMatchObject({ type: "idle", queued: 1 });
		expect((await post(`/session/${id}/loop`)).json).toEqual({ ran: 1 });
		await idleOf(id, 2);
	}, 60_000);
});
