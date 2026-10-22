/**
 * provider gates: the per-wire-format differences cmx2 owns on top of pi's adapters. each runs on the
 * payload pi built (`onPayload`) or on the raw provider events (`onProviderStreamEvent`), so pi's
 * adapters stay unpatched.
 */

/** request-level asks that every provider expresses differently */
export interface RequestAsk {
	/** call this tool (by name) or any tool ("required") before answering */
	toolChoice?: { name: string } | "required";
	/** constrain the final text to json matching this schema */
	format?: { schema: Record<string, unknown>; name?: string };
}

/** a provider declined, surfaced as data instead of a silent empty answer */
export interface Refusal {
	provider: string;
	model: string;
	/** the classifier or category that fired, as the provider names it */
	classifier: string;
	explanation?: string;
}

export class RefusalError extends Error {
	constructor(readonly refusal: Refusal) {
		super(
			`${refusal.provider}/${refusal.model} declined this request (classifier: ${refusal.classifier})${refusal.explanation ? `: ${refusal.explanation}` : ""}. rephrase it, or send it to another model`,
		);
		this.name = "RefusalError";
	}
}

/**
 * opus 5.5, fable 5.1, sonnet 5.5 and later answer `tool_choice` any/tool with a 400. they get auto
 * plus an explicit instruction naming the tool (the engine adds it as a turn-scoped message).
 */
export function rejectsForcedToolUse(api: string, modelId: string): boolean {
	if (api !== "anthropic-messages") return false;
	const m = modelId.match(/claude-(opus|fable|sonnet|mythos)-(\d+)(?:-(\d+))?/);
	if (!m) return false;
	const v = Number(m[2]) + Number(m[3] ?? 0) / 10;
	const floor = { opus: 5.5, fable: 5.1, sonnet: 5.5, mythos: 5.1 }[m[1] as "opus"];
	return v >= floor;
}

/** the text of the instruction that stands in for a forced tool choice */
export function forcedToolInstruction(ask: NonNullable<RequestAsk["toolChoice"]>): string {
	return ask === "required" ? "answer this turn by calling one of your tools first." : `answer this turn by calling the ${ask.name} tool first.`;
}

export interface GateNotes {
	/** what the gate did to the payload, for the request log */
	applied: string[];
}

/** applies a request ask to the payload pi built. mutates and returns it. */
export function applyAsk(api: string, modelId: string, payload: any, ask: RequestAsk, notes: GateNotes): any {
	if (ask.toolChoice) {
		const tc = ask.toolChoice;
		if (api === "anthropic-messages") {
			if (rejectsForcedToolUse(api, modelId)) {
				delete payload.tool_choice;
				notes.applied.push("tool_choice:auto(forced rejected by model; instruction sent)");
			} else {
				payload.tool_choice = tc === "required" ? { type: "any" } : { type: "tool", name: tc.name };
				notes.applied.push(`tool_choice:${payload.tool_choice.type}`);
			}
		} else if (api === "google-generative-ai") {
			payload.config ??= {};
			payload.config.toolConfig = {
				functionCallingConfig: tc === "required" ? { mode: "ANY" } : { mode: "ANY", allowedFunctionNames: [tc.name] },
			};
			notes.applied.push("toolConfig:ANY");
		} else if (api === "openai-completions") {
			payload.tool_choice = tc === "required" ? "required" : { type: "function", function: { name: tc.name } };
			notes.applied.push("tool_choice:function");
		}
	}
	if (ask.format) {
		const { schema, name = "answer" } = ask.format;
		if (api === "anthropic-messages") {
			payload.output_config = { ...payload.output_config, format: { type: "json_schema", schema } };
			notes.applied.push("output_config.format");
		} else if (api === "google-generative-ai") {
			payload.config ??= {};
			payload.config.responseMimeType = "application/json";
			payload.config.responseJsonSchema = schema;
			notes.applied.push("responseJsonSchema");
		} else if (api === "openai-completions") {
			payload.response_format = { type: "json_schema", json_schema: { name, schema, strict: true } };
			notes.applied.push("response_format.json_schema");
		}
	}
	return payload;
}

const GOOGLE_BLOCKS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

/** watches raw provider events for a decline; returns one when it sees it */
export function refusalFromEvent(api: string, provider: string, model: string, event: any): Refusal | undefined {
	if (api === "anthropic-messages") {
		if (event?.type === "message_delta" && event.delta?.stop_reason === "refusal") {
			const d = event.delta.stop_details ?? {};
			return { provider, model, classifier: d.category ?? "unspecified", ...(d.explanation ? { explanation: d.explanation } : {}) };
		}
		return undefined;
	}
	if (api === "google-generative-ai") {
		const block = event?.promptFeedback?.blockReason;
		if (block) {
			return { provider, model, classifier: `prompt:${block}`, ...(event.promptFeedback.blockReasonMessage ? { explanation: event.promptFeedback.blockReasonMessage } : {}) };
		}
		const c = event?.candidates?.[0];
		if (c?.finishReason && GOOGLE_BLOCKS.has(c.finishReason)) {
			const fired = (c.safetyRatings ?? []).filter((r: any) => r.blocked).map((r: any) => r.category);
			return { provider, model, classifier: [c.finishReason, ...fired].join(":"), ...(c.finishMessage ? { explanation: c.finishMessage } : {}) };
		}
		return undefined;
	}
	if (api === "openai-completions") {
		const fr = event?.choices?.[0]?.finish_reason;
		if (fr === "content_filter" || fr === "sensitive") return { provider, model, classifier: fr };
	}
	return undefined;
}

/** the text inside a provider's error body when pi hands it over as json (`{"type":"error","error":{"message":...}}`) */
function errorText(message: string): string {
	try {
		const body = JSON.parse(message);
		const inner = body?.error?.message ?? body?.message;
		if (typeof inner === "string" && inner) return inner;
	} catch {}
	return message;
}

/**
 * some providers decline with an error instead of a stop reason: glm answers 400 with code 1301;
 * anthropic on vertex ends the stream with an `invalid_request_error` event reading "Output blocked by
 * content filtering policy" (recorded in `test/fixtures/vertex-content-filter.sse`)
 */
export function refusalFromError(provider: string, model: string, message: string | undefined): Refusal | undefined {
	if (!message) return undefined;
	const text = errorText(message);
	if (/output blocked by content filtering policy/i.test(text)) {
		return { provider, model, classifier: "vertex_content_filter", explanation: text.slice(0, 300) };
	}
	if (/\b1301\b|content[_ ]?filter|contentfilter|sensitive content|data_inspection_failed|inappropriate content/i.test(text)) {
		const code = text.match(/\b(1301)\b/)?.[1];
		return { provider, model, classifier: code ? `content_filter:${code}` : "content_filter", explanation: text.slice(0, 300) };
	}
	return undefined;
}

/** the prefix a request carries: the system prompt and the tool definitions the model reads from turn one */
export interface PrefixView {
	bytes: string;
	/** tools declared deferred (after pi's placeholder); not part of the rendered prefix */
	deferred: string[];
	tools: string[];
}

export const PI_DEFERRED_PLACEHOLDER = "__pi_deferred_placeholder__";

export function prefixOf(api: string, payload: any): PrefixView {
	if (api === "anthropic-messages") {
		const tools: any[] = payload.tools ?? [];
		const rendered = tools.filter((t) => !t.defer_loading || t.name === PI_DEFERRED_PLACEHOLDER);
		return {
			bytes: `${JSON.stringify(payload.system ?? [])}\n${JSON.stringify(rendered)}`,
			deferred: tools.filter((t) => t.defer_loading && t.name !== PI_DEFERRED_PLACEHOLDER).map((t) => t.name),
			tools: rendered.map((t) => t.name),
		};
	}
	if (api === "google-generative-ai") {
		const tools = payload.config?.tools ?? [];
		const names = tools.flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => f.name));
		return { bytes: `${JSON.stringify(payload.config?.systemInstruction ?? "")}\n${JSON.stringify(tools)}`, deferred: [], tools: names };
	}
	const first = payload.messages?.[0];
	const system = first?.role === "system" || first?.role === "developer" ? first : null;
	const tools = payload.tools ?? [];
	return { bytes: `${JSON.stringify(system)}\n${JSON.stringify(tools)}`, deferred: [], tools: tools.map((t: any) => t.function?.name ?? t.name) };
}

/** effort markers on the wire, in order (anthropic per-message output_config) */
export function effortMarkers(api: string, payload: any): string[] {
	if (api !== "anthropic-messages") return [];
	return (payload.messages ?? []).filter((m: any) => m.role === "system" && m.output_config?.effort).map((m: any) => m.output_config.effort);
}

/**
 * anthropic: pi puts the latest cache breakpoint on the last message, which at a turn's first request is
 * the turn-context system message. an entry keyed there is found by an identical replay but not by the
 * next, longer request (measured at m5: a 95k-token child re-wrote everything 45 s later), so a turn
 * that ends in one step paid a full cache write on the following turn. the breakpoint moves to the last
 * block of the nearest user message before it; multi-step turns end on a tool result and are untouched.
 */
export function moveTrailingSystemBreakpoint(api: string, payload: Record<string, any>, notes: GateNotes): void {
	if (api !== "anthropic-messages" || !Array.isArray(payload.messages)) return;
	const msgs = payload.messages as Array<{ role: string; content: unknown }>;
	let at = -1;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const c = msgs[i]!.content;
		if (Array.isArray(c) && c.some((b: any) => b?.cache_control)) {
			at = i;
			break;
		}
	}
	if (at < 0 || msgs[at]!.role !== "system") return;
	let to = -1;
	for (let i = at - 1; i >= 0; i--) {
		const c = msgs[i]!.content;
		if (msgs[i]!.role === "user" && ((Array.isArray(c) && c.length) || (typeof c === "string" && c.length))) {
			to = i;
			break;
		}
		if (msgs[i]!.role === "assistant") break;
	}
	if (to < 0) return;
	const from = msgs[at]!.content as Array<Record<string, unknown>>;
	const block = from.find((b) => b.cache_control)!;
	const cc = block.cache_control;
	delete block.cache_control;
	// string content is the api's shorthand for one text block; the block form carries the breakpoint
	if (typeof msgs[to]!.content === "string") msgs[to]!.content = [{ type: "text", text: msgs[to]!.content }];
	const target = msgs[to]!.content as Array<Record<string, unknown>>;
	target[target.length - 1]!.cache_control = cc;
	notes.applied.push("cache breakpoint moved from the turn-context system message to the user message before it");
}

/** block types a cache breakpoint may sit on (thinking blocks and empty text may not carry one) */
const MARKABLE = new Set(["text", "image", "document", "tool_use", "tool_result", "tool_addition", "tool_removal"]);

/**
 * anthropic, for a side request (a btw) appended to a session's own request: nothing from the first block
 * holding `marker` onwards carries a breakpoint, and the one pi put on the last message goes to the last block
 * before that, the end of the session's own messages. the request then has the breakpoints the session's
 * request had at the same positions, so it reads the session's entries and writes none for the side question
 * or its answer, which never go back into the session. returns whether it found the marker.
 */
export function asideBreakpoint(api: string, payload: Record<string, any>, marker: string, notes: GateNotes): boolean {
	if (api !== "anthropic-messages" || !Array.isArray(payload.messages)) return false;
	const msgs = payload.messages as Array<{ role: string; content: unknown }>;
	let mi = -1;
	let bi = -1;
	for (let i = msgs.length - 1; i >= 0 && mi < 0; i--) {
		const c = msgs[i]!.content;
		if (typeof c === "string" && c.includes(marker)) {
			msgs[i]!.content = [{ type: "text", text: c }];
			[mi, bi] = [i, 0];
		} else if (Array.isArray(c)) {
			const at = c.findIndex((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.includes(marker));
			if (at >= 0) [mi, bi] = [i, at];
		}
	}
	if (mi < 0) return false;
	let moved: unknown;
	for (let i = mi; i < msgs.length; i++) {
		const c = msgs[i]!.content;
		if (!Array.isArray(c)) continue;
		for (let j = i === mi ? bi : 0; j < c.length; j++) {
			const b = c[j] as Record<string, unknown>;
			if (b?.cache_control) {
				moved ??= b.cache_control;
				delete b.cache_control;
			}
		}
	}
	if (!moved) return true;
	// the last markable block before the side question
	for (let i = mi; i >= 0; i--) {
		const m = msgs[i]!;
		if (typeof m.content === "string") {
			if (!m.content.trim()) continue;
			m.content = [{ type: "text", text: m.content }];
		}
		if (!Array.isArray(m.content)) continue;
		const blocks = m.content as Array<Record<string, any>>;
		for (let j = (i === mi ? bi : blocks.length) - 1; j >= 0; j--) {
			const b = blocks[j]!;
			if (!MARKABLE.has(String(b.type)) || (b.type === "text" && !String(b.text ?? "").trim())) continue;
			b.cache_control = moved;
			notes.applied.push("btw: cache breakpoint kept at the end of the session's own messages");
			return true;
		}
	}
	return true;
}

/**
 * anthropic: a fourth breakpoint where the previous request put its last one, so the next request hits
 * that entry exactly instead of relying on the api's look-back, which does not find an entry across a
 * turn-context system message (measured at m5: an agent's first turn was never reused by its second,
 * while later turns read 99.9% at 30 to 120 s gaps). history is append-only and the previous request's
 * last breakpoint sat on its last user-role message (see moveTrailingSystemBreakpoint), which is the last
 * user message before the newest assistant message, so the position is known even right after a resume.
 */
export function rollingBreakpoint(api: string, payload: Record<string, any>, notes: GateNotes): void {
	if (api !== "anthropic-messages" || !Array.isArray(payload.messages)) return;
	const msgs = payload.messages as Array<{ role: string; content: unknown }>;
	const has = (c: unknown) => Array.isArray(c) && c.some((b: any) => b?.cache_control);
	const count =
		(Array.isArray(payload.system) ? payload.system.filter((b: any) => b?.cache_control).length : 0) +
		(Array.isArray(payload.tools) ? payload.tools.filter((t: any) => t?.cache_control).length : 0) +
		msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b: any) => b?.cache_control).length : 0), 0);
	if (count >= 4) return;
	const lastAssistant = msgs.findLastIndex((m) => m.role === "assistant");
	if (lastAssistant < 0) return;
	let at = -1;
	for (let i = lastAssistant - 1; i >= 0; i--) {
		const c = msgs[i]!.content;
		if (msgs[i]!.role === "user" && ((Array.isArray(c) && c.length) || (typeof c === "string" && c.length))) {
			at = i;
			break;
		}
	}
	if (at < 0 || has(msgs[at]!.content)) return;
	// the same ttl as pi's own breakpoints: a 5m marker ahead of a 1h one is a 400 ("a ttl='1h' cache_control
	// block must not come after a ttl='5m' cache_control block"), which failed every 1h session's second request
	const marks = [...msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])), ...(Array.isArray(payload.system) ? payload.system : []), ...(Array.isArray(payload.tools) ? payload.tools : [])];
	const template = marks.find((b: any) => b?.cache_control)?.cache_control ?? { type: "ephemeral" };
	if (typeof msgs[at]!.content === "string") msgs[at]!.content = [{ type: "text", text: msgs[at]!.content }];
	const blocks = msgs[at]!.content as Array<Record<string, unknown>>;
	blocks[blocks.length - 1]!.cache_control = { ...template };
	notes.applied.push("cache breakpoint kept where the previous request wrote its entry");
}
