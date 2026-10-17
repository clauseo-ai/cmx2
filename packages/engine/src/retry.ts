import { type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

/**
 * transient provider failures (429, 529, overloaded, 5xx, a dropped connection) are retried with backoff
 * and jitter before a turn sees them. a failure is retried until text or a tool call has streamed: a retry
 * would replay those, so that error passes through as it is. thinking alone does not stop a retry. the
 * retried attempt's own start event is dropped, so pi's agent loop keeps the one message it opened and
 * replaces its content with the retried attempt's partials: the failed attempt's unsigned thinking never
 * reaches the transcript or the next request. clients see the part restart: the retry's request resets
 * the session's streaming parts (onPayload), so its first token announces the message and its parts again.
 */
export interface RetryPolicy {
	/** retries after the first attempt */
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

/** how long the stream's events may run before the event loop gets a turn */
const YIELD_EVERY_MS = 16;

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export interface RetryHooks {
	/** a retry is scheduled after `delayMs`; attempt is 1-based */
	onRetry?: (attempt: number, delayMs: number, message: string) => void;
	/** the retry's request is going out (the wait is over) */
	onResume?: () => void;
	/** the failed attempt had streamed thinking, which the retry discards and streams again; called before onRetry */
	onDiscard?: () => void;
}

/** the events a retry may discard and stream again; any other event commits the attempt */
const THINKING = new Set<string>(["thinking_start", "thinking_delta", "thinking_end"]);

/** 429 and 5xx by status too: pi's classifier reads the text, and a bare "529" is easy to miss */
export function retryable(m: AssistantMessage): boolean {
	if (m.stopReason !== "error") return false;
	const text = m.errorMessage ?? "";
	return isRetryableAssistantError(m) || /^(408|409|429|5\d\d)\b/.test(text) || /overloaded_error|rate_limit_error|api_error/.test(text);
}

export function retryDelay(policy: RetryPolicy, attempt: number): number {
	const exp = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
	// full jitter on the top quarter so parallel agents do not retry in lockstep
	return Math.round(exp * (1 - Math.random() * 0.25));
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function failed(stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
	return { role: "assistant", content: [], api: "unknown", provider: "unknown", model: "unknown", usage: ZERO, stopReason, errorMessage, timestamp: Date.now() } as unknown as AssistantMessage;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function withRetry(produce: () => Promise<AssistantMessageEventStream>, opts: { policy?: RetryPolicy; signal?: AbortSignal; hooks?: RetryHooks } = {}): AssistantMessageEventStream {
	const policy = opts.policy ?? DEFAULT_RETRY;
	const out = createAssistantMessageEventStream();
	void (async () => {
		// a start reached the loop: a later attempt's start is dropped, the loop already holds that message
		let opened = false;
		for (let attempt = 0; ; attempt++) {
			let inner: AssistantMessageEventStream;
			try {
				inner = await produce();
			} catch (e) {
				// the adapters report failures as error events; a throw here is a bug upstream, surfaced as one
				const message = e instanceof Error ? e.message : String(e);
				out.push({ type: "error", reason: "error", error: failed("error", message) });
				out.end();
				return;
			}
			// held: this attempt's start, until something follows it. committed: text, a tool call or the end
			// reached the loop, so a failure is no longer retried. streamed: thinking reached it
			let held: AssistantMessageEvent | undefined;
			let committed = false;
			let streamed = false;
			let retry: string | undefined;
			let since = performance.now();
			for await (const ev of inner) {
				// a provider chunk's events run back to back on microtasks; a big burst would hold the event loop
				// for seconds (no socket writes, no heartbeats, no other session). give the loop a turn every slice
				if (performance.now() - since > YIELD_EVERY_MS) {
					await new Promise((ok) => setImmediate(ok));
					since = performance.now();
				}
				if (!committed && ev.type === "error" && attempt < policy.maxRetries && !opts.signal?.aborted && retryable(ev.error)) {
					retry = ev.error.errorMessage ?? "the provider failed";
					break;
				}
				if (ev.type === "start") {
					if (!opened) held = ev;
					continue;
				}
				if (held) {
					out.push(held);
					held = undefined;
					opened = true;
				}
				if (THINKING.has(ev.type)) streamed = true;
				else committed = true;
				out.push(ev);
			}
			if (retry === undefined) {
				if (held) out.push(held);
				out.end();
				return;
			}
			if (streamed) opts.hooks?.onDiscard?.();
			const delay = retryDelay(policy, attempt + 1);
			opts.hooks?.onRetry?.(attempt + 1, delay, retry);
			const slept = await sleep(delay, opts.signal);
			opts.hooks?.onResume?.();
			if (!slept) {
				out.push({ type: "error", reason: "aborted", error: failed("aborted", "aborted while waiting to retry") });
				out.end();
				return;
			}
		}
	})();
	return out;
}
