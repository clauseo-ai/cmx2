/**
 * the opt-in switches of an event stream (coalesce=100, types=, compact=1, gzip=1) and gzip on json answers. a daemon in
 * this process (port 4841, shifted by CMX2_PORT_SHIFT) whose provider is a scripted stand-in on loopback speaking
 * anthropic's stream, so the whole path runs without a model. each switch is checked against a plain stream of the same
 * turn: the plain stream is today's, and every switch must leave what a client ends up with unchanged.
 *
 * run: bun test packages/server/test/switches.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { constants, gunzipSync } from "node:zlib";
import { DEFAULTS } from "@cmx2/engine/config";
import { apply, initialState } from "../../tui/src/state.ts";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";
import { gzipSink, stateKey, Supersession, switchesOf } from "../src/stream.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-switches-"));
const WORK = join(SCRATCH, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4841);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- the scripted provider ----------

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} `);
type Block = { type: "thinking" | "text"; deltas: string[]; gapMs: number } | { type: "tool_use"; input: unknown };

function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", deltas: ["a title"], gapMs: 0 }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = JSON.stringify(messages).includes('"tool_result"');
	if (first.includes("[tool]") && !answered) {
		return [
			{ type: "thinking", deltas: words(20, "t"), gapMs: 12 },
			{ type: "text", deltas: [...words(10, "w"), "𝄞é "], gapMs: 12 },
			{ type: "tool_use", input: { command: "echo switches" } },
		];
	}
	return [
		{ type: "thinking", deltas: words(15, "r"), gapMs: 12 },
		{ type: "text", deltas: words(30, "a"), gapMs: 12 },
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
let d: ReturnType<typeof serve>;
beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(SCRATCH, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
	rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------- helpers ----------

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { json: (await res.json()) as any, seq: res.headers.get("x-cmx2-seq")! };
};

/** a stream on a raw socket: the bytes as they cross the wire, decoded on demand (chunked framing, then gzip if it says so) */
class Raw {
	private chunks: Buffer[] = [];
	private sock;
	constructor(path: string, headers: Record<string, string> = {}) {
		this.sock = connect(PORT, "127.0.0.1");
		const head = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${PORT}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
		this.sock.on("connect", () => this.sock.write(head));
		this.sock.on("data", (c: Buffer) => this.chunks.push(c));
		this.sock.on("error", () => {});
	}
	get wire() {
		return Buffer.concat(this.chunks);
	}
	decode() {
		const all = this.wire;
		const at = all.indexOf("\r\n\r\n");
		const head = at < 0 ? "" : all.subarray(0, at).toString("latin1");
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
		const gz = /^content-encoding: gzip$/im.test(head);
		const body = Buffer.concat(parts);
		return { head, gz, wire: body.length, text: (gz && body.length ? gunzipSync(body, { finishFlush: constants.Z_SYNC_FLUSH }) : body).toString() };
	}
	frames() {
		return this.decode()
			.text.split("\n\n")
			.filter(Boolean)
			.map((raw) => {
				const j = JSON.parse(raw.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
				return { raw, id: raw.startsWith("id: ") ? raw.split("\n")[0]!.slice(4) : undefined, p: j.payload ?? j };
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
type Frame = ReturnType<Raw["frames"]>[number];
const normId = (s: string) => s.replace(/evt_[a-z0-9]+_\d+/g, "evt");
const idles = (r: Raw, id: string) => r.frames().filter((f) => f.p.type === "session.idle" && f.p.properties.sessionID === id).length;
const deltaKey = (pr: any) => `${pr.messageID}/${pr.partID}/${pr.field}`;

/** the text each part has received by every non-delta frame, and whether offsets ran on without a gap */
function textWalk(frames: Frame[]) {
	const text = new Map<string, string>();
	const before: string[] = [];
	let contiguous = true;
	for (const f of frames) {
		if (f.p.type !== "message.part.delta") {
			before.push(JSON.stringify([...text].sort()));
			continue;
		}
		const pr = f.p.properties;
		const t = text.get(deltaKey(pr)) ?? "";
		if (pr.offset !== t.length) contiguous = false;
		text.set(deltaKey(pr), t + pr.delta);
	}
	return { text: JSON.stringify([...text].sort()), before, contiguous, deltas: frames.filter((f) => f.p.type === "message.part.delta").length };
}

const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
/** what a client ends up holding: the tui's reducer per session, and a keyed map of every state event's last value */
function finalState(frames: Frame[]) {
	const keyed = new Map<string, string>();
	const others: string[] = [];
	const tui = new Map<string, ReturnType<typeof initialState>>();
	for (const f of frames) {
		const props = JSON.stringify(f.p.properties);
		const k = stateKey(f.p.type, props);
		// a status is keyed by its type for compaction; the state a client holds is the session's latest status
		if (k) keyed.set(f.p.type === "session.status" ? `status ${f.p.properties.sessionID}` : k, props);
		else if (f.p.type !== "server.connected") others.push(normId(f.raw));
		const sid = f.p.properties?.sessionID;
		if (sid) {
			if (!tui.has(sid)) tui.set(sid, Object.assign(initialState(), { sessionID: sid }));
			apply(tui.get(sid)!, f.p);
		}
	}
	return { keyed: JSON.stringify([...keyed].sort()), others, tui: JSON.stringify(sorted([...tui].map(([k, s]) => [k, { ...s, agents: [...s.agents], steers: [...s.steers] }]))) };
}

// ---------- a recorded run ----------

const TYPES = "session.status,session.idle,message.updated,message.part.updated,message.part.delta";
const taps: Record<string, Raw> = {};
let sessionID = "";

describe("the switches against a plain stream of the same turns", () => {
	beforeAll(async () => {
		taps.plain = new Raw("/global/event");
		taps.gzip = new Raw("/global/event?gzip=1", { "accept-encoding": "gzip" });
		taps.gzipNoHeader = new Raw("/global/event?gzip=1");
		taps.coalesce = new Raw("/global/event?coalesce=100");
		taps.types = new Raw(`/global/event?types=${TYPES}`);
		taps.dirPlain = new Raw(`/event?directory=${encodeURIComponent(WORK)}`);
		taps.dirAll = new Raw(`/event?directory=${encodeURIComponent(WORK)}&coalesce=100&gzip=1`, { "accept-encoding": "gzip" });
		await taps.plain.until(() => Object.values(taps).every((t) => t.decode().text.length > 0 || t === taps.types), "every stream");
		sessionID = (await api("/session", { directory: WORK, title: `it-switches-${nonce()}` })).json.id;
		await api(`/session/${sessionID}/prompt`, { text: "[tool] look" });
		await taps.plain.until(() => idles(taps.plain!, sessionID) >= 1, "the first turn");
		await api(`/session/${sessionID}/prompt`, { text: "again" });
		await taps.plain.until(() => idles(taps.plain!, sessionID) >= 2, "the second turn");
		await Bun.sleep(300);
	});
	afterAll(() => {
		for (const t of Object.values(taps)) t.close();
	});

	test("a stream that asks for none is today's: gzip=1 without accept-encoding stays plain", () => {
		const plain = taps.plain!.decode();
		const bare = taps.gzipNoHeader!.decode();
		expect(bare.gz).toBe(false);
		expect(bare.head).not.toContain("content-encoding");
		expect(normId(bare.text)).toBe(normId(plain.text));
	});

	test("gzip: content-encoding gzip, and the decompressed frames are the plain stream's", () => {
		const plain = taps.plain!.decode();
		const gz = taps.gzip!.decode();
		console.log(`gzip: ${plain.wire} bytes plain, ${gz.wire} gzip on the wire for the same frames`);
		expect(gz.gz).toBe(true);
		expect(normId(gz.text)).toBe(normId(plain.text));
		expect(gz.wire * 4).toBeLessThan(plain.wire);
	});

	test("coalesce: fewer delta frames, the same text per part, offsets contiguous, and pending deltas go before any other frame", () => {
		for (const [plainTap, coalTap] of [
			[taps.plain!, taps.coalesce!],
			[taps.dirPlain!, taps.dirAll!],
		] as const) {
			const a = plainTap.frames();
			const b = coalTap.frames();
			const nonDelta = (fs: Frame[]) => fs.filter((f) => f.p.type !== "message.part.delta").map((f) => normId(f.raw));
			expect(nonDelta(b)).toEqual(nonDelta(a));
			const wa = textWalk(a);
			const wb = textWalk(b);
			console.log(`coalesce: ${wa.deltas} delta frames plain, ${wb.deltas} coalesced`);
			expect(wa.contiguous && wb.contiguous).toBe(true);
			expect(wb.text).toBe(wa.text);
			expect(wb.text).toContain("𝄞é");
			// every non-delta frame finds each part holding exactly the text the plain stream had delivered by then
			expect(wb.before).toEqual(wa.before);
			expect(wb.deltas).toBeLessThan(wa.deltas / 2);
		}
	});

	test("without coalesce the stream is as a23 reads it: one frame per delta at reading pace, contiguous from 0", () => {
		const a = taps.plain!.frames().filter((f) => f.p.type === "message.part.delta");
		// the tool step's 20 + 11, the step after the tool's 15 + 30, the second turn's 15 + 30: one frame each at this pace
		expect(a.length).toBe(20 + 11 + 45 + 45);
		expect(textWalk(taps.plain!.frames()).contiguous).toBe(true);
	});

	test("types: the full stream minus the types not asked for; heartbeats always pass, server.connected only when listed", () => {
		const want = new Set(TYPES.split(","));
		const full = taps.plain!.frames().filter((f) => want.has(f.p.type));
		const got = taps.types!.frames();
		expect(got.map((f) => normId(f.raw))).toEqual(full.map((f) => normId(f.raw)));
		expect(got.some((f) => f.p.type === "server.connected")).toBe(false);
	});

	test("compact: a resume from random cursors ends in the full replay's state, keeping every other event in seq order", async () => {
		const live = taps.plain!.frames();
		const logged = live.filter((f) => f.id);
		const seqs = logged.map((f) => Number(f.id!.split(":")[1]));
		const epoch = logged[0]!.id!.split(":")[0];
		const head = seqs.at(-1)!;
		// from before the first event, before the last, just before the second turn's busy (that whole turn inside the
		// gap), and random points between (never the head: nothing to replay)
		const busies = logged.filter((f) => f.p.type === "session.status" && f.p.properties.status.type === "busy");
		const gapTurn = Number(busies.at(-1)!.id!.split(":")[1]) - 1;
		const cursors = [seqs[0]! - 1, head - 1, gapTurn, ...Array.from({ length: 6 }, () => seqs[Math.floor(Math.random() * (seqs.length - 1))]!)];
		let fullFrames = 0;
		let compactFrames = 0;
		let gapStatuses = "";
		for (const c of cursors) {
			const full = new Raw("/global/event", { "last-event-id": `${epoch}:${c}` });
			const compact = new Raw("/global/event?compact=1&gzip=1", { "last-event-id": `${epoch}:${c}`, "accept-encoding": "gzip" });
			const reached = (r: Raw) => r.frames().some((f) => f.id === `${epoch}:${head}`);
			await full.until(() => reached(full), `the full replay from ${c}`);
			await compact.until(() => reached(compact), `the compact replay from ${c}`);
			full.close();
			compact.close();
			// the client held what the live stream had given it up to the cursor
			const upTo = live.slice(0, live.findIndex((f) => f.id && Number(f.id.split(":")[1]) === c) + 1);
			const a = full.frames();
			const b = compact.frames();
			fullFrames += a.length;
			compactFrames += b.length;
			const sa = finalState([...upTo, ...a]);
			const sb = finalState([...upTo, ...b]);
			expect(sb.keyed).toBe(sa.keyed);
			expect(sb.others).toEqual(sa.others);
			expect(sb.tui).toBe(sa.tui);
			const ids = b.filter((f) => f.id).map((f) => Number(f.id!.split(":")[1]));
			expect(ids.every((s, i) => i === 0 || s > ids[i - 1]!)).toBe(true);
			// a part never comes before its message when the full replay had the message first
			const seqOf = (f: Frame) => Number(f.id!.split(":")[1]);
			const messageAt = (fs: Frame[], mid: string) => fs.find((f) => f.p.type === "message.updated" && f.p.properties.info.id === mid);
			for (const f of b.filter((x) => x.p.type === "message.part.updated" && x.id)) {
				const inFull = messageAt(a, f.p.properties.part.messageID);
				if (inFull && seqOf(inFull) < seqOf(f)) {
					const inCompact = messageAt(b, f.p.properties.part.messageID);
					expect(inCompact && seqOf(inCompact) < seqOf(f)).toBe(true);
				}
			}
			// a turn inside the gap keeps its busy and its idle: each status type the full replay had comes, in the same order of first sight
			const kinds = (fs: Frame[]) => [...new Set(fs.filter((x) => x.p.type === "session.status").map((x) => `${x.p.properties.sessionID} ${x.p.properties.status.type}`))];
			expect(kinds(b)).toEqual(kinds(a));
			if (c === gapTurn) {
				const st = b.filter((x) => x.p.type === "session.status" && x.p.properties.sessionID === sessionID).map((x) => x.p.properties.status.type);
				expect(st.indexOf("busy")).toBeGreaterThanOrEqual(0);
				expect(st.lastIndexOf("idle")).toBeGreaterThan(st.indexOf("busy"));
				gapStatuses = st.join(" ");
			}
		}
		console.log(`compact: ${cursors.length} resumes, ${fullFrames} frames replayed in full, ${compactFrames} compact; the turn in the gap kept its statuses: ${gapStatuses}`);
		expect(compactFrames).toBeLessThan(fullFrames);
	}, 60_000);
});

// ---------- json answers ----------

describe("gzip on json answers", () => {
	const get = async (path: string, ae?: string) => {
		const res = await fetch(BASE + path, { headers: { "x-cmx2-directory": WORK, "accept-encoding": ae ?? "identity" }, decompress: false } as RequestInit);
		const bytes = Buffer.from(await res.arrayBuffer());
		return { enc: res.headers.get("content-encoding"), length: res.headers.get("content-length"), vary: res.headers.get("vary"), bytes, text: (res.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes) : bytes).toString() };
	};
	test("over 1 kb with accept-encoding gzip: gzipped, with its compressed length, and the decoded bytes are the same", async () => {
		const id = (await api("/session", { directory: WORK, title: `it-switches-rest-${nonce()}-${"x".repeat(2000)}` })).json.id;
		const plain = await get(`/session/${id}`);
		const gz = await get(`/session/${id}`, "gzip, deflate, br");
		expect(plain.enc).toBeNull();
		expect(plain.bytes.length).toBeGreaterThan(1024);
		expect(gz.enc).toBe("gzip");
		expect(gz.vary).toContain("accept-encoding");
		expect(Number(gz.length)).toBe(gz.bytes.length);
		expect(gz.text).toBe(plain.text);
		// a refusal of gzip is honoured
		expect((await get(`/session/${id}`, "gzip;q=0")).enc).toBeNull();
	});
	test("a small answer is never gzipped", async () => {
		const small = await get("/global/health", "gzip");
		expect(small.enc).toBeNull();
		expect(small.text).toBe((await get("/global/health")).text);
	});
});

// ---------- the parts on their own ----------

describe("the gzip sink", () => {
	test("each batch decodes whole as it lands; the end makes a whole gzip file; backlog counts the compressed bytes", async () => {
		const out: Buffer[] = [];
		let backlog = 0;
		const sink = gzipSink({ write: (b) => void out.push(Buffer.from(b as Uint8Array)), backlog: () => backlog, end: () => {}, destroy: () => {} });
		let plain = "";
		for (let batch = 0; batch < 50; batch++) {
			for (let i = 0; i < 1 + (batch % 7); i++) {
				const f = `data: {"payload":{"type":"message.part.delta","properties":{"delta":"word ${batch}.${i} ${"z".repeat(batch * 37)}"}}}\n\n`;
				sink.write(f);
				plain += f;
			}
			// written frames wait for the end of the loop's turn, and count toward the backlog meanwhile
			expect(sink.backlog()).toBeGreaterThan(0);
			await new Promise((ok) => setImmediate(ok));
			expect(sink.backlog()).toBe(0);
			expect(gunzipSync(Buffer.concat(out), { finishFlush: constants.Z_SYNC_FLUSH }).toString()).toBe(plain);
		}
		const wire = Buffer.concat(out).length;
		backlog = 1000;
		expect(sink.taken()).toBe(wire - 1000);
		sink.end();
		// the trailer's crc and size check out
		expect(gunzipSync(Buffer.concat(out)).toString()).toBe(plain);
	});

	test("a stream closed before its first frame is still a whole gzip body", () => {
		const out: Buffer[] = [];
		gzipSink({ write: (b) => void out.push(Buffer.from(b as Uint8Array)), backlog: () => 0, end: () => {}, destroy: () => {} }).end();
		expect(gunzipSync(Buffer.concat(out)).length).toBe(0);
	});

	test("a batch past 64 KB is compressed at once, so the backlog never holds much uncompressed", () => {
		const out: Buffer[] = [];
		const sink = gzipSink({ write: (b) => void out.push(Buffer.from(b as Uint8Array)), backlog: () => 0, end: () => {}, destroy: () => {} });
		for (let i = 0; i < 2000; i++) sink.write(`data: {"n":${i},"pad":"${"q".repeat(100)}"}\n\n`);
		expect(out.length).toBeGreaterThan(2);
		expect(sink.backlog()).toBeLessThan(64 * 1024);
	});
});

describe("types= and the cursor", () => {
	test("heartbeats on a filtered stream carry the id it has passed, so a resume does not expire for events it never asked for", async () => {
		// a window of 5 events and no age, heartbeats every 150 ms
		const c = config();
		const d2 = serve({ config: c, port: port(4842), hostname: "127.0.0.1", dataDir: join(SCRATCH, "data-types"), reload: () => c, eventWindow: { events: 5, ms: 0 }, heartbeatMs: 150 });
		const b2 = `http://127.0.0.1:${d2.server.port}`;
		const raw = (path: string, headers: Record<string, string> = {}) => {
			const sock = connect(d2.server.port, "127.0.0.1");
			const got = { text: "" };
			sock.on("connect", () => sock.write([`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${d2.server.port}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n")));
			sock.on("data", (b: Buffer) => (got.text += b.toString()));
			sock.on("error", () => {});
			return { sock, got };
		};
		try {
			const plainTap = raw("/global/event");
			const narrow = raw("/global/event?types=session.idle");
			await Bun.sleep(200);
			const before = (await fetch(`${b2}/session/status`)).headers.get("x-cmx2-seq")!;
			for (let i = 0; i < 8; i++) await fetch(`${b2}/session`, { method: "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: JSON.stringify({ title: `it-types-${i}` }) });
			const head = (await fetch(`${b2}/session/status`)).headers.get("x-cmx2-seq")!;
			const t0 = Date.now();
			while (!narrow.got.text.includes(`id: ${head}\ndata: {"payload":{"id":"evt_`) && Date.now() - t0 < 5_000) await Bun.sleep(20);
			// the narrow stream got no event, and a heartbeat that names the head
			expect(narrow.got.text).not.toContain("session.created");
			expect(narrow.got.text).toContain(`id: ${head}\ndata: {"payload":{"id":"evt_`);
			// a stream without types= keeps its heartbeats bare
			expect(plainTap.got.text).toContain('"type":"server.heartbeat"');
			expect(plainTap.got.text).not.toMatch(/id: [^\n]*\ndata: \{"payload":\{"id":"evt_[^"]*","type":"server.heartbeat"/);
			plainTap.sock.destroy();
			narrow.sock.destroy();
			d2.store.pruneEvents({ events: 5, ms: 0 });
			expect(Number(before.split(":")[1])).toBeLessThan(d2.store.eventsPrunedThrough());
			// from the heartbeat's id: no reset. from the cursor it held before the heartbeat moved it: expired
			const fresh = raw("/global/event?types=session.idle", { "last-event-id": head });
			const stale = raw("/global/event?types=session.idle", { "last-event-id": before });
			await Bun.sleep(400);
			expect(fresh.got.text).not.toContain("stream.reset");
			expect(fresh.got.text).toContain('"type":"server.heartbeat"');
			expect(stale.got.text).toContain('"reason":"expired"');
			fresh.sock.destroy();
			stale.sock.destroy();
		} finally {
			await d2.stop();
		}
	}, 30_000);
});

describe("switches and supersession", () => {
	test("the switches are read only as given: gzip needs accept-encoding, coalesce only 100", () => {
		const h = (ae?: string) => new Headers(ae ? { "accept-encoding": ae } : {});
		expect(switchesOf(new URL("http://x/global/event"), h("gzip"))).toEqual({ compact: false, gzip: false });
		expect(switchesOf(new URL("http://x/global/event?gzip=1"), h())).toMatchObject({ gzip: false });
		expect(switchesOf(new URL("http://x/global/event?gzip=1"), h("deflate, gzip"))).toMatchObject({ gzip: true });
		expect(switchesOf(new URL("http://x/global/event?coalesce=100&compact=1"), h())).toMatchObject({ coalesce: 100, compact: true });
		expect(switchesOf(new URL("http://x/global/event?coalesce=50"), h()).coalesce).toBeUndefined();
		expect([...(switchesOf(new URL("http://x/global/event?types=a,b,,c"), h()).types ?? [])]).toEqual(["a", "b", "c"]);
	});
	test("the first and the last of each key stay; one between goes when the last has its fields; statuses are keyed by type", () => {
		const s = new Supersession();
		const rows: [number, string, unknown][] = [
			[1, "message.updated", { sessionID: "s", info: { id: "m", role: "assistant" } }],
			[2, "message.part.updated", { sessionID: "s", part: { id: "p", messageID: "m", text: "" } }],
			[3, "message.updated", { sessionID: "s", info: { id: "m", role: "assistant", variant: "x" } }],
			[4, "message.updated", { sessionID: "s", info: { id: "m", role: "assistant" } }],
			[5, "message.part.updated", { sessionID: "s", part: { id: "p", messageID: "m", text: "a" } }],
			[6, "message.part.updated", { sessionID: "s", part: { id: "p", messageID: "m", text: "ab" } }],
			[7, "message.updated", { sessionID: "s", info: { id: "m", role: "assistant", done: true } }],
			[8, "session.status", { sessionID: "s", status: { type: "busy" } }],
			[9, "session.status", { sessionID: "s", status: { type: "busy", queued: 1 } }],
			[10, "session.status", { sessionID: "s", status: { type: "busy", queued: 0 } }],
			[11, "session.status", { sessionID: "s", status: { type: "idle" } }],
			[12, "session.created", { sessionID: "s", info: { id: "s" } }],
			[13, "session.idle", { sessionID: "s" }],
		];
		for (const [seq, type, p] of rows) s.note(seq, type, JSON.stringify(p));
		const skipped = rows.filter(([seq]) => s.skip(seq)).map(([seq]) => seq);
		// 1 is the message's first (before its part at 2), 7 its last; 3 has variant, which 7 lacks; 4 goes. the part keeps
		// 2 and 6, 5 goes. busy keeps its first (8) and last (10), 9 goes; idle is its own key and stays. creation and
		// events without state stay
		expect(skipped).toEqual([4, 5, 9]);
	});
});
