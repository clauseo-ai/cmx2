/**
 * pi drift: cmx2 pins pi exactly and depends on a few behaviours of pi's internals that are not part
 * of its documented api. these tests fail loudly when any of that moves, so a pi upgrade is a
 * deliberate step (GOTCHAS: pi api churn).
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { hotTools } from "@cmx2/tools";
import { PI_DEFERRED_PLACEHOLDER, prefixOf, RefusalError, refusalFromError, refusalFromEvent } from "../src/gates.ts";

const ROOT = join(import.meta.dir, "../../..");
const PIN = "0.99.1";
const internals = JSON.parse(readFileSync(join(import.meta.dir, "pi-internals.json"), "utf8")) as {
	files: Array<{ package: string; file: string; sha256: string; relies: string }>;
};

function pkgRoot(name: string): string {
	return dirname(Bun.resolveSync(`${name}/package.json`, join(ROOT, "packages/engine/src")));
}

test("every pi package in the tree is exactly the pinned version", () => {
	const store = join(ROOT, "node_modules/.bun");
	const pi = readdirSync(store).filter((d) => d.startsWith("@earendil-works+"));
	expect(pi.length).toBeGreaterThan(0);
	for (const d of pi) expect(d.split("@")[2]?.split("+")[0], `${d} is not ${PIN}`).toBe(PIN);
	for (const p of readdirSync(join(ROOT, "packages"))) {
		const deps = JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8")).dependencies ?? {};
		for (const [name, v] of Object.entries(deps)) if (name.startsWith("@earendil-works/")) expect(v, `${p} depends on ${name}@${v}; pin it to ${PIN}`).toBe(PIN);
	}
});

test("the internals cmx2 relies on are byte-identical to the ones reviewed", () => {
	for (const f of internals.files) {
		const actual = createHash("sha256").update(readFileSync(join(pkgRoot(f.package), f.file))).digest("hex");
		expect(actual, `${f.package}/${f.file} changed. re-check: ${f.relies}. then update test/pi-internals.json`).toBe(f.sha256);
	}
});

test("the daemon's import graph has pi-ai, pi-agent-core, pi-codemode and pi-mcp, and not pi-coding-agent", () => {
	// the bundler's metafile lists every module the cli can load, dynamic imports included
	const script = `const r = await Bun.build({ entrypoints: ["packages/cli/src/index.ts"], target: "bun", metafile: true, outdir: "/tmp/cmx2-drift-build" }); if (!r.success) { console.error(r.logs.join("\\n")); process.exit(1); } console.log(JSON.stringify(Object.keys(r.metafile.inputs)));`;
	const r = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	const inputs = JSON.parse(r.stdout.toString()) as string[];
	const pi = [...new Set(inputs.map((p) => p.match(/@earendil-works\/(pi-[a-z-]+)/)?.[1]).filter(Boolean))].sort();
	console.log(`pi packages in the daemon's graph (${inputs.length} modules): ${pi.join(", ")}`);
	expect(pi).not.toContain("pi-coding-agent");
	expect(pi).not.toContain("pi-tui");
	// pi-telemetry arrives as a dependency of pi-agent-core, not as a direct import
	// pi-mcp is imported lazily, on the first mcp connection (m6)
	expect(pi.filter((p) => p !== "pi-telemetry")).toEqual(["pi-agent-core", "pi-ai", "pi-codemode", "pi-mcp"]);
	// only the Agent (src/pi-agent.ts): pi-agent-core's index drags its whole harness in, ~12 MB of boot rss (GOTCHAS, m5)
	const core = inputs.filter((p) => p.includes("@earendil-works/pi-agent-core/"));
	expect(core.filter((p) => p.endsWith("pi-agent-core/dist/index.js") || p.includes("pi-agent-core/dist/harness/"))).toEqual([]);
	expect(inputs.filter((p) => /node_modules\/(yaml|diff)\//.test(p))).toEqual([]);
});

// ---- wire-shape pins: pi's anthropic payload, captured through onPayload with a recorded response ----

const OK_SSE = readFileSync(join(import.meta.dir, "fixtures/anthropic-ok.sse"), "utf8");

function replayFetch(sse: string): typeof fetch {
	return (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

async function capture(messages: any[], opts: { effort?: string; sse?: string } = {}) {
	const model = { ...(ANTHROPIC_MODELS as unknown as Record<string, Model<Api>>)["claude-opus-5-5"]!, baseUrl: "http://replay.invalid" };
	let payload: any;
	const s = streamSimple(model as never, { messages } as never, {
		apiKey: "replay",
		reasoning: (opts.effort ?? "medium") as never,
		fetch: replayFetch(opts.sse ?? OK_SSE),
		onPayload: (p: unknown) => {
			payload = structuredClone(p);
			return undefined;
		},
	} as never);
	const result = await s.result();
	return { payload, result };
}

const tools = hotTools({ cwd: "/tmp", spillDir: "/tmp" }, async () => ({ result: { content: [], details: {} }, isError: false }), async () => []);
const decls = tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) }));
const system = { role: "system", content: "you are a test prompt", toolsAdded: decls, timestamp: 0 };

test("prefix: system and tools carry the breakpoints, the deferred placeholder follows the hot tools", async () => {
	const { payload } = await capture([system, { role: "user", content: "hi", timestamp: 1 }]);
	expect(payload.system[0].cache_control).toBeDefined();
	const names = payload.tools.map((t: any) => t.name);
	expect(names.slice(0, -1)).toEqual(decls.map((d) => d.name));
	expect(names.at(-1)).toBe(PI_DEFERRED_PLACEHOLDER);
	expect(payload.tools.at(-1).defer_loading).toBe(true);
	expect(payload.tools.at(-2).cache_control).toBeDefined();
	expect(payload.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
	expect(payload.betas).toContain("mid-conversation-output-config-2026-07-01");
});

test("effort: markers are rebuilt from each assistant message's recorded level, active marker last", async () => {
	const asst = (level: string, text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		providerThinkingLevel: level,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	});
	const history = [system, { role: "user", content: "a", timestamp: 1 }, asst("high", "one"), { role: "user", content: "b", timestamp: 3 }, asst("low", "two"), { role: "user", content: "c", timestamp: 4 }];
	const one = await capture(history, { effort: "max" });
	const two = await capture(structuredClone(history), { effort: "max" });
	const markers = one.payload.messages.filter((m: any) => m.role === "system" && m.output_config).map((m: any) => m.output_config.effort);
	expect(markers).toEqual(["high", "low", "max"]);
	expect(one.payload.messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "max" } });
	// replay determinism: the same transcript always produces the same bytes
	expect(JSON.stringify(one.payload)).toBe(JSON.stringify(two.payload));
	expect(one.result.providerThinkingLevel).toBe("max");
});

test("a later system message with toolsAdded becomes a tool_addition and a deferred declaration; the rendered prefix is unchanged", async () => {
	const base = [system, { role: "user", content: "hi", timestamp: 1 }];
	const before = await capture(base);
	const late = { name: "webfetch", description: "fetch a url", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };
	const after = await capture([...base, { role: "system", content: "", toolsAdded: [late], timestamp: 2 }]);
	const additions = after.payload.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_addition");
	expect(additions.map((b: any) => b.tool.name)).toEqual(["webfetch"]);
	expect(after.payload.tools.at(-1)).toMatchObject({ name: "webfetch", defer_loading: true });
	expect(after.payload.betas).toContain("mid-conversation-tool-changes-2026-07-01");
	expect(prefixOf("anthropic-messages", after.payload).bytes).toBe(prefixOf("anthropic-messages", before.payload).bytes);
	expect(prefixOf("anthropic-messages", after.payload).deferred).toEqual(["webfetch"]);
});

test("a text system message after the user turn is sent after it, before the active marker", async () => {
	const { payload } = await capture([system, { role: "user", content: "hi", timestamp: 1 }, { role: "system", content: "turn note", timestamp: 1 }]);
	const roles = payload.messages.map((m: any) => (m.role === "system" ? (m.output_config ? "marker" : "system") : m.role));
	expect(roles).toEqual(["user", "system", "marker"]);
});

// ---- refusal surfacing on recorded wire shapes (a live anthropic refusal is not provoked on purpose) ----

test("anthropic refusal: pi maps it to an error, the gate names the classifier", async () => {
	// the recorded stream with its message_delta rewritten to the documented refusal shape
	const refusalSse = OK_SSE.replace(
		/"stop_reason":"end_turn","stop_sequence":null,"stop_details":null/,
		'"stop_reason":"refusal","stop_sequence":null,"stop_details":{"type":"refusal","category":"cyber","explanation":"declined by a safety classifier"}',
	);
	expect(refusalSse).not.toBe(OK_SSE);
	const events: unknown[] = [];
	const model = { ...(ANTHROPIC_MODELS as unknown as Record<string, Model<Api>>)["claude-opus-5-5"]!, baseUrl: "http://replay.invalid" };
	const s = streamSimple(model as never, { messages: [system, { role: "user", content: "hi", timestamp: 1 }] } as never, {
		apiKey: "replay",
		reasoning: "medium",
		fetch: replayFetch(refusalSse),
		onProviderStreamEvent: (e: unknown) => {
			events.push(e);
		},
	} as never);
	const result = await s.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("declined by a safety classifier");
	const refusal = events.map((e) => refusalFromEvent("anthropic-messages", "anthropic", "claude-opus-5-5", e)).find(Boolean);
	expect(refusal).toEqual({ provider: "anthropic", model: "claude-opus-5-5", classifier: "cyber", explanation: "declined by a safety classifier" });
});

test("vertex content filter: the recorded mid-stream error becomes a typed refusal, not a provider error", async () => {
	// recorded 2026-09-30 through the vertex proxy: sonnet 5.5 counting to 300 in words; a 200 stream whose
	// last event is `error` / invalid_request_error "Output blocked by content filtering policy"
	const sse = readFileSync(join(import.meta.dir, "fixtures/vertex-content-filter.sse"), "utf8");
	expect(sse).toContain('"message":"Output blocked by content filtering policy"');
	const events: unknown[] = [];
	const model = { ...(ANTHROPIC_MODELS as unknown as Record<string, Model<Api>>)["claude-sonnet-5-5"]!, baseUrl: "http://replay.invalid" };
	const s = streamSimple(model as never, { messages: [system, { role: "user", content: "count", timestamp: 1 }] } as never, {
		apiKey: "replay",
		reasoning: "low",
		fetch: replayFetch(sse),
		onProviderStreamEvent: (e: unknown) => {
			events.push(e);
		},
	} as never);
	const result = await s.result();
	// what the session sees: an error stop with the provider's error body as the message
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("invalid_request_error");
	// no stop_reason refusal on the wire, so the event gate stays quiet and the error gate decides
	expect(events.map((e) => refusalFromEvent("anthropic-messages", "anthropic", "claude-sonnet-5-5", e)).find(Boolean)).toBeUndefined();
	const refusal = refusalFromError("anthropic", "claude-sonnet-5-5", result.errorMessage);
	expect(refusal).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", classifier: "vertex_content_filter", explanation: "Output blocked by content filtering policy" });
	const err = new RefusalError(refusal!);
	expect(err.name).toBe("RefusalError");
	expect(err.message).toContain("classifier: vertex_content_filter");
	// the older shapes keep their classifiers
	expect(refusalFromError("glm", "glm-5", '400 {"error":{"code":"1301","message":"sensitive content"}}')?.classifier).toBe("content_filter:1301");
	expect(refusalFromError("anthropic", "claude-opus-5-5", "overloaded_error")).toBeUndefined();
});

test("google block: a prompt blocked before any candidate is surfaced, not an empty answer", () => {
	const chunk = { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, candidates: [] };
	expect(refusalFromEvent("google-generative-ai", "google", "gemini-3.8-flash", chunk)?.classifier).toBe("prompt:PROHIBITED_CONTENT");
	const stopped = { candidates: [{ finishReason: "SAFETY", safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", blocked: true }] }] };
	expect(refusalFromEvent("google-generative-ai", "google", "gemini-3.8-flash", stopped)?.classifier).toBe("SAFETY:HARM_CATEGORY_HARASSMENT");
});

test("pi-agent-core replays a recorded leading system message instead of rendering a new one", () => {
	const agent = new Agent({ initialState: { messages: [system as never], systemPrompt: "a different prompt", tools: [] }, streamFn: (() => {}) as never });
	expect(agent.state.messages.length).toBe(1);
	expect((agent.state.messages[0] as any).content).toBe("you are a test prompt");
});
