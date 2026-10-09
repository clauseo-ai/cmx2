import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { defineTool, text, type Tool } from "./types.ts";

/** notes over this size are refused; they ride every post-compaction block */
export const NOTES_MAX_CHARS = 16_000;

export function readNotes(file: string): string {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	} catch {
		return "";
	}
}

/**
 * notes: a file the model keeps across context windows. it lives in the daemon's data dir, one per
 * session; after a compaction its text rides the post-compaction block, so what is written here is
 * never lost to a summary.
 */
export function notesTool(file: string): Tool {
	return defineTool({
		name: "notes",
		label: "notes",
		description:
			"your notes file for this session. it survives compaction: after the context is compacted its full text is in the post-compaction block. read returns it, write replaces it, append adds text to the end.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("append")]),
			text: Type.Optional(Type.String({ description: "for write and append" })),
		}),
		async execute(_id, params) {
			const now = readNotes(file);
			if (params.action === "read") return { content: [text(now || "(the notes file is empty)")], details: { chars: now.length } };
			if (typeof params.text !== "string") return { content: [text(`${params.action} needs text`)], details: { chars: now.length }, isError: true };
			const next = params.action === "write" ? params.text : now ? `${now.replace(/\n*$/, "\n")}${params.text}` : params.text;
			if (next.length > NOTES_MAX_CHARS) {
				return { content: [text(`the notes would be ${next.length} characters; the limit is ${NOTES_MAX_CHARS}. write a shorter version`)], details: { chars: now.length }, isError: true };
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, next);
			return { content: [text(`notes saved (${next.length} characters)`)], details: { chars: next.length } };
		},
	});
}

/** one stored piece of the session's history that matched */
export interface RecallHit {
	messageID: string;
	/** transcript position */
	seq: number;
	role: string;
	/** text, reasoning, tool input, tool output */
	kind: string;
	tool?: string;
	callID?: string;
	at: number;
	text: string;
	/** where the model stands with it: in context, cleared from context, or compacted away */
	note?: string;
}

export type RecallSearch = (query: string, limit: number) => Promise<{ hits: RecallHit[]; matches: number }>;

const EXCERPT_CHARS = 700;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function excerpt(t: string, terms: string[]): string {
	const lower = t.toLowerCase();
	const hits = terms.map((x) => lower.indexOf(x)).filter((i) => i >= 0);
	const at = hits.length ? Math.min(...hits) : 0;
	const start = Math.min(Math.max(0, at - EXCERPT_CHARS / 2), Math.max(0, t.length - EXCERPT_CHARS));
	const end = Math.min(t.length, start + EXCERPT_CHARS);
	return `${start > 0 ? "..." : ""}${t.slice(start, end).trim()}${end < t.length ? "..." : ""}`;
}

/**
 * recall: search this session's own stored history, everything said, run and read, including what a
 * compaction summarised away and tool output cleared from the context. the rows live in sqlite.
 */
export function recallTool(search: RecallSearch): Tool {
	return defineTool({
		name: "recall",
		label: "recall",
		description:
			"search this session's full stored history: every message, tool call and tool output, including what compaction replaced with a summary and outputs cleared from your context. every term must match (case-insensitive). returns excerpts with message ids and times, newest first among equals. it does not search files or other sessions.",
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "terms that must all appear; something distinctive works best (an error code, a path, a flag)" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `excerpts to return, default ${DEFAULT_LIMIT}` })),
		}),
		async execute(_id, params) {
			const limit = params.limit ?? DEFAULT_LIMIT;
			const { hits, matches } = await search(params.query, limit);
			if (!hits.length) {
				return { content: [text(`nothing in this session's history matches "${params.query}". every term has to appear in the same piece; try fewer or more distinctive terms`)], details: { matches: 0, returned: 0, notes: 0 } };
			}
			const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
			const lines = [`${matches} match${matches === 1 ? "" : "es"} in this session's history${matches > hits.length ? `, the top ${hits.length}` : ""}:`];
			hits.forEach((h, i) => {
				lines.push("", `${i + 1}. ${h.messageID} | ${h.role} | ${h.kind}${h.tool ? ` ${h.tool}` : ""} | ${new Date(h.at).toISOString()}`);
				if (h.note) lines.push(h.note);
				lines.push(excerpt(h.text, terms));
			});
			return { content: [text(lines.join("\n"))], details: { matches, returned: hits.length, notes: hits.filter((h) => h.note).length } };
		},
	});
}
