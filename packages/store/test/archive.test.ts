import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileBytes, importCmx, projectMessage, Store } from "../src/index.ts";

/**
 * rule 15: nothing deletes sessions or messages. counts are taken from the source, after the import,
 * after a restart and after a full history read (every page of every session, every part
 * decompressed), and must agree everywhere. archiving hides sessions from listings and changes no count.
 */

const SESSIONS = 240;
const BIG = "the quick brown fox jumps over the lazy dog, again and again. ".repeat(8_000); // ~500 KB

function synthetic(): { path: string; texts: Map<string, string> } {
	const path = join(mkdtempSync(join(tmpdir(), "cmx2-archive-")), "opencode.db");
	const db = new Database(path, { create: true });
	db.exec(`
		create table project (id text primary key, worktree text not null);
		create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null,
			version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
			time_created integer not null, time_updated integer not null, model text, cost real default 0, tokens_input integer default 0,
			tokens_output integer default 0, tokens_cache_read integer default 0, tokens_cache_write integer default 0, agent text);
		create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
		create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
	`);
	db.query("insert into project values ('prj', '/code/app')").run();
	const texts = new Map<string, string>();
	const insS = db.query("insert into session values (?, 'prj', ?, ?, '/code/app', ?, '1', null, null, null, null, ?, ?, null, 0, 0, 0, 0, 0, 'build')");
	const insM = db.query("insert into message values (?, ?, ?, ?, ?)");
	const insP = db.query("insert into part values (?, ?, ?, ?, ?, ?)");
	db.transaction(() => {
		for (let i = 0; i < SESSIONS; i++) {
			const sid = `ses_${String(i).padStart(4, "0")}`;
			insS.run(sid, i % 7 === 6 ? "ses_0000" : null, `slug-${i}`, `session ${i} ✓ ünïcode`, 1_000 + i, 2_000 + i);
			const messages = 1 + (i % 9);
			for (let j = 0; j < messages; j++) {
				const mid = `msg_${i}_${j}`;
				const t = 10_000 + i * 100 + j;
				insM.run(mid, sid, t, t, JSON.stringify(j % 2 ? { role: "assistant", time: { created: t, completed: t + 1 }, providerID: "anthropic", modelID: "m", cost: 0.01, tokens: { input: 1, output: 2, cache: { read: 3, write: 0 } }, finish: "stop" } : { role: "user", time: { created: t } }));
				for (let k = 0; k < 1 + (j % 3); k++) {
					const pid = `prt_${i}_${j}_${k}`;
					const text = i === 3 && j === 0 && k === 0 ? BIG : `part ${pid}: ${"lorem ipsum ".repeat(1 + ((i * 7 + j * 3 + k) % 40))}\n\ttabs, "quotes", \\ backslashes, emoji-free, ✓`;
					texts.set(pid, text);
					insP.run(pid, mid, sid, t, t, JSON.stringify({ type: "text", text }));
				}
			}
		}
		// one row over the 8 MB ceiling: imported as a stub, never read
		insM.run("msg_huge", "ses_0005", 99_999, 99_999, JSON.stringify({ role: "user", time: { created: 99_999 }, summary: { diffs: [{ patch: "y".repeat(9_000_000) }] } }));
	})();
	db.close();
	return { path, texts };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const n = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;

/** every session through the listing, a page at a time */
function listAll(store: Store, archived?: boolean | "only"): string[] {
	const ids: string[] = [];
	let before: number | undefined;
	for (;;) {
		const page = store.sessionsByUpdated({ limit: 37, before, archived });
		if (!page.length) break;
		ids.push(...page.map((r) => r.id));
		if (page.length < 37) break;
		before = page.at(-1)!.updated_at!;
	}
	return ids;
}

/** every message of every session, paged to the end, every part decompressed */
function readAll(store: Store, ids: string[], texts: Map<string, string>): { messages: number; parts: number; mismatched: number } {
	let messages = 0;
	let parts = 0;
	let mismatched = 0;
	for (const id of ids) {
		let before: number | undefined;
		for (;;) {
			const page = store.messages(id, { limit: 4, before });
			for (const m of page.rows) {
				messages++;
				JSON.parse(m.info);
				for (const p of m.parts) {
					parts++;
					const data = JSON.parse(p.data);
					const want = texts.get(p.id);
					if (want !== undefined && data.text !== want) mismatched++;
				}
			}
			if (page.next === null) break;
			before = page.next;
		}
	}
	return { messages, parts, mismatched };
}

test("rule 15: counts hold across import, restart and a full history read; archive hides, never deletes", () => {
	const { path: src, texts } = synthetic();
	const srcDb = new Database(src, { readonly: true });
	const source = { sessions: n(srcDb, "select count(*) as n from session"), messages: n(srcDb, "select count(*) as n from message"), parts: n(srcDb, "select count(*) as n from part") };
	srcDb.close();
	const srcSha = sha(src);

	const dir = mkdtempSync(join(tmpdir(), "cmx2-archive-"));
	const mainPath = join(dir, "cmx2.db");
	const importer = new Store(mainPath);
	// two native sessions in main, so every count is a union of both databases
	for (const id of ["ses_native_a", "ses_native_b"]) {
		importer.putSession({ id, directory: "/code/app", title: id, model: "anthropic/m", session_file: null, created_at: 5_000, updated_at: 5_000 });
		projectMessage(importer, { sessionId: id, cwd: "/code/app", seq: 2 }, { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "there" }], timestamp: 5_000 });
	}
	const counts = importCmx(importer, { from: src, since: 0 });
	importer.close();
	expect(sha(src)).toBe(srcSha);
	expect(counts).toMatchObject({ sessions: source.sessions, messages: source.messages, parts: source.parts, skipped: 0, oversized: 1, truncated: 0 });
	const archivePath = join(dir, "archive.db");
	const archiveSha = sha(archivePath);

	const expected = { sessions: source.sessions + 2, messages: source.messages + 2, parts: source.parts + 4 };
	const countNow = (s: Store) => ({ sessions: s.sessionCount(), messages: s.messageCount(), parts: s.partCount() });

	// the daemon's view: main plus archive.db attached read-only
	let store = new Store(mainPath);
	expect(store.hasArchive).toBe(true);
	expect(() => store.db.exec("delete from archive.session")).toThrow(/readonly/);
	expect(() => store.db.exec("insert into archive.import_run (source, path, started_at) values ('x', 'y', 1)")).toThrow(/readonly/);
	const afterImport = countNow(store);
	expect(afterImport).toEqual(expected);
	expect(listAll(store).length).toBe(expected.sessions);
	store.close();

	// restart
	store = new Store(mainPath);
	const afterRestart = countNow(store);
	expect(afterRestart).toEqual(expected);

	// full history read, every part text byte for byte
	const ids = listAll(store);
	expect(new Set(ids).size).toBe(expected.sessions);
	const read = readAll(store, ids, texts);
	expect(read).toEqual({ messages: expected.messages, parts: expected.parts, mismatched: 0 });
	const big = store.messages("ses_0003").rows[0]!.parts[0]!;
	expect(JSON.parse(big.data).text).toBe(BIG);
	const afterRead = countNow(store);
	expect(afterRead).toEqual(expected);

	// archive one imported and one native session: listings shrink, stored counts do not
	expect(store.archiveSession("ses_0010")).toBe(true);
	expect(store.archiveSession("ses_native_a")).toBe(true);
	expect(store.archiveSession("ses_nope")).toBe(false);
	expect(listAll(store).length).toBe(expected.sessions - 2);
	expect(listAll(store, "only").sort()).toEqual(["ses_0010", "ses_native_a"]);
	expect(listAll(store, true).length).toBe(expected.sessions);
	expect(store.session("ses_0010")!.archived_at).toBeGreaterThan(0);
	expect(store.session("ses_native_a")!.archived_at).toBeGreaterThan(0);
	expect(store.messages("ses_0010").rows.length).toBe(store.messageCount("ses_0010"));
	const afterArchive = countNow(store);
	expect(afterArchive).toEqual(expected);
	store.close();

	// archiving survives a restart and never wrote to archive.db
	store = new Store(mainPath);
	expect(listAll(store).length).toBe(expected.sessions - 2);
	expect(store.unarchiveSession("ses_0010")).toBe(true);
	expect(listAll(store).length).toBe(expected.sessions - 1);
	expect(countNow(store)).toEqual(expected);
	store.close();
	expect(sha(archivePath)).toBe(archiveSha);

	const b = counts.bytes;
	console.log(`source:         ${source.sessions} sessions, ${source.messages} messages, ${source.parts} parts`);
	console.log(`after import:   ${JSON.stringify(afterImport)} (main holds 2 native sessions, 2 messages, 4 parts)`);
	console.log(`after restart:  ${JSON.stringify(afterRestart)}`);
	console.log(`full read:      ${read.messages} messages, ${read.parts} parts decompressed, ${read.mismatched} mismatched`);
	console.log(`after read:     ${JSON.stringify(afterRead)}`);
	console.log(`after archive:  ${JSON.stringify(afterArchive)} (listing ${expected.sessions} -> ${expected.sessions - 2})`);
	console.log(`message infos:  ${b.infoRaw} bytes raw -> ${b.infoStored} stored`);
	console.log(`part bodies:    ${b.partRaw} bytes raw -> ${b.partStored} stored (${((100 * b.partStored) / b.partRaw).toFixed(1)}%)`);
	console.log(`files:          opencode.db ${fileBytes(src)} bytes, archive.db ${fileBytes(archivePath)} bytes`);
});
