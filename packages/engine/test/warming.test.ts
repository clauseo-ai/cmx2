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

function sse(text: string): string {
	const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return [
		ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } }),
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

async function session(horizonMs: number) {
	const events: EngineEvent[] = [];
	const s = await EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-warm-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-warm-data-")),
		warm: () => ({ enabled: true, horizonMs }),
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
