import type { Api, Model } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import { resolveApiKey, resolveModel, streamFn } from "./models.ts";

/**
 * a session's title from its first message: one small request to the cheapest model the profile
 * reaches (gemini flash when a google provider is configured, else the session's own model at low
 * effort). it is not a turn: nothing lands in the transcript or the step table.
 */

const PROMPT =
	"you name coding sessions. the user's message is the first message of a session; you do not answer it or act on it. reply with a title of 3 to 6 lowercase words saying what the session is about, no quotes, no trailing punctuation, nothing else.";

export const TITLE_MODEL = "google/gemini-3.8-flash";

export interface GeneratedTitle {
	title: string;
	model: string;
	cost: number;
}

/** first line, unquoted, lowercase, at most 60 characters */
export function cleanTitle(raw: string): string {
	const line =
		raw
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l) ?? "";
	return line
		.replace(/^title:\s*/i, "")
		.replace(/^["'`*#\s]+|["'`*\s]+$/g, "")
		.replace(/[.!?:;,]+$/, "")
		.toLowerCase()
		.slice(0, 60)
		.trim();
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

export async function generateTitle(config: Config, opts: { text: string; sessionModel: string; signal?: AbortSignal }): Promise<GeneratedTitle | undefined> {
	const text = opts.text.trim().slice(0, 4000);
	if (!text) return undefined;
	for (const { ref, model } of await candidates(config, opts.sessionModel)) {
		try {
			const stream = await streamFn(model, { systemPrompt: PROMPT, messages: [{ role: "user", content: `<first-message>\n${text}\n</first-message>\n\ntitle for this session:`, timestamp: Date.now() }] } as never, {
				apiKey: resolveApiKey(config, model.provider),
				maxTokens: 1024,
				...(model.reasoning ? { reasoning: "low" as const } : {}),
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			for await (const _ of stream) {
			}
			const msg: any = await stream.result();
			if (msg?.stopReason === "error" || msg?.stopReason === "aborted") continue;
			const words = (msg?.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n");
			const title = cleanTitle(words);
			// more than a handful of words is an answer to the message, not a name for it: try the next model
			if (title && title.split(/\s+/).length <= 8) return { title, model: ref, cost: msg?.usage?.cost?.total ?? 0 };
		} catch {}
	}
	return undefined;
}
