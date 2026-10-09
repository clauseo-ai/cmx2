import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config.ts";
import { type EngineEvent, EngineSession } from "../src/session.ts";

/**
 * what the engine says about a streaming message: each text and reasoning part is announced
 * (`message.part.started`) before its first delta, closed when its block ends (`message.part.ended`, the
 * provider's whole text and when it ended), and the finished message carries when each part started and ended. a local upstream speaking anthropic's wire format (a fixture, as in retry.test.ts);
 * pi's adapter and the engine run for real against it.
 */

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

const thinkingThenText = [
	ev("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
	ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
	ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "let me " } }),
	ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "think" } }),
	ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "c2ln" } }),
	ev("content_block_stop", { index: 0 }),
	ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
	ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "four" } }),
	ev("content_block_stop", { index: 1 }),
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
	ev("message_stop", {}),
].join("");

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			await req.json().catch(() => null);
			return new Response(thinkingThenText, { headers: { "content-type": "text/event-stream" } });
		},
	});
});
afterAll(() => server.stop(true));

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] };
}

const create = (events: EngineEvent[]) =>
	EngineSession.create({ cwd: mkdtempSync(join(tmpdir(), "cmx2-stream-")), config: config(), dataDir: mkdtempSync(join(tmpdir(), "cmx2-stream-data-")), onEvent: (e) => events.push(e), onStep: () => {} });

async function run() {
	const events: EngineEvent[] = [];
	const s = await create(events);
	await s.prompt("ping");
	await s.idle();
	return { events, s };
}

describe("streamed parts", () => {
	test("each part is announced before its first delta, in content order, with the position the message will land at", async () => {
		const { events, s } = await run();
		const parts = events.filter((e) => e.type.startsWith("message.part") || e.type === "message.started");
		s.dispose();
		const shape = parts.map((e) => (e.type === "message.part.started" ? `started ${e.properties.index} ${e.properties.type}` : e.type === "message.part.delta" ? `delta ${e.properties.index} ${JSON.stringify(e.properties.delta)}` : e.type === "message.part.ended" ? `ended ${e.properties.index} ${e.properties.type} ${JSON.stringify(e.properties.text)}` : e.type));
		// each part ends when its block does: the reasoning's end comes before the text is announced
		expect(shape).toEqual(["message.started", "started 0 reasoning", 'delta 0 "let me "', 'delta 0 "think"', 'ended 0 reasoning "let me think"', "started 1 text", 'delta 1 "four"', 'ended 1 text "four"']);
		// one position for the whole message: the next transcript slot
		expect(new Set(parts.map((e) => e.properties.seq)).size).toBe(1);
		expect(parts.every((e) => e.properties.field === undefined || e.properties.field === "text")).toBe(true);
	});

	test("the finished message carries when each part started and ended, by content position", async () => {
		const { events, s } = await run();
		const started = events.filter((e) => e.type === "message.part.started");
		const m = s.messages.at(-1) as any;
		s.dispose();
		expect(m.content.map((b: any) => b.type)).toEqual(["thinking", "text"]);
		expect(Object.keys(m.partTimes)).toEqual(["0", "1"]);
		expect(m.partTimes[0].start).toBe(started[0]!.properties.start);
		expect(m.partTimes[1].start).toBe(started[1]!.properties.start);
		for (const t of Object.values(m.partTimes) as Array<{ start: number; end: number }>) expect(t.end).toBeGreaterThanOrEqual(t.start);
		// the thinking ended no later than the text began
		expect(m.partTimes[0].end).toBeLessThanOrEqual(m.partTimes[1].start);
		// the times the message carries are the ones the events said, so the step's end agrees with the block's end
		const ended = events.filter((e) => e.type === "message.part.ended");
		expect(ended.map((e) => [e.properties.start, e.properties.end])).toEqual([0, 1].map((i) => [m.partTimes[i].start, m.partTimes[i].end]));
		expect(ended.map((e) => e.properties.text)).toEqual(m.content.map((b: any) => b.thinking ?? b.text));
		// the events carry the position the message lands at, and the started event always precedes the ended one
		expect(new Set(events.filter((e) => e.type.startsWith("message.part")).map((e) => e.properties.seq)).size).toBe(1);
		const order = events.filter((e) => e.type.startsWith("message.part")).map((e) => `${e.type}:${e.properties.index}`);
		for (const i of [0, 1]) expect(order.indexOf(`message.part.started:${i}`)).toBeLessThan(order.indexOf(`message.part.ended:${i}`));
	});

	test("a block's end is said once, and an end for a part nothing announced announces it first", async () => {
		const events: EngineEvent[] = [];
		const s = await create(events);
		const feed = (assistantMessageEvent: unknown) => (s as any).onAgentEvent({ type: "message_update", assistantMessageEvent, message: {} });
		feed({ type: "thinking_start", contentIndex: 0 });
		feed({ type: "thinking_delta", contentIndex: 0, delta: "a" });
		feed({ type: "thinking_end", contentIndex: 0, content: "a" });
		feed({ type: "thinking_end", contentIndex: 0, content: "a" });
		// a block that is complete at its end event: no start, no deltas (redacted thinking, a provider that sends the block whole)
		feed({ type: "text_end", contentIndex: 1, content: "whole" });
		s.dispose();
		const shape = events.filter((e) => e.type.startsWith("message.part")).map((e) => `${e.type.slice("message.part.".length)} ${e.properties.index} ${e.properties.text ?? e.properties.delta ?? ""}`.trim());
		expect(shape).toEqual(["started 0", "delta 0 a", "ended 0 a", "started 1", "ended 1 whole"]);
	});

	test("a delta for a part no start event announced is announced first", async () => {
		const events: EngineEvent[] = [];
		const s = await create(events);
		const feed = (assistantMessageEvent: unknown) => (s as any).onAgentEvent({ type: "message_update", assistantMessageEvent, message: {} });
		feed({ type: "thinking_delta", contentIndex: 0, delta: "a" });
		feed({ type: "thinking_delta", contentIndex: 0, delta: "b" });
		feed({ type: "text_delta", contentIndex: 1, delta: "c" });
		s.dispose();
		const shape = events.filter((e) => e.type.startsWith("message.part")).map((e) => (e.type === "message.part.started" ? `started ${e.properties.index} ${e.properties.type}` : `delta ${e.properties.index} ${e.properties.delta}`));
		expect(shape).toEqual(["started 0 reasoning", "delta 0 a", "delta 0 b", "started 1 text", "delta 1 c"]);
	});
});
