/**
 * the web client's asks, one contract test each, against real daemons.
 *
 * two daemons: one in this process on a real socket (port 4836) whose provider accepts and never
 * answers, for the sync mechanics that need no model (a turn stays busy until aborted); and a cli daemon
 * on port 4834 with a real provider, for everything a model turn drives: the a1 restart test (a turn
 * streaming, the daemon SIGKILLed, a restart, a resume), a5, a6 and a9. a3 runs its own cli daemon on port
 * 4835 so its rss is the daemon's alone; it needs no model and always runs.
 *
 * the real provider part needs a provider key or profile and CMX2_LIVE_TESTS=1, else it is skipped and no daemon
 * starts. the live profile is the config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else
 * ANTHROPIC_API_KEY from the env.
 *
 * run: bun test packages/server/test/asks.test.ts (add CMX2_LIVE_TESTS=1 for the model part; a few minutes)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { Daemon, gitRepo, liveDescribe, liveNote, liveProfile, nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const N = nonce();
const SCRATCH = `/tmp/cmx2-asks-${N}`;
mkdirSync(SCRATCH, { recursive: true });
const AUTH = { authorization: `Basic ${btoa("cmx2:asks")}` };

/** an sse tap that keeps every frame as the bytes it arrived as */
class Tap {
	blocks: string[] = [];
	status = 0;
	private ctl = new AbortController();
	readonly ended: Promise<void>;
	constructor(url: string, headers: Record<string, string> = {}) {
		this.ended = (async () => {
			try {
				const res = await fetch(url, { headers: { ...AUTH, ...headers }, signal: this.ctl.signal });
				this.status = res.status;
				const reader = res.body!.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						this.blocks.push(buf.slice(0, i));
						buf = buf.slice(i + 2);
					}
				}
			} catch {}
		})();
	}
	/** frames that carry an sse id: logged events and the reset */
	logged(): string[] {
		return this.blocks.filter((b) => b.startsWith("id: ") && !b.includes('"type":"stream.reset"'));
	}
	payloads(): any[] {
		return this.blocks.map((b) => {
			const data = JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
			return data.payload ?? data;
		});
	}
	async until(pred: (t: Tap) => boolean, what: string, ms = 60_000) {
		const t0 = Date.now();
		while (!pred(this)) {
			if (Date.now() - t0 > ms) throw new Error(`tap: timed out waiting for ${what} (${this.blocks.length} frames)`);
			await Bun.sleep(25);
		}
	}
	close() {
		this.ctl.abort();
	}
}

const idOf = (block: string) => block.split("\n")[0]!.slice(4);
const seqOf = (block: string) => Number(idOf(block).split(":")[1]);

// ---------- the in-process daemon (no model answers) ----------

const root = realpathSync(SCRATCH);
const work = join(root, "proj");
mkdirSync(work, { recursive: true });
const sockets = new Set<Socket>();
let silent: Server;
let local: ReturnType<typeof serve>;
let base = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(base + path, { method, headers: { ...AUTH, "content-type": "application/json", "x-cmx2-directory": work, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, headers: res.headers, json: text.trim() ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
	silent = createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	const config = { ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${(silent.address() as { port: number }).port}`, apiKey: "unused" } }, sources: [] };
	local = serve({ config, port: port(4836), hostname: "127.0.0.1", dataDir: join(root, "data-local"), password: "asks", checkEvents: true, reload: () => config, eventWindow: { events: 50_000, ms: 30 * 60_000 } });
	base = `http://127.0.0.1:${local.server.port}`;
});

afterAll(async () => {
	await local?.stop();
	for (const s of sockets) s.destroy();
	silent?.close();
});

describe("in process, no model", () => {
	test("a1: a resume replays every logged event after the cursor in order, then goes live with no gap and no duplicate", async () => {
		const s = (await call("POST", "/session", { title: `it-a1-${N}` })).json;
		const first = await call("GET", `/session/${s.id}`);
		const cursor = first.headers.get("x-cmx2-seq")!;
		expect(cursor).toMatch(/^[0-9a-f]+:\d+$/);
		// events keep landing while the resumed stream replays and crosses its seam
		const writer = (async () => {
			for (let i = 0; i < 400; i++) await call("PATCH", `/session/${s.id}`, { title: `it-a1-${N}-${i}` });
		})();
		await Bun.sleep(30);
		const tap = new Tap(`${base}/global/event`, { "last-event-id": cursor });
		await writer;
		const head = Number((await call("GET", "/session/status")).headers.get("x-cmx2-seq")!.split(":")[1]);
		await tap.until((t) => t.logged().length > 0 && seqOf(t.logged().at(-1)!) >= head, "the head");
		const seqs = tap.logged().map(seqOf);
		const from = Number(cursor.split(":")[1]);
		console.log(`a1 seam: cursor ${cursor}, head ${head}, got ${seqs.length} logged frames ${seqs[0]}..${seqs.at(-1)}`);
		expect(seqs).toEqual(Array.from({ length: head - from }, (_, i) => from + 1 + i));
		expect(tap.payloads()[0].type).toBe("server.connected");
		// every logged body carries the same seq and epoch as its sse id
		for (const b of tap.logged()) {
			const p = JSON.parse(b.split("\ndata: ")[1]!).payload;
			expect(`${p.epoch}:${p.seq}`).toBe(idOf(b));
			expect(p.id).toBe(idOf(b));
		}
		tap.close();
	}, 30_000); // 400 sequential patches: under the full suite's load they have taken longer than the 5 s default

	test("a1: expired, foreign-epoch and invalid cursors get stream.reset first, then the stream goes live", async () => {
		const epoch = (await call("GET", "/session/status")).headers.get("x-cmx2-seq")!.split(":")[0]!;
		const cases: Array<[string, string]> = [
			["not-a-cursor", "invalid"],
			[`${epoch}:999999999`, "invalid"],
			["abcdef012345:3", "epoch"],
		];
		for (const [raw, reason] of cases) {
			const t = new Tap(`${base}/global/event?after=${encodeURIComponent(raw)}`);
			await t.until((x) => x.blocks.length >= 2, "reset and connected");
			const [reset, connected] = t.payloads();
			expect(reset).toMatchObject({ type: "stream.reset", properties: { reason, epoch } });
			expect(t.blocks[0]!.startsWith(`id: ${epoch}:`)).toBe(true);
			expect(connected.type).toBe("server.connected");
			t.close();
		}
		// a window of 5 events and no age: older cursors expire once pruned
		const d2 = serve({ config: { ...structuredClone(DEFAULTS), sources: [] }, port: port(4837), hostname: "127.0.0.1", dataDir: join(root, "data-window"), password: "asks", eventWindow: { events: 5, ms: 0 } });
		try {
			const b2 = `http://127.0.0.1:${d2.server.port}`;
			const h = { ...AUTH, "content-type": "application/json", "x-cmx2-directory": work };
			const old = (await fetch(`${b2}/session/status`, { headers: h })).headers.get("x-cmx2-seq")!;
			for (let i = 0; i < 8; i++) await fetch(`${b2}/session`, { method: "POST", headers: h, body: JSON.stringify({ title: `it-win-${i}` }) });
			const pruned = d2.store.pruneEvents({ events: 5, ms: 0 });
			const t = new Tap(`${b2}/global/event`, { "last-event-id": old });
			await t.until((x) => x.blocks.length >= 2, "expired reset");
			expect(t.payloads()[0]).toMatchObject({ type: "stream.reset", properties: { reason: "expired" } });
			console.log(`a1 expired: cursor ${old} after pruning ${pruned} rows (pruned through ${d2.store.eventsPrunedThrough()}) -> ${t.blocks[0]!.split("\n")[1]}`);
			t.close();
		} finally {
			await d2.stop();
		}
	});

	test("a2: a read's x-cmx2-seq is exact: racing reads against publishes, no event is applied twice or lost", async () => {
		const s = (await call("POST", "/session", { title: `it-a2-${N}` })).json;
		const start = (await call("GET", `/session/${s.id}`)).headers.get("x-cmx2-seq")!;
		const tap = new Tap(`${base}/global/event`, { "last-event-id": start });
		const reads: Array<{ seq: number; title: string }> = [];
		// rounds of 50: the client and the daemon share this process's event loop, and a burst of hundreds of fresh
		// sockets here can overflow the accept queue (a daemon in its own process takes 1,000 at once; GOTCHAS)
		for (let round = 0; round < 6; round++) {
			await Promise.all(
				Array.from({ length: 50 }, (_, j) => {
					const i = round * 50 + j;
					return i % 2
						? call("PATCH", `/session/${s.id}`, { title: `t-${i}` })
						: call("GET", `/session/${s.id}`).then((r) => reads.push({ seq: Number(r.headers.get("x-cmx2-seq")!.split(":")[1]), title: r.json.title }));
				}),
			);
		}
		const head = Number((await call("GET", `/session/${s.id}`)).headers.get("x-cmx2-seq")!.split(":")[1]);
		await tap.until((t) => t.logged().length > 0 && seqOf(t.logged().at(-1)!) >= head, "the head");
		const titles = new Map<number, string>();
		for (const b of tap.logged()) {
			const p = JSON.parse(b.split("\ndata: ")[1]!).payload;
			if (p.type === "session.updated" && p.properties.sessionID === s.id) titles.set(p.seq, p.properties.info.title);
		}
		// the state a read returned is exactly the state after applying every event up to its seq and none after
		let mismatches = 0;
		for (const r of reads) {
			const applied = [...titles].filter(([q]) => q <= r.seq).at(-1)?.[1] ?? `it-a2-${N}`;
			if (applied !== r.title) mismatches++;
		}
		const seqs = tap.logged().map(seqOf);
		console.log(`a2 race: ${reads.length} reads against ${titles.size} title events; mismatches ${mismatches}; stream ${seqs.length} frames, duplicates ${seqs.length - new Set(seqs).size}`);
		expect(mismatches).toBe(0);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(new Set(reads.map((r) => r.seq)).size).toBeGreaterThan(5);
		tap.close();
	});

	test("a4 and a11: a client id acts once and rides the events; queue and prompt_async return the message id and announce it", async () => {
		const s = (await call("POST", "/session", { title: `it-a4-${N}` })).json;
		const tap = new Tap(`${base}/global/event`);
		await tap.until((t) => t.blocks.length > 0, "connected");
		const cid = crypto.randomUUID();
		const a = await call("POST", `/session/${s.id}/prompt_async`, { clientID: cid, parts: [{ type: "text", text: "start a turn that never answers" }] });
		const b = await call("POST", `/session/${s.id}/prompt_async`, { clientID: cid, parts: [{ type: "text", text: "start a turn that never answers" }] });
		expect(a.status).toBe(202);
		// bun's toMatchObject writes asymmetric matchers into the received object, so ids are read first
		const aID: string = a.json.messageID;
		expect(aID).toMatch(/^msg_/);
		expect(a.json.queued).toBe(false);
		expect(b.text).toBe(a.text);
		expect(b.headers.get("x-cmx2-repeat")).toBe("true");
		expect((await call("POST", `/session/${s.id}/queue`, { clientID: cid, text: "x" })).status).toBe(409);

		// busy now: a queued send is announced as a provisional message under the id it returned
		const qid = crypto.randomUUID();
		const q = await call("POST", `/session/${s.id}/queue`, { clientID: qid, text: "after this turn" });
		const qID: string = q.json.messageID;
		expect([q.json.result, qID]).toEqual(["queued", expect.stringMatching(/_q/)]);
		const again = await call("POST", `/session/${s.id}/queue`, { clientID: qid, text: "after this turn" });
		expect(again.text).toBe(q.text);
		expect((await call("GET", "/session/status")).json[s.id]).toMatchObject({ type: "busy", queued: 1 });
		const pa = await call("POST", `/session/${s.id}/prompt_async`, { parts: [{ type: "text", text: "and this" }] });
		const paID: string = pa.json.messageID;
		expect([pa.json.queued, paID]).toEqual([true, expect.stringMatching(/_q/)]);

		await tap.until((t) => t.payloads().some((p) => p.type === "message.updated" && p.properties.info.id === paID), "the provisional message");
		const ps = tap.payloads();
		const firstUser = ps.find((p) => p.type === "message.updated" && p.properties.info.id === aID);
		expect(firstUser?.properties.info).toMatchObject({ role: "user", clientID: cid });
		expect(ps.find((p) => p.type === "message.updated" && p.properties.info.id === qID)?.properties.info).toMatchObject({ queued: true, clientID: qid });
		expect(ps.find((p) => p.type === "session.queued")?.properties.clientID).toBe(qid);
		expect(ps.filter((p) => p.type === "message.updated" && p.properties.info.clientID === cid).length).toBe(1);
		const msgs = (await call("GET", `/session/${s.id}/message`)).json;
		expect(msgs.filter((m: any) => m.info.role === "user").map((m: any) => m.info.id)).toEqual([aID]);
		console.log(`a4: first ${a.text} repeat ${b.text} (x-cmx2-repeat ${b.headers.get("x-cmx2-repeat")}); a11: queue -> ${qID}, prompt_async -> ${paID}`);
		await call("POST", `/session/${s.id}/abort`);
		tap.close();
	}, 60_000);
});

// ---------- the cli daemon and a real provider ----------

liveNote("the real provider part of asks.test.ts");
liveDescribe("a real daemon and a real provider", () => {
	const PORT = port(4834);
	const CONFIG = join(SCRATCH, "config");
	const REPO = join(SCRATCH, "repo");
	const DATA = join(SCRATCH, "data-real");
	let d: Daemon;
	const env = { CMX2_CONFIG_DIR: CONFIG, CMX2_MODEL: "anthropic/claude-sonnet-5-5", CMX2_EFFORT: "low" };
	const start = async () => {
		d = new Daemon({ port: PORT, dataDir: DATA, log: join(SCRATCH, `daemon-${Date.now()}.log`), password: "asks", env });
		await d.start();
	};

	beforeAll(async () => {
		liveProfile(CONFIG);
		await gitRepo(REPO, { "README.md": "# asks\n" });
		// shell asks first in this project, so a turn raises permission asks on demand
		mkdirSync(join(REPO, ".cmx2"), { recursive: true });
		writeFileSync(join(REPO, ".cmx2", "cmx2.jsonc"), JSON.stringify({ permission: { shell: { "*": "allow", "touch *": "ask" } } }));
		await start();
	}, 30_000);

	afterAll(async () => {
		await d?.stop();
	});

	const session = async (title: string) => (await d.api("/session", { directory: REPO, title })).id as string;

	test(
		"a1: kill the daemon mid-stream, restart it, resume from the last id: the replay is byte-identical to what was seen live",
		async () => {
			const live = new Tap(`${d.base}/global/event`);
			await live.until((t) => t.blocks.length > 0, "connected");
			const id = await session(`it-a1-restart-${N}`);
			await d.api(`/session/${id}/prompt`, { text: "write the numbers from one to sixty in words, one per line, nothing else" });
			await live.until((t) => t.payloads().filter((p) => p.type === "message.part.delta" && p.properties.sessionID === id).length >= 15, "15 deltas", 120_000);
			await d.kill();
			await Bun.sleep(200);
			const seen = live.logged();
			live.close();
			// deltas carry offsets that tile each part's text with no gap, and only go to a part announced before them
			const deltas = live.payloads().filter((p) => p.type === "message.part.delta" && p.properties.sessionID === id);
			const announced = new Set(live.payloads().filter((p) => p.type === "message.part.updated" && p.properties.part.streaming).map((p) => p.properties.part.id));
			const upTo = new Map<string, number>();
			let at = 0;
			for (const dl of deltas) {
				expect(announced.has(dl.properties.partID)).toBe(true);
				expect(dl.properties.offset).toBe(upTo.get(dl.properties.partID) ?? 0);
				upTo.set(dl.properties.partID, (upTo.get(dl.properties.partID) ?? 0) + dl.properties.delta.length);
				at += dl.properties.delta.length;
			}
			const cursor = idOf(seen[1]!);
			const expected = seen.slice(2);

			await start();
			const resumed = new Tap(`${d.base}/global/event`, { "last-event-id": cursor });
			await resumed.until((t) => t.logged().length >= expected.length, `${expected.length} replayed frames`);
			const replayed = resumed.logged().slice(0, expected.length);
			const same = replayed.every((b, i) => b === expected[i]);
			const seqs = resumed.logged().map(seqOf);
			console.log(`a1 restart: killed after ${deltas.length} deltas (${at} characters streamed). live saw ${seen.length} logged frames; resumed from ${cursor}`);
			console.log(`  live    : ${expected.map((b) => `${seqOf(b)} ${JSON.parse(b.split("\ndata: ")[1]!).payload.type}`).join(", ")}`);
			console.log(`  replayed: ${replayed.map((b) => `${seqOf(b)} ${JSON.parse(b.split("\ndata: ")[1]!).payload.type}`).join(", ")}`);
			console.log(`  byte-identical: ${same} (${replayed.reduce((n, b) => n + b.length, 0)} bytes each side); after the replay the stream went live with ${resumed.logged().length - expected.length} more logged frames; strictly increasing: ${seqs.every((q, i) => i === 0 || q > seqs[i - 1]!)}`);
			expect(same).toBe(true);
			expect(seqs.every((q, i) => i === 0 || q > seqs[i - 1]!)).toBe(true);
			resumed.close();
		},
		240_000,
	);

	test(
		"a5 and the streaming resend: mid-answer, reads include the words so far; a resumed stream gets the part once in full",
		async () => {
			const tap = new Tap(`${d.base}/global/event`);
			await tap.until((t) => t.blocks.length > 0, "connected");
			const id = await session(`it-a5-${N}`);
			await d.api(`/session/${id}/prompt`, { text: "write the numbers from one to seventy in words, one per line, nothing else" });
			// ten deltas of the reply itself: a model that thinks first streams its thinking before the text
			const replyDeltas = (t: Tap) => {
				const texts = new Set(t.payloads().filter((p) => p.type === "message.part.updated" && p.properties.part.streaming && p.properties.part.type === "text" && p.properties.part.sessionID === id).map((p) => p.properties.part.id));
				return t.payloads().filter((p) => p.type === "message.part.delta" && p.properties.sessionID === id && texts.has(p.properties.partID));
			};
			await tap.until((t) => replyDeltas(t).length >= 10, "10 deltas of the reply", 120_000);
			const res = await d.raw(`/session/${id}/message`);
			const list = await res.json();
			const last = list.at(-1);
			const reply = last.parts.find((p: any) => p.type === "text");
			const text = reply?.text ?? "";
			expect(last.info.role).toBe("assistant");
			expect(last.info.time.completed).toBeUndefined();
			expect(reply).toMatchObject({ type: "text", streaming: true });
			// every part the message has started is typed and in content order: thinking, if any, ahead of the reply
			// a part whose block has ended (the thinking, once the reply began) reads final, with time.end; the reply is still streaming
			expect(last.parts.every((p: any) => typeof p.time?.start === "number" && (p.type === "text" || p.type === "reasoning") && (p.streaming === true ? p.time.end === undefined : typeof p.time.end === "number"))).toBe(true);
			expect(reply.streaming).toBe(true);
			expect(last.parts.map((p: any) => Number(p.id.split("_").at(-1)))).toEqual(last.parts.map((_: unknown, i: number) => i));
			expect(text.length).toBeGreaterThan(0);
			const one = await d.api(`/session/${id}/message/${last.info.id}`);
			expect(one.info.id).toBe(last.info.id);
			expect(one.parts.find((p: any) => p.id === reply.id).text.startsWith(text)).toBe(true);
			// the read's text is exactly the deltas below its length
			const deltas = tap.payloads().filter((p) => p.type === "message.part.delta" && p.properties.partID === reply.id);
			const prefix = deltas.filter((x) => x.properties.offset < text.length).map((x) => x.properties.delta).join("");
			expect(prefix).toBe(text);
			// a stream resuming at the read's cursor gets the streaming part in full, then the deltas after it
			const resumed = new Tap(`${d.base}/global/event`, { "last-event-id": res.headers.get("x-cmx2-seq")! });
			await resumed.until((t) => t.payloads().some((p) => p.type === "message.part.updated" && p.properties.part.id === reply.id && p.properties.part.streaming), "the streaming resend");
			const resend = resumed.payloads().find((p) => p.type === "message.part.updated" && p.properties.part.id === reply.id && p.properties.part.streaming)!;
			expect(resend.properties.part.text.startsWith(text)).toBe(true);
			expect(resend.seq).toBeUndefined();
			await resumed.until((t) => t.payloads().some((p) => p.type === "message.part.delta" && p.properties.partID === reply.id), "a delta after the resend");
			const after = resumed.payloads().find((p) => p.type === "message.part.delta" && p.properties.partID === reply.id)!;
			expect(after.properties.offset).toBe(resend.properties.part.text.length);
			console.log(`a5: read mid-answer: ${last.parts.map((p: any) => `${p.type} ${p.text.length}`).join(", ")} characters, streaming ${reply.streaming}, x-cmx2-seq ${res.headers.get("x-cmx2-seq")}; the resend carried ${resend.properties.part.text.length}; the next delta's offset ${after.properties.offset}`);
			resumed.close();
			await d.idle(id);
			const done = await d.api(`/session/${id}/message`);
			expect(done.at(-1).parts.every((p: any) => p.streaming === undefined)).toBe(true);
			tap.close();
		},
		240_000,
	);

	test(
		"a6: asks as a contract on a real turn: 404 unknown, 409 settled with who and when, abort rejects the asks left open with events",
		async () => {
			const tap = new Tap(`${d.base}/global/event`);
			await tap.until((t) => t.blocks.length > 0, "connected");
			const id = await session(`it-a6-${N}`);
			await d.api(`/session/${id}/prompt`, { text: "in one response, make three separate shell calls at once: `touch a1.txt`, `touch a2.txt` and `touch a3.txt`. do not combine them." });
			// pi gates calls one at a time: the second ask exists once the first is answered
			const pending = async (not: string[] = []) =>
				d.until(async () => (await d.api("/permission")).find((x: any) => x.sessionID === id && !not.includes(x.id)), "a permission ask", 120_000);
			const one = await pending();
			expect((await d.raw(`/permission/per_nope/reply`, { reply: "once" })).status).toBe(404);
			expect(await d.api(`/permission/${one.id}/reply`, { reply: "once", by: "phone" })).toBe(true);
			const again = await d.raw(`/permission/${one.id}/reply`, { reply: "reject", by: "mac" });
			const body = await again.json();
			expect(again.status).toBe(409);
			expect(body).toMatchObject({ name: "ConflictError", data: { reply: "once", by: "phone", settledAt: expect.any(Number) } });
			const two = await pending([one.id]);
			await d.api(`/session/${id}/abort`, {});
			await tap.until((t) => t.payloads().some((p) => p.type === "permission.replied" && p.properties.requestID === two.id), "the abort's rejection");
			const byAbort = tap.payloads().find((p) => p.type === "permission.replied" && p.properties.requestID === two.id)!;
			expect(byAbort.properties).toMatchObject({ reply: "reject", by: "abort" });
			expect((await d.api("/permission")).filter((x: any) => x.sessionID === id)).toEqual([]);
			const late = await (await d.raw(`/permission/${two.id}/reply`, { reply: "once" })).json();
			expect(late.data).toMatchObject({ reply: "reject", by: "abort" });

			// a question left open by a stopped turn goes the same way
			const q = await session(`it-a6q-${N}`);
			await d.api(`/session/${q}/prompt`, { text: "use the question tool to ask me one question: red or blue? then wait for my answer." });
			const asked = await d.until(async () => (await d.api("/question")).find((x: any) => x.sessionID === q), "a question", 120_000);
			await d.api(`/session/${q}/abort`, {});
			await tap.until((t) => t.payloads().some((p) => p.type === "question.rejected" && p.properties.requestID === asked.id), "question.rejected");
			const qr = tap.payloads().find((p) => p.type === "question.rejected" && p.properties.requestID === asked.id)!;
			expect(qr.properties.by).toBe("abort");
			const lateQ = await d.raw(`/question/${asked.id}/reply`, { answers: [["red"]] });
			expect(lateQ.status).toBe(409);
			console.log(`a6: ${one.id} answered once by phone; a second reply -> 409 "${body.data.message}"; ${two.id} and ${asked.id} left open by stopped turns -> ${byAbort.type} ${byAbort.properties.reply} by ${byAbort.properties.by}, ${qr.type} by ${qr.properties.by}; a late answer -> 409 ${JSON.stringify(late.data)}`);
			tap.close();
		},
		300_000,
	);

	test(
		"a9: a running shell reports its output tail at most once a second",
		async () => {
			const tap = new Tap(`${d.base}/global/event`);
			await tap.until((t) => t.blocks.length > 0, "connected");
			const id = await session(`it-a9-${N}`);
			const t0 = Date.now();
			const stamps: number[] = [];
			const watch = setInterval(() => {
				const n = tap.payloads().filter((p) => p.type === "message.part.updated" && p.properties.part.type === "tool" && p.properties.part.state?.metadata?.output !== undefined && p.properties.part.state.status === "running").length;
				while (stamps.length < n) stamps.push(Date.now() - t0);
			}, 20);
			await d.api(`/session/${id}/prompt`, { text: "run exactly this with the shell tool and nothing else: for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done" });
			await d.idle(id, 180_000);
			clearInterval(watch);
			const progress = tap.payloads().filter((p) => p.type === "message.part.updated" && p.properties.part.type === "tool" && p.properties.part.state?.status === "running" && p.properties.part.state.metadata?.output !== undefined);
			const gaps = stamps.slice(1).map((s, i) => s - stamps[i]!);
			console.log(`a9: ${progress.length} progress updates; tails: ${progress.map((p) => JSON.stringify(p.properties.part.state.metadata.output.trim().split("\n").at(-1))).join(", ")}; gaps ms ${gaps.join(", ")}`);
			expect(progress.length).toBeGreaterThanOrEqual(3);
			expect(progress.at(-1)!.properties.part.state.metadata.output).toContain("tick");
			expect(progress.every((p) => p.properties.part.state.metadata.output.length <= 2048)).toBe(true);
			expect(gaps.every((g) => g >= 900)).toBe(true);
			tap.close();
		},
		240_000,
	);
});

// ---------- a3: its own daemon, so rss is the daemon's alone ----------

/** the same load twice on fresh daemons: without a stalled subscriber, then with one; rss after a full gc */
async function a3Run(stalled: boolean) {
	const tag = stalled ? "stall" : "control";
	mkdirSync(join(SCRATCH, `config-a3-${tag}`), { recursive: true });
	const d = new Daemon({ port: port(4835), dataDir: join(SCRATCH, `data-a3-${tag}`), log: join(SCRATCH, `a3-${tag}.log`), password: "asks", env: { CMX2_CONFIG_DIR: join(SCRATCH, `config-a3-${tag}`) } });
	await d.start();
	try {
		const fast = new Tap(`${d.base}/global/event`);
		// a peer that connects and never reads: its kernel buffers fill and the daemon's backlog grows
		const stall = stalled
			? Bun.spawn(["python3", "-c", `import socket,time\ns=socket.create_connection(("127.0.0.1",${port(4835)}))\ns.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4096)\ns.sendall(b"GET /global/event HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: ${AUTH.authorization}\\r\\n\\r\\n")\ntime.sleep(120)`])
			: undefined;
		await Bun.sleep(500);
		const s = (await d.api("/session", { directory: SCRATCH, title: "it-a3" })).id;
		const warm = async (n: number) => {
			for (let i = 0; i < n; i++) await Promise.all(Array.from({ length: 20 }, (_, j) => d.api(`/session/${s}`, { title: `${"x".repeat(4000)}-${i}-${j}` }, "PATCH")));
		};
		await warm(20);
		const before = (await d.api("/global/memory?gc=true")).rss / 1e6;
		await warm(600);
		await Bun.sleep(500);
		const after = (await d.api("/global/memory?gc=true")).rss / 1e6;
		const closed = readFileSync(`${join(SCRATCH, `a3-${tag}.log`)}.err`, "utf8")
			.split("\n")
			.filter((l) => l.includes("closed an event stream"));
		const frames = fast.payloads().filter((p) => p.type === "session.updated").length;
		stall?.kill();
		fast.close();
		return { before, after, closed, frames };
	} finally {
		await d.stop();
	}
}

test(
	"a3: a stalled subscriber is cut off at 1 MB and cannot grow daemon rss",
	async () => {
		const control = await a3Run(false);
		const stalled = await a3Run(true);
		const grow = (r: { before: number; after: number }) => r.after - r.before;
		console.log(`a3: 12,000 session.updated events of ~4.7 KB (~56 MB) published on each daemon, rss after a full gc:`);
		console.log(`  no stalled peer : ${control.before.toFixed(1)} -> ${control.after.toFixed(1)} MB (${grow(control) >= 0 ? "+" : ""}${grow(control).toFixed(1)}); streams closed ${control.closed.length}; the reading subscriber got ${control.frames}`);
		console.log(`  a stalled peer  : ${stalled.before.toFixed(1)} -> ${stalled.after.toFixed(1)} MB (${grow(stalled) >= 0 ? "+" : ""}${grow(stalled).toFixed(1)}); streams closed ${stalled.closed.length}; the reading subscriber got ${stalled.frames}`);
		console.log(`  daemon said: ${stalled.closed[0]?.replace(/^.*cmx2: /, "") ?? "(nothing)"}`);
		expect(control.closed.length).toBe(0);
		expect(stalled.closed.length).toBe(1);
		// what bounds memory is where the stream is cut: 1 MB behind, not the 56 MB it would otherwise hold. rss
		// after a gc cannot show a 1 MB difference: the same run grew -2.6, +2.2, +49.1 and +69.4 MB across four
		// daemons (2026-10-01), so it is printed above and the cut point is what is asserted
		const kb = Number(stalled.closed[0]?.match(/fell (\d+) KB behind/)?.[1] ?? Number.NaN);
		expect(kb).toBeGreaterThanOrEqual(1024);
		expect(kb).toBeLessThan(1100);
		expect(stalled.frames).toBe(control.frames);
	},
	// 24,800 requests over two daemons: at the 2,000-in-6-to-16-s this machine measured under load, 300 s was not enough
	600_000,
);

test("a6: reject settles one ask; the cascade only when asked for, each with who settled it", async () => {
	const { Store } = await import("@cmx2/store");
	const { Asks } = await import("../src/asks.ts");
	const store = new Store(join(SCRATCH, "asks-unit.db"), { archivePath: null });
	const events: Array<{ type: string; props: any }> = [];
	const asks = new Asks(store, (_d, type, props) => events.push({ type, props }), () => false);
	const ask = (n: number) => asks.permission("ses_unit", "/tmp", { permission: "shell", patterns: [`touch ${n}`], metadata: {}, always: [], callID: `c${n}`, messageSeq: 2 });
	const results = [ask(1), ask(2), ask(3), ask(4)];
	const ids = store.pendingPermissions().map((p) => p.id);
	expect(asks.replyPermission(ids[0]!, "reject", { by: "phone" })).toEqual({ ok: true });
	expect(store.pendingPermissions().map((p) => p.id)).toEqual(ids.slice(1));
	expect(asks.replyPermission(ids[1]!, "reject", { by: "mac", cascade: true })).toEqual({ ok: true });
	expect(store.pendingPermissions()).toEqual([]);
	expect(await Promise.all(results)).toEqual([{ reply: "reject" }, { reply: "reject" }, { reply: "reject" }, { reply: "reject" }]);
	expect(events.filter((e) => e.type === "permission.replied").map((e) => e.props.by)).toEqual(["phone", "mac", "cascade", "cascade"]);
	expect(asks.replyPermission(ids[3]!, "once")).toMatchObject({ ok: false, kind: "settled", reply: "reject", by: "cascade" });
	expect(asks.replyPermission("per_missing", "once")).toEqual({ ok: false, kind: "unknown" });
	store.close();
});
