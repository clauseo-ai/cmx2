/**
 * the stream lane: the stalled-subscriber cap, held against a real socket that never reads, without
 * closing readers that read. a daemon in this process on a real socket (port 4838, shifted by CMX2_PORT_SHIFT),
 * a scripted provider on loopback that speaks the anthropic stream, and the peers in processes of their own
 * (stream-peers.py): raw sockets with a 64 KB receive buffer, read at a steady rate or not at all, as boxbox's
 * probe a3 and a slow link do.
 *
 * run: bun test packages/server/test/stream.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = `/tmp/cmx2-stream-${nonce()}`;
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4838);
const BASE = `http://127.0.0.1:${PORT}`;
const PEERS = join(import.meta.dir, "stream-peers.py");
const MIB = 1024 * 1024;
/** boxbox's a3 burst: 24,000 deltas of 200 characters, about 14 MiB of frames with the finished part's */
const BURST = "[burst 24000 200]";
/** the same burst of random text, which gzip cannot shrink below the cap */
const NOISE = "[noise 24000 200]";

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** `[burst N SIZE]` streams N deltas of SIZE characters in one network chunk; `[big N]` one delta of N characters */
function deltas(body: any): string[] {
	if (!body.tools?.length) return ["a title"];
	const first = JSON.stringify((body.messages ?? []).find((m: any) => m.role === "user") ?? "");
	const burst = first.match(/\[burst (\d+) (\d+)\]/);
	if (burst) return Array.from({ length: Number(burst[1]) }, (_, i) => `${String(i).padStart(8, "0")} ${"x".repeat(Number(burst[2]) - 10)}\n`);
	const noise = first.match(/\[noise (\d+) (\d+)\]/);
	if (noise) return Array.from({ length: Number(noise[1]) }, () => `${Buffer.from(crypto.getRandomValues(new Uint8Array(Number(noise[2])))).toString("base64").slice(0, Number(noise[2]) - 1)}\n`);
	const bignoise = first.match(/\[bignoise (\d+)\]/);
	if (bignoise) return [randomBytes(Number(bignoise[1])).toString("base64").slice(0, Number(bignoise[1]))];
	const big = first.match(/\[big (\d+)\]/);
	if (big) return ["y".repeat(Number(big[1]))];
	return ["ok"];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = await req.json();
		const out = [
			sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }),
			sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
			...deltas(body).map((t) => sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })),
			sse("content_block_stop", { index: 0 }),
			sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }),
			sse("message_stop", {}),
		].join("");
		return new Response(out, { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => provider.stop(true));

/** a daemon for one test, with the streams it closed (its log lines) */
async function withDaemon<T>(data: string, fn: (closes: string[]) => Promise<T>): Promise<T> {
	const c = { ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] };
	const closes: string[] = [];
	const error = console.error;
	console.error = (...a: unknown[]) => {
		const line = a.map(String).join(" ");
		if (line.includes("closed an event stream")) closes.push(line.replace(/^.*cmx2: /, ""));
		error(...a);
	};
	const d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, data), checkEvents: true, reload: () => c });
	try {
		return await fn(closes);
	} finally {
		console.error = error;
		await d.stop();
	}
}

const api = async (path: string, body: unknown) => (await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) })).json();

/** starts a turn in a fresh session */
async function turn(text: string) {
	const id = (await api("/session", { directory: WORK, title: `it-stream-${nonce()}` })).id;
	await api(`/session/${id}/prompt`, { text });
	return id;
}

/** one peer process; `next()` is its next json line. gzip: it asks for the gzip stream (and decodes it) */
function peer(args: string[], gzip = false) {
	const child = Bun.spawn(["python3", PEERS, args[0]!, String(PORT), ...args.slice(1)], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, PEER_GZIP: gzip ? "1" : "0" } });
	const reader = child.stdout.getReader();
	const dec = new TextDecoder();
	let buf = "";
	return {
		child,
		go() {
			child.stdin.write("go\n");
			child.stdin.flush();
		},
		async next(ms = 120_000): Promise<any> {
			const deadline = Date.now() + ms;
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					return JSON.parse(line);
				}
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`the peer (${args.join(" ")}) said nothing in time`);
				const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => ({ done: true, value: undefined }))]);
				if (r.done) throw new Error(`the peer (${args.join(" ")}) exited without an answer`);
				buf += dec.decode(r.value, { stream: true });
			}
		},
	};
}

/** a reader at `rate` KB/s (0: as fast as it can), resuming whenever the daemon closes it, until `need` turns settle */
const reader = (rate: number, opts: { ka?: boolean; cursor?: string; need?: number; gzip?: boolean } = {}) => peer(["read", String(rate), opts.ka ? "ka" : "-", opts.cursor ?? "-", String(opts.need ?? 1), "170"], opts.gzip);

const mib = (n: number) => `${(n / MIB).toFixed(1)} MiB`;
const said = (closes: string[]) => closes.slice(0, 3).forEach((l) => console.log(`  daemon said: ${l}`));

// the gzip stream's cap counts compressed bytes, so its burst is random text that gzip cannot bring under the cap
for (const [ka, gzip] of [
	[false, false],
	[true, false],
	[false, true],
]) {
	const how = (ka ? "as a kept-alive connection's second request" : "as a connection's first request") + (gzip ? ", gzip" : "");
	test(`a22: a subscriber that never reads (${how}) is closed in a burst far past the cap, handed no more than the cap and socket buffers`, async () => {
		await withDaemon(ka ? "stall-ka" : gzip ? "stall-gzip" : "stall", async (closes) => {
			const stalled = peer(["stall", ka ? "ka" : "-"], gzip);
			const witness = reader(0, { gzip });
			try {
				expect((await stalled.next()).ready).toBe(true);
				expect((await witness.next()).ready).toBe(true);
				await Bun.sleep(300);
				await turn(gzip ? NOISE : BURST);
				const w = await witness.next();
				// the turn has settled: the stalled subscriber reads for the first time, as probe a3's does
				stalled.go();
				const s = await stalled.next();
				console.log(`a22 ${how}: ${mib(w.bytes)} to the witness (${w.resumes} resumes); the stalled subscriber was ${s.closed ? "closed" : "still open 10 s after"}, handed ${mib(s.reached)}`);
				said(closes);
				expect(w.done).toBe(true);
				expect(s.closed).toBe(true);
				// probe a3's bound: the 1 MiB cap plus what the loopback socket buffers on its side hold
				expect(s.reached).toBeLessThanOrEqual(4 * MIB);
			} finally {
				stalled.child.kill();
				witness.child.kill();
			}
		});
	}, 120_000);
}

for (const gzip of [false, true])
test(`a22: a 500 KB/s reader with a 64 KB receive buffer is never closed through a 1.5 MB part, live or replayed${gzip ? ", gzip" : ""}`, async () => {
	// under gzip the part is random text: a part of one letter shrinks to a few KB and would never slow the reader
	await withDaemon(gzip ? "slow-gzip" : "slow", async (closes) => {
		const live = reader(500, { gzip });
		try {
			expect((await live.next()).ready).toBe(true);
			await turn(gzip ? `[bignoise ${1536 * 1024}]` : `[big ${1536 * 1024}]`);
			const r = await live.next();
			console.log(`a22: a 1.5 MB part to a 500 KB/s reader, live: ${mib(r.bytes)} in ${r.secs} s, ${r.resumes} resumes, ${closes.length} closes`);
			said(closes);
			expect(r.done).toBe(true);
			expect(closes.length).toBe(0);
			expect(r.resumes).toBe(0);
			expect(r.gaps).toBe(0);
		} finally {
			live.child.kill();
		}
		// the same part again, then read from the log from the start of the store
		const epoch = (await fetch(`${BASE}/global/health`)).headers.get("x-cmx2-seq")!.split(":")[0];
		await turn(gzip ? `[bignoise ${1536 * 1024}]` : `[big ${1536 * 1024}]`);
		await Bun.sleep(1500);
		const replay = reader(500, { cursor: `${epoch}:0`, need: 2, gzip });
		try {
			expect((await replay.next()).ready).toBe(true);
			const r = await replay.next();
			console.log(`a22: two 1.5 MB parts replayed to a 500 KB/s reader: ${mib(r.bytes)} in ${r.secs} s, ${r.resumes} resumes, ${closes.length} closes`);
			said(closes);
			expect(r.done).toBe(true);
			expect(closes.length).toBe(0);
			expect(r.resumes).toBe(0);
			expect(r.gaps).toBe(0);
		} finally {
			replay.child.kill();
		}
	});
}, 120_000);

test("a22: 30 readers taking the 14 MiB burst as fast as they can are never closed", async () => {
	await withDaemon("thirty", async (closes) => {
		const readers = Array.from({ length: 30 }, () => reader(0));
		try {
			for (const r of readers) expect((await r.next()).ready).toBe(true);
			await turn(BURST);
			const rs = await Promise.all(readers.map((r) => r.next(170_000)));
			const secs = rs.map((r) => r.secs).sort((a, b) => a - b);
			console.log(`a22: 30 readers through the burst: ${rs.filter((r) => r.done).length} done, ${closes.length} closes, ${rs.reduce((n, r) => n + r.resumes, 0)} resumes, ${secs[0]} to ${secs.at(-1)} s`);
			said(closes);
			expect(rs.every((r) => r.done && r.gaps === 0)).toBe(true);
			expect(closes.length).toBe(0);
		} finally {
			for (const r of readers) r.child.kill();
		}
	});
}, 180_000);

test("a22: an answer asked for just before a stream on the same connection is never lost", async () => {
	await withDaemon("pipelined", async (closes) => {
		// a session list of about 400 KB, so the first answer takes several turns to cross the hop
		for (let i = 0; i < 100; i++) await api("/session", { directory: WORK, title: `it-pipelined-${i}-${"x".repeat(4000)}` });
		for (const path of ["/session", "/global/health"]) {
			// from another process, as a client that does not wait for an answer before its next request
			const p = peer(["race", "200", path]);
			try {
				const r = await p.next();
				console.log(`a22: 200 times ${path} then /global/event 0 to 2.5 ms later: ${r.lost} answers lost; the stream answered by the front ${r.front} times, over the hop ${r.hop}`);
				expect(r.lost).toBe(0);
				expect(r.front + r.hop).toBe(200);
			} finally {
				p.child.kill();
			}
		}
		expect(closes.length).toBe(0);
	});
}, 120_000);

test("a22: an event stream asked for later on a kept-alive connection is answered by the front, and a pipelined one after the hop's answer", async () => {
	await withDaemon("keepalive", async () => {
		const { connect } = await import("node:net");
		const until = async (f: () => boolean) => {
			for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(50);
			return f();
		};
		const open = () => {
			const sock = connect(PORT, "127.0.0.1");
			const got = { raw: "" };
			sock.on("data", (c: Buffer) => {
				got.raw += c.toString("latin1");
			});
			return { sock, got };
		};
		const health = `GET /global/health HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\n\r\n`;
		const events = `GET /global/event HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\n\r\n`;
		// health, its answer, then the stream: the stream's head is the front's own (it writes `date` first, node does not)
		const a = open();
		a.sock.write(health);
		expect(await until(() => a.got.raw.includes('"healthy"'))).toBe(true);
		a.sock.write(events);
		expect(await until(() => a.got.raw.includes('"type":"server.connected"'))).toBe(true);
		const heads = a.got.raw.split("HTTP/1.1 200 OK\r\n");
		expect(heads.length).toBe(3);
		expect(heads[2]!.startsWith("date: ")).toBe(true);
		a.sock.destroy();
		// both in one write: the health answer is not lost, and the stream follows it
		const b = open();
		b.sock.write(health + events);
		expect(await until(() => b.got.raw.includes('"type":"server.connected"'))).toBe(true);
		expect(b.got.raw.indexOf('"healthy"')).toBeGreaterThan(0);
		expect(b.got.raw.indexOf('"healthy"')).toBeLessThan(b.got.raw.indexOf("text/event-stream"));
		b.sock.destroy();
	});
});
