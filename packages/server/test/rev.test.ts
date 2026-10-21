/**
 * the transcript revision (boxbox protocol 14a): transcriptRev on session infos, x-cmx2-rev on message reads, and rev=1
 * on the event stream. a daemon in this process (port 4843, shifted by CMX2_PORT_SHIFT) whose provider is a scripted
 * stand-in on loopback speaking anthropic's stream. every write site is driven and checked: the revision moves by one per
 * counted event and only then, a read never moves it, a read's revision is the one the stream had said at its cursor,
 * and a stream that does not ask gets the same bytes without it.
 *
 * run: bun test packages/server/test/rev.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve, withRev } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-rev-"));
const WORK = join(SCRATCH, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4843);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- the scripted provider ----------

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} `);
type Block = { type: "thinking" | "text"; deltas: string[]; gapMs: number } | { type: "tool_use"; input: unknown };

const SUMMARY = ["goal", "constraints and preferences", "done", "in progress", "blocked", "key decisions", "ruled out", "live state", "next steps", "critical context", "relevant files"].map((s) => `## ${s}\n- the transcript revision moves once per counted write and never on a read or a streamed delta\n`).join("\n");

function script(body: any): Block[] {
	const messages: any[] = body.messages ?? [];
	// a compaction asks for the summary's sections
	if (JSON.stringify(messages.slice(-2)).includes("use exactly these sections")) return [{ type: "text", deltas: [SUMMARY], gapMs: 0 }];
	if (!body.tools?.length) return [{ type: "text", deltas: ["a title"], gapMs: 0 }];
	const last = JSON.stringify(messages.findLast((m) => m.role === "user") ?? "");
	const answered = last.includes('"tool_result"');
	if (last.includes("[long]") && !answered) return [{ type: "tool_use", input: { command: "for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.4; done" } }];
	if (last.includes("[tool]") && !answered) {
		return [
			{ type: "thinking", deltas: words(8, "t"), gapMs: 10 },
			{ type: "text", deltas: words(8, "w"), gapMs: 10 },
			{ type: "tool_use", input: { command: "echo rev" } },
		];
	}
	// a slow answer holds the turn long enough to queue behind it
	const slow = last.includes("[slow]");
	return [
		{ type: "thinking", deltas: words(6, "r"), gapMs: 10 },
		{ type: "text", deltas: words(slow ? 60 : 12, "a"), gapMs: slow ? 25 : 10 },
	];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const put = (s: string) => c.enqueue(new TextEncoder().encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
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
				c.close();
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
beforeAll(start);
afterAll(async () => {
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
	rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------- helpers ----------

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined, text, seq: res.headers.get("x-cmx2-seq"), rev: res.headers.get("x-cmx2-rev") };
};
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);

/** a stream on a raw socket, its frames decoded from the chunked body */
class Raw {
	private chunks: Buffer[] = [];
	private sock;
	constructor(path: string) {
		this.sock = connect(PORT, "127.0.0.1");
		const head = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${PORT}`, "", ""].join("\r\n");
		this.sock.on("connect", () => this.sock.write(head));
		this.sock.on("data", (c: Buffer) => this.chunks.push(c));
		this.sock.on("error", () => {});
	}
	text() {
		const all = Buffer.concat(this.chunks);
		const at = all.indexOf("\r\n\r\n");
		let b = at < 0 ? Buffer.alloc(0) : all.subarray(at + 4);
		const parts: Buffer[] = [];
		for (;;) {
			const eol = b.indexOf("\r\n");
			if (eol < 0) break;
			const size = Number.parseInt(b.subarray(0, eol).toString("latin1"), 16);
			if (!size || b.length < eol + 4 + size) break;
			parts.push(b.subarray(eol + 2, eol + 2 + size));
			b = b.subarray(eol + 4 + size);
		}
		return Buffer.concat(parts).toString();
	}
	frames() {
		return this.text()
			.split("\n\n")
			.filter(Boolean)
			.map((raw) => {
				const j = JSON.parse(raw.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
				return { raw, logged: raw.startsWith("id: "), p: j.payload ?? j };
			})
			.filter((f) => f.p.type !== "server.heartbeat");
	}
	async until(pred: () => boolean, what: string, ms = 20_000) {
		const t0 = Date.now();
		while (!pred()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}
	close() {
		this.sock.destroy();
	}
}

const COUNTED = new Set(["message.updated", "message.part.updated", "message.removed"]);
/** the logged events that count a write for this session, in stream order */
const counted = (r: Raw, sid: string) => r.frames().filter((f) => f.logged && COUNTED.has(f.p.type) && f.p.properties.sessionID === sid);
const idles = (r: Raw, sid: string) => r.frames().filter((f) => f.p.type === "session.idle" && f.p.properties.sessionID === sid).length;
const revNow = async (sid: string) => (await get(`/session/${sid}`)).json.transcriptRev as number;
/** the revision a client following the stream holds at a cursor: the last counted event at or before it */
const revAt = (r: Raw, sid: string, seq: number) => counted(r, sid).filter((f) => f.p.seq <= seq).at(-1)?.p.properties.rev ?? 0;
/** a rev=1 frame as a stream that did not ask would have it */
const strip = (raw: string) => raw.replace(/,"rev":\d+\}/g, "}").replace(/,"transcriptRev":\d+\}\}/g, "}}");
const normEvt = (s: string) => s.replace(/evt_[a-z0-9]+_\d+/g, "evt");

const taps = {} as { plain: Raw; rev: Raw; dir: Raw };
let sid = "";

describe("the transcript revision", () => {
	beforeAll(async () => {
		taps.plain = new Raw("/global/event");
		taps.rev = new Raw("/global/event?rev=1");
		taps.dir = new Raw(`/event?directory=${encodeURIComponent(WORK)}&rev=1`);
		await taps.plain.until(() => Object.values(taps).every((t) => t.text().length > 0), "every stream");
	}, 30_000);
	afterAll(() => {
		for (const t of Object.values(taps)) t.close();
	}, 30_000);

	test("a new session starts at 0 on every answer that returns it, and its message read says 0", async () => {
		const made = await post("/session", { directory: WORK, title: `it-rev-${nonce()}` });
		sid = made.json.id;
		expect(made.json.transcriptRev).toBe(0);
		expect((await get(`/session/${sid}`)).json.transcriptRev).toBe(0);
		const list = (await get(`/session?directory=${encodeURIComponent(WORK)}`)).json as any[];
		expect(list.find((s) => s.id === sid).transcriptRev).toBe(0);
		const read = await get(`/session/${sid}/message`);
		expect(read.rev).toBe("0");
		await taps.rev.until(() => taps.rev.frames().some((f) => f.p.type === "session.created" && f.p.properties.sessionID === sid), "session.created");
		const created = taps.rev.frames().find((f) => f.p.type === "session.created" && f.p.properties.sessionID === sid)!;
		expect(created.p.properties.info.transcriptRev).toBe(0);
	}, 30_000);

	test("a turn: each counted event moves the revision by one, deltas and reads do not, and reads agree with the stream", async () => {
		const reads: Array<{ seq: number; rev: number; kind: string }> = [];
		const turn = post(`/session/${sid}/prompt_async`, { text: "[tool] look" });
		// reads while the turn streams: each one's revision must be the one the stream had said at its cursor
		while (idles(taps.rev, sid) < 1) {
			const page = await get(`/session/${sid}/message?limit=5`);
			reads.push({ seq: Number(page.seq!.split(":")[1]), rev: Number(page.rev), kind: "page" });
			const all = await get(`/session/${sid}/message`);
			reads.push({ seq: Number(all.seq!.split(":")[1]), rev: Number(all.rev), kind: "all" });
			const last = (all.json as any[]).at(-1);
			if (last) {
				const one = await get(`/session/${sid}/message/${last.info.id}`);
				reads.push({ seq: Number(one.seq!.split(":")[1]), rev: Number(one.rev), kind: "one" });
			}
			await Bun.sleep(5);
		}
		await turn;
		await Bun.sleep(200);
		const ev = counted(taps.rev, sid);
		expect(ev.length).toBeGreaterThan(5);
		// consecutive from 1: one per counted event, nothing else moved it
		expect(ev.map((f) => f.p.properties.rev)).toEqual(ev.map((_, i) => i + 1));
		const deltas = taps.rev.frames().filter((f) => f.p.type === "message.part.delta" && f.p.properties.sessionID === sid);
		expect(deltas.length).toBeGreaterThan(5);
		expect(deltas.every((f) => f.p.properties.rev === undefined)).toBe(true);
		// a tool's result replaced its part: a counted event of a completed tool part
		expect(ev.some((f) => f.p.type === "message.part.updated" && f.p.properties.part.type === "tool" && f.p.properties.part.state.status === "completed")).toBe(true);
		const rev = ev.at(-1)!.p.properties.rev;
		expect(await revNow(sid)).toBe(rev);
		expect(reads.length).toBeGreaterThan(3);
		for (const r of reads) expect({ ...r, rev: r.rev }).toEqual({ ...r, rev: revAt(taps.rev, sid, r.seq) });
		// reads after it: the same revision, the read's and the session's, as often as asked
		for (let i = 0; i < 3; i++) {
			const all = await get(`/session/${sid}/message`);
			expect(Number(all.rev)).toBe(rev);
			expect(revAt(taps.rev, sid, Number(all.seq!.split(":")[1]))).toBe(rev);
		}
		expect(await revNow(sid)).toBe(rev);
		// the session.updated after the turn says the revision the stream's counted events had reached
		const updates = taps.rev.frames().filter((f) => f.p.type === "session.updated" && f.p.properties.sessionID === sid);
		const lastUpdate = updates.at(-1)!;
		expect(lastUpdate.p.properties.info.transcriptRev).toBe(revAt(taps.rev, sid, lastUpdate.p.seq));
		// the directory stream carries the same revisions
		expect(counted(taps.dir, sid).map((f) => f.p.properties.rev)).toEqual(ev.map((f) => f.p.properties.rev));
	}, 30_000);

	test("a stream that does not ask gets today's frames: the rev=1 frames with the revision taken out", () => {
		const plain = taps.plain.frames().filter((f) => f.p.type !== "server.connected");
		const rev = taps.rev.frames().filter((f) => f.p.type !== "server.connected");
		expect(taps.plain.text()).not.toContain('"rev":');
		expect(taps.plain.text()).not.toContain("transcriptRev");
		expect(plain.length).toBe(rev.length);
		expect(rev.map((f) => normEvt(strip(f.raw)))).toEqual(plain.map((f) => normEvt(f.raw)));
		// the logged ones byte for byte, the unnumbered ones apart from their event ids
		const logged = rev.filter((f) => f.logged);
		expect(logged.length).toBeGreaterThan(10);
		expect(logged.map((f) => strip(f.raw))).toEqual(plain.filter((f) => f.logged).map((f) => f.raw));
	}, 30_000);

	test("a resume replays the revisions from the log: the same frames the live rev=1 stream got", async () => {
		const live = taps.rev.frames().filter((f) => f.logged);
		const first = live[0]!.p;
		const resumed = new Raw(`/global/event?rev=1&after=${first.epoch}:${first.seq - 1}`);
		const last = live.at(-1)!.p.seq;
		await resumed.until(() => resumed.frames().some((f) => f.logged && f.p.seq >= last), "the replay");
		const replayed = resumed.frames().filter((f) => f.logged && f.p.seq <= last);
		resumed.close();
		expect(replayed.map((f) => f.raw)).toEqual(live.filter((f) => f.p.seq <= last).map((f) => f.raw));
	}, 30_000);

	test("a queued prompt taken back, and one swapped for its committed message: each removal moves it by one", async () => {
		const before = await revNow(sid);
		const idle0 = idles(taps.rev, sid);
		const busy = post(`/session/${sid}/prompt_async`, { text: "[slow] hold on" });
		await taps.rev.until(() => taps.rev.frames().some((f) => f.p.type === "session.status" && f.p.properties.sessionID === sid && f.p.properties.status.type === "busy" && f.p.seq > 0), "busy", 10_000).catch(() => {});
		await Bun.sleep(150);
		const queued = await post(`/session/${sid}/prompt_async`, { text: "take me back" });
		const qid = queued.json?.messageID ?? (await get(`/session/${sid}/queue`)).json.at(-1)?.info.id;
		expect(typeof qid).toBe("string");
		await taps.rev.until(() => counted(taps.rev, sid).some((f) => f.p.type === "message.updated" && f.p.properties.info.id === qid), "the queued message");
		const atQueue = await revNow(sid);
		const taken = await call("DELETE", `/session/${sid}/message/${qid}`);
		expect(taken.json).toBe(true);
		await taps.rev.until(() => counted(taps.rev, sid).some((f) => f.p.type === "message.removed" && f.p.properties.messageID === qid), "the removal");
		const removal = counted(taps.rev, sid).find((f) => f.p.type === "message.removed" && f.p.properties.messageID === qid)!;
		expect(removal.p.properties.rev).toBeGreaterThan(atQueue);
		// a second queued prompt runs after the slow one: its provisional message is removed as it lands
		const second = await post(`/session/${sid}/prompt_async`, { text: "run me after" });
		const pid = second.json?.messageID ?? (await get(`/session/${sid}/queue`)).json.at(-1)?.info.id;
		await busy;
		await taps.rev.until(() => counted(taps.rev, sid).some((f) => f.p.type === "message.removed" && f.p.properties.messageID === pid), "the swap", 30_000);
		// the queued prompt runs in the same turn, after the slow answer
		await taps.rev.until(() => idles(taps.rev, sid) >= idle0 + 1, "the queued turn", 30_000);
		await Bun.sleep(200);
		const ev = counted(taps.rev, sid);
		expect(ev.map((f) => f.p.properties.rev)).toEqual(ev.map((_, i) => i + 1));
		expect(await revNow(sid)).toBe(ev.at(-1)!.p.properties.rev);
		expect(ev.at(-1)!.p.properties.rev).toBeGreaterThan(before);
	}, 30_000);

	test("a shell's tail moves nothing; an abort closes the open step, its close counted", async () => {
		const idle0 = idles(taps.rev, sid);
		const n0 = counted(taps.rev, sid).length;
		const r0 = await revNow(sid);
		await post(`/session/${sid}/prompt_async`, { text: "[long] count" });
		const tails = () => taps.rev.frames().filter((f) => !f.logged && f.p.type === "message.part.updated" && f.p.properties.sessionID === sid && f.p.properties.part.state?.metadata?.progress);
		await taps.rev.until(() => tails().length >= 2, "the shell's tail");
		// a tail carries the revision as it stands (the last counted event before it on the stream), and moves nothing
		let said = 0;
		const seen: Array<[number, number]> = [];
		for (const f of taps.rev.frames()) {
			if (f.p.properties?.sessionID !== sid) continue;
			if (f.logged && COUNTED.has(f.p.type)) said = f.p.properties.rev;
			else if (!f.logged && f.p.type === "message.part.updated" && f.p.properties.part.state?.metadata?.progress) seen.push([f.p.properties.rev, said]);
		}
		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const [rev, at] of seen) expect(rev).toBe(at);
		const plainTails = taps.plain.frames().filter((f) => !f.logged && f.p.type === "message.part.updated" && f.p.properties.part.state?.metadata?.progress);
		expect(plainTails.length).toBeGreaterThan(0);
		expect(plainTails.every((f) => f.p.properties.rev === undefined)).toBe(true);
		await post(`/session/${sid}/abort`);
		await taps.rev.until(() => idles(taps.rev, sid) >= idle0 + 1, "the aborted turn");
		await Bun.sleep(200);
		const ev = counted(taps.rev, sid);
		expect(ev.length).toBeGreaterThan(n0);
		expect(ev.slice(n0).map((f) => f.p.properties.rev)).toEqual(ev.slice(n0).map((_, i) => r0 + 1 + i));
		expect(await revNow(sid)).toBe(ev.at(-1)!.p.properties.rev);
		// nothing is left open on a read
		const msgs = (await get(`/session/${sid}/message`)).json as any[];
		expect(msgs.filter((m) => m.info.role === "assistant").every((m) => m.info.time.completed !== undefined)).toBe(true);
	}, 30_000);

	test("a revert and its undo each move it by one with no message event; a revert made permanent removes each parked message, one revision each", async () => {
		const msgs = (await get(`/session/${sid}/message`)).json as any[];
		const lastUser = msgs.findLast((m) => m.info.role === "user")!;
		const r0 = await revNow(sid);
		const events0 = counted(taps.rev, sid).length;
		const armed = await post(`/session/${sid}/revert`, { messageID: lastUser.info.id });
		expect(armed.status).toBe(200);
		expect(armed.json.transcriptRev).toBe(r0 + 1);
		await taps.rev.until(() => taps.rev.frames().some((f) => f.p.type === "session.updated" && f.p.properties.info.transcriptRev === r0 + 1), "the armed revert's session.updated");
		const undone = await post(`/session/${sid}/unrevert`);
		expect(undone.json.transcriptRev).toBe(r0 + 2);
		await taps.rev.until(() => taps.rev.frames().some((f) => f.p.type === "session.updated" && f.p.properties.info.transcriptRev === r0 + 2), "the undo's session.updated");
		expect(counted(taps.rev, sid).length).toBe(events0);
		// the plain stream's session.updated for the same moments has no revision
		expect(taps.plain.frames().filter((f) => f.p.type === "session.updated").every((f) => f.p.properties.info.transcriptRev === undefined)).toBe(true);

		// armed again, then a send makes it permanent
		const parked = msgs.filter((m) => m.info.time.created >= lastUser.info.time.created && m.info.id >= lastUser.info.id).map((m) => m.info.id);
		await post(`/session/${sid}/revert`, { messageID: lastUser.info.id });
		const r1 = await revNow(sid);
		expect(r1).toBe(r0 + 3);
		const idle0 = idles(taps.rev, sid);
		await post(`/session/${sid}/prompt_async`, { text: "start over" });
		await taps.rev.until(() => idles(taps.rev, sid) >= idle0 + 1, "the turn after the revert", 30_000);
		await Bun.sleep(200);
		const removed = counted(taps.rev, sid).filter((f) => f.p.type === "message.removed" && parked.includes(f.p.properties.messageID));
		expect(removed.map((f) => f.p.properties.messageID).sort()).toEqual([...parked].sort());
		// the first removal is the first counted event after the arm: r1 + 1, then one each
		expect(removed.map((f) => f.p.properties.rev)).toEqual(removed.map((_, i) => r1 + 1 + i));
		const after = (await get(`/session/${sid}/message`)).json as any[];
		expect(after.some((m) => parked.includes(m.info.id))).toBe(false);
		const ev = counted(taps.rev, sid);
		expect(await revNow(sid)).toBe(ev.at(-1)!.p.properties.rev);
	}, 30_000);

	test("a compaction summary written moves it, one per counted event", async () => {
		const r0 = await revNow(sid);
		const n0 = counted(taps.rev, sid).length;
		const res = await post(`/session/${sid}/summarize`, {});
		expect(res.text).toBe("true");
		await Bun.sleep(300);
		const ev = counted(taps.rev, sid).slice(n0);
		const summary = ev.find((f) => f.p.type === "message.updated" && f.p.properties.info.summary === true);
		expect(summary).toBeDefined();
		expect(ev.map((f) => f.p.properties.rev)).toEqual(ev.map((_, i) => r0 + 1 + i));
		expect(await revNow(sid)).toBe(r0 + ev.length);
	}, 30_000);

	test("title, archive and status leave it", async () => {
		const r0 = await revNow(sid);
		await call("PATCH", `/session/${sid}`, { title: `renamed-${nonce()}` });
		await call("PATCH", `/session/${sid}`, { time: { archived: Date.now() } });
		await call("PATCH", `/session/${sid}`, { time: { archived: null } });
		expect(await revNow(sid)).toBe(r0);
	}, 30_000);

	test("a restart: the revision is kept, and reading the session again (its transcript replayed) does not move it", async () => {
		const r0 = await revNow(sid);
		const page = await get(`/session/${sid}/message`);
		for (const t of Object.values(taps)) t.close();
		await d.stop();
		start();
		for (let i = 0; i < 3; i++) {
			const again = await get(`/session/${sid}/message`);
			expect(again.rev).toBe(String(r0));
			expect(again.text).toBe(page.text);
		}
		expect(await revNow(sid)).toBe(r0);
	}, 30_000);
});

describe("writes the events never said", () => {
	/** a session's transcript file, wherever the daemon keeps it */
	const transcriptOf = (id: string) => {
		const found = [...new Bun.Glob(`**/${id}.jsonl`).scanSync({ cwd: DATA, absolute: true })];
		expect(found.length).toBe(1);
		return found[0]!;
	};

	test("a clean restart of a store with many sessions replays none of them, and the daemon answers before the heal ends", async () => {
		// a shell reply (its row names the shell's folder) and many sessions with transcripts (forks of this one)
		await post(`/session/${sid}/shell`, { command: "cd / && pwd" });
		for (let i = 0; i < 60; i++) expect((await post(`/session/${sid}/fork`, {})).status).toBe(200);
		await d.stop();
		start();
		const first = await get("/global/health");
		expect(first.status).toBe(200);
		const healed = await d.healed();
		expect(healed.checked).toBeGreaterThanOrEqual(61);
		expect(healed).toEqual({ checked: healed.checked, replayed: 0, moved: 0 });
	}, 60_000);

	test("a crash between the transcript line and its landing: the next start heals the rows and moves the revision before any read", async () => {
		const r0 = await revNow(sid);
		const file = transcriptOf(sid);
		await d.stop();
		await Bun.sleep(20);
		// what the engine had written when the daemon died: a line the rows never got
		appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "written before the crash", timestamp: Date.now() } })}\n`);
		start();
		expect(await d.healed()).toEqual({ checked: expect.any(Number), replayed: 1, moved: 1 });
		// the session's revision says it before anything read the messages
		expect(await revNow(sid)).toBe(r0 + 1);
		const read = await get(`/session/${sid}/message`);
		expect(read.rev).toBe(String(r0 + 1));
		expect(read.text).toContain("written before the crash");
		// another start finds nothing to heal
		await d.stop();
		start();
		expect((await d.healed()).replayed).toBe(0);
		expect(await revNow(sid)).toBe(r0 + 1);
	}, 30_000);

	test("a landing that throws after its rows are written commits them and moves the revision", async () => {
		const tap = new Raw("/global/event?rev=1");
		await tap.until(() => tap.text().length > 0, "the stream");
		const id = (await post("/session", { directory: WORK, title: `it-rev-boom-${nonce()}` })).json.id as string;
		// the recall write after the message's rows fails, as a full disk or a broken index would
		const db = new Database(join(DATA, "cmx2.db"));
		db.exec("create trigger rev_boom before insert on recall_doc when new.text like '%[boom]%' begin select raise(abort, 'boom'); end");
		try {
			await post(`/session/${id}/prompt_async`, { text: "[boom] land me" });
			await tap.until(() => tap.frames().some((f) => f.p.properties?.sessionID === id && (f.p.type === "session.idle" || f.p.type === "session.error")), "the failed turn");
			await Bun.sleep(200);
		} finally {
			db.exec("drop trigger rev_boom");
			db.close();
		}
		const ev = counted(tap, id);
		const read = await get(`/session/${id}/message`);
		expect(read.text).toContain("[boom] land me");
		// the row has no event that counted it, and the revision moved for it anyway: the first counted event after it is 2
		expect(ev.some((f) => f.p.type === "message.updated" && f.p.properties.info.role === "user")).toBe(false);
		expect(ev.map((f) => f.p.properties.rev)).toEqual(ev.map((_, i) => i + 2));
		expect(Number(read.rev)).toBe(ev.length + 1);
		expect(await revNow(id)).toBe(Number(read.rev));
		tap.close();
	}, 30_000);
});

test("withRev splices the revision as the last field and parses only what it cannot splice", () => {
	expect(withRev("message.removed", '{"sessionID":"s","messageID":"m"}', 7)).toBe('{"sessionID":"s","messageID":"m","rev":7}');
	expect(withRev("session.updated", '{"sessionID":"s","info":{"id":"s"}}', 3)).toBe('{"sessionID":"s","info":{"id":"s","transcriptRev":3}}');
	expect(withRev("message.updated", '{"sessionID":"s"}', null)).toBe('{"sessionID":"s"}');
});
