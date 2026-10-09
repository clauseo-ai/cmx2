import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * the archive database: imported history (cmx today) in its own file next to `cmx2.db`. the daemon
 * attaches it read-only, so nothing the daemon does can change a byte of it; only the importer opens
 * it for writing. message infos and part bodies are zstd-compressed blobs with their raw byte length
 * beside them, decompressed one page at a time on read.
 *
 * the file stays in rollback-journal mode, not wal: a read-only attach of a wal database needs the
 * -shm file to exist and be writable, which is exactly what read-only should not need.
 */

export const ARCHIVE_FILE = "archive.db";

export function archivePathFor(mainPath: string): string {
	return join(dirname(mainPath), ARCHIVE_FILE);
}

/** columns every session table carries, main and archive alike, in one order so the two can union */
export const SESSION_COLUMNS = [
	"id",
	"directory",
	"title",
	"model",
	"session_file",
	"created_at",
	"updated_at",
	"effort",
	"nudge",
	"turn_mode",
	"cache_ttl",
	"parent_id",
	"slug",
	"project_id",
	"source",
	"version",
	"cost",
	"tokens_input",
	"tokens_output",
	"tokens_cache_read",
	"tokens_cache_write",
	"summary",
] as const;

/** append only, one entry per `pragma user_version` of archive.db */
export const ARCHIVE_MIGRATIONS: readonly string[] = [
	// 1 · m3: sessions as in main, messages and parts compressed, the import log
	`create table session (
		id text primary key,
		directory text not null,
		title text not null,
		model text not null,
		session_file text,
		created_at integer not null,
		updated_at integer,
		effort text,
		nudge integer,
		turn_mode text,
		cache_ttl text,
		parent_id text,
		slug text,
		project_id text,
		source text not null default 'cmx',
		version text,
		cost real not null default 0,
		tokens_input integer not null default 0,
		tokens_output integer not null default 0,
		tokens_cache_read integer not null default 0,
		tokens_cache_write integer not null default 0,
		summary text
	 );
	 create index session_updated_idx on session (updated_at desc, id desc);
	 create index session_created_idx on session (created_at, id);
	 create index session_project_idx on session (project_id, updated_at desc);
	 create table message (
		id text primary key,
		session_id text not null,
		seq integer not null,
		role text not null,
		created_at integer not null,
		completed_at integer,
		model text,
		effort text,
		tokens_input integer not null default 0,
		tokens_output integer not null default 0,
		tokens_cache_read integer not null default 0,
		tokens_cache_write integer not null default 0,
		cost real not null default 0,
		stop_reason text,
		info_z blob not null,
		info_bytes integer not null
	 );
	 create index message_session_seq_idx on message (session_id, seq);
	 create table part (
		id text primary key,
		message_id text not null,
		session_id text not null,
		seq integer not null,
		type text not null,
		data_z blob not null,
		data_bytes integer not null
	 );
	 create index part_message_idx on part (message_id, seq);
	 create index part_session_idx on part (session_id);
	 create table import_run (
		id integer primary key autoincrement,
		source text not null,
		path text not null,
		started_at integer not null,
		finished_at integer,
		since integer,
		sessions integer,
		messages integer,
		parts integer,
		skipped integer,
		raw_bytes integer,
		stored_bytes integer
	 )`,
];

/** opens archive.db for writing (the importer only) and brings its schema up to date */
export function openArchiveWriter(path: string): Database {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("pragma busy_timeout = 5000; pragma journal_mode = delete; pragma synchronous = normal;");
	const version = () => (db.query("pragma user_version").get() as { user_version: number }).user_version;
	if (version() < ARCHIVE_MIGRATIONS.length) {
		db.transaction(() => {
			for (let i = version(); i < ARCHIVE_MIGRATIONS.length; i++) {
				db.exec(ARCHIVE_MIGRATIONS[i]!);
				db.exec(`pragma user_version = ${i + 1}`);
			}
		}).immediate();
	}
	return db;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function compress(s: string): { z: Uint8Array; bytes: number } {
	const raw = enc.encode(s);
	return { z: Bun.zstdCompressSync(raw), bytes: raw.byteLength };
}

export function decompress(z: Uint8Array | null): string {
	if (!z) return "";
	return dec.decode(Bun.zstdDecompressSync(z));
}
