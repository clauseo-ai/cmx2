import { isContextOverflow } from "@earendil-works/pi-ai";

/**
 * provider failures as typed errors a client can show as they are. refusals and content filters have
 * their own path (`RefusalError`, gates.ts); everything else a provider answers with lands in one of
 * these kinds. the message is short, lowercase, and says what to do.
 */
export type ProviderErrorKind = "context_overflow" | "auth" | "rate_limit" | "overloaded" | "unknown";

export interface TypedProviderError {
	name: "ContextOverflowError" | "AuthError" | "RateLimitError" | "ProviderUnavailableError" | "ProviderError";
	kind: ProviderErrorKind;
	message: string;
	/** the provider's own words, for the transcript and the log */
	detail: string;
	status?: number;
}

/** the http status the sdk put at the front of its message (`529 {...}`), when there is one */
function statusOf(text: string): number | undefined {
	const m = text.match(/^(\d{3})\b/);
	return m ? Number(m[1]) : undefined;
}

/** the provider's error type and message out of a json body anywhere in the text (vertex wraps it in an array) */
function bodyOf(text: string): { type?: string; message?: string } {
	const parse = (from: number) => {
		if (from < 0) return undefined;
		try {
			const b = JSON.parse(text.slice(from));
			return Array.isArray(b) ? b[0] : b;
		} catch {
			return undefined;
		}
	};
	const b = [text.indexOf("["), text.indexOf("{")]
		.filter((i) => i >= 0)
		.sort((x, y) => x - y)
		.reduce<any>((found, i) => found ?? parse(i), undefined);
	const e = b?.error ?? b;
	return { ...(typeof e?.type === "string" ? { type: e.type } : typeof e?.status === "string" ? { type: e.status } : {}), ...(typeof e?.message === "string" ? { message: e.message } : {}) };
}

/**
 * a refusal of the request's media rather than its tokens, by what was wrong: the bytes (anthropic's 413
 * `request_too_large`, vertex's `The message size (N bytes) exceeds 30.000MB limit.`, gemini's payload
 * size), the count of images and documents, one image's size (over the many-image size or the per-image
 * cap), or an image the provider could not read (`Could not process image`). dropping images fixes these
 * where a summary would not, and since the transcript replays, nothing else does
 */
export type MediaRefusal = "bytes" | "count" | "image" | "unreadable";

const UNREADABLE_REFUSAL = /could not process image|image does not match the provided media type|specified using the image\/\w+ media type|invalid base64 image|unsupported image format/i;
const COUNT_REFUSAL = /too many images|too much media|images? and documents?: \d+ ?\+ ?\d+ ?> ?\d+/i;
const IMAGE_REFUSAL = /many-image requests|image exceeds [\d.]+ ?mb|image base64 size/i;
const BYTES_REFUSAL = /request_too_large|request entity too large|payload too large|request exceeds the maximum size|message size \(\d+ bytes\) exceeds|exceeds [\d.]+ ?mb limit|payload size exceeds/i;

export function mediaRefusal(errorMessage: string | undefined): MediaRefusal | undefined {
	const raw = errorMessage ?? "";
	if (UNREADABLE_REFUSAL.test(raw)) return "unreadable";
	if (COUNT_REFUSAL.test(raw)) return "count";
	if (IMAGE_REFUSAL.test(raw)) return "image";
	if (statusOf(raw) === 413 || BYTES_REFUSAL.test(raw)) return "bytes";
	return undefined;
}

export function classifyProviderError(opts: { provider: string; model: string; errorMessage: string | undefined; contextWindow?: number; message?: any }): TypedProviderError {
	const raw = opts.errorMessage ?? "";
	const status = statusOf(raw);
	const body = bodyOf(raw);
	const detail = (body.message ?? raw).slice(0, 500) || "the provider returned an error with no message";
	const who = `${opts.provider}/${opts.model}`;
	const t = `${body.type ?? ""} ${raw}`.toLowerCase();
	const base = { detail, ...(status ? { status } : {}) };
	const overflow = opts.message ? isContextOverflow({ ...opts.message, stopReason: "error", errorMessage: raw }, opts.contextWindow) : false;
	const media = mediaRefusal(raw);
	if (media === "unreadable") return { name: "ProviderError", kind: "unknown", message: `${who} could not read an image in the request`, ...base };
	if (media) return { name: "ContextOverflowError", kind: "context_overflow", message: `the request is over ${who}'s size limit (too many bytes or images)`, ...base };
	if (overflow || /prompt is too long|context length|context window|too many tokens|maximum context|request too large|input is too long|exceeds the maximum/.test(t) || status === 413) {
		return { name: "ContextOverflowError", kind: "context_overflow", message: `the conversation is longer than ${who} accepts; compact it or start a new session`, ...base };
	}
	if (status === 401 || status === 403 || /authentication_error|permission_error|invalid (x-)?api[- ]?key|unauthorized|invalid_api_key|api key not valid|forbidden/.test(t)) {
		return { name: "AuthError", kind: "auth", message: `${opts.provider} refused the credentials; check providers.${opts.provider}.apiKey in cmx2.jsonc`, ...base };
	}
	if (status === 429 || /rate_limit|rate limit|too many requests|resource_exhausted|quota/.test(t)) {
		return { name: "RateLimitError", kind: "rate_limit", message: `${opts.provider} is rate limiting this key; the retries ran out, try again in a minute`, ...base };
	}
	if (status === 529 || (status !== undefined && status >= 500) || /overloaded|unavailable|internal server error|bad gateway|gateway timeout|high demand/.test(t)) {
		return { name: "ProviderUnavailableError", kind: "overloaded", message: `${who} is overloaded or down; the retries ran out, send it again in a moment`, ...base };
	}
	return { name: "ProviderError", kind: "unknown", message: `${who} failed: ${detail.slice(0, 200).toLowerCase()}`, ...base };
}
