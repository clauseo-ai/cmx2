import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { archivePathFor, decompress, SESSION_COLUMNS } from "./archive.ts";
import { MIGRATIONS } from "./migrations.ts";
import { AgentStore } from "./agents.ts";

export { MIGRATIONS } from "./migrations.ts";
export { AgentStore, type AgentRow, type AgentState, type MailKind, type MailRow } from "./agents.ts";
export { ARCHIVE_FILE, ARCHIVE_MIGRATIONS, archivePathFor, openArchiveWriter } from "./archive.ts";
export { closeIfDone, closeOpenSteps, documentPart, messageId, partId, projectMessage, projectTranscript, type Touched } from "./projection.ts";
export { EXPORT_FORMAT, EXPORT_VERSION, type ExportedMessage, ExportError, exportSession, importSession, type ImportResult, readExport, type SessionExport, sessionMarkdown } from "./export.ts";
export { DEFAULT_SINCE_DAYS, fileBytes, importCmx, ImportError, type ImportCounts, type ImportOptions, parseSince } from "./import-cmx.ts";

export interface StoredSession {
	id: string;
	directory: string;
	title: string;
	model: string;
	session_file: string | null;
	created_at: number;
	updated_at?: number | null;
	effort?: string | null;
	nudge?: number | null;
	turn_mode?: string | null;
	cache_ttl?: string | null;
	parent_id?: string | null;
	slug?: string | null;
	project_id?: string | null;
	/** `cmx2` for sessions this daemon ran, `cmx` for history imported from the cmx db (browse only) */
	source?: string;
	version?: string | null;
	cost?: number;
	tokens_input?: number;
	tokens_output?: number;
	tokens_cache_read?: number;
	tokens_cache_write?: number;
	/** json `{additions, deletions, files}` when known */
	summary?: string | null;
	/** when the session was archived (hidden from listings, never deleted: rule 15) */
	archived_at?: number | null;
	/** moves on every write that changes what the session's message reads answer, streamed text aside; 0 for imported history */
	transcript_rev?: number;
	/** set on a session made by fork: the session it was forked from */
	forked_from?: string | null;
	/** the parent's message the fork was cut before; null when the whole history was forked */
	forked_at_message?: string | null;
}

/** an armed revert: the files are back as they were before `messageID`; unrevert puts `snapshot` back */
export interface SessionRevert {
	messageID: string;
	partID?: string;
	/** transcript position of the first parked message */
	seq: number;
	/** the work tree as it was just before the revert, for unrevert */
	snapshot?: string;
	/** the files the revert put back */
	files: string[];
	/** what the revert undid, summarised */
	diff?: { files: number; additions: number; deletions: number };
}

/** the work tree before a turn (and after it, once it settled) */
export interface TurnSnapshot {
	session_id: string;
	/** transcript position before the turn's first message */
	from_seq: number;
	to_seq?: number | null;
	before: string;
	after?: string | null;
	/** json list of files the turn changed */
	files?: string | null;
	at: number;
}

/** one searchable piece of a session's history */
export interface RecallDoc {
	id: string;
	session_id: string;
	message_id: string;
	seq: number;
	role: string;
	kind: string;
	tool?: string | null;
	call_id?: string | null;
	at: number;
	text: string;
}

export interface MessageRow {
	id: string;
	session_id: string;
	seq: number;
	role: string;
	created_at: number;
	completed_at: number | null;
	model: string | null;
	effort: string | null;
	tokens_input: number;
	tokens_output: number;
	tokens_cache_read: number;
	tokens_cache_write: number;
	cost: number;
	stop_reason: string | null;
	/** json: opencode-shaped message info extras */
	info: string;
	/** 1 when a permanent revert took the message out of the context (it stays: rule 15) */
	reverted?: number;
}

export interface PartRow {
	id: string;
	message_id: string;
	session_id: string;
	seq: number;
	type: string;
	/** json: opencode-shaped part */
	data: string;
}

export interface PendingPermission {
	id: string;
	session_id: string;
	directory: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool: { messageID: string; callID: string } | null;
	created_at: number;
}

export interface PendingQuestion {
	id: string;
	session_id: string;
	directory: string;
	questions: unknown[];
	tool: { messageID: string; callID: string } | null;
	created_at: number;
}

export interface SavedRule {
	scope: string;
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
}

/** filters for session listing; every list is newest first unless `order` says otherwise */
export interface SessionQuery {
	limit: number;
	/** exact directory match */
	directory?: string;
	/** sessions whose project (git root or directory) is this */
	project?: string;
	/** only sessions without a parent */
	roots?: boolean;
	/** title contains, case-insensitive */
	search?: string;
	/** updated at or after (ms) */
	start?: number;
	/** archived sessions are left out unless this is true (include them) or "only" */
	archived?: boolean | "only";
}

/** a position in a created-ordered listing; filters ride inside so a page can never drift from its query */
export interface CreatedCursor {
	id: string;
	time: number;
	order: "asc" | "desc";
	direction: "next" | "previous";
	directory?: string;
	project?: string;
	roots?: boolean;
	search?: string;
	start?: number;
}

export function encodeCursor(c: CreatedCursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): CreatedCursor | undefined {
	try {
		const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
		if (typeof c?.id !== "string" || typeof c?.time !== "number") return undefined;
		if (c.order !== "asc" && c.order !== "desc") return undefined;
		if (c.direction !== "next" && c.direction !== "previous") return undefined;
		return c as CreatedCursor;
	} catch {
		return undefined;
	}
}

/**
 * a part as an imported session serves it. cmx once recorded a tool call the model garbled with its `input` as the
 * raw string; the contract says an object, so a decoder built from it rejects the page. the input reads as {} and the
 * string rides on the state as `raw`; what is stored is untouched
 */
export function archivedPart(type: string, data: string): string {
	if (type !== "tool" || !data.includes('"input":"')) return data;
	try {
		const part = JSON.parse(data);
		const input = part?.state?.input;
		if (!part?.state || typeof input !== "string") return data;
		return JSON.stringify({ ...part, state: { ...part.state, input: {}, raw: input } });
	} catch {
		return data;
	}
}

/** what a session's context holds and its armed revert, as session rows carry them */
export interface SessionStateInfo {
	context?: { used: number; limit: number; compactAt?: number };
	revert?: SessionRevert;
}

interface SessionStateRow {
	context_used: number | null;
	context_limit: number | null;
	compact_at: number | null;
	revert: string | null;
}

function stateInfo(r: SessionStateRow): SessionStateInfo {
	return {
		...(r.context_used !== null && r.context_limit !== null ? { context: { used: r.context_used, limit: r.context_limit, ...(r.compact_at ? { compactAt: r.compact_at } : {}) } } : {}),
		...(r.revert ? { revert: JSON.parse(r.revert) as SessionRevert } : {}),
	};
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

const COLS = SESSION_COLUMNS.join(", ");

export class Store {
	readonly db: Database;
	/** imported history, attached read-only as `archive` once the file exists; null turns it off */
	readonly archivePath: string | null;
	private attached = false;
	/** agents and mailboxes (m5) */
	readonly agents: AgentStore;

	constructor(
		readonly path: string,
		opts: { archivePath?: string | null } = {},
	) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true, strict: true });
		// a small page cache on purpose: transcripts are read in ranges, never held whole (daemon budget)
		this.db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma synchronous = normal; pragma cache_size = -8000; pragma foreign_keys = on;");
		this.migrate();
		this.agents = new AgentStore(this.db);
		this.archivePath = opts.archivePath === undefined ? archivePathFor(path) : opts.archivePath;
		this.sessionView();
		this.attachArchive();
	}

	/** true when archive.db is attached (read-only) and its sessions ride every listing */
	get hasArchive(): boolean {
		this.attachArchive();
		return this.attached;
	}

	/**
	 * attaches archive.db read-only the first time it is seen. called from every read path, so an
	 * import that creates the file while the daemon runs shows up without a restart. the attach is a
	 * uri with `mode=ro`: a write through this connection fails with "attempt to write a readonly database".
	 * bun's own sqlite (its linux builds) is compiled without uri filenames, so there the uri is read as a
	 * file name that does not exist and the attach fails: the plain path is attached instead, and temp
	 * triggers refuse every insert, update and delete on the archive's tables with the same message.
	 */
	private attachArchive() {
		if (this.attached || !this.archivePath || !existsSync(this.archivePath)) return;
		const uri = `file:${encodeURI(this.archivePath).replace(/\?/g, "%3f").replace(/#/g, "%23")}?mode=ro`;
		let guard = false;
		try {
			this.db.query("attach database ? as archive").run(uri);
		} catch {
			try {
				this.db.query("attach database ? as archive").run(this.archivePath);
				guard = true;
			} catch {
				return;
			}
		}
		// an importer that has created the file but not its schema yet: try again on the next read
		const ready = this.db.query("select count(*) as n from archive.sqlite_master where type = 'table' and name in ('session', 'message', 'part')").get() as { n: number };
		if (ready.n < 3) {
			this.db.exec("detach database archive");
			return;
		}
		if (guard) this.guardArchive();
		this.attached = true;
		this.sessionView();
	}

	/** what `mode=ro` does, where the attach could not say it: every write to an archive table is refused */
	private guardArchive() {
		const tables = this.db.query("select name from archive.sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>;
		for (const { name } of tables) {
			const table = name.replace(/"/g, '""');
			for (const op of ["insert", "update", "delete"]) {
				this.db.exec(`create temp trigger if not exists "archive_ro_${table}_${op}" before ${op} on archive."${table}" begin select raise(abort, 'attempt to write a readonly database'); end`);
			}
		}
	}

	/**
	 * `all_session`: main's sessions plus the archive's, one row per id with main winning. a temp view,
	 * so it lives on this connection only and never touches either file.
	 */
	private sessionView() {
		this.db.exec("drop view if exists temp.all_session");
		const main = `select ${COLS}, archived_at, transcript_rev, forked_from, forked_at_message from main.session`;
		const archive = `select ${SESSION_COLUMNS.map((c) => `a.${c}`).join(", ")}, ai.archived_at, 0 as transcript_rev, null as forked_from, null as forked_at_message from archive.session a
			left join main.archived_import ai on ai.id = a.id where not exists (select 1 from main.session m where m.id = a.id)`;
		this.db.exec(`create temp view all_session as ${this.attached ? `${main} union all ${archive}` : main}`);
	}

	/** where a session's messages live: the live projection in main, or the compressed archive */
	private home(sessionId: string): "main" | "archive" | undefined {
		if (this.db.query("select 1 from main.session where id = ?").get(sessionId)) return "main";
		if (this.hasArchive && this.db.query("select 1 from archive.session where id = ?").get(sessionId)) return "archive";
		return undefined;
	}

	get version(): number {
		return (this.db.query("pragma user_version").get() as { user_version: number }).user_version;
	}

	/**
	 * one write transaction taken before the version is read, so daemons opening the same fresh
	 * database at once migrate it exactly once: the second waits on the lock, then finds nothing to do.
	 */
	private migrate() {
		if (this.version >= MIGRATIONS.length) return;
		this.db
			.transaction(() => {
				for (let i = this.version; i < MIGRATIONS.length; i++) {
					this.db.exec(MIGRATIONS[i]!);
					this.db.exec(`pragma user_version = ${i + 1}`);
				}
			})
			.immediate();
	}

	// ---------- sessions ----------

	putSession(s: StoredSession) {
		this.db
			.query(
				`insert into session (id, directory, title, model, session_file, created_at, updated_at, effort, nudge, turn_mode, cache_ttl,
				   parent_id, slug, project_id, source, version, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, summary, forked_from, forked_at_message)
				 values ($id, $directory, $title, $model, $session_file, $created_at, $updated_at, $effort, $nudge, $turn_mode, $cache_ttl,
				   $parent_id, $slug, $project_id, $source, $version, $cost, $tokens_input, $tokens_output, $tokens_cache_read, $tokens_cache_write, $summary, $forked_from, $forked_at_message)
				 on conflict(id) do update set title = excluded.title, model = excluded.model, session_file = excluded.session_file,
				   updated_at = excluded.updated_at, effort = excluded.effort, nudge = excluded.nudge, turn_mode = excluded.turn_mode,
				   cache_ttl = excluded.cache_ttl, parent_id = excluded.parent_id, slug = excluded.slug, project_id = excluded.project_id,
				   version = excluded.version, cost = excluded.cost, tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output,
				   tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write, summary = excluded.summary,
				   forked_from = coalesce(excluded.forked_from, session.forked_from), forked_at_message = coalesce(excluded.forked_at_message, session.forked_at_message)`,
			)
			.run({
				effort: null,
				nudge: null,
				turn_mode: null,
				cache_ttl: null,
				parent_id: null,
				slug: null,
				project_id: null,
				source: "cmx2",
				version: null,
				cost: 0,
				tokens_input: 0,
				tokens_output: 0,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				summary: null,
				forked_from: null,
				forked_at_message: null,
				...s,
				updated_at: s.updated_at ?? s.created_at,
			} as never);
	}

	/** one session from either database, archived or not */
	session(id: string): StoredSession | undefined {
		this.attachArchive();
		return (this.db.query("select * from all_session where id = ?").get(id) as StoredSession | null) ?? undefined;
	}

	setSessionEffort(id: string, effort: string) {
		this.db.query("update main.session set effort = ? where id = ?").run(effort, id);
	}

	/** a session's prompt-cache ttl once the daemon switched it to 1h (an explicit one is written at creation) */
	setSessionCacheTtl(id: string, ttl: "5m" | "1h") {
		this.db.query("update main.session set cache_ttl = ? where id = ?").run(ttl, id);
	}

	setSessionModel(id: string, model: string) {
		this.db.query("update main.session set model = ? where id = ?").run(model, id);
	}

	/** sessions started by this one (subagents, from m5), newest first, from either database */
	children(id: string): StoredSession[] {
		this.attachArchive();
		return this.db.query("select * from all_session where parent_id = ? order by created_at desc").all(id) as StoredSession[];
	}

	/** the session's transcript revision now (0 for imported history and unknown ids) */
	transcriptRev(id: string): number {
		return (this.db.query("select transcript_rev as n from main.session where id = ?").get(id) as { n: number } | null)?.n ?? 0;
	}

	/**
	 * moves the transcript revision on by one and returns it. callers run it inside the transaction of the write it
	 * counts, so the two commit or roll back together. a session that is not in main (imported history) stays at 0
	 */
	bumpTranscriptRev(id: string): number {
		return (this.db.query("update main.session set transcript_rev = transcript_rev + 1 where id = ? returning transcript_rev as n").get(id) as { n: number } | null)?.n ?? 0;
	}

	/** while a replay runs: each message it wrote, as it was before its first write (row and parts) */
	private tracked?: Map<string, string>;

	/** a message and its parts as one string, to compare a message before and after a replay */
	private messageImage(id: string): string {
		const m = this.db.query("select * from main.message where id = ?").get(id);
		const parts = this.db.query("select * from main.part where message_id = ? order by id").all(id);
		return JSON.stringify([m, parts]);
	}

	/** called before every write to a message's row or parts; while a replay is tracked, keeps how the message was */
	noteTranscriptWrite(messageId: string) {
		if (this.tracked && !this.tracked.has(messageId)) this.tracked.set(messageId, this.messageImage(messageId));
	}

	/**
	 * runs a replay and says whether any message it wrote ends different from how it was (a heal that a read would see),
	 * as opposed to rows rewritten with what they held, which a replay does on the way (a tool call reopened, then its
	 * result landing again)
	 */
	trackTranscript<T>(fn: () => T): { result: T; changed: boolean } {
		const outer = this.tracked;
		this.tracked = new Map();
		try {
			const result = fn();
			let changed = false;
			for (const [id, was] of this.tracked) {
				if (this.messageImage(id) !== was) {
					changed = true;
					break;
				}
			}
			if (outer) for (const [id, was] of this.tracked) if (!outer.has(id)) outer.set(id, was);
			return { result, changed };
		} finally {
			this.tracked = outer;
		}
	}

	/** activity on a session (a message, an ask, a reply): it moves to the top of the updated list */
	touchSession(id: string, at = Date.now()) {
		this.db.query("update main.session set updated_at = max(coalesce(updated_at, 0), ?) where id = ?").run(at, id);
	}

	/** a generated title lands only while the session still has the title it had when generation began (a rename wins) */
	setGeneratedTitle(id: string, title: string, expected: string): boolean {
		return this.db.query("update main.session set title = ? where id = ? and title = ?").run(title, id, expected).changes > 0;
	}

	/** spend that is not a message (a title request) still counts on the session */
	addSessionCost(id: string, cost: number) {
		if (cost > 0) this.db.query("update main.session set cost = cost + ? where id = ?").run(cost, id);
	}

	/** renames a session this daemon owns; false for imported history, which is read-only here */
	setSessionTitle(id: string, title: string): boolean {
		return this.db.query("update main.session set title = ?, updated_at = ? where id = ?").run(title, Date.now(), id).changes > 0;
	}

	/**
	 * hides a session from listings. nothing is deleted (rule 15): rows, parts and the transcript file
	 * stay, `session(id)` still answers, and `unarchiveSession` brings it back. imported sessions are
	 * marked in main, because archive.db is read-only to the daemon. false when no such session exists.
	 */
	archiveSession(id: string, at = Date.now()): boolean {
		const home = this.home(id);
		if (home === "main") this.db.query("update main.session set archived_at = coalesce(archived_at, ?) where id = ?").run(at, id);
		else if (home === "archive") this.db.query("insert or ignore into main.archived_import (id, archived_at) values (?, ?)").run(id, at);
		return home !== undefined;
	}

	unarchiveSession(id: string): boolean {
		const home = this.home(id);
		if (home === "main") this.db.query("update main.session set archived_at = null where id = ?").run(id);
		else if (home === "archive") this.db.query("delete from main.archived_import where id = ?").run(id);
		return home !== undefined;
	}

	private where(q: Omit<SessionQuery, "limit">, args: Record<string, string | number>): string[] {
		const where: string[] = [];
		if (q.directory) {
			where.push("directory = $directory");
			args.directory = q.directory;
		}
		if (q.project) {
			where.push("(project_id = $project or (project_id is null and directory = $project))");
			args.project = q.project;
		}
		if (q.roots) where.push("parent_id is null");
		if (q.search) {
			where.push("title like $search");
			args.search = `%${q.search}%`;
		}
		if (q.start) {
			where.push("updated_at >= $start");
			args.start = q.start;
		}
		if (q.archived === "only") where.push("archived_at is not null");
		else if (q.archived !== true) where.push("archived_at is null");
		return where;
	}

	/**
	 * opencode-compatible listing: newest updated first, ties by id descending. `before` is a keyset: a bare
	 * time pages strictly older than it (the form a version 5 client sends), `{ time, id }` continues exactly
	 * after that row, so sessions sharing one updated time are neither dropped nor repeated at a page edge
	 */
	sessionsByUpdated(q: SessionQuery & { before?: number | { time: number; id: string } }): StoredSession[] {
		const args: Record<string, string | number> = { limit: q.limit };
		const where = this.where(q, args);
		if (typeof q.before === "object") {
			where.push("(updated_at < $before or (updated_at = $before and id < $beforeid))");
			args.before = q.before.time;
			args.beforeid = q.before.id;
		} else if (q.before) {
			where.push("updated_at < $before");
			args.before = q.before;
		}
		this.attachArchive();
		const sql = `select * from all_session ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc, id desc limit $limit`;
		return this.db.query(sql).all(args as never) as StoredSession[];
	}

	/** the v2 listing: ordered by created time then id, keyset-paged in either direction */
	sessionsByCreated(q: SessionQuery & { order: "asc" | "desc"; after?: { time: number; id: string }; direction?: "next" | "previous" }): StoredSession[] {
		const args: Record<string, string | number> = { limit: q.limit };
		const where = this.where(q, args);
		// walking "previous" is walking the opposite order from the cursor, then flipping the page back
		const walk = q.direction === "previous" ? (q.order === "asc" ? "desc" : "asc") : q.order;
		if (q.after) {
			const op = walk === "asc" ? ">" : "<";
			where.push(`(created_at ${op} $atime or (created_at = $atime and id ${op} $aid))`);
			args.atime = q.after.time;
			args.aid = q.after.id;
		}
		this.attachArchive();
		const sql = `select * from all_session ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at ${walk}, id ${walk} limit $limit`;
		const rows = this.db.query(sql).all(args as never) as StoredSession[];
		return walk === q.order ? rows : rows.reverse();
	}

	/** stored sessions in both databases, archived included: archiving never changes this number */
	sessionCount(source?: string): number {
		this.attachArchive();
		const row = source
			? this.db.query("select count(*) as n from all_session where source = ?").get(source)
			: this.db.query("select count(*) as n from all_session").get();
		return (row as { n: number }).n;
	}

	/** distinct projects with their newest activity, for `GET /project` */
	projects(): Array<{ project: string; created: number; updated: number }> {
		this.attachArchive();
		return this.db
			.query(
				"select project, min(created) as created, max(updated) as updated from (select coalesce(project_id, directory) as project, created_at as created, updated_at as updated from all_session union all select path, opened_at, opened_at from project_opened) group by 1 order by updated desc",
			)
			.all() as Array<{ project: string; created: number; updated: number }>;
	}

	/** a project a client opened; it lists with the others from now on, sessions or not */
	openProject(path: string): boolean {
		return this.db.query("insert or ignore into project_opened (path, opened_at) values (?, ?)").run(path, Date.now()).changes > 0;
	}

	// ---------- prefix ----------

	/** the first request's prefix bytes; every later request and every resume is compared to this */
	putPrefix(sessionId: string, hash: string, bytes: string) {
		this.db.query("insert or ignore into prefix (session_id, hash, bytes, recorded_at) values (?, ?, ?, ?)").run(sessionId, hash, bytes, Date.now());
	}

	prefix(sessionId: string): { hash: string; bytes: string } | undefined {
		return (this.db.query("select hash, bytes from prefix where session_id = ?").get(sessionId) as { hash: string; bytes: string } | null) ?? undefined;
	}

	// ---------- messages (the projection) ----------

	/** upsert one projected message and its parts; bumps the session's updated time and totals */
	putMessage(m: MessageRow, parts: PartRow[]) {
		this.db.transaction(() => {
			const prev = this.db.query("select * from message where id = ?").get(m.id) as MessageRow | null;
			// a replay of what is stored writes nothing: the read is the same, and a permanent revert's mark stays
			if (this.sameMessage(prev, m, parts)) return;
			this.noteTranscriptWrite(m.id);
			this.db
				.query(
					`insert or replace into message (id, session_id, seq, role, created_at, completed_at, model, effort, tokens_input, tokens_output,
					   tokens_cache_read, tokens_cache_write, cost, stop_reason, info)
					 values ($id, $session_id, $seq, $role, $created_at, $completed_at, $model, $effort, $tokens_input, $tokens_output,
					   $tokens_cache_read, $tokens_cache_write, $cost, $stop_reason, $info)`,
				)
				.run(m as never);
			this.db.query("delete from part where message_id = ?").run(m.id);
			const ins = this.db.query("insert or replace into part (id, message_id, session_id, seq, type, data) values ($id, $message_id, $session_id, $seq, $type, $data)");
			for (const p of parts) ins.run(p as never);
			this.db
				.query(
					`update session set updated_at = max(coalesce(updated_at, 0), $at), cost = cost + $cost, tokens_input = tokens_input + $ti,
					   tokens_output = tokens_output + $to, tokens_cache_read = tokens_cache_read + $tr, tokens_cache_write = tokens_cache_write + $tw
					 where id = $id`,
				)
				.run({
					id: m.session_id,
					at: m.completed_at ?? m.created_at,
					cost: m.cost - (prev?.cost ?? 0),
					ti: m.tokens_input - (prev?.tokens_input ?? 0),
					to: m.tokens_output - (prev?.tokens_output ?? 0),
					tr: m.tokens_cache_read - (prev?.tokens_cache_read ?? 0),
					tw: m.tokens_cache_write - (prev?.tokens_cache_write ?? 0),
				} as never);
		})();
	}

	/** whether a stored message and its parts are already exactly these (a replay rewriting what it holds) */
	private sameMessage(prev: MessageRow | null, m: MessageRow, parts: PartRow[]): boolean {
		if (!prev) return false;
		for (const k of Object.keys(m) as Array<keyof MessageRow>) if (prev[k] !== m[k]) return false;
		// a turn's system lines ride on the user message as parts at 1000 + their position (projection.ts); they are not this write's
		const have = this.db.query("select id, seq, type, data from part where message_id = ? and seq < 1000 order by seq, rowid").all(m.id) as Array<Pick<PartRow, "id" | "seq" | "type" | "data">>;
		if (have.length !== parts.length) return false;
		return parts.every((p, i) => have[i]!.id === p.id && have[i]!.seq === p.seq && have[i]!.type === p.type && have[i]!.data === p.data);
	}

	/** update one part in place (a tool result landing on its call) */
	putPart(p: PartRow) {
		if (this.tracked) {
			const prev = this.db.query("select message_id from part where id = ?").get(p.id) as Pick<PartRow, "message_id"> | null;
			if (prev && prev.message_id !== p.message_id) this.noteTranscriptWrite(prev.message_id);
			this.noteTranscriptWrite(p.message_id);
		}
		this.db.query("insert or replace into part (id, message_id, session_id, seq, type, data) values ($id, $message_id, $session_id, $seq, $type, $data)").run(p as never);
	}

	part(id: string): PartRow | undefined {
		return (this.db.query("select * from part where id = ?").get(id) as PartRow | null) ?? undefined;
	}

	/** the part holding a tool call, found by call id within a session */
	toolPart(sessionId: string, callId: string): PartRow | undefined {
		return (
			(this.db
				.query("select * from part where session_id = ? and type = 'tool' and json_extract(data, '$.callID') = ? order by seq desc limit 1")
				.get(sessionId, callId) as PartRow | null) ?? undefined
		);
	}

	message(id: string): MessageRow | undefined {
		return (this.db.query("select * from message where id = ?").get(id) as MessageRow | null) ?? undefined;
	}

	/** stored messages in both databases (one session's, or all of them) */
	messageCount(sessionId?: string): number {
		return this.countIn("message", sessionId);
	}

	/** stored parts in both databases (one session's, or all of them) */
	partCount(sessionId?: string): number {
		return this.countIn("part", sessionId);
	}

	private countIn(table: "message" | "part", sessionId?: string): number {
		const n = (sql: string, ...args: string[]) => (this.db.query(sql).get(...args) as { n: number }).n;
		if (sessionId) {
			const home = this.home(sessionId) === "archive" ? "archive" : "main";
			return n(`select count(*) as n from ${home}.${table} where session_id = ?`, sessionId);
		}
		const main = n(`select count(*) as n from main.${table}`);
		if (!this.hasArchive) return main;
		return main + n(`select count(*) as n from archive.${table} a where not exists (select 1 from main.session m where m.id = a.session_id)`);
	}

	/** one message and its parts from either database, or nothing when the session has no such message */
	messageWithParts(sessionId: string, messageId: string): (MessageRow & { parts: PartRow[] }) | undefined {
		if (this.home(sessionId) === "archive") {
			const r = this.db.query("select * from archive.message where id = ? and session_id = ?").get(messageId, sessionId) as any;
			if (!r) return undefined;
			const { info_z, info_bytes: _ib, ...rest } = r;
			const parts = (this.db.query("select * from archive.part where message_id = ? order by seq").all(messageId) as any[]).map(({ data_z, data_bytes: _db, ...p }) => ({ ...p, data: archivedPart(p.type, decompress(data_z)) }) as PartRow);
			return { ...rest, info: decompress(info_z), parts };
		}
		const m = this.db.query("select * from main.message where id = ? and session_id = ?").get(messageId, sessionId) as MessageRow | null;
		if (!m) return undefined;
		return { ...m, parts: this.db.query("select * from main.part where message_id = ? order by seq").all(messageId) as PartRow[] };
	}

	/** true when the session lives in archive.db (imported history, read through archivedPart) */
	archived(sessionId: string): boolean {
		return this.home(sessionId) === "archive";
	}

	lastMessageSeq(sessionId: string): number {
		return ((this.db.query("select max(seq) as n from message where session_id = ?").get(sessionId) as { n: number | null }).n ?? 0) as number;
	}

	/**
	 * a page of messages, oldest first within the page. `before` is a message seq: the page ends just
	 * before it. returns the rows plus the seq to pass as `before` for the next older page, if any.
	 */
	messages(sessionId: string, opts: { limit?: number; before?: number } = {}): { rows: Array<MessageRow & { parts: PartRow[] }>; next: number | null } {
		const archived = this.home(sessionId) === "archive";
		const home = archived ? "archive" : "main";
		const args: Record<string, string | number> = { sid: sessionId };
		// a permanent revert's messages stay in the store, out of lists (imported history has none)
		let sql = `select * from ${home}.message where session_id = $sid${archived ? "" : " and reverted = 0"}`;
		if (opts.before !== undefined) {
			sql += " and seq < $before";
			args.before = opts.before;
		}
		sql += " order by seq desc";
		if (opts.limit) {
			sql += " limit $limit";
			args.limit = opts.limit + 1;
		}
		let rows = this.db.query(sql).all(args as never) as any[];
		let next: number | null = null;
		if (opts.limit && rows.length > opts.limit) {
			rows = rows.slice(0, opts.limit);
			next = rows.at(-1)!.seq;
		}
		rows.reverse();
		const partsOf = this.db.query(`select * from ${home}.part where message_id = ? order by seq`);
		if (!archived) return { rows: rows.map((r) => ({ ...r, parts: partsOf.all(r.id) as PartRow[] })), next };
		// archived rows are decompressed here, for this page only
		return {
			rows: rows.map(({ info_z, info_bytes: _ib, ...r }) => ({
				...r,
				info: decompress(info_z),
				parts: (partsOf.all(r.id) as any[]).map(({ data_z, data_bytes: _db, ...p }) => ({ ...p, data: archivedPart(p.type, decompress(data_z)) }) as PartRow),
			})),
			next,
		};
	}

	// ---------- m7: context fill, reverts, snapshots, recall ----------

	/** what a session's context holds now and where it compacts (a10); written after every step and compaction */
	setSessionContext(id: string, used: number, limit: number, compactAt: number) {
		this.db
			.query(
				`insert into session_state (session_id, context_used, context_limit, compact_at) values (?, ?, ?, ?)
				 on conflict(session_id) do update set context_used = excluded.context_used, context_limit = excluded.context_limit, compact_at = excluded.compact_at`,
			)
			.run(id, Math.round(used), limit, compactAt);
	}

	sessionState(id: string): SessionStateInfo {
		const r = this.db.query("select * from session_state where session_id = ?").get(id) as SessionStateRow | null;
		return r ? stateInfo(r) : {};
	}

	/** sessionState for many sessions in one query; a session without a state row is left out of the map */
	sessionStates(ids: string[]): Map<string, SessionStateInfo> {
		const out = new Map<string, SessionStateInfo>();
		if (!ids.length) return out;
		const rows = this.db.query("select * from session_state where session_id in (select value from json_each(?))").all(JSON.stringify(ids)) as Array<SessionStateRow & { session_id: string }>;
		for (const r of rows) out.set(r.session_id, stateInfo(r));
		return out;
	}

	/** arms or clears a revert: messages from `seq` on are parked until the next send makes it permanent */
	setRevert(id: string, revert: SessionRevert | null) {
		this.db
			.query("insert into session_state (session_id, revert) values (?, ?) on conflict(session_id) do update set revert = excluded.revert")
			.run(id, revert ? JSON.stringify(revert) : null);
	}

	setSessionSummary(id: string, summary: { files: number; additions: number; deletions: number }) {
		this.db.query("update main.session set summary = ? where id = ?").run(JSON.stringify(summary), id);
	}

	/** messages a permanent revert took out of the context: kept, marked, left out of message lists */
	markReverted(sessionId: string, from: number, to: number): number {
		if (this.tracked) for (const r of this.db.query("select id from message where session_id = ? and seq >= ? and seq < ? and reverted = 0").all(sessionId, from, to) as Array<{ id: string }>) this.noteTranscriptWrite(r.id);
		return this.db.query("update message set reverted = 1 where session_id = ? and seq >= ? and seq < ?").run(sessionId, from, to).changes;
	}

	/** reverted messages, which lists leave out; rule 15 counts them as kept */
	revertedCount(sessionId: string): number {
		return (this.db.query("select count(*) as n from message where session_id = ? and reverted = 1").get(sessionId) as { n: number }).n;
	}

	putTurnSnapshot(s: TurnSnapshot) {
		this.db
			.query(
				`insert into turn_snapshot (session_id, from_seq, to_seq, before, after, files, at) values ($session_id, $from_seq, $to_seq, $before, $after, $files, $at)
				 on conflict(session_id, from_seq) do update set to_seq = excluded.to_seq, after = excluded.after, files = excluded.files`,
			)
			.run({ to_seq: null, after: null, files: null, ...s } as never);
	}

	turnSnapshots(sessionId: string): TurnSnapshot[] {
		return this.db.query("select * from turn_snapshot where session_id = ? order by from_seq").all(sessionId) as TurnSnapshot[];
	}

	/** replaces the recall rows of one message; the fts index follows by trigger */
	putRecall(messageId: string, docs: RecallDoc[]) {
		this.db.transaction(() => {
			this.db.query("delete from recall_doc where message_id = ?").run(messageId);
			const ins = this.db.query("insert or replace into recall_doc (id, session_id, message_id, seq, role, kind, tool, call_id, at, text) values ($id, $session_id, $message_id, $seq, $role, $kind, $tool, $call_id, $at, $text)");
			for (const d of docs) ins.run({ tool: null, call_id: null, ...d } as never);
		})();
	}

	/** one tool output joins its call's rows */
	putRecallDoc(d: RecallDoc) {
		this.db.query("insert or replace into recall_doc (id, session_id, message_id, seq, role, kind, tool, call_id, at, text) values ($id, $session_id, $message_id, $seq, $role, $kind, $tool, $call_id, $at, $text)").run({ tool: null, call_id: null, ...d } as never);
	}

	recallCount(sessionId: string): number {
		return (this.db.query("select count(*) as n from recall_doc where session_id = ?").get(sessionId) as { n: number }).n;
	}

	/**
	 * every term must appear (fts5 phrase per term, so `zx-4471` matches as written); best matches first,
	 * newest first among equals. reverted messages are left out.
	 */
	recallSearch(sessionId: string, query: string, limit: number): { hits: RecallDoc[]; matches: number } {
		const terms = query.split(/\s+/).filter(Boolean);
		if (!terms.length) return { hits: [], matches: 0 };
		const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
		// recall's own calls and answers would only find the query itself
		const where = `recall_fts match $match and d.session_id = $sid and coalesce(d.tool, '') != 'recall' and not exists (select 1 from message m where m.id = d.message_id and m.reverted = 1)`;
		try {
			const n = (this.db.query(`select count(*) as n from recall_fts join recall_doc d on d.rowid = recall_fts.rowid where ${where}`).get({ match, sid: sessionId } as never) as { n: number }).n;
			const hits = this.db
				.query(`select d.* from recall_fts join recall_doc d on d.rowid = recall_fts.rowid where ${where} order by bm25(recall_fts), d.seq desc limit $limit`)
				.all({ match, sid: sessionId, limit } as never) as RecallDoc[];
			return { hits, matches: n };
		} catch {
			// a query fts5 cannot parse falls back to a plain scan, every term as a substring
			const rows = this.db.query("select * from recall_doc where session_id = ? order by seq desc").all(sessionId) as RecallDoc[];
			const lower = terms.map((t) => t.toLowerCase());
			const all = rows.filter((r) => r.tool !== "recall" && lower.every((t) => r.text.toLowerCase().includes(t)));
			return { hits: all.slice(0, limit), matches: all.length };
		}
	}

	// ---------- steps ----------

	putStep(row: Record<string, unknown>) {
		const cols = Object.keys(row);
		this.db.query(`insert or replace into step (${cols.join(",")}) values (${cols.map((c) => `$${c}`).join(",")})`).run(row as never);
	}

	steps(sessionId: string): Record<string, unknown>[] {
		return this.db.query("select * from step where session_id = ? order by seq").all(sessionId) as Record<string, unknown>[];
	}

	/** a session's newest step: the size of its context now and what that step cost */
	lastStep(sessionId: string): { input: number; cache_read: number; cache_write: number; cost: number } | undefined {
		return (this.db.query("select input, cache_read, cache_write, cost from step where session_id = ? order by seq desc limit 1").get(sessionId) as never) ?? undefined;
	}

	// ---------- pending permission and question asks ----------

	putPermission(p: PendingPermission) {
		this.db
			.query(
				`insert into permission (id, session_id, directory, permission, patterns, metadata, always, tool, created_at)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(p.id, p.session_id, p.directory, p.permission, JSON.stringify(p.patterns), JSON.stringify(p.metadata), JSON.stringify(p.always), p.tool ? JSON.stringify(p.tool) : null, p.created_at);
	}

	/** records the answer; returns false when the ask is unknown or already answered */
	replyPermission(id: string, reply: "once" | "always" | "reject" | "expired", message?: string, by?: string): boolean {
		return this.db.query("update permission set reply = ?, message = ?, replied_at = ?, settled_by = ? where id = ? and reply is null").run(reply, message ?? null, Date.now(), by ?? null, id).changes > 0;
	}

	/** one permission ask, pending or settled, with who settled it and when */
	permissionAsk(id: string): { id: string; session_id: string; directory: string; reply: string | null; replied_at: number | null; settled_by: string | null } | undefined {
		return (this.db.query("select id, session_id, directory, reply, replied_at, settled_by from permission where id = ?").get(id) as never) ?? undefined;
	}

	/** one question, pending or settled */
	questionAsk(id: string): { id: string; session_id: string; directory: string; state: string | null; answers: string[][] | null; replied_at: number | null; settled_by: string | null } | undefined {
		const r = this.db.query("select id, session_id, directory, state, answers, replied_at, settled_by from question where id = ?").get(id) as any;
		return r ? { ...r, answers: parseJson(r.answers, null) } : undefined;
	}

	pendingPermissions(filter: { directory?: string; sessionId?: string } = {}): PendingPermission[] {
		const rows = this.db
			.query(
				`select * from permission where reply is null ${filter.directory ? "and directory = $directory" : ""} ${filter.sessionId ? "and session_id = $sid" : ""} order by created_at`,
			)
			.all({ ...(filter.directory ? { directory: filter.directory } : {}), ...(filter.sessionId ? { sid: filter.sessionId } : {}) } as never) as any[];
		return rows.map((r) => ({
			id: r.id,
			session_id: r.session_id,
			directory: r.directory,
			permission: r.permission,
			patterns: parseJson(r.patterns, []),
			metadata: parseJson(r.metadata, {}),
			always: parseJson(r.always, []),
			tool: parseJson(r.tool, null),
			created_at: r.created_at,
		}));
	}

	putQuestion(q: PendingQuestion) {
		this.db
			.query("insert into question (id, session_id, directory, questions, tool, created_at) values (?, ?, ?, ?, ?, ?)")
			.run(q.id, q.session_id, q.directory, JSON.stringify(q.questions), q.tool ? JSON.stringify(q.tool) : null, q.created_at);
	}

	/** records the answers (or the dismissal); returns false when unknown or already settled */
	settleQuestion(id: string, outcome: { answers: string[][] } | { rejected: true } | { expired: true }, by?: string): boolean {
		const answers = "answers" in outcome ? JSON.stringify(outcome.answers) : null;
		const state = "answers" in outcome ? "replied" : "rejected" in outcome ? "rejected" : "expired";
		return this.db.query("update question set answers = ?, state = ?, replied_at = ?, settled_by = ? where id = ? and state is null").run(answers, state, Date.now(), by ?? null, id).changes > 0;
	}

	pendingQuestions(filter: { directory?: string; sessionId?: string } = {}): PendingQuestion[] {
		const rows = this.db
			.query(
				`select * from question where state is null ${filter.directory ? "and directory = $directory" : ""} ${filter.sessionId ? "and session_id = $sid" : ""} order by created_at`,
			)
			.all({ ...(filter.directory ? { directory: filter.directory } : {}), ...(filter.sessionId ? { sid: filter.sessionId } : {}) } as never) as any[];
		return rows.map((r) => ({
			id: r.id,
			session_id: r.session_id,
			directory: r.directory,
			questions: parseJson(r.questions, []),
			tool: parseJson(r.tool, null),
			created_at: r.created_at,
		}));
	}

	/** asks left open by a previous daemon process can never be answered: their tool call is gone */
	expireOrphanedAsks(): { permissions: number; questions: number } {
		const now = Date.now();
		const permissions = this.db.query("update permission set reply = 'expired', replied_at = ?, settled_by = 'daemon_restart' where reply is null").run(now).changes;
		const questions = this.db.query("update question set state = 'expired', replied_at = ?, settled_by = 'daemon_restart' where state is null").run(now).changes;
		return { permissions, questions };
	}

	// ---------- saved "always" rules ----------

	putRule(r: SavedRule) {
		this.db.query("insert or replace into permission_rule (scope, permission, pattern, action, created_at) values (?, ?, ?, ?, ?)").run(r.scope, r.permission, r.pattern, r.action, Date.now());
	}

	rules(scopes: string[]): SavedRule[] {
		if (!scopes.length) return [];
		return this.db
			.query(`select scope, permission, pattern, action from permission_rule where scope in (${scopes.map(() => "?").join(",")}) order by created_at`)
			.all(...scopes) as SavedRule[];
	}

	// ---------- imports ----------

	startImport(source: string, path: string): number {
		return Number(this.db.query("insert into import_run (source, path, started_at) values (?, ?, ?)").run(source, path, Date.now()).lastInsertRowid);
	}

	finishImport(id: number, counts: { sessions: number; messages: number; parts: number; skipped: number }) {
		this.db
			.query("update import_run set finished_at = ?, sessions = ?, messages = ?, parts = ?, skipped = ? where id = ?")
			.run(Date.now(), counts.sessions, counts.messages, counts.parts, counts.skipped, id);
	}

	/** import runs, newest first: archive.db's (m3 on) then main's (m2 imports wrote into main) */
	imports(): Array<Record<string, unknown> & { db: "archive" | "main" }> {
		const main = (this.db.query("select * from main.import_run order by id desc").all() as Array<Record<string, unknown>>).map((r) => ({ ...r, db: "main" as const }));
		if (!this.hasArchive) return main;
		const archive = (this.db.query("select * from archive.import_run order by id desc").all() as Array<Record<string, unknown>>).map((r) => ({ ...r, db: "archive" as const }));
		return [...archive, ...main];
	}

	/** what archive.db holds, for `cmx2 db status` */
	archiveStats(): { path: string; attached: boolean; sessions: number; messages: number; parts: number; raw_bytes: number; stored_bytes: number } | undefined {
		if (!this.archivePath) return undefined;
		if (!this.hasArchive) return { path: this.archivePath, attached: false, sessions: 0, messages: 0, parts: 0, raw_bytes: 0, stored_bytes: 0 };
		const r = this.db
			.query(
				`select (select count(*) from archive.session) as sessions, (select count(*) from archive.message) as messages, (select count(*) from archive.part) as parts,
				   (select coalesce(sum(info_bytes), 0) from archive.message) + (select coalesce(sum(data_bytes), 0) from archive.part) as raw_bytes,
				   (select coalesce(sum(octet_length(info_z)), 0) from archive.message) + (select coalesce(sum(octet_length(data_z)), 0) from archive.part) as stored_bytes`,
			)
			.get() as { sessions: number; messages: number; parts: number; raw_bytes: number; stored_bytes: number };
		return { path: this.archivePath, attached: true, ...r };
	}

	// ---------- the event log (a1) ----------

	/** names this store; it changes only when the database is made afresh, so a cursor from another store is known */
	get epoch(): string {
		return (this.db.query("select value from meta where key = 'epoch'").get() as { value: string }).value;
	}

	/** the highest seq ever assigned (pruned or not); 0 before the first event */
	eventHead(): number {
		const r = this.db.query("select seq from sqlite_sequence where name = 'event_log'").get() as { seq: number } | null;
		return r?.seq ?? 0;
	}

	/** logs one state-changing event and returns its seq: strictly increasing, never reused */
	appendEvent(e: { at: number; directory: string; project: string | null; type: string; properties: string; rev?: number | null }): number {
		return Number(this.db.query("insert into event_log (at, directory, project, type, properties, rev) values ($at, $directory, $project, $type, $properties, $rev)").run({ ...e, rev: e.rev ?? null } as never).lastInsertRowid);
	}

	/** logged events after a seq, oldest first; a directory narrows to that directory's events */
	eventsAfter(seq: number, opts: { directory?: string; limit: number }): EventRow[] {
		if (opts.directory) return this.db.query("select * from event_log where seq > ? and directory = ? order by seq limit ?").all(seq, opts.directory, opts.limit) as EventRow[];
		return this.db.query("select * from event_log where seq > ? order by seq limit ?").all(seq, opts.limit) as EventRow[];
	}

	/** every seq at or below this has been pruned; a cursor below it cannot be replayed */
	eventsPrunedThrough(): number {
		return Number((this.db.query("select value from meta where key = 'pruned_through'").get() as { value: string }).value);
	}

	/**
	 * drops the log's oldest rows beyond the replay window: a row goes only when it is both older than
	 * `ms` and more than `events` behind the head, so the window is whichever of the two is longer
	 */
	pruneEvents(keep: { events: number; ms: number }, now = Date.now()): number {
		const byCount = this.eventHead() - keep.events;
		const byAge = (this.db.query("select max(seq) as n from event_log where at < ?").get(now - keep.ms) as { n: number | null }).n ?? 0;
		const cutoff = Math.min(byCount, byAge);
		if (cutoff <= this.eventsPrunedThrough()) return 0;
		return this.db.transaction(() => {
			const n = this.db.query("delete from event_log where seq <= ?").run(cutoff).changes;
			this.db.query("update meta set value = ? where key = 'pruned_through'").run(String(cutoff));
			return n;
		})();
	}

	// ---------- client ids (a4) ----------

	/** the first request that carried this client id, if it came within the window */
	clientAction(clientID: string, since: number): ClientAction | undefined {
		return (this.db.query("select * from client_action where client_id = ? and created_at >= ?").get(clientID, since) as ClientAction | null) ?? undefined;
	}

	/** claims a client id for a request; false when another request holds it (inside the window) */
	claimClientAction(a: { client_id: string; route: string; session_id: string | null; created_at: number }, since: number): boolean {
		return this.db.transaction(() => {
			this.db.query("delete from client_action where client_id = ? and created_at < ?").run(a.client_id, since);
			return this.db.query("insert or ignore into client_action (client_id, route, session_id, created_at) values ($client_id, $route, $session_id, $created_at)").run(a as never).changes > 0;
		})();
	}

	finishClientAction(clientID: string, status: number, body: string) {
		this.db.query("update client_action set status = ?, body = ?, done_at = ? where client_id = ?").run(status, body, Date.now(), clientID);
	}

	/** client ids older than the window are forgotten */
	pruneClientActions(since: number): number {
		return this.db.query("delete from client_action where created_at < ?").run(since).changes;
	}

	close() {
		this.db.close();
	}
}

export interface EventRow {
	seq: number;
	at: number;
	directory: string;
	project: string | null;
	type: string;
	/** the event's properties as the json text that was sent */
	properties: string;
	/** the session's transcript revision the event carries to a stream that asks for it (rev=1), or null */
	rev: number | null;
}

export interface ClientAction {
	client_id: string;
	route: string;
	session_id: string | null;
	/** null while the first request is still running */
	status: number | null;
	body: string | null;
	created_at: number;
	done_at: number | null;
}
