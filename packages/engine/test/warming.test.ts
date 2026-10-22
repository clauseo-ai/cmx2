import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config.ts";
import { type EngineEvent, EngineSession } from "../src/session.ts";

/**
 * cache warming against a local stand-in for the provider (wire format only): a refresh on the wire counts as
 * warming, so the residency cache cannot evict it mid-request; a session disposed mid-refresh arms nothing
 * more; once warming stops the copy of the last request goes.
 */

function sse(text: string, outputAtStart = 1): string {
	const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return [
		ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: outputAtStart } } }),
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
}

/** requests after the turn are refreshes; each is held for `holdMs` before the provider answers */
let requests = 0;
let holdMs = 0;
/**
 * when set, the provider sends message_start at once and the first content block only after this many ms, the way a
 * thinking model does; `slow` records when that response went out and whether its stream was cancelled
 */
let thinkMs = 0;
const slow = { sentAt: 0, cancelled: false };
let server: ReturnType<typeof Bun.serve>;
const WARM_DELAY_BEFORE = process.env.CMX2_WARM_DELAY_MS;

beforeAll(() => {
	process.env.CMX2_WARM_DELAY_MS = "40";
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			await req.json().catch(() => null);
			requests++;
			if (holdMs) await Bun.sleep(holdMs);
			if (thinkMs) {
				const [start, ...rest] = sse("ok", 7).split(/(?<=\n\n)/);
				const wait = thinkMs;
				const enc = new TextEncoder();
				slow.sentAt = Date.now();
				return new Response(
					new ReadableStream({
						async start(c) {
							c.enqueue(enc.encode(start!));
							await Bun.sleep(wait);
							if (slow.cancelled) return;
							try {
								c.enqueue(enc.encode(rest.join("")));
								c.close();
							} catch {}
						},
						cancel() {
							slow.cancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(sse("ok"), { headers: { "content-type": "text/event-stream" } });
		},
	});
});
afterAll(() => {
	server.stop(true);
	if (WARM_DELAY_BEFORE === undefined) delete process.env.CMX2_WARM_DELAY_MS;
	else process.env.CMX2_WARM_DELAY_MS = WARM_DELAY_BEFORE;
});

const config = (): Config => ({ ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] });

async function session(horizonMs: number, extra: { cacheTtl?: "5m" | "1h"; ttls?: string[] } = {}) {
	const events: EngineEvent[] = [];
	const s = await EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-warm-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-warm-data-")),
		...(extra.cacheTtl ? { cacheTtl: extra.cacheTtl } : {}),
		warm: (ttl) => {
			extra.ttls?.push(ttl);
			return { enabled: true, horizonMs };
		},
		onEvent: (e) => events.push(e),
		onStep: () => {},
	});
	return { s, events };
}

const until = async (f: () => boolean, what: string, ms = 5000) => {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
};

test("a refresh on the wire counts as warming; disposed mid-refresh, the session arms no other and says nothing", async () => {
	const { s, events } = await session(60_000);
	holdMs = 0;
	await s.prompt("hello");
	await s.idle();
	const afterTurn = requests;
	holdMs = 400;
	// the refresh goes out after the warm delay and is held by the provider: the timer is cleared, only the request is in flight
	await until(() => requests > afterTurn, "the refresh request");
	await Bun.sleep(20);
	expect(s.warming).toBe(true);
	s.dispose();
	await Bun.sleep(holdMs + 300);
	expect(requests).toBe(afterTurn + 1);
	expect(events.filter((e) => e.type === "session.warmed" || e.type === "session.warning").length).toBe(0);
	expect(s.warming).toBe(false);
});

test("once warming stops (the horizon passed) the copy of the last request goes", async () => {
	const { s } = await session(150);
	holdMs = 0;
	await s.prompt("hello");
	await s.idle();
	expect(s.holdsWarmCopy).toBe(true);
	await until(() => !s.warming, "warming to stop", 3000);
	expect(s.holdsWarmCopy).toBe(false);
	s.dispose();
});

test("a refresh hangs up at message_start: it does not wait out the thinking, pays message_start's output, and says no warning", async () => {
	const { s, events } = await session(60_000);
	holdMs = 0;
	await s.prompt("hello");
	await s.idle();
	slow.sentAt = 0;
	slow.cancelled = false;
	thinkMs = 1500;
	try {
		await until(() => events.some((e) => e.type === "session.warmed"), "session.warmed", 3000);
		const warmedAt = Date.now();
		s.dispose();
		expect(slow.sentAt).toBeGreaterThan(0);
		// well before the first content block would have come
		expect(warmedAt - slow.sentAt).toBeLessThan(750);
		const w = events.find((e) => e.type === "session.warmed")!.properties as { output: number; input: number; cache_read: number; cost: number };
		expect(w.output).toBe(7);
		expect(w.input).toBe(10);
		expect(w.cache_read).toBe(90);
		expect(w.cost).toBeGreaterThan(0);
		await until(() => slow.cancelled, "the provider to see its stream cancelled", 1000);
		expect(events.filter((e) => e.type === "session.warning")).toEqual([]);
	} finally {
		thinkMs = 0;
		s.dispose();
	}
});

test("warm() is asked with the ttl in force: 5m by default, 1h for a session made with cacheTtl 1h", async () => {
	holdMs = 0;
	const short: string[] = [];
	const a = await session(10, { ttls: short });
	await a.s.prompt("hello");
	await a.s.idle();
	a.s.dispose();
	expect(short.length).toBeGreaterThan(0);
	expect(short.every((t) => t === "5m")).toBe(true);
	const long: string[] = [];
	const b = await session(10, { cacheTtl: "1h", ttls: long });
	await b.s.prompt("hello");
	await b.s.idle();
	b.s.dispose();
	expect(long.length).toBeGreaterThan(0);
	expect(long.every((t) => t === "1h")).toBe(true);
});
