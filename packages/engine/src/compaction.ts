import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dropBlocks, dropsOf } from "./images.ts";

/**
 * compaction: a long context becomes a summary plus the recent messages, verbatim. the summary is asked
 * for on the session's own request (same system prompt, same tools, same history, the instruction as the
 * last user message), so the provider reads the whole prefix from cache; the old `system: []` compaction
 * paid a full cache write and minutes of stall every time (GOTCHAS). the transcript keeps every message
 * (rule 15): a compaction is one more line, and the context is rebuilt from the transcript the same way
 * live and on resume, byte for byte.
 */

export interface CompactionSettings {
	/** compact on their own when the context passes the threshold */
	auto: boolean;
	/** the threshold: tokens, or a fraction of the model's window when at most 1 */
	at: number;
	/** start the summary in the background at this fraction of the threshold; false turns it off */
	prefire: number | false;
	/** recent context kept verbatim after the summary, as a fraction of the threshold */
	keep: number;
	/** the newest tool output kept whole in that tail, in tokens; older outputs there are cleared (recall reads them) */
	protect: number;
}

export const COMPACTION_DEFAULTS: CompactionSettings = { auto: true, at: 300_000, prefire: 0.85, keep: 0.1, protect: 40_000 };

/** a summary shorter than this, over a head this long, cannot carry the state it replaces */
const DEGENERATE_MIN_CHARS = 500;
const DEGENERATE_MIN_HEAD = 6;
/** a cleared tool output leaves this behind; recall finds the original by its call id */
export const CLEARED = (callID: string) => `[tool output cleared from context at compaction; recall finds it (call ${callID})]`;
/** tool outputs under this many tokens are never worth clearing */
const CLEAR_MIN_TOKENS = 500;

/** the compaction line in the transcript; the model reads it as a user message */
export interface CompactionRecord {
	role: "compaction";
	summary: string;
	/** the post-compaction state block: runtime facts, not the model's prose */
	state: string;
	/** transcript position of the first message kept verbatim; the record's own position when none is */
	tailFrom: number;
	/** tool calls whose output the kept tail carries cleared */
	cleared: string[];
	trigger: "auto" | "manual" | "overflow";
	/** context tokens before */
	tokensBefore: number;
	/** the summary request's usage */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	model: string;
	/** wall time of the summary request */
	summaryMs: number;
	/** the summary was made in the background before the threshold (prefire) */
	prefire: boolean;
	timestamp: number;
}

export function thresholdOf(s: CompactionSettings, contextWindow: number): number {
	const window = contextWindow > 0 ? contextWindow : 200_000;
	if (s.at <= 1) return Math.floor(s.at * window);
	return Math.min(s.at, Math.floor(window * 0.9));
}

/** a rough token count for a message: characters over three (prose runs near four, code and json near two and a half), images a flat 1,600 */
export function estimateTokens(m: unknown): number {
	const any = m as { content?: unknown };
	let chars = 0;
	let images = 0;
	const walk = (c: unknown) => {
		if (typeof c === "string") chars += c.length;
		else if (Array.isArray(c)) for (const b of c) walk(b);
		else if (c && typeof c === "object") {
			const b = c as Record<string, unknown>;
			if (b.type === "image") images++;
			else if (typeof b.text === "string") chars += b.text.length;
			else if (typeof b.thinking === "string") chars += b.thinking.length;
			else chars += JSON.stringify(b).length;
		}
	};
	walk(any?.content);
	const rest = m as Record<string, unknown>;
	for (const k of ["summary", "state", "text", "output", "command"]) if (typeof rest[k] === "string") chars += (rest[k] as string).length;
	if (Array.isArray(rest.toolsAdded)) chars += JSON.stringify(rest.toolsAdded).length;
	return Math.ceil(chars / 3) + images * 1600;
}

/**
 * the context's size now: the newest assistant message's usage (what the provider counted, output
 * included) plus an estimate of everything after it. with no usage yet, all of it is estimated.
 */
export function contextUsed(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }; stopReason?: string };
		if (m.role !== "assistant" || !m.usage || m.stopReason === "error" || m.stopReason === "aborted") continue;
		const u = m.usage;
		const counted = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
		if (!counted) continue;
		let after = 0;
		for (let j = i + 1; j < messages.length; j++) after += estimateTokens(messages[j]);
		return counted + after;
	}
	return messages.reduce((n, m) => n + estimateTokens(m), 0);
}

/** the instruction the summary request ends with; the history before it is the session's own */
export const SUMMARY_INSTRUCTION = `the context is about to be compacted: everything above is replaced by what you write now, followed by the most recent messages kept word for word. write the summary you would want to resume from. use exactly these sections, in this order, with terse bullets:

## goal
## constraints and preferences
## done
## in progress
## blocked
## key decisions
## ruled out
## live state
## next steps
## critical context
## relevant files

write "(none)" under a section with nothing in it. keep exact file paths, commands, error strings, ids and names; never paraphrase an identifier. mark guesses with (hypothesis). answer with the summary only: no tool calls, no preamble.`;

/** why a summary is unusable, or undefined when it is fine */
export function degenerate(text: string | undefined, headMessages: number): string | undefined {
	const t = text?.trim() ?? "";
	if (!t) return "the summary came back empty";
	if (headMessages < DEGENERATE_MIN_HEAD) return undefined;
	if (!/^##\s*goal\b/im.test(t)) return "the summary is missing its goal section";
	if (t.length < DEGENERATE_MIN_CHARS) return `the summary is ${t.length} characters for ${headMessages} messages`;
	return undefined;
}

/** what the model reads in place of the compacted history */
export function compactionText(r: Pick<CompactionRecord, "summary" | "state">): string {
	return `<compaction-summary>\nthe conversation before this point was compacted into this summary; the messages after it are verbatim.\n\n${r.summary.trim()}\n</compaction-summary>\n<post-compaction-state>\n${r.state.trim()}\n</post-compaction-state>`;
}

/** a system message that changes the tool set, stripped of its words, so the tools survive the compaction that drops the words */
export function toolCarrier(m: AgentMessage): AgentMessage | undefined {
	const s = m as { role?: string; toolsAdded?: unknown[]; toolsRemoved?: unknown[]; sections?: Record<string, unknown>; timestamp?: number };
	if (s.role !== "system") return undefined;
	if (!s.toolsAdded?.length && !s.toolsRemoved?.length && !(s.sections && Object.keys(s.sections).length)) return undefined;
	return {
		role: "system",
		content: "",
		...(s.toolsAdded?.length ? { toolsAdded: s.toolsAdded } : {}),
		...(s.toolsRemoved?.length ? { toolsRemoved: s.toolsRemoved } : {}),
		...(s.sections && Object.keys(s.sections).length ? { sections: s.sections } : {}),
		timestamp: s.timestamp ?? 0,
	} as unknown as AgentMessage;
}

/** a tool result with its output replaced by the cleared marker; the transcript keeps the original */
export function clearedResult(m: AgentMessage): AgentMessage {
	const r = m as { toolCallId: string };
	return { ...(m as object), content: [{ type: "text", text: CLEARED(r.toolCallId) }] } as unknown as AgentMessage;
}

/**
 * the tool calls in a kept tail whose output is cleared: walking back from the newest, outputs stay whole
 * until `protect` tokens of them are kept; older ones over a small floor are cleared
 */
export function toClear(tail: readonly AgentMessage[], protect: number): string[] {
	const out: string[] = [];
	let kept = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const m = tail[i] as { role?: string; toolCallId?: string };
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		const t = estimateTokens(m);
		if (kept + t <= protect || t < CLEAR_MIN_TOKENS) {
			kept += t;
			continue;
		}
		out.push(m.toolCallId);
	}
	return out.reverse();
}

/**
 * where the kept tail starts: as many recent messages as fit `budget` tokens, never starting on a tool
 * result (its call would be gone) or a system message, and never before `floor` (messages at or before
 * the previous compaction line stay behind it). returns an index into `messages`, `messages.length` for none.
 */
export function tailStart(messages: readonly AgentMessage[], floor: number, budget: number): number {
	let i = messages.length;
	let used = 0;
	while (i > floor) {
		const t = estimateTokens(messages[i - 1]);
		if (used + t > budget) break;
		used += t;
		i--;
	}
	while (i < messages.length) {
		const r = (messages[i] as { role?: string }).role;
		if (r === "assistant" || r === "user" || r === "shell" || r === "notice" || r === "mail") break;
		i++;
	}
	return i;
}

/**
 * the context a transcript holds: every message, or after a compaction the leading system message, the
 * tool changes made before the kept tail, the compaction line, the tail (cleared outputs marked) and what
 * came after. message i of the transcript sits at position i + 1; reverted ranges are skipped. images a
 * drop line took out are markers wherever their message lands, whatever was reverted since: a drop is a
 * fact about the context, not part of the conversation.
 */
export function contextOf(all: readonly AgentMessage[]): AgentMessage[] {
	return contextWithSeq(all).map((x) => x.m);
}

/** contextOf, each message with the transcript position it stands for (copies carry their original's) */
export function contextWithSeq(all: readonly AgentMessage[]): Array<{ m: AgentMessage; seq: number }> {
	const live = visible(all);
	const drops = dropsOf(all);
	const shown = (x: { m: AgentMessage; seq: number }) => {
		const blocks = drops.get(x.seq);
		return blocks ? { m: dropBlocks(x.m, blocks), seq: x.seq } : x;
	};
	let c = -1;
	for (let i = live.length - 1; i >= 0; i--) {
		if ((live[i]!.m as { role?: string }).role === "compaction") {
			c = i;
			break;
		}
	}
	if (c < 0) return live.map(shown);
	const rec = live[c]!.m as unknown as CompactionRecord;
	let start = live.findIndex((x) => x.seq >= rec.tailFrom);
	if (start < 0 || start > c) start = c;
	const cleared = new Set(rec.cleared);
	const carriers = live.slice(1, start).flatMap((x) => {
		const t = toolCarrier(x.m);
		return t ? [{ m: t, seq: x.seq }] : [];
	});
	const tail = live
		.slice(start, c)
		.map((x) => ((x.m as { role?: string; toolCallId?: string }).role === "toolResult" && cleared.has((x.m as { toolCallId: string }).toolCallId) ? { m: clearedResult(x.m), seq: x.seq } : shown(x)));
	return [live[0]!, ...carriers, live[c]!, ...tail, ...live.slice(c + 1).map(shown)];
}

/** a revert line: messages from `from` up to the line itself are out of the context (they stay in the transcript) */
export interface RevertRecord {
	role: "revert";
	/** transcript position of the first message taken out */
	from: number;
	timestamp: number;
}

/** the transcript minus reverted ranges, each message with its position; revert and drop lines themselves are dropped */
export function visible(all: readonly AgentMessage[]): Array<{ m: AgentMessage; seq: number }> {
	const out: Array<{ m: AgentMessage; seq: number }> = [];
	all.forEach((m, i) => {
		const seq = i + 1;
		const role = (m as { role?: string }).role;
		if (role === "revert") {
			const from = (m as unknown as RevertRecord).from;
			while (out.length && out[out.length - 1]!.seq >= from) out.pop();
			return;
		}
		if (role === "drop") return;
		out.push({ m, seq });
	});
	return out;
}
