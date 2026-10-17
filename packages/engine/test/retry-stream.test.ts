import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type Config, DEFAULTS } from "../src/config.ts";
import { withRetry } from "../src/retry.ts";
import { type EngineEvent, EngineSession } from "../src/session.ts";

/** a provider failure after some events: thinking, text or a tool call. fake event streams, no network */

const FAST = { maxRetries: 4, baseDelayMs: 5, maxDelayMs: 10 };
const DROPPED = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

function message(content: any[], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	} as AssistantMessage;
}

type Step = "thinking" | "text" | "tool" | "fail" | "done";

/** one attempt: each step's events, each carrying the attempt's own partial */
function attempt(steps: Step[], tag: string): AssistantMessageEventStream {
	const s = createAssistantMessageEventStream();
	const content: any[] = [];
	const partial = () => message([...content.map((c) => ({ ...c }))]);
	queueMicrotask(() => {
		s.push({ type: "start", partial: partial() });
		for (const step of steps) {
			const i = content.length;
			if (step === "thinking") {
				content.push({ type: "thinking", thinking: "" });
				s.push({ type: "thinking_start", contentIndex: i, partial: partial() });
				content[i].thinking = `thought ${tag}`;
				s.push({ type: "thinking_delta", contentIndex: i, delta: `thought ${tag}`, partial: partial() });
				s.push({ type: "thinking_end", contentIndex: i, content: `thought ${tag}`, partial: partial() });
			} else if (step === "text") {
				content.push({ type: "text", text: "" });
				s.push({ type: "text_start", contentIndex: i, partial: partial() });
				content[i].text = `text ${tag}`;
				s.push({ type: "text_delta", contentIndex: i, delta: `text ${tag}`, partial: partial() });
			} else if (step === "tool") {
				const call = { type: "toolCall", id: `call_${tag}`, name: "read", arguments: {} };
				content.push(call);
				s.push({ type: "toolcall_start", contentIndex: i, partial: partial() });
				s.push({ type: "toolcall_end", contentIndex: i, toolCall: call as never, partial: partial() });
			} else if (step === "fail") {
				s.push({ type: "error", reason: "error", error: message(partial().content, "error", DROPPED) });
				s.end();
				return;
			} else {
				s.push({ type: "done", reason: "stop", message: message(partial().content) });
				s.end();
				return;
			}
		}
		s.end();
	});
	return s;
}

async function drive(attempts: Step[][]) {
	let n = 0;
	const hooks: string[] = [];
	const stream = withRetry(async () => attempt(attempts[n]!, String(++n)), {
		policy: FAST,
		hooks: { onRetry: (a) => hooks.push(`retry ${a}`), onResume: () => hooks.push("resume"), onDiscard: () => hooks.push("discard") },
	});
	const events: AssistantMessageEvent[] = [];
	for await (const ev of stream) events.push(ev);
	return { events, hooks, attempts: n, result: await stream.result() };
}

describe("withRetry after streamed content", () => {
	test("an error after thinking is retried; one start reaches the loop and the result is the retry's", async () => {
		const { events, hooks, attempts, result } = await drive([["thinking", "fail"], ["thinking", "text", "done"]]);
		expect(attempts).toBe(2);
		expect(hooks).toEqual(["discard", "retry 1", "resume"]);
		expect(events.filter((e) => e.type === "start").length).toBe(1);
		expect(events.some((e) => e.type === "error")).toBe(false);
		// every event after the retry carries the retry's partial only: the loop replaces the message with it
		const after = events.slice(events.findIndex((e) => e.type === "thinking_end") + 1);
		expect(after[0]!.type).toBe("thinking_start");
		expect((after[0] as any).partial.content).toEqual([{ type: "thinking", thinking: "" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thought 2" },
			{ type: "text", text: "text 2" },
		]);
	});

	test("an error before any content is retried as before, without a discard", async () => {
		const { events, hooks, attempts } = await drive([["fail"], ["text", "done"]]);
		expect(attempts).toBe(2);
		expect(hooks).toEqual(["retry 1", "resume"]);
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "done"]);
	});

	test("an error after text passes through", async () => {
		const { events, hooks, attempts, result } = await drive([["thinking", "text", "fail"], ["text", "done"]]);
		expect(attempts).toBe(1);
		expect(hooks).toEqual([]);
		expect(events.at(-1)!.type).toBe("error");
		expect(result.errorMessage).toBe(DROPPED);
	});

	test("an error after a tool call passes through", async () => {
		const { events, hooks, attempts } = await drive([["tool", "fail"], ["text", "done"]]);
		expect(attempts).toBe(1);
		expect(hooks).toEqual([]);
		expect(events.at(-1)!.type).toBe("error");
	});

	test("thinking that fails every attempt ends with the last error once the retries run out", async () => {
		const { events, hooks, attempts } = await drive([1, 2, 3, 4, 5].map(() => ["thinking", "fail"] as Step[]));
		expect(attempts).toBe(5);
		expect(hooks.filter((h) => h === "discard").length).toBe(4);
		expect(events.filter((e) => e.type === "start").length).toBe(1);
		expect(events.at(-1)!.type).toBe("error");
	});
});

/**
 * the same failure over the wire: an anthropic sse stream cut after its first thinking delta, then a whole
 * answer. the engine, pi's agent loop, its adapter and the sdk run for real against a local upstream
 */

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const head = (id: string) => [
	ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
	ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
];
const thought = (text: string) => ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } });
const whole = [
	...head("msg_two"),
	thought("second thought"),
	ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } }),
	ev("content_block_stop", { type: "content_block_stop", index: 0 }),
	ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "pong" } }),
	ev("content_block_stop", { type: "content_block_stop", index: 1 }),
	ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
	ev("message_stop", { type: "message_stop" }),
].join("");

const requests: any[] = [];

/** a raw socket server, so the first answer can end the way the incident did: the connection closes mid-stream */
function listen() {
	return Bun.listen<{ buf: string }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(sock) {
				sock.data = { buf: "" };
			},
			data(sock, chunk) {
				sock.data.buf += chunk.toString();
				const at = sock.data.buf.indexOf("\r\n\r\n");
				if (at < 0) return;
				const length = Number(/content-length: (\d+)/i.exec(sock.data.buf.slice(0, at))?.[1] ?? 0);
				const body = sock.data.buf.slice(at + 4);
				if (Buffer.byteLength(body) < length) return;
				sock.data.buf = "";
				requests.push(JSON.parse(body));
				const chunked = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
				sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n");
				if (requests.length > 1) {
					sock.write(chunked(whole) + "0\r\n\r\n");
					sock.end();
					return;
				}
				// the first answer streams a thought, then the connection drops
				sock.write(chunked([...head("msg_one"), thought("first thought")].join("")));
				setTimeout(() => sock.end(), 50);
			},
		},
	});
}

let server: ReturnType<typeof listen>;

beforeAll(() => {
	server = listen();
});

afterAll(() => server.stop(true));

test("a connection dropped after thinking: retried, one assistant message, the restart visible to clients", async () => {
	const config: Config = { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] };
	const events: EngineEvent[] = [];
	const s = await EngineSession.create({ cwd: mkdtempSync(join(tmpdir(), "cmx2-retry-")), config, dataDir: mkdtempSync(join(tmpdir(), "cmx2-retry-data-")), retry: FAST, onEvent: (e) => events.push(e), onStep: () => {} });
	await s.prompt("ping");
	await s.idle();
	s.dispose();
	const assistants = s.messages.filter((m: any) => m.role === "assistant") as any[];
	console.log("retry status:", JSON.stringify(events.find((e) => e.type === "session.status" && (e.properties.status as any).type === "retry")?.properties.status));
	expect(requests.length).toBe(2);
	expect(assistants.length).toBe(1);
	expect(assistants[0].stopReason).toBe("stop");
	expect(assistants[0].content.map((b: any) => b.thinking ?? b.text)).toEqual(["second thought", "pong"]);
	expect(JSON.stringify(s.messages)).not.toContain("first thought");
	expect(events.some((e) => e.type === "session.error")).toBe(false);
	expect(events.filter((e) => e.type === "session.status").map((e) => (e.properties.status as any).type)).toEqual(["busy", "retry", "busy", "idle"]);
	// the retry's first token announces the message again and its reasoning part again, empty, at the same place
	const stream = events.filter((e) => e.type.startsWith("message.")).map((e) => `${e.type} ${(e.properties as any).seq}:${(e.properties as any).index ?? ""}`);
	console.log("stream:", stream.filter((x) => !x.startsWith("message.part.delta")).join(", "));
	const started = events.filter((e) => e.type === "message.started");
	expect(started.length).toBe(2);
	expect(started[0]!.properties.seq).toBe(started[1]!.properties.seq);
	const parts = events.filter((e) => e.type === "message.part.started" && (e.properties as any).index === 0);
	expect(parts.length).toBe(2);
	expect(events.indexOf(parts[1]!)).toBeGreaterThan(events.indexOf(started[1]!));
	// the request after the retry is the same as the first: nothing of the failed attempt went into it
	expect(JSON.stringify(requests[1].messages)).toBe(JSON.stringify(requests[0].messages));
});
