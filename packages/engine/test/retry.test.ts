import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config.ts";
import { classifyProviderError } from "../src/errors.ts";
import { type EngineEvent, EngineSession, type StepRow } from "../src/session.ts";

/**
 * a local upstream speaking anthropic's wire format (sse for answers, json error bodies with the
 * status anthropic documents for each class). the shapes are wire fixtures, not a mocked loop: the
 * engine, pi's adapter and the sdk run for real against it.
 */

type Reply = { status: number; body: string } | { sse: string };

function sse(text: string, stop = "end_turn"): string {
	const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return [
		ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
}

const err = (status: number, type: string, message: string): Reply => ({ status, body: JSON.stringify({ type: "error", error: { type, message } }) });

let replies: Reply[] = [];
const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests.push(await req.json().catch(() => null));
			const r = replies.shift() ?? { sse: sse("fallback") };
			if ("sse" in r) return new Response(r.sse, { headers: { "content-type": "text/event-stream" } });
			return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
		},
	});
});

afterAll(() => server.stop(true));

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] };
}

async function run(prompt: string, retry = { maxRetries: 4, baseDelayMs: 20, maxDelayMs: 100 }) {
	const events: EngineEvent[] = [];
	const steps: StepRow[] = [];
	const s = await EngineSession.create({ cwd: mkdtempSync(join(tmpdir(), "cmx2-retry-")), config: config(), dataDir: mkdtempSync(join(tmpdir(), "cmx2-retry-data-")), retry, onEvent: (e) => events.push(e), onStep: (r) => steps.push(r) });
	await s.prompt(prompt);
	await s.idle();
	s.dispose();
	return { events, steps, s };
}

describe("provider retries", () => {
	test("529 twice then 200: two retry statuses, back to busy, one answer", async () => {
		replies = [err(529, "overloaded_error", "Overloaded"), err(529, "overloaded_error", "Overloaded"), { sse: sse("pong") }];
		requests.length = 0;
		const { events, steps, s } = await run("ping", { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 30_000 });
		const statuses = events.filter((e) => e.type === "session.status").map((e) => e.properties.status as any);
		console.log("status frames:", JSON.stringify(statuses));
		const retries = statuses.filter((st) => st.type === "retry");
		expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
		expect(retries[0].message).toContain("overloaded");
		expect(retries[0].next).toBeGreaterThan(Date.now() - 10_000);
		// after each wait the session reads busy again, and it ends idle
		expect(statuses.map((st) => st.type)).toEqual(["busy", "retry", "busy", "retry", "busy", "idle"]);
		expect(requests.length).toBe(3);
		expect(events.some((e) => e.type === "session.error")).toBe(false);
		const last = s.messages.at(-1) as any;
		expect(last.stopReason).toBe("stop");
		expect(last.content[0].text).toBe("pong");
		expect(steps.length).toBe(1);
	}, 20_000);

	test("429 until the retries run out: a typed RateLimitError", async () => {
		replies = [err(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), err(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit")];
		const { events } = await run("ping", { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 });
		const e = events.find((x) => x.type === "session.error")!.properties.error as any;
		console.log("rate limit:", JSON.stringify(e));
		expect(e.name).toBe("RateLimitError");
		expect(e.data.kind).toBe("rate_limit");
		expect(e.data.message).toBe(e.data.message.toLowerCase());
	});

	test("a 400 is not retried", async () => {
		replies = [err(400, "invalid_request_error", "messages: text content blocks must be non-empty")];
		requests.length = 0;
		const { events } = await run("ping");
		expect(requests.length).toBe(1);
		const e = events.find((x) => x.type === "session.error")!.properties.error as any;
		expect(e.name).toBe("ProviderError");
		expect(e.data.kind).toBe("unknown");
	});
});

describe("typed provider errors", () => {
	const cases: Array<[string, Reply, string, string]> = [
		["context too long", err(400, "invalid_request_error", "prompt is too long: 1204511 tokens > 1000000 maximum"), "ContextOverflowError", "context_overflow"],
		["auth", err(401, "authentication_error", "invalid x-api-key"), "AuthError", "auth"],
		["overloaded after retries", err(529, "overloaded_error", "Overloaded"), "ProviderUnavailableError", "overloaded"],
		["server error after retries", err(500, "api_error", "Internal server error"), "ProviderUnavailableError", "overloaded"],
		["unknown", err(400, "invalid_request_error", "tools.0.name: String should match pattern"), "ProviderError", "unknown"],
	];
	for (const [what, reply, name, kind] of cases) {
		test(what, async () => {
			replies = [reply, reply];
			const { events, s } = await run("ping", { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 });
			const e = events.find((x) => x.type === "session.error")!.properties.error as any;
			console.log(`${what}:`, JSON.stringify(e));
			expect(e.name).toBe(name);
			expect(e.data.kind).toBe(kind);
			// lowercase apart from a config key it names (providers.anthropic.apiKey)
			const words = e.data.message.replace(/providers\.[\w.]+/g, "");
			expect(words).toBe(words.toLowerCase());
			expect(e.data.message).not.toMatch(/[–—]/);
			// the transcript carries the same type, so a client reading history sees it too
			expect((s.messages.at(-1) as any).errorType.name).toBe(name);
		});
	}

	test("recorded: vertex's prompt-too-long answer, replayed over the wire and classified", async () => {
		const rec = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/vertex-context-overflow.json"), "utf8"));
		expect(classifyProviderError({ provider: "anthropic", model: "claude-sonnet-5-5", errorMessage: rec.errorMessage }).name).toBe("ContextOverflowError");
		replies = [{ status: rec.status, body: JSON.stringify(rec.body) }];
		const { events } = await run("ping");
		const e = events.find((x) => x.type === "session.error")!.properties.error as any;
		console.log("recorded overflow:", JSON.stringify(e));
		expect(e.name).toBe("ContextOverflowError");
		expect(e.data.detail).toContain("3900056 tokens > 1000000 maximum");
	});

	test("classifier on the sdk's message shape", () => {
		expect(classifyProviderError({ provider: "anthropic", model: "m", errorMessage: '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}' }).name).toBe("ContextOverflowError");
		expect(classifyProviderError({ provider: "google", model: "m", errorMessage: '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}' }).name).toBe("RateLimitError");
		expect(classifyProviderError({ provider: "anthropic", model: "m", errorMessage: undefined }).name).toBe("ProviderError");
	});
});

describe("output limit", () => {
	test("max_tokens continues the turn once with a continuation request, recorded on the step", async () => {
		replies = [{ sse: sse("first half of a long answer", "max_tokens") }, { sse: sse(" and the rest.") }];
		requests.length = 0;
		const { steps, s } = await run("write something long");
		expect(requests.length).toBe(2);
		const second = requests[1];
		const lastUser = [...second.messages].reverse().find((m: any) => m.role === "user");
		const text = JSON.stringify(lastUser.content);
		console.log("continuation request tail:", text.slice(0, 200));
		expect(text).toContain("hit the output limit");
		expect(steps.map((r) => [r.stop_reason, r.continued])).toEqual([
			["length", 1],
			["stop", 0],
		]);
		expect((s.messages.at(-1) as any).content[0].text).toBe(" and the rest.");
	});

	test("continuations are capped at three per turn", async () => {
		replies = [1, 2, 3, 4, 5].map(() => ({ sse: sse("more", "max_tokens") }));
		requests.length = 0;
		const { steps } = await run("write forever");
		expect(requests.length).toBe(4);
		expect(steps.map((r) => r.continued)).toEqual([1, 1, 1, 0]);
	});
});
