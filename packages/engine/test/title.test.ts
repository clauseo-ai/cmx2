/**
 * session titles over each wire format: a loopback stand-in speaks anthropic's, google's and an
 * openai-compatible stream, so pi's real adapters parse the replies and the payload gate runs. covers the
 * structured answer per provider (json for anthropic and google, a forced set_title call for
 * openai-compatible), a model that answers in text anyway, a refused structured request that falls back to
 * the plain text request, and the text cleaner on labelled replies.
 *
 * run: bun test packages/engine/test/title.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { type Config, DEFAULTS } from "../src/config.ts";
import { cleanTitle, generateTitle, structuredTitle, TITLE_TOOL, titleMechanism, validTitle } from "../src/title.ts";

type Reply = { text: string } | { tool: { name: string; args: unknown } } | { status: number };
type Wire = "anthropic" | "google" | "openai";

const seen: Array<{ wire: Wire; body: any }> = [];
let replies: Reply[] = [];

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(event ? { type: event, ...(data as object) } : data)}\n\n`;

function anthropic(r: Exclude<Reply, { status: number }>, model: string): string {
	let out = sse({ message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }, "message_start");
	if ("text" in r) {
		out += sse({ index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
		out += sse({ index: 0, delta: { type: "text_delta", text: r.text } }, "content_block_delta");
	} else {
		out += sse({ index: 0, content_block: { type: "tool_use", id: "toolu_1", name: r.tool.name, input: {} } }, "content_block_start");
		out += sse({ index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(r.tool.args) } }, "content_block_delta");
	}
	out += sse({ index: 0 }, "content_block_stop");
	out += sse({ delta: { stop_reason: "text" in r ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } }, "message_delta");
	return out + sse({}, "message_stop");
}

function google(r: Exclude<Reply, { status: number }>): string {
	const part = "text" in r ? { text: r.text } : { functionCall: { name: r.tool.name, args: r.tool.args } };
	return sse({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 } });
}

function openai(r: Exclude<Reply, { status: number }>, model: string): string {
	const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model };
	const delta = "text" in r ? { role: "assistant", content: r.text } : { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] };
	return (
		sse({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) +
		sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in r ? "stop" : "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) +
		"data: [DONE]\n\n"
	);
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const path = new URL(req.url).pathname;
		const wire: Wire = path.includes(":streamGenerateContent") ? "google" : path.endsWith("/chat/completions") ? "openai" : "anthropic";
		const body = await req.json();
		seen.push({ wire, body });
		const r = replies.shift() ?? { status: 500 };
		if ("status" in r) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "schema not supported here" } }), { status: r.status, headers: { "content-type": "application/json" } });
		const model = body.model ?? "m";
		const text = wire === "anthropic" ? anthropic(r, model) : wire === "google" ? google(r) : openai(r, model);
		return new Response(text, { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => provider.stop(true));

const BASE = `http://127.0.0.1:${provider.port}`;

function config(providers: Config["providers"]): Config {
	return { ...structuredClone(DEFAULTS), providers, sources: [] } as Config;
}
const ANTHROPIC = config({ anthropic: { baseUrl: BASE, apiKey: "unused" } });
const GOOGLE = config({ google: { baseUrl: `${BASE}/v1beta`, apiKey: "unused" }, anthropic: { baseUrl: BASE, apiKey: "unused" } });
const OPENAI = config({ compat: { api: "openai-completions", baseUrl: `${BASE}/v1`, apiKey: "unused", models: { "small-1": { name: "small" } } } });

async function run(cfg: Config, sessionModel: string, r: Reply[], sessionOnly = false) {
	seen.length = 0;
	replies = [...r];
	const t = await generateTitle(cfg, { text: "the login form submits twice when you press enter, find out why", sessionModel, sessionOnly });
	return { t, seen: [...seen], left: replies.length };
}

describe("structured title per provider", () => {
	test("anthropic: a schema-constrained json reply, via output_config.format, on a model that rejects forced tools", async () => {
		const { t, seen } = await run(ANTHROPIC, "anthropic/claude-opus-5-5", [{ text: '{"title":"Fix Double Login Submit"}' }]);
		expect(t).toMatchObject({ title: "fix double login submit", model: "anthropic/claude-opus-5-5", via: "json_schema" });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.body.output_config.format).toMatchObject({ type: "json_schema", schema: { required: ["title"] } });
		expect(seen[0]!.body.tool_choice).toBeUndefined();
		expect(JSON.stringify(seen[0]!.body.system)).toContain("you name coding sessions");
		expect(seen[0]!.body.tools ?? []).toHaveLength(0);
	});

	test("google: the title model first, responseJsonSchema with a json mime type", async () => {
		const { t, seen } = await run(GOOGLE, "anthropic/claude-sonnet-5-5", [{ text: '{"title": "fix double login submit"}' }]);
		expect(t).toMatchObject({ title: "fix double login submit", model: "google/gemini-3.8-flash", via: "json_schema" });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.wire).toBe("google");
		const gen = seen[0]!.body.generationConfig;
		expect(JSON.stringify(gen.systemInstruction ?? seen[0]!.body.systemInstruction)).toContain("you name coding sessions");
		expect(gen.responseMimeType).toBe("application/json");
		expect(gen.responseJsonSchema).toMatchObject({ properties: { title: { type: "string" } } });
	});

	test("openai-compatible: one set_title tool, forced, read from the call's arguments", async () => {
		const { t, seen } = await run(OPENAI, "compat/small-1", [{ tool: { name: TITLE_TOOL, args: { title: "fix double login submit" } } }]);
		expect(t).toMatchObject({ title: "fix double login submit", model: "compat/small-1", via: "tool" });
		expect(seen).toHaveLength(1);
		const body = seen[0]!.body;
		expect(body.tools.map((x: any) => x.function.name)).toEqual([TITLE_TOOL]);
		expect(body.tool_choice).toEqual({ type: "function", function: { name: TITLE_TOOL } });
		expect(body.tools[0].function.parameters.properties.title.description).toContain("3 to 6 lowercase words");
	});

	test("a model that answers in text anyway: its text is cleaned, no second request", async () => {
		const { t, seen } = await run(ANTHROPIC, "anthropic/claude-opus-5-5", [{ text: "**title:** planning stetdoc testing on claude code" }]);
		expect(t).toMatchObject({ title: "planning stetdoc testing on claude code", via: "text" });
		expect(seen).toHaveLength(1);
	});

	test("a refused structured request falls back to the plain text request on the same model", async () => {
		const { t, seen } = await run(OPENAI, "compat/small-1", [{ status: 400 }, { text: "Title: Fix double login submit." }]);
		expect(t).toMatchObject({ title: "fix double login submit", via: "text" });
		expect(seen).toHaveLength(2);
		expect(seen[0]!.body.tool_choice).toBeDefined();
		expect(seen[1]!.body.tools).toBeUndefined();
		expect(seen[1]!.body.tool_choice).toBeUndefined();
	});

	test("an invalid structured answer is a miss for that model: the next model is asked", async () => {
		const { t, seen } = await run(GOOGLE, "anthropic/claude-sonnet-5-5", [{ text: '{"title":"   "}' }, { text: '{"title":"fix double login submit"}' }]);
		expect(t).toMatchObject({ title: "fix double login submit", model: "anthropic/claude-sonnet-5-5", via: "json_schema" });
		expect(seen.map((s) => s.wire)).toEqual(["google", "anthropic"]);
	});

	test("a structured title over 60 characters is cut at a word boundary, not rejected", async () => {
		const long = "refactor the authentication middleware for multitenant deployments";
		const { t } = await run(ANTHROPIC, "anthropic/claude-opus-5-5", [{ text: JSON.stringify({ title: long }) }]);
		expect(t?.title).toBe("refactor the authentication middleware for multitenant");
		expect(t!.title.length).toBeLessThanOrEqual(60);
	});

	test("a reply cut off inside its json is not stored as a title", async () => {
		const { t, seen } = await run(ANTHROPIC, "anthropic/claude-opus-5-5", [{ text: '{"title":"fix' }]);
		expect(t).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	test("sessionOnly skips the title model on another provider", async () => {
		const { t, seen } = await run(GOOGLE, "anthropic/claude-sonnet-5-5", [{ text: '{"title":"fix double login submit"}' }], true);
		expect(t).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
		expect(seen.map((x) => x.wire)).toEqual(["anthropic"]);
	});

	test("every model failing is no title", async () => {
		const { t } = await run(ANTHROPIC, "anthropic/claude-opus-5-5", [{ status: 400 }, { status: 400 }]);
		expect(t).toBeUndefined();
	});
});

describe("parsing", () => {
	test("validTitle", () => {
		expect(validTitle("  Fix Login  Bug. ")).toBe("fix login bug");
		expect(validTitle("")).toBeUndefined();
		expect(validTitle(42)).toBeUndefined();
		expect(validTitle("x".repeat(61))).toBe("x".repeat(60));
		expect(titleMechanism("anthropic-messages")).toBe("json_schema");
		expect(titleMechanism("openai-completions")).toBe("tool");
		expect(titleMechanism("openai-responses")).toBeUndefined();
		expect(validTitle("one two three four five six seven eight nine")).toBeUndefined();
	});

	test("structuredTitle reads a tool call, a json reply and a fenced json reply; plain text is not structured", () => {
		expect(structuredTitle([{ type: "toolCall", name: TITLE_TOOL, arguments: { title: "a b c" } }])).toEqual({ title: "a b c", via: "tool" });
		expect(structuredTitle([{ type: "text", text: '{"title":"a b c"}' }])).toEqual({ title: "a b c", via: "json_schema" });
		expect(structuredTitle([{ type: "text", text: '```json\n{"title":"a b c"}\n```' }])).toEqual({ title: "a b c", via: "json_schema" });
		expect(structuredTitle([{ type: "text", text: "a b c" }])).toBeUndefined();
		expect(structuredTitle([{ type: "thinking", thinking: "{}" }, { type: "text", text: "{not json" }])).toBeUndefined();
	});

	test("cleanTitle strips labels, emphasis and quotes", () => {
		expect(cleanTitle("**title:** planning stetdoc testing on claude code")).toBe("planning stetdoc testing on claude code");
		expect(cleanTitle("**Title**: Fix the login bug")).toBe("fix the login bug");
		expect(cleanTitle("*Session title:* refactor auth flow")).toBe("refactor auth flow");
		expect(cleanTitle('Title: "Nightly backup script".')).toBe("nightly backup script");
		expect(cleanTitle("## Title\n\nnightly backup script")).toBe("nightly backup script");
		expect(cleanTitle("__title__ - debug flaky tests")).toBe("debug flaky tests");
		expect(cleanTitle("`fix login bug`")).toBe("fix login bug");
		expect(cleanTitle("subtitle parsing in video player")).toBe("subtitle parsing in video player");
		expect(cleanTitle("title-case helper for headings")).toBe("title-case helper for headings");
	});
});
