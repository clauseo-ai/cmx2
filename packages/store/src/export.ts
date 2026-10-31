import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, linkSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { arch, homedir, hostname, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BundleError, BundleReader, type Range } from "./bundle.ts";
import type { MessageRow, PartRow, Store, StoredSession } from "./index.ts";
import { projectMessage } from "./projection.ts";

/**
 * a session as one file: the session row, every projected message with its parts, the engine
 * transcript (the truth a daemon resumes from), the recorded prefix and the step telemetry. an import
 * writes all of it into another store so the session lists, reads and continues there. nothing is
 * ever overwritten or deleted (rule 15): an id that is already there is refused, or imported under a
 * fresh id when asked.
 *
 * an export says where it was written (origin: machine, os, arch, the session's directory, the home folder). an import
 * that lands on another machine or in another folder writes one moved record: a runtime notice at the end of the
 * transcript (source moved) that the model reads with the next request, a timeline entry clients can draw as a
 * divider, and moved_from on the session.
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
	/** where it was written; absent in files from before 0.9.6, whose import records no move */
	origin?: Place;
	session: Omit<StoredSession, "session_file" | "archived_at">;
	messages: ExportedMessage[];
	/** the engine transcript as written (jsonl), or null for a session that never had one (cmx history) */
	transcript: string | null;
	prefix: { hash: string; bytes: string } | null;
	steps: Record<string, unknown>[];
}

/** one side of a move: the machine and the folder the session ran in */
export interface Place {
	machine: string;
	os: string;
	arch: string;
	directory: string;
	home: string;
}

/** what an import that changed machine or folder records, on the session (moved_from) and on its notice */
export interface MoveRecord {
	from: Place;
	to: Place;
	at: number;
}

const OS_NAMES: Record<string, string> = { darwin: "macos", linux: "linux", win32: "windows" };

/** this machine, as an export's origin or a move's destination says it; the name is the short hostname the turn context uses */
export function thisMachine(directory: string): Place {
	return { machine: hostname().split(".")[0] || hostname(), os: OS_NAMES[platform()] ?? platform(), arch: arch(), directory, home: homedir() };
}

/** the one line the model reads after a move: where from, where to, how the repo root's paths translate */
export function movedText(m: MoveRecord): string {
	const { from, to } = m;
	const where = (p: Place) => `${p.machine} (${p.os}, ${p.directory})`;
	const roots = from.directory !== to.directory ? `: a path under ${from.directory} is under ${to.directory} now${from.home !== to.home ? `, and the home folder ${from.home} is ${to.home}` : ""}` : "";
	return `this thread moved from ${where(from)} to ${where(to)}${roots}. paths, processes and dev servers from before the move belong to the old machine: re-check paths and restart anything you need.`;
}

export class ExportError extends Error {
	/** clash: the session (or its transcript file) is already here; format: the file is not a readable export */
	constructor(
		message: string,
		readonly code: "missing" | "format" | "clash" = "format",
	) {
		super(message);
	}
}

function parse(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return { raw: s };
	}
}

const exported = ({ parts, info, ...m }: MessageRow & { parts: PartRow[] }): ExportedMessage => ({ ...m, info: parse(info), parts: parts.map(({ data, ...p }) => ({ ...p, data: parse(data) })) });

/** messages per page read from the store, and the most an export chunk holds before it is handed on */
const PAGE = 50;
const CHUNK_BYTES = 1024 * 1024;

/**
 * where an export stops reading the transcript: its size when the export began, cut back to the end of its last whole
 * line, so a turn that appends while the export streams neither tears a line nor adds one
 */
function transcriptEnd(file: string): number {
	const size = statSync(file).size;
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(64 * 1024);
		for (let to = size; to > 0; ) {
			const from = Math.max(0, to - buf.length);
			const n = readSync(fd, buf, 0, to - from, from);
			const nl = buf.subarray(0, n).lastIndexOf(10);
			if (nl >= 0) return from + nl + 1;
			to = from;
		}
		return 0;
	} finally {
		closeSync(fd);
	}
}

/** the fields before the messages, where the transcript is and where it ends, and the newest message when the export began */
function exportHead(store: Store, id: string, opts: { cmx2?: string }) {
	const s = store.session(id);
	if (!s) throw new ExportError(`there is no session ${id} in ${store.path}; cmx2 session list shows the ids`, "missing");
	// the transcript revision belongs to this store's writes; an import starts its own at 0
	const { session_file, archived_at: _a, transcript_rev: _r, ...session } = s;
	const file = session_file && existsSync(session_file) ? session_file : null;
	const end = file ? transcriptEnd(file) : 0;
	const last = store.messages(id, { limit: 1 }).rows[0]?.seq ?? Number.NEGATIVE_INFINITY;
	return { file, end, last, head: { format: EXPORT_FORMAT as typeof EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: Date.now(), ...(opts.cmx2 ? { cmx2: opts.cmx2 } : {}), origin: thisMachine(session.directory), session } };
}

/** the messages that were there when the export began, oldest first, a page at a time */
function* messagePages(store: Store, id: string, last: number) {
	let after = -1;
	for (;;) {
		const page = store.messages(id, { limit: PAGE, after });
		const rows = page.rows.filter((r) => r.seq <= last);
		if (rows.length) yield rows;
		if (page.next === null || rows.length < page.rows.length) return;
		after = page.next;
	}
}

/** reads one session out of the store; works for live and archived (imported cmx) sessions alike */
export function exportSession(store: Store, id: string, opts: { cmx2?: string } = {}): SessionExport {
	const { file, end, last, head: h } = exportHead(store, id, opts);
	const messages: ExportedMessage[] = [];
	for (const rows of messagePages(store, id, last)) for (const r of rows) messages.push(exported(r));
	let transcript: string | null = null;
	if (file) {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.allocUnsafe(end);
			readSync(fd, buf, 0, end, 0);
			transcript = buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	}
	return { ...h, messages, transcript, prefix: store.prefix(id) ?? null, steps: store.steps(id) };
}

/**
 * the same export as exportSession (JSON.parse of the joined chunks deep-equals it), written as it is read: 50 messages
 * at a time, the transcript in 1 MB pieces, no chunk much over 1 MB, so a large session never sits in memory whole. it
 * holds what was there when it began: the messages up to the newest one then, the transcript up to its last whole line
 * then. a missing session throws before the first chunk
 */
export function exportStream(store: Store, id: string, opts: { cmx2?: string } = {}): AsyncGenerator<string> {
	const { file, end, last, head: h } = exportHead(store, id, opts);
	return (async function* () {
		let chunk = `${JSON.stringify(h).slice(0, -1)},"messages":[`;
		let first = true;
		for (const rows of messagePages(store, id, last)) {
			for (const r of rows) {
				chunk += (first ? "" : ",") + JSON.stringify(exported(r));
				first = false;
				if (chunk.length >= CHUNK_BYTES) {
					yield chunk;
					chunk = "";
				}
			}
		}
		yield `${chunk}],"transcript":`;
		if (file) {
			yield '"';
			// a utf8 read stream never splits a character, so each piece escapes on its own
			if (end > 0) for await (const piece of createReadStream(file, { encoding: "utf8", start: 0, end: end - 1, highWaterMark: CHUNK_BYTES })) yield JSON.stringify(piece).slice(1, -1);
			yield '"';
		} else yield "null";
		yield `,"prefix":${JSON.stringify(store.prefix(id) ?? null)},"steps":${JSON.stringify(store.steps(id))}}\n`;
	})();
}

/** a session id an import takes: ses_ and at least 16 letters or digits, so it is safe in a file name and unique in text */
const SESSION_ID = /^ses_[A-Za-z0-9]{16,64}$/;

/** the fields an import checks before it writes anything */
function checkHead(v: any) {
	if (v?.format !== EXPORT_FORMAT) throw new ExportError(`that file is not a cmx2 session export (format is ${JSON.stringify(v?.format)}, want ${EXPORT_FORMAT})`);
	if (typeof v.version !== "number" || v.version > EXPORT_VERSION) throw new ExportError(`that export is version ${v.version}; this cmx2 reads up to ${EXPORT_VERSION}. upgrade with cmx2 upgrade`);
	if (typeof v.session?.id !== "string" || typeof v.session.directory !== "string") throw new ExportError("that export has no session; it is cut short or edited");
	if (!SESSION_ID.test(v.session.id)) throw new ExportError(`that export's session id ${JSON.stringify(v.session.id).slice(0, 80)} is not a cmx2 session id`);
}

/** checks the shape of an export held in memory before anything is written */
export function readExport(raw: string): SessionExport {
	let v: any;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new ExportError("that file is not json; it should be what cmx2 session export wrote");
	}
	checkHead(v);
	if (!Array.isArray(v.messages)) throw new ExportError("that export has no messages; it is cut short or edited");
	if (v.transcript !== null && typeof v.transcript !== "string") throw new ExportError("that export's transcript is not text; it is cut short or edited");
	return v as SessionExport;
}

const bare = (id: string) => id.replace(/^ses_/, "");
const ID_KEY = /(^id$|ID$|Id$|_id$)/;
const OWN_ID = /^(ses|msg|prt)_/;

/**
 * a copy's ids: in one parsed row or transcript line, the values of id fields (id, sessionID, messageID, parentID,
 * session_id, tail_start_id, ...) that are this session's, its messages' or its parts' ids move to the new session id.
 * text, tool input and output are left as they are
 */
function renamer(from: string, to: string) {
	const a = bare(from);
	const b = bare(to);
	const walk = (v: unknown, key?: string): unknown => {
		if (typeof v === "string") return key && ID_KEY.test(key) && OWN_ID.test(v) && v.includes(a) ? v.replaceAll(a, b) : v;
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
			return v;
		}
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			for (const k of Object.keys(o)) o[k] = walk(o[k], k);
		}
		return v;
	};
	return (v: unknown) => walk(v);
}

export interface ImportResult {
	id: string;
	/** the session id in the bundle; differs from id for a copy (asNew) */
	source: string;
	/** where the session runs here */
	directory: string;
	/** set when the import landed on another machine or in another folder than the export's origin */
	moved?: MoveRecord;
	messages: number;
	parts: number;
	steps: number;
	transcript: string | null;
}

export interface BundleImportOptions {
	/** where this store keeps transcripts (`<dataDir>/sessions/<id>.jsonl`) */
	dataDir: string;
	/** an absolute folder on this machine the session moves to */
	directory?: string;
	/** import a session that is already here as a copy under a fresh id instead of refusing */
	asNew?: boolean;
	title?: string;
	/** this machine's project for the folder the session lands in; it may refuse the folder by throwing, before anything is written */
	project?: (directory: string) => string | null;
	/** stands in for this machine (tests) */
	here?: Omit<Place, "directory">;
	now?: number;
}

/** a folder an import is given: absolute, and the real path when it exists */
function folder(dir: string): string {
	if (!isAbsolute(dir)) throw new ExportError(`the directory ${dir} is not an absolute path`);
	const r = resolve(dir);
	return existsSync(r) ? realpathSync(r) : r;
}

/** a buffered append to a file opened with wx */
class Out {
	private pending: string[] = [];
	private size = 0;
	constructor(private fd: number) {}
	write(s: string) {
		this.pending.push(s);
		this.size += s.length;
		if (this.size >= CHUNK_BYTES) this.flush();
	}
	flush() {
		if (this.pending.length) writeSync(this.fd, this.pending.join(""));
		this.pending = [];
		this.size = 0;
	}
}

/**
 * writes a bundle file into the store without reading it into memory: the small fields are parsed whole, the messages
 * one at a time, the transcript a line at a time straight into its new file. nothing is overwritten or deleted (rule 15):
 * an id that is already here is refused (or imported under a fresh id with asNew), and the transcript file is created
 * with wx. it is all or nothing: the transcript is written first, the rows in one transaction after it, and a failure in
 * either removes the file it made. an export with an origin that names another machine or folder gets a moved record
 * (see the top of this file).
 */
export async function importBundleFile(store: Store, path: string, opts: BundleImportOptions): Promise<ImportResult> {
	let reader: BundleReader;
	try {
		reader = new BundleReader(path);
	} catch {
		throw new ExportError(`there is no readable file at ${path}`);
	}
	try {
		return await importFrom(store, reader, opts);
	} catch (e) {
		if (e instanceof BundleError) throw new ExportError(e.message);
		throw e;
	} finally {
		reader.close();
	}
}

async function importFrom(store: Store, r: BundleReader, opts: BundleImportOptions): Promise<ImportResult> {
	const top = await r.top();
	const small = (k: string) => {
		const at = top.get(k);
		return at ? r.parse(at) : undefined;
	};
	const head = { format: small("format"), version: small("version"), session: small("session") as Record<string, any> | undefined, origin: small("origin") as Place | undefined };
	checkHead(head);
	const session = head.session!;
	const messages = top.get("messages");
	if (!messages || r.byte(messages.start) !== 0x5b) throw new ExportError("that export has no messages; it is cut short or edited");
	const tr: Range | undefined = top.get("transcript");
	const hasTranscript = !!tr && r.byte(tr.start) === 0x22;
	if (tr && !hasTranscript && small("transcript") !== null) throw new ExportError("that export's transcript is not text; it is cut short or edited");
	const prefix = (small("prefix") ?? null) as SessionExport["prefix"];
	const steps = (small("steps") ?? []) as Record<string, unknown>[];
	if (!Array.isArray(steps)) throw new ExportError("that export's steps are not a list; it is cut short or edited");

	const asNew = "pass --as-new (asNew=true over http) to import a copy under a fresh id";
	const source = session.id as string;
	let id = source;
	let rename: ((v: unknown) => unknown) | undefined;
	// a transcript or rows under the id with no session row belong to someone else (a session whose row is not written yet,
	// an import in flight, history this import cannot vouch for): they are left alone, like a session that is here
	const unmarked = (sid: string) => existsSync(join(opts.dataDir, "sessions", `${sid}.jsonl`)) || !!store.db.query("select 1 from message where session_id = ? limit 1").get(sid);
	const here0 = store.session(source);
	if (here0 || unmarked(source)) {
		if (!opts.asNew) {
			if (here0) throw new ExportError(`session ${source} is already in this database; nothing was changed. ${asNew}`, "clash");
			const busy = store.db.query("select 1 from import_staging where session_id = ?").get(source);
			throw new ExportError(busy ? `session ${source} is being imported right now; nothing was changed. wait for it, or ${asNew}` : `there is already a transcript or messages for ${source} here, with no session; nothing was changed. ${asNew}`, "clash");
		}
		id = `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		rename = renamer(source, id);
	}
	const file = hasTranscript ? join(opts.dataDir, "sessions", `${id}.jsonl`) : null;
	const directory = folder(opts.directory ?? (session.directory as string));
	const projectId = opts.project?.(directory);
	const here: Place = { ...(opts.here ?? thisMachine(directory)), directory };
	const o = head.origin;
	const moved: MoveRecord | undefined = o && typeof o === "object" && (o.machine !== here.machine || o.directory !== directory) ? { from: { ...o, directory: session.directory }, to: here, at: opts.now ?? Date.now() } : undefined;
	// a subagent's parent stays behind; pointing at a session that is not here would hide the import as an orphan
	const parent = session.parent_id && store.session(session.parent_id) ? session.parent_id : null;

	// 0. the marker: this import's claim on the id, before anything is written. another import of the same id (the cli and
	// the daemon at once) fails to insert it and stops; on failure, and at daemon start, only rows under a marked id with no
	// session row are removed (sweepImports), so nothing guesses who wrote a file or a row
	const token = randomUUID();
	try {
		store.db.query("insert into import_staging (session_id, token, created_at, pid, started) values (?, ?, ?, ?, ?)").run(id, token, Date.now(), process.pid, PROCESS_STARTED);
	} catch {
		throw new ExportError(`session ${id} is being imported right now; nothing was changed. wait for it, or ${asNew}`, "clash");
	}
	// checked again under the marker: something written between the check above and the claim is left alone too
	if (unmarked(id)) {
		store.db.query("delete from import_staging where session_id = ? and token = ?").run(id, token);
		throw new ExportError(`there is already a transcript or messages for ${id} here, with no session; nothing was changed. ${asNew}`, "clash");
	}
	const temp = file ? join(opts.dataDir, "import", `${randomUUID()}.jsonl`) : null;
	let linked = false;
	/** a failure: what this run staged under its marker, its temp transcript, a transcript it linked, and the marker */
	const undo = () => {
		if (temp) rmSync(temp, { force: true });
		if (linked && file) rmSync(file, { force: true });
		unstage(store, id, token);
	};

	// 1. the transcript, a line at a time, into a temp file only this import made
	let lines = 0;
	if (temp && tr) {
		mkdirSync(join(opts.dataDir, "import"), { recursive: true });
		const fd = openSync(temp, "wx");
		try {
			const out = new Out(fd);
			const oldBare = bare(source);
			let first = true;
			let ended = true;
			for (let line of r.lines(tr)) {
				if (first) {
					first = false;
					// the header's cwd is where tools run on resume; it follows the session's directory
					const h = line.startsWith('{"type":"header"') ? parseLine(line) : undefined;
					if (h?.type === "header") line = `${JSON.stringify({ ...h, id, cwd: directory })}${line.endsWith("\n") ? "\n" : ""}`;
				} else if (rename && line.includes(oldBare)) {
					const v = parseLine(line);
					if (v) line = `${JSON.stringify(rename(v))}${line.endsWith("\n") ? "\n" : ""}`;
				}
				if (line.startsWith('{"type":"message"') || (!line.startsWith('{"type":"header"') && parseLine(line)?.type === "message")) lines++;
				ended = line.endsWith("\n");
				out.write(line);
				if (r.due()) {
					out.flush();
					await r.pause();
				}
			}
			if (moved) {
				// the moved record: a runtime notice the engine hands the model as user text on the next request, projected as
				// a timeline entry marked moved. appended after the last line, so it reads as the newest thing that happened
				out.write(`${ended ? "" : "\n"}${JSON.stringify({ type: "message", message: { role: "notice", source: "moved", text: movedText(moved), moved, timestamp: moved.at } })}\n`);
			}
			out.flush();
		} catch (e) {
			closeSync(fd);
			undo();
			throw e;
		}
		closeSync(fd);
	}

	// 2. the rows. the messages go in first, in transactions of about 20 ms with a turn of the event loop between them, under
	// an id no session row names yet, so no list or read sees them; the session row, prefix, steps and moved notice then go
	// in one transaction, which is what makes the session appear. a failure on the way removes the rows this import staged
	// (only rows under an id with no session row, which nothing else writes) and the transcript made above
	const stepCols = new Set((store.db.query("pragma table_info(step)").all() as Array<{ name: string }>).map((c) => c.name));
	let count = 0;
	let parts = 0;
	// a transaction of hundreds of megabytes keeps its dirty pages in memory unless sqlite may spill them to the wal as it
	// goes: 1 MB of pages here, the connection's own setting back after (measured: 124 MB peak for 280 MB of rows without, 48 with)
	const spill = (store.db.query("pragma cache_spill").get() as { cache_spill: number } | null)?.cache_spill;
	store.db.exec("pragma cache_spill = 256");
	let open = false;
	const begin = () => {
		store.db.exec("begin immediate");
		open = true;
	};
	const commit = () => {
		store.db.exec("commit");
		open = false;
	};
	try {
		const msg = store.db.query(
			`insert into message (id, session_id, seq, role, created_at, completed_at, model, effort, tokens_input, tokens_output,
			   tokens_cache_read, tokens_cache_write, cost, stop_reason, info)
			 values ($id, $session_id, $seq, $role, $created_at, $completed_at, $model, $effort, $tokens_input, $tokens_output,
			   $tokens_cache_read, $tokens_cache_write, $cost, $stop_reason, $info)`,
		);
		const part = store.db.query("insert into part (id, message_id, session_id, seq, type, data) values ($id, $message_id, $session_id, $seq, $type, $data)");
		begin();
		for (const el of r.elements(messages)) {
			const m = (rename ? rename(el) : el) as ExportedMessage;
			if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.info || typeof m.info !== "object") throw new ExportError("a message in that export has no parts or no info; it is cut short or edited");
			const { parts: ps, info, ...row } = m;
			const i = { ...info, ...(typeof (info as { path?: unknown }).path === "object" && opts.directory ? { path: { cwd: directory, root: directory } } : {}) };
			msg.run({
				id: row.id,
				seq: row.seq,
				role: row.role,
				created_at: row.created_at,
				completed_at: row.completed_at ?? null,
				model: row.model ?? null,
				effort: row.effort ?? null,
				tokens_input: row.tokens_input ?? 0,
				tokens_output: row.tokens_output ?? 0,
				tokens_cache_read: row.tokens_cache_read ?? 0,
				tokens_cache_write: row.tokens_cache_write ?? 0,
				cost: row.cost ?? 0,
				stop_reason: row.stop_reason ?? null,
				session_id: id,
				info: JSON.stringify(i),
			} as never);
			count++;
			for (const { data, ...p } of ps) {
				part.run({ id: p.id, message_id: p.message_id, seq: p.seq, type: p.type, session_id: id, data: JSON.stringify(data) } as never);
				parts++;
			}
			if (r.due()) {
				commit();
				await r.pause();
				begin();
			}
		}
		commit();
		if (temp && file) {
			// the transcript takes its place only now: a link fails if a file is already there, so nothing is overwritten
			mkdirSync(join(opts.dataDir, "sessions"), { recursive: true });
			linkSync(temp, file);
			linked = true;
			rmSync(temp, { force: true });
		}
		store.db.transaction(() => {
			// a daemon that started while this import ran (a cli import) swept its marker: its staged rows may be gone
			if (!store.db.query("select 1 from import_staging where session_id = ? and token = ?").get(id, token)) throw new ExportError(`the claim on ${id} was cleared while it was imported (a daemon started and swept it); nothing was imported. import it again`);
			const s = { ...session };
			for (const k of ["session_file", "archived_at", "transcript_rev"]) delete s[k];
			store.putSession({
				...s,
				id,
				directory,
				parent_id: parent,
				session_file: file,
				updated_at: session.updated_at ?? session.created_at,
				...(opts.title ? { title: opts.title } : {}),
				...(projectId !== undefined ? { project_id: projectId } : {}),
				...(moved ? { moved_from: JSON.stringify(moved) } : {}),
			} as StoredSession);
			if (prefix) store.putPrefix(id, prefix.hash, prefix.bytes);
			for (const st of steps) store.putStep(Object.fromEntries(Object.entries({ ...st, session_id: id }).filter(([k]) => stepCols.has(k))));
			if (moved && file) projectMessage(store, { sessionId: id, cwd: directory, seq: lines + 1 }, { role: "notice", source: "moved", text: movedText(moved), moved, timestamp: moved.at });
			store.db.query("delete from import_staging where session_id = ? and token = ?").run(id, token);
		})();
	} catch (e) {
		if (open) store.db.exec("rollback");
		undo();
		if (e instanceof ExportError || e instanceof BundleError) throw e;
		throw new ExportError(`that bundle could not be imported: ${e instanceof Error ? e.message : String(e)}; nothing was changed`);
	} finally {
		if (spill !== undefined) store.db.exec(`pragma cache_spill = ${spill}`);
	}
	return { id, source, directory, messages: count, parts, steps: steps.length, transcript: file, ...(moved ? { moved } : {}) };
}

/**
 * the rows an import staged under its marker, and the marker: only while the marker is there (with this token, when one
 * is given) and no session row has the id. a committed import removed its marker in the transaction that wrote the
 * session row, so this never touches a session's history (rule 14)
 */
function unstage(store: Store, id: string, token?: string) {
	store.db.transaction(() => {
		const marked = token
			? store.db.query("select 1 from import_staging where session_id = ? and token = ?").get(id, token)
			: store.db.query("select 1 from import_staging where session_id = ?").get(id);
		if (!marked) return;
		if (!store.db.query("select 1 from main.session where id = ?").get(id)) {
			store.db.query("delete from part where session_id = ?").run(id);
			store.db.query("delete from message where session_id = ?").run(id);
		}
		store.db.query("delete from import_staging where session_id = ?").run(id);
	})();
}

/** when this process started (ms), within a second: with the pid it names an importer even after the pid is reused */
const PROCESS_STARTED = Math.round(Date.now() - process.uptime() * 1000);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** a claim whose importer cannot be checked is cleared once it is this old */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * whether the process that holds a claim still runs: true or false when the pid and its start time can be checked (ps
 * prints the start to the second), undefined when they cannot (no pid recorded, no ps)
 */
export function importerAlive(pid: number | null, started: number | null): boolean | undefined {
	if (!pid || !started) return undefined;
	try {
		process.kill(pid, 0);
	} catch (e) {
		if ((e as { code?: string }).code === "ESRCH") return false;
		if ((e as { code?: string }).code !== "EPERM") return undefined;
	}
	// ps prints the start in local time; asked in utc and read field by field, it does not depend on the reader's TZ
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
	const [, mon, day, time, year] = r.status === 0 ? r.stdout.trim().split(/\s+/) : [];
	const month = MONTHS.indexOf(mon ?? "") + 1;
	const at = month && day && time && year ? Date.parse(`${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}T${time}Z`) : Number.NaN;
	if (Number.isNaN(at)) return undefined;
	// the pid runs; it is the importer only if it started when the importer did (a reused pid started later)
	return Math.abs(at - started) < 2000;
}

/**
 * at daemon start: what imports that stopped part way left. a claim stays while its importer runs (a cli import the
 * daemon started beside); one whose importer is gone, or that is over an hour old when that cannot be checked, is cleared. the rows under each marked id with no session row, the
 * markers, and the temp files in <dataDir>/import (bodies and transcripts, never a session's own files). returns the ids
 * it cleared
 */
export function sweepImports(store: Store, dataDir: string): string[] {
	const claims = store.db.query("select session_id, token, created_at, pid, started from import_staging").all() as Array<{ session_id: string; token: string; created_at: number; pid: number | null; started: number | null }>;
	const cleared: string[] = [];
	let live = 0;
	for (const c of claims) {
		const alive = importerAlive(c.pid, c.started);
		if (alive === true || (alive === undefined && Date.now() - c.created_at < STALE_CLAIM_MS)) {
			live++;
			continue;
		}
		unstage(store, c.session_id, c.token);
		cleared.push(c.session_id);
	}
	// a live import's temp files are its own; with none running, everything in the folder is left over
	if (!live) {
		try {
			for (const f of readdirSync(join(dataDir, "import"))) rmSync(join(dataDir, "import", f), { force: true });
		} catch {}
	}
	return cleared;
}

function parseLine(line: string): Record<string, any> | undefined {
	try {
		return JSON.parse(line) as Record<string, any>;
	} catch {
		return undefined;
	}
}

/** an export held in memory, imported through the same path as a file (tests and small callers) */
export async function importSession(store: Store, input: SessionExport, opts: BundleImportOptions): Promise<ImportResult> {
	const dir = join(opts.dataDir, "import");
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `${randomUUID()}.json`);
	writeFileSync(tmp, JSON.stringify(input), { flag: "wx" });
	try {
		return await importBundleFile(store, tmp, opts);
	} finally {
		rmSync(tmp, { force: true });
	}
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
