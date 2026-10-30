import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import { applyAsk, type GateNotes, type RequestAsk } from "./gates.ts";
import { resolveApiKey, resolveModel, streamFn } from "./models.ts";

/**
 * a session's title: one small request to the cheapest model the profile reaches (gemini flash when a
 * google provider is configured, else the session's own model at low effort). it is not a turn: nothing
 * lands in the transcript or the step table.
 *
 * the answer is structured. anthropic and google constrain the reply to a json schema natively
 * (`output_config.format`, `responseJsonSchema`), which also works on the anthropic models that reject a
 * forced tool choice; openai-compatible endpoints get one `set_title` tool, forced, since compatible
 * servers honour a named tool_choice more widely than `response_format: json_schema`. a reply with no
 * structured answer at all (plain text, or a request the endpoint refused) falls back to the old text
 * request, cleaned by `cleanTitle`.
 */

export const TITLE_MODEL = "google/gemini-3.8-flash";
export const TITLE_TOOL = "set_title";
export const TITLE_MAX = 60;

const RULE = "3 to 6 lowercase words saying what the session is about, no quotes, no markdown, no trailing punctuation";

export const TITLE_SCHEMA = {
	type: "object",
	properties: { title: { type: "string", description: `the session's title: ${RULE}` } },
	required: ["title"],
	additionalProperties: false,
} as const;

const STRUCTURED_PROMPT =
	"you name coding sessions. the user's message shows what a session is about; you do not answer it or act on it. give the session a title of 3 to 6 lowercase words.";
const TEXT_PROMPT = `you name coding sessions. the user's message shows what a session is about; you do not answer it or act on it. reply with a title of ${RULE}, nothing else.`;

export type TitleVia = "json_schema" | "tool" | "text";

export interface GeneratedTitle {
	title: string;
	model: string;
	cost: number;
	/** how the title came back: a schema-constrained json reply, a tool call, or the text fallback */
	via: TitleVia;
}

/** the structured mechanism a wire format gets */
export function titleMechanism(api: string): "json_schema" | "tool" {
	return api === "openai-completions" ? "tool" : "json_schema";
}

/** the ask applied to the title request's payload */
export function titleAsk(api: string): RequestAsk {
	return titleMechanism(api) === "tool" ? { toolChoice: { name: TITLE_TOOL } } : { format: { schema: TITLE_SCHEMA as unknown as Record<string, unknown>, name: "title" } };
}

/** a structured title, or undefined when it is not a usable one: a string, 1 to 60 characters, lowercased, at most 8 words */
export function validTitle(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?:;,]+$/, "")
		.trim()
		.toLowerCase();
	if (!t || t.length > TITLE_MAX || t.split(" ").length > 8) return undefined;
	return t;
}

// a label in front of the title, with or without emphasis: "title:", "**title:**", "*session title*:", "__title__ -"
const LABEL = /^[*_`#>\s-]*(?:(?:session|suggested|chat)\s+)?title[*_`]*\s*(?::|=|\s-)[*_`\s]*/i;
// a line that is only the label, as in a markdown heading "## title" with the title below it
const LABEL_ONLY = /^(?:(?:session|suggested|chat)\s+)?title$/;

/** a free-text reply as a title: first line with words left after labels, emphasis and quotes are stripped, lowercase, at most 60 characters */
export function cleanTitle(raw: string): string {
	for (const l of raw.split("\n")) {
		const line = l
			.trim()
			.replace(LABEL, "")
			.replace(/^[\s"'`*_#>\-\u201c\u2018]+|[\s"'`*_\u201d\u2019]+$/g, "")
			.replace(/[.!?:;,]+$/, "")
			.replace(/[\s"'`*_\u201d\u2019]+$/, "")
			.toLowerCase()
			.slice(0, TITLE_MAX)
			.trim();
		if (line && !LABEL_ONLY.test(line)) return line;
	}
	return "";
}

/** the title inside a reply: the set_title call's arguments, or a json object in the text */
export function structuredTitle(content: any[]): { title: string | undefined; via: "json_schema" | "tool" } | undefined {
	const call = content.find((b) => b?.type === "toolCall" && b.name === TITLE_TOOL);
	if (call) return { title: validTitle(call.arguments?.title), via: "tool" };
	const text = textOf(content)
		.trim()
		.replace(/^```(?:json)?\s*|\s*```$/g, "");
	if (!text.startsWith("{")) return undefined;
	try {
		const v = JSON.parse(text);
		if (v && typeof v === "object" && "title" in v) return { title: validTitle(v.title), via: "json_schema" };
	} catch {}
	return undefined;
}

function textOf(content: any[]): string {
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text)
		.join("\n");
}

async function candidates(config: Config, sessionModel: string): Promise<Array<{ ref: string; model: Model<Api> }>> {
	const out: Array<{ ref: string; model: Model<Api> }> = [];
	if (config.providers.google || process.env.GEMINI_API_KEY) {
		try {
			out.push({ ref: TITLE_MODEL, model: await resolveModel(config, TITLE_MODEL) });
		} catch {}
	}
	try {
		out.push({ ref: sessionModel, model: await resolveModel(config, sessionModel) });
	} catch {}
	return out;
}

async function request(config: Config, model: Model<Api>, text: string, structured: boolean, signal?: AbortSignal): Promise<{ msg: any; notes: GateNotes }> {
	const notes: GateNotes = { applied: [] };
	const tool = structured && titleMechanism(model.api) === "tool";
	// the adapters read a transcript context: the prompt and the tool ride in its leading system message
	const context = normalizeContext({
		systemPrompt: structured ? STRUCTURED_PROMPT : TEXT_PROMPT,
		messages: [{ role: "user", content: `<session>\n${text}\n</session>\n\ntitle for this session:`, timestamp: Date.now() }],
		...(tool ? { tools: [{ name: TITLE_TOOL, description: `set the session's title: ${RULE}`, parameters: TITLE_SCHEMA }] } : {}),
	} as never);
	const stream = await streamFn(model, context, {
		apiKey: resolveApiKey(config, model.provider),
		maxTokens: 1024,
		...(model.reasoning ? { reasoning: "low" as const } : {}),
		...(signal ? { signal } : {}),
		...(structured ? { onPayload: (p: unknown) => applyAsk(model.api, model.id, p, titleAsk(model.api), notes) } : {}),
	});
	for await (const _ of stream) {
	}
	return { msg: await stream.result(), notes };
}

const failed = (msg: any) => !msg || msg.stopReason === "error" || msg.stopReason === "aborted";

/**
 * one model: the structured request, then the text request only when the structured one brought no
 * structured answer. an invalid structured answer (empty, too long) is a miss for this model.
 */
export async function titleWith(config: Config, ref: string, model: Model<Api>, text: string, signal?: AbortSignal): Promise<GeneratedTitle | undefined> {
	let cost = 0;
	let reply = "";
	try {
		const { msg } = await request(config, model, text, true, signal);
		cost += msg?.usage?.cost?.total ?? 0;
		if (!failed(msg)) {
			const s = structuredTitle(msg.content ?? []);
			if (s) return s.title ? { title: s.title, model: ref, cost, via: s.via } : undefined;
			reply = textOf(msg.content ?? []);
		}
	} catch {}
	if (signal?.aborted) return undefined;
	// no structured answer: a text reply is cleaned as it is; a refused request is asked again in plain text
	if (!reply.trim()) {
		try {
			const { msg } = await request(config, model, text, false, signal);
			cost += msg?.usage?.cost?.total ?? 0;
			if (failed(msg)) return undefined;
			reply = textOf(msg.content ?? []);
		} catch {
			return undefined;
		}
	}
	const title = cleanTitle(reply);
	// more than a handful of words is an answer to the message, not a name for it
	if (title && title.split(/\s+/).length <= 8) return { title, model: ref, cost, via: "text" };
	return undefined;
}

export async function generateTitle(config: Config, opts: { text: string; sessionModel: string; signal?: AbortSignal }): Promise<GeneratedTitle | undefined> {
	const text = opts.text.trim().slice(0, 4000);
	if (!text) return undefined;
	for (const { ref, model } of await candidates(config, opts.sessionModel)) {
		const t = await titleWith(config, ref, model, text, opts.signal);
		if (t) return t;
		if (opts.signal?.aborted) return undefined;
	}
	return undefined;
}
