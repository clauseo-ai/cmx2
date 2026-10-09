import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { archivePathFor, compress, openArchiveWriter } from "./archive.ts";
import type { Store } from "./index.ts";

/**
 * import of cmx (opencode) history into archive.db so it is browsable in cmx2. browse only
 * (DECISIONS Q4): imported sessions carry `source = 'cmx'` and never run a turn.
 *
 * the source is opened read-only and only ever read. message infos and part bodies are stored whole,
 * zstd-compressed (the m2 projection cut strings to 8 KB; on a large db it threw away most of
 * the part text, and compressed whole text costs less disk than the cut text did raw). two things
 * are still left in the cmx db: message `summary.diffs` (whole-file patches, removed in sql before a row
 * reaches this process) and message rows over 8 MB, which are stubbed without being read.
 *
 * re-runs are upserts by id. sessions whose id already lives in main (m2 imported into main, or a cmx2
 * session with the same id) are skipped, so main keeps winning and nothing is written twice.
 */

/** on a first import, how far back to go; later runs pick up from the previous run */
export const DEFAULT_SINCE_DAYS = 90;
const DAY = 86_400_000;
/** a re-run starts this long before the previous run started, so sessions updated during it are caught */
const OVERLAP = DAY;

export interface ImportOptions {
	/** path to `opencode.db` */
	from: string;
	/** archive.db to write; default the store's archive path */
	archive?: string;
	/** longest string kept per field; default no cap (everything is compressed whole) */
	cap?: number;
	/**
	 * only sessions updated at or after this time (ms); 0 imports everything. default: from the
	 * previous finished import's start minus a day, or `DEFAULT_SINCE_DAYS` back on the first run.
	 */
	since?: number;
	/** progress every 10,000 messages */
	onProgress?: (p: ImportCounts & { phase: string }) => void;
}

export interface ImportCounts {
	sessions: number;
	/** sessions skipped because main already holds that id */
	inMain: number;
	/** message rows over the size ceiling, imported as a stub without reading them */
	oversized: number;
	messages: number;
	parts: number;
	/** rows the source had that could not be read as json */
	skipped: number;
	/** strings cut to the cap (0 unless a cap was asked for) */
	truncated: number;
	/** the since that was applied, ms (0 = everything) */
	since: number;
	archive: string;
	/** raw json bytes vs the compressed bytes stored, per kind */
	bytes: { infoRaw: number; infoStored: number; partRaw: number; partStored: number };
	/**
	 * what the source held in the selection, counted inside the same read snapshot the import copied
	 * from, so a live cmx serve writing meanwhile cannot make the two disagree. parts count only those
	 * whose message belongs to the same session (the ones an import can place)
	 */
	source: { sessions: number; messages: number; parts: number };
}

export class ImportError extends Error {}

/** bytes above which a cmx message row is imported as a stub instead of read */
const OVERSIZED = 8_000_000;

/**
 * `--since`: `all` or `0` for everything, `30d` / `12h` / `2w` back from now, an iso date, or ms since
 * the epoch. undefined means the default.
 */
export function parseSince(raw: string | undefined, now = Date.now()): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (raw === "all" || raw === "0") return 0;
	const rel = raw.match(/^(\d+)([hdw])$/);
	if (rel) return now - Number(rel[1]) * { h: 3_600_000, d: DAY, w: 7 * DAY }[rel[2] as "h" | "d" | "w"];
	if (/^\d+$/.test(raw)) return Number(raw);
	const t = Date.parse(raw);
	if (Number.isNaN(t)) throw new ImportError(`--since takes all, 30d, 12h, 2w, a date like 2026-08-01, or ms since the epoch; got ${JSON.stringify(raw)}`);
	return t;
}

function capStrings(v: unknown, max: number | undefined, where: string, counts: ImportCounts): unknown {
	if (max === undefined) return v;
	if (typeof v === "string") {
		if (v.length <= max) return v;
		counts.truncated++;
		return `${v.slice(0, max)}\n…[${v.length - max} more characters in the cmx db, ${where}]`;
	}
	if (Array.isArray(v)) return v.map((x) => capStrings(x, max, where, counts));
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = capStrings(x, max, where, counts);
		return out;
	}
	return v;
}

function openSource(path: string): Database {
	if (!existsSync(path)) throw new ImportError(`no cmx database at ${path}; pass --from with the path to opencode.db`);
	let src: Database;
	try {
		src = new Database(path, { readonly: true });
	} catch (e) {
		throw new ImportError(`could not open ${path} read-only: ${e instanceof Error ? e.message : String(e)}`);
	}
	const tables = new Set((src.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
	for (const t of ["session", "message", "part", "project"]) {
		if (!tables.has(t)) {
			src.close();
			throw new ImportError(`${path} has no ${t} table; it does not look like a cmx database`);
		}
	}
	return src;
}

/** the default since: the previous finished run's start minus the overlap, or DEFAULT_SINCE_DAYS back */
function defaultSince(archive: Database, now: number): number {
	const last = archive.query("select max(started_at) as t from import_run where source = 'cmx' and finished_at is not null").get() as { t: number | null };
	return last.t ? last.t - OVERLAP : now - DEFAULT_SINCE_DAYS * DAY;
}

export function importCmx(store: Store, opts: ImportOptions): ImportCounts {
	const src = openSource(opts.from);
	const archivePath = opts.archive ?? store.archivePath ?? archivePathFor(store.path);
	const out = openArchiveWriter(archivePath);
	const now = Date.now();
	const since = opts.since ?? defaultSince(out, now);
	const counts: ImportCounts = {
		sessions: 0,
		inMain: 0,
		oversized: 0,
		messages: 0,
		parts: 0,
		skipped: 0,
		truncated: 0,
		since,
		archive: archivePath,
		bytes: { infoRaw: 0, infoStored: 0, partRaw: 0, partStored: 0 },
		source: { sessions: 0, messages: 0, parts: 0 },
	};
	const run = Number(out.query("insert into import_run (source, path, started_at, since) values ('cmx', ?, ?, ?)").run(opts.from, now, since).lastInsertRowid);
	try {
		// one read transaction: in wal mode every read below sees the same snapshot while the cmx serve
		// that owns the file goes on writing (its checkpoints wait for the import, about a minute)
		src.exec("begin");
		const selected = "select id from session where time_updated >= ?";
		counts.source.sessions = (src.query(`select count(*) as n from session where time_updated >= ?`).get(since) as { n: number }).n;
		counts.source.messages = (src.query(`select count(*) as n from message where session_id in (${selected})`).get(since) as { n: number }).n;
		counts.source.parts = (
			src.query(`select count(*) as n from part p join message m on m.id = p.message_id and m.session_id = p.session_id where p.session_id in (${selected})`).get(since) as { n: number }
		).n;
		const projects = new Map(
			(src.query("select id, worktree from project").all() as Array<{ id: string; worktree: string }>).map((p) => [p.id, p.worktree]),
		);
		const sessions = src
			.query(
				`select id, project_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files,
				   time_created, time_updated, model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, agent
				 from session where time_updated >= ? order by time_created`,
			)
			.all(since) as any[];

		const inMain = store.db.query("select 1 from main.session where id = ?");
		const insSession = out.query(
			`insert into session (id, directory, title, model, session_file, created_at, updated_at, parent_id, slug, project_id, source, version,
			   cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, summary)
			 values ($id, $directory, $title, $model, null, $created_at, $updated_at, $parent_id, $slug, $project_id, 'cmx', $version,
			   $cost, $tokens_input, $tokens_output, $tokens_cache_read, $tokens_cache_write, $summary)
			 on conflict(id) do update set title = excluded.title, model = excluded.model, updated_at = excluded.updated_at,
			   parent_id = excluded.parent_id, project_id = excluded.project_id, cost = excluded.cost, tokens_input = excluded.tokens_input,
			   tokens_output = excluded.tokens_output, tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write,
			   summary = excluded.summary`,
		);
		const insMessage = out.query(
			`insert or replace into message (id, session_id, seq, role, created_at, completed_at, model, effort, tokens_input, tokens_output,
			   tokens_cache_read, tokens_cache_write, cost, stop_reason, info_z, info_bytes)
			 values ($id, $session_id, $seq, $role, $created_at, $completed_at, $model, $effort, $tokens_input, $tokens_output,
			   $tokens_cache_read, $tokens_cache_write, $cost, $stop_reason, $info_z, $info_bytes)`,
		);
		const insPart = out.query(
			"insert or replace into part (id, message_id, session_id, seq, type, data_z, data_bytes) values ($id, $message_id, $session_id, $seq, $type, $data_z, $data_bytes)",
		);
		// diffs are removed by sqlite before a row reaches this process. a row over the ceiling is not read
		// at all (sqlite loads a value only when an expression needs it, and octet_length does not): in cmx
		// those are user messages whose summary holds whole-file diffs, up to 286 MB each.
		const messagesOf = src.query(
			`select id, time_created, octet_length(data) as bytes,
			   case when octet_length(data) > ${OVERSIZED} then null when json_valid(data) then json_remove(data, '$.summary.diffs') else data end as data
			 from message where session_id = ? order by time_created, id`,
		);
		const partsOf = src.query("select id, message_id, data from part where session_id = ? order by message_id, id");

		for (const s of sessions) {
			if (inMain.get(s.id)) {
				counts.inMain++;
				continue;
			}
			const model = (() => {
				try {
					const m = s.model ? JSON.parse(s.model) : undefined;
					return m?.providerID && m?.id ? `${m.providerID}/${m.id}` : typeof s.model === "string" && s.model ? s.model : "unknown";
				} catch {
					return String(s.model ?? "unknown");
				}
			})();
			out.transaction(() => {
				insSession.run({
					id: s.id,
					directory: s.directory,
					title: s.title,
					model,
					created_at: s.time_created,
					updated_at: s.time_updated,
					parent_id: s.parent_id ?? null,
					slug: s.slug ?? null,
					project_id: projects.get(s.project_id) ?? null,
					version: s.version ?? null,
					cost: s.cost ?? 0,
					tokens_input: s.tokens_input ?? 0,
					tokens_output: s.tokens_output ?? 0,
					tokens_cache_read: s.tokens_cache_read ?? 0,
					tokens_cache_write: s.tokens_cache_write ?? 0,
					summary: s.summary_files === null && s.summary_additions === null ? null : JSON.stringify({ additions: s.summary_additions ?? 0, deletions: s.summary_deletions ?? 0, files: s.summary_files ?? 0 }),
				} as never);
				counts.sessions++;

				const seqOf = new Map<string, number>();
				let seq = 0;
				for (const m of messagesOf.iterate(s.id) as Iterable<{ id: string; time_created: number; bytes: number; data: string | null }>) {
					let info: any;
					if (m.data === null) {
						counts.oversized++;
						info = { role: "user", time: { created: m.time_created }, oversized: { bytes: m.bytes, note: "this cmx message held whole-file diffs; they stay in the cmx db" } };
					} else {
						try {
							info = JSON.parse(m.data);
						} catch {
							counts.skipped++;
							continue;
						}
					}
					seq++;
					seqOf.set(m.id, seq);
					info = capStrings({ ...info, id: m.id, sessionID: s.id }, opts.cap, `message ${m.id}`, counts);
					const t = info.tokens ?? {};
					const z = compress(JSON.stringify(info));
					counts.bytes.infoRaw += z.bytes;
					counts.bytes.infoStored += z.z.byteLength;
					insMessage.run({
						id: m.id,
						session_id: s.id,
						seq,
						role: info.role ?? "unknown",
						created_at: info.time?.created ?? m.time_created,
						completed_at: info.time?.completed ?? null,
						model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : info.model?.providerID ? `${info.model.providerID}/${info.model.modelID}` : null,
						effort: info.variant ?? info.model?.variant ?? null,
						tokens_input: t.input ?? 0,
						tokens_output: t.output ?? 0,
						tokens_cache_read: t.cache?.read ?? 0,
						tokens_cache_write: t.cache?.write ?? 0,
						cost: info.cost ?? 0,
						stop_reason: info.finish ?? null,
						info_z: z.z,
						info_bytes: z.bytes,
					} as never);
					counts.messages++;
					if (opts.onProgress && counts.messages % 10_000 === 0) opts.onProgress({ ...counts, phase: "messages" });
				}

				let lastMessage = "";
				let partSeq = 0;
				for (const p of partsOf.iterate(s.id) as Iterable<{ id: string; message_id: string; data: string }>) {
					if (!seqOf.has(p.message_id)) continue;
					let data: any;
					try {
						data = JSON.parse(p.data);
					} catch {
						counts.skipped++;
						continue;
					}
					partSeq = p.message_id === lastMessage ? partSeq + 1 : 0;
					lastMessage = p.message_id;
					data = capStrings({ ...data, id: p.id, sessionID: s.id, messageID: p.message_id }, opts.cap, `part ${p.id}`, counts);
					const z = compress(JSON.stringify(data));
					counts.bytes.partRaw += z.bytes;
					counts.bytes.partStored += z.z.byteLength;
					insPart.run({ id: p.id, message_id: p.message_id, session_id: s.id, seq: partSeq, type: String(data.type ?? "unknown"), data_z: z.z, data_bytes: z.bytes } as never);
					counts.parts++;
				}
			})();
		}
		out
			.query("update import_run set finished_at = ?, sessions = ?, messages = ?, parts = ?, skipped = ?, raw_bytes = ?, stored_bytes = ? where id = ?")
			.run(
				Date.now(),
				counts.sessions,
				counts.messages,
				counts.parts,
				counts.skipped,
				counts.bytes.infoRaw + counts.bytes.partRaw,
				counts.bytes.infoStored + counts.bytes.partStored,
				run,
			);
		return counts;
	} finally {
		if (src.inTransaction) src.exec("rollback");
		src.close();
		out.close();
	}
}

/** file size in bytes, 0 when missing; for the before and after lines */
export function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
