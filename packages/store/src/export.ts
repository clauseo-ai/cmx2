import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageRow, PartRow, Store, StoredSession } from "./index.ts";

/**
 * a session as one file: the session row, every projected message with its parts, the engine
 * transcript (the truth a daemon resumes from), the recorded prefix and the step telemetry. an import
 * writes all of it into another store so the session lists, reads and continues there. nothing is
 * ever overwritten or deleted (rule 15): an id that is already there is refused, or imported under a
 * fresh id when asked.
 */

export const EXPORT_FORMAT = "cmx2.session";
export const EXPORT_VERSION = 1;

export interface ExportedMessage extends Omit<MessageRow, "info"> {
	info: Record<string, unknown>;
	parts: Array<Omit<PartRow, "data"> & { data: Record<string, unknown> }>;
}

export interface SessionExport {
	format: typeof EXPORT_FORMAT;
	version: number;
	exported_at: number;
	/** the cmx2 version that wrote the file, when the caller knows it */
	cmx2?: string;
	session: Omit<StoredSession, "session_file" | "archived_at">;
	messages: ExportedMessage[];
	/** the engine transcript as written (jsonl), or null for a session that never had one (cmx history) */
	transcript: string | null;
	prefix: { hash: string; bytes: string } | null;
	steps: Record<string, unknown>[];
}

export class ExportError extends Error {}

function parse(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return { raw: s };
	}
}

/** reads one session out of the store; works for live and archived (imported cmx) sessions alike */
export function exportSession(store: Store, id: string, opts: { cmx2?: string } = {}): SessionExport {
	const s = store.session(id);
	if (!s) throw new ExportError(`there is no session ${id} in ${store.path}; cmx2 session list shows the ids`);
	// the transcript revision belongs to this store's writes; an import starts its own at 0
	const { session_file, archived_at: _a, transcript_rev: _r, ...session } = s;
	const messages: ExportedMessage[] = [];
	let before: number | undefined;
	// newest page first, 200 at a time, so a long session never sits in memory twice as rows and json
	const pages: ExportedMessage[][] = [];
	for (;;) {
		const page = store.messages(id, { limit: 200, ...(before !== undefined ? { before } : {}) });
		pages.push(page.rows.map(({ parts, info, ...m }) => ({ ...m, info: parse(info), parts: parts.map(({ data, ...p }) => ({ ...p, data: parse(data) })) })));
		if (page.next === null) break;
		before = page.next;
	}
	for (const p of pages.reverse()) messages.push(...p);
	const transcript = session_file && existsSync(session_file) ? readFileSync(session_file, "utf8") : null;
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exported_at: Date.now(),
		...(opts.cmx2 ? { cmx2: opts.cmx2 } : {}),
		session,
		messages,
		transcript,
		prefix: store.prefix(id) ?? null,
		steps: store.steps(id),
	};
}

/** checks the shape of a file before anything is written */
export function readExport(raw: string): SessionExport {
	let v: any;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new ExportError("that file is not json; it should be what cmx2 session export wrote");
	}
	if (v?.format !== EXPORT_FORMAT) throw new ExportError(`that file is not a cmx2 session export (format is ${JSON.stringify(v?.format)}, want ${EXPORT_FORMAT})`);
	if (typeof v.version !== "number" || v.version > EXPORT_VERSION) throw new ExportError(`that export is version ${v.version}; this cmx2 reads up to ${EXPORT_VERSION}. upgrade with cmx2 upgrade`);
	if (typeof v.session?.id !== "string" || !Array.isArray(v.messages)) throw new ExportError("that export has no session or no messages; it is cut short or edited");
	return v as SessionExport;
}

const bare = (id: string) => id.replace(/^ses_/, "");

/** the same export under another session id: message and part ids carry the session's, so every mention moves */
function renamed(e: SessionExport, to: string): SessionExport {
	const from = bare(e.session.id);
	return JSON.parse(JSON.stringify(e).replaceAll(from, bare(to))) as SessionExport;
}

export interface ImportResult {
	id: string;
	messages: number;
	parts: number;
	steps: number;
	transcript: string | null;
}

/**
 * writes an export into the store. `dataDir` is where the importing daemon keeps transcripts
 * (`<dataDir>/sessions/<id>.jsonl`); `directory` moves the session to a folder on this machine;
 * `asNew` imports a session that is already here under a fresh id instead of refusing.
 */
export function importSession(store: Store, input: SessionExport, opts: { dataDir: string; directory?: string; asNew?: boolean }): ImportResult {
	let e = input;
	if (store.session(e.session.id)) {
		if (!opts.asNew) throw new ExportError(`session ${e.session.id} is already in this database; nothing was changed. pass --as-new to import a copy under a fresh id`);
		e = renamed(e, `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
	}
	const id = e.session.id;
	const file = e.transcript === null ? null : join(opts.dataDir, "sessions", `${id}.jsonl`);
	if (file && existsSync(file)) throw new ExportError(`${file} already exists; nothing was changed. pass --as-new to import under a fresh id`);
	const directory = opts.directory ?? e.session.directory;
	const stepCols = new Set((store.db.query("pragma table_info(step)").all() as Array<{ name: string }>).map((c) => c.name));
	let parts = 0;
	store.db.transaction(() => {
		store.putSession({ ...e.session, directory, session_file: file, updated_at: e.session.updated_at ?? e.session.created_at } as StoredSession);
		const msg = store.db.query(
			`insert into message (id, session_id, seq, role, created_at, completed_at, model, effort, tokens_input, tokens_output,
			   tokens_cache_read, tokens_cache_write, cost, stop_reason, info)
			 values ($id, $session_id, $seq, $role, $created_at, $completed_at, $model, $effort, $tokens_input, $tokens_output,
			   $tokens_cache_read, $tokens_cache_write, $cost, $stop_reason, $info)`,
		);
		const part = store.db.query("insert into part (id, message_id, session_id, seq, type, data) values ($id, $message_id, $session_id, $seq, $type, $data)");
		for (const { parts: ps, info, ...m } of e.messages) {
			const i = { ...info, ...(typeof (info as { path?: unknown }).path === "object" && opts.directory ? { path: { cwd: directory, root: directory } } : {}) };
			msg.run({ ...m, completed_at: m.completed_at ?? null, model: m.model ?? null, effort: m.effort ?? null, stop_reason: m.stop_reason ?? null, session_id: id, info: JSON.stringify(i) } as never);
			for (const { data, ...p } of ps) {
				part.run({ ...p, session_id: id, data: JSON.stringify(data) } as never);
				parts++;
			}
		}
		if (e.prefix) store.putPrefix(id, e.prefix.hash, e.prefix.bytes);
		for (const s of e.steps) store.putStep(Object.fromEntries(Object.entries({ ...s, session_id: id }).filter(([k]) => stepCols.has(k))));
	})();
	if (file && e.transcript !== null) {
		mkdirSync(join(opts.dataDir, "sessions"), { recursive: true });
		// the header's cwd is where tools run on resume; it follows the session's directory
		const lines = e.transcript.split("\n");
		const head = lines[0] ? parse(lines[0]) : undefined;
		if (head?.type === "header") lines[0] = JSON.stringify({ ...head, id, cwd: directory });
		writeFileSync(file, lines.join("\n"), { flag: "wx" });
	}
	return { id, messages: e.messages.length, parts, steps: e.steps.length, transcript: file };
}

// ---------- markdown ----------

const fence = (s: string) => {
	const ticks = s.match(/`{3,}/g)?.reduce((n, t) => Math.max(n, t.length + 1), 3) ?? 3;
	return `${"`".repeat(ticks)}\n${s}\n${"`".repeat(ticks)}`;
};

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}\n… ${s.length - max} more characters` : s;
}

function when(ms: number | null | undefined): string {
	return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "unknown";
}

/**
 * the session as markdown for reading or pasting: the user's words, the answers, and each tool call with
 * its input and (clipped) output. `toolOutput` caps each tool output in characters (0 leaves outputs out).
 */
export function sessionMarkdown(e: SessionExport, opts: { toolOutput?: number } = {}): string {
	const cap = opts.toolOutput ?? 4000;
	const s = e.session;
	const out: string[] = [`# ${s.title || "untitled"}`, ""];
	out.push(`- session: \`${s.id}\``, `- directory: \`${s.directory}\``, `- model: ${s.model}`, `- started: ${when(s.created_at)}, last active: ${when(s.updated_at)}`);
	if (s.cost) out.push(`- cost: $${Number(s.cost).toFixed(4)}`);
	out.push("");
	for (const m of e.messages) {
		const who = m.role === "user" ? "user" : `assistant${m.model ? ` (${m.model}${m.effort ? `, ${m.effort}` : ""})` : ""}`;
		out.push(`## ${who}`, "", `<sub>${when(m.created_at)}</sub>`, "");
		for (const { data: p } of m.parts) {
			if (p.type === "text" && typeof p.text === "string") {
				if (p.synthetic) continue;
				out.push(p.text, "");
			} else if (p.type === "reasoning" && typeof p.text === "string" && p.text.trim()) {
				out.push(p.text.split("\n").map((l) => `> ${l}`).join("\n"), "");
			} else if (p.type === "tool") {
				const st = (p.state ?? {}) as { status?: string; input?: unknown; output?: unknown; error?: unknown };
				out.push(`**${String(p.tool)}** ${st.status ?? ""}`.trimEnd(), "");
				if (st.input !== undefined) out.push(fence(clip(typeof st.input === "string" ? st.input : JSON.stringify(st.input, null, 2), 4000)), "");
				const result = st.error ?? st.output;
				if (cap && result !== undefined && result !== "") out.push(fence(clip(typeof result === "string" ? result : JSON.stringify(result, null, 2), cap)), "");
			} else if (p.type === "file") {
				out.push(`*attached: ${String(p.filename ?? p.mime ?? "a file")}*`, "");
			}
		}
		const err = (m.info.error as { data?: { message?: string } } | undefined)?.data?.message;
		if (err) out.push(`*error: ${err}*`, "");
	}
	return `${out.join("\n").trimEnd()}\n`;
}
