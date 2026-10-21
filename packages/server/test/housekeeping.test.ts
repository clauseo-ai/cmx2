/**
 * the daemon's housekeeping: a running shell's progress stays out of the database and the event log while
 * reads, live streams and a resume still see its latest tail; idle sessions beyond MAX_RESIDENT, or unused
 * past the idle limit, leave memory without losing a message; a finished turn that is not warming keeps no
 * copy of its last request. a daemon in this process (port 4887, shifted by CMX2_PORT_SHIFT) whose provider
 * is a scripted stand-in on loopback speaking anthropic's stream.
 *
 * run: bun test packages/server/test/housekeeping.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { MAX_RESIDENT, serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-housekeeping-"));
const WORK = join(SCRATCH, "work");
const CONFIG = join(SCRATCH, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const PORT = port(4887);
const BASE = `http://127.0.0.1:${PORT}`;
const TICKS = "for i in 1 2 3 4; do echo tick $i; sleep 1; done";

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
/** a prompt saying [ticks] asks for the shell once, then answers; everything else answers at once */
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const convo = JSON.stringify(body.messages ?? []);
		const tool = body.tools?.length && convo.includes("[ticks]") && !convo.includes("tool_result");
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const put = (s: string) => c.enqueue(new TextEncoder().encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				if (tool) {
					put(sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${nonce()}`, name: "shell", input: {} } }));
					put(sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: TICKS }) } }));
				} else {
					put(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
					put(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: body.tools?.length ? "ok" : "a title" } }));
				}
				put(sse("content_block_stop", { index: 0 }));
				put(sse("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
let d: ReturnType<typeof serve>;
// a short idle limit and sweep, so the sweep can be seen
const IDLE_MS = 1500;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(SCRATCH, "data"), checkEvents: true, reload: () => c, idleEvictMs: IDLE_MS, idleSweepMs: 200, idleSinceMax: 3 });
});
afterAll(async () => {
	try {
		expect(d.violations()).toBe(0);
	} finally {
		if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
		else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
		await d.stop();
		provider.stop(true);
		rmSync(SCRATCH, { recursive: true, force: true });
	}
});

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined, seq: res.headers.get("x-cmx2-seq") };
};
const newSession = async (tag: string) => (await call("POST", "/session", { directory: WORK, title: `it-hk-${tag}-${nonce()}` })).json.id as string;
const until = async <T>(f: () => T | undefined | Promise<T | undefined>, what: string, ms = 15_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) {
		const v = await f();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
};

/** an sse reader: every frame's id line (if any) and payload */
class Tap {
	frames: Array<{ id?: string; p: any }> = [];
	private ctl = new AbortController();
	constructor(headers: Record<string, string> = {}) {
		void (async () => {
			try {
				const res = await fetch(`${BASE}/global/event`, { headers, signal: this.ctl.signal });
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
						const id = block.match(/^id: (.*)$/m)?.[1];
						const data = block.match(/^data: (.*)$/m)?.[1];
						if (data) this.frames.push({ ...(id ? { id } : {}), p: JSON.parse(data).payload });
					}
				}
			} catch {}
		})();
	}
	progress(sessionID: string) {
		return this.frames.filter((f) => f.p.type === "message.part.updated" && f.p.properties.sessionID === sessionID && f.p.properties.part.type === "tool" && f.p.properties.part.state?.status === "running" && f.p.properties.part.state.metadata?.output !== undefined);
	}
	close() {
		this.ctl.abort();
	}
}

const toolPartOf = (messages: any[]) => messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool");

test("a running shell's progress is not stored or logged; live streams, reads and a resume see its latest tail", async () => {
	const live = new Tap();
	await until(() => live.frames.length > 0, "connected");
	const id = await newSession("progress");
	const head = (await call("GET", `/session/${id}/message`)).seq!;
	const eventsBefore = d.store.eventHead();
	await call("POST", `/session/${id}/prompt_async`, { text: "[ticks] run it" });
	await until(() => live.progress(id).some((f) => f.p.properties.part.state.metadata.output.includes("tick 2")), "a progress frame with tick 2");

	// the progress frames are unnumbered: no id line, no seq
	expect(live.progress(id).every((f) => f.id === undefined && f.p.seq === undefined)).toBe(true);
	// each tail is numbered from 1, so a client can order an unnumbered frame against a read
	expect(live.progress(id).map((f) => f.p.properties.part.state.metadata.progress)).toEqual(live.progress(id).map((_, i) => i + 1));
	// a read in the middle of the run shows the tail on the running tool part, with its number
	const seen = live.progress(id).length;
	const mid = toolPartOf((await call("GET", `/session/${id}/message`)).json);
	expect(mid.state.status).toBe("running");
	expect(mid.state.metadata.output).toContain("tick");
	expect(mid.state.metadata.progress).toBeGreaterThanOrEqual(seen);
	const one = (await call("GET", `/session/${id}/message/${mid.messageID}`)).json;
	expect(one.parts.find((p: any) => p.type === "tool").state.metadata.output).toContain("tick");
	// the stored row has no tail: nothing was written for it
	const row = d.store.toolPart(id, mid.callID)!;
	expect(JSON.parse(row.data).state.metadata?.output).toBeUndefined();
	// a stream resuming from before the run gets the latest tail at its seam
	const resumed = new Tap({ "last-event-id": `${head.split(":")[0]}:${eventsBefore}` });
	await until(() => resumed.progress(id).length > 0, "the tail at the resume's seam", 3000);

	await until(async () => toolPartOf((await call("GET", `/session/${id}/message`)).json)?.state.status === "completed", "the shell to finish");
	const done = toolPartOf((await call("GET", `/session/${id}/message`)).json);
	expect(done.state.output).toContain("tick 4");
	expect(done.state.metadata.output).toBeUndefined();
	// the log holds no running tool part with output
	const logged = d.store.eventsAfter(eventsBefore, { limit: 10_000 }).filter((e) => e.type === "message.part.updated" && JSON.parse(e.properties).part.state?.metadata?.output !== undefined && JSON.parse(e.properties).part.state.status === "running");
	expect(logged.length).toBe(0);
	console.log(`progress: ${live.progress(id).length} live frames, ${resumed.progress(id).length} on the resumed stream, 0 logged`);
	live.close();
	resumed.close();
}, 30_000);

test("idle sessions beyond the cap, or unused past the idle limit, leave memory and keep every message", async () => {
	const ids: string[] = [];
	for (let i = 0; i < MAX_RESIDENT + 2; i++) {
		const id = await newSession(`evict${i}`);
		await call("POST", `/session/${id}/message`, { parts: [{ type: "text", text: `hello ${i}` }] });
		ids.push(id);
	}
	const counts = () => ids.map((id) => d.store.messageCount(id));
	const before = counts();
	await Bun.sleep(50);
	expect(ids.filter((id) => d.sessions.has(id)).length).toBeLessThanOrEqual(MAX_RESIDENT);
	// the newest ones stay (least recently used goes first)
	expect(d.sessions.has(ids.at(-1)!)).toBe(true);
	// a finished root turn does not warm, so it keeps no copy of its last request
	expect(d.sessions.get(ids.at(-1)!)!.holdsWarmCopy).toBe(false);
	const idleAt = d.sessions.get(ids.at(-1)!)!.stateSince;
	// past the idle limit the sweep drops the rest
	await until(() => ids.every((id) => !d.sessions.has(id)), "the idle sweep", IDLE_MS + 3000);
	expect(counts()).toEqual(before);
	// a reopened session is idle since it went idle, not since it was reloaded
	await call("GET", `/session/${ids.at(-1)}/messages`);
	expect(d.sessions.get(ids.at(-1)!)!.stateSince).toBe(idleAt);
	expect(d.idleSince.has(ids.at(-1)!)).toBe(false);
	// the remembered idle times are capped (3 here, the three last evicted; the reopened one left), the oldest gone
	// first, and an archive (delete) drops its entry
	expect([...d.idleSince.keys()]).toEqual(ids.slice(-3, -1));
	const archived = [...d.idleSince.keys()][0]!;
	expect((await call("DELETE", `/session/${archived}`)).status).toBe(200);
	expect(d.idleSince.has(archived)).toBe(false);
	// an evicted session reopens on its next message with its history
	const again = await call("POST", `/session/${ids[0]}/message`, { parts: [{ type: "text", text: "again" }] });
	expect(again.status).toBe(200);
	expect(d.store.messageCount(ids[0])).toBeGreaterThan(before[0]!);
	expect((await call("GET", `/session/${ids[0]}/messages`)).json.filter((m: any) => m.role === "user").length).toBe(2);
}, 30_000);
