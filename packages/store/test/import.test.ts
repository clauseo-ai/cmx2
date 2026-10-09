import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SINCE_DAYS, ImportError, importCmx, parseSince, Store } from "../src/index.ts";

/** a cmx-shaped database: the columns the importer reads, with the traps the real one has */
function cmxFixture(): string {
	const path = join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "opencode.db");
	const db = new Database(path, { create: true });
	db.exec(`
		create table project (id text primary key, worktree text not null, sandboxes text not null default '[]');
		create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null,
			version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
			time_created integer not null, time_updated integer not null, model text, cost real default 0, tokens_input integer default 0,
			tokens_output integer default 0, tokens_cache_read integer default 0, tokens_cache_write integer default 0, agent text);
		create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
		create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
	`);
	db.query("insert into project values ('prj1', '/code/app', '[]')").run();
	db.query("insert into session values ('ses_a', 'prj1', null, 'brave-owl', '/code/app', 'fix the thing', '1.0', null, 3, 1, 2, 100, 200, ?, 0.5, 10, 20, 30, 0, 'build')").run(
		JSON.stringify({ providerID: "anthropic", id: "claude-opus-5-5" }),
	);
	db.query("insert into session values ('ses_b', 'prj1', 'ses_a', 'calm-fox', '/code/app', 'child', '1.0', null, null, null, null, 110, 150, null, 0, 0, 0, 0, 0, 'explore')").run();
	const huge = "x".repeat(200_000);
	db.query("insert into message values ('msg_1', 'ses_a', 101, 101, ?)").run(JSON.stringify({ role: "user", time: { created: 101 }, summary: { title: "t", diffs: [{ file: "a.ts", patch: huge }] } }));
	db.query("insert into message values ('msg_2', 'ses_a', 102, 102, ?)").run(
		JSON.stringify({ role: "assistant", time: { created: 102, completed: 103 }, providerID: "anthropic", modelID: "claude-opus-5-5", cost: 0.25, tokens: { input: 5, output: 6, cache: { read: 7, write: 0 } }, finish: "stop", variant: "max" }),
	);
	db.query("insert into message values ('msg_bad', 'ses_a', 104, 104, '{not json')").run();
	db.query("insert into message values ('msg_huge', 'ses_a', 105, 105, ?)").run(JSON.stringify({ role: "user", time: { created: 105 }, summary: { diffs: [{ patch: "y".repeat(9_000_000) }] } }));
	db.query("insert into part values ('prt_1', 'msg_1', 'ses_a', 101, 101, ?)").run(JSON.stringify({ type: "text", text: "hello" }));
	db.query("insert into part values ('prt_2', 'msg_2', 'ses_a', 102, 102, ?)").run(JSON.stringify({ type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: {}, output: huge } }));
	db.close();
	return path;
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("imports sessions, messages and parts into archive.db without writing to the source", () => {
	const src = cmxFixture();
	const before = sha(src);
	const store = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "cmx2.db"));
	const counts = importCmx(store, { from: src, cap: 1000, since: 0 });
	expect(counts).toMatchObject({ sessions: 2, messages: 3, parts: 2, skipped: 1, oversized: 1, since: 0 });
	// the source's own counts, from the snapshot the import read: the unreadable message is the difference
	expect(counts.source).toEqual({ sessions: 2, messages: 4, parts: 2 });
	expect(sha(src)).toBe(before);
	// nothing landed in main: the history lives in the attached archive
	expect((store.db.query("select count(*) as n from main.session").get() as { n: number }).n).toBe(0);
	expect(store.hasArchive).toBe(true);

	const a = store.session("ses_a")!;
	expect(a).toMatchObject({ source: "cmx", project_id: "/code/app", model: "anthropic/claude-opus-5-5", cost: 0.5, updated_at: 200 });
	expect(JSON.parse(a.summary!)).toEqual({ additions: 3, deletions: 1, files: 2 });
	expect(store.session("ses_b")!.parent_id).toBe("ses_a");

	const page = store.messages("ses_a");
	const user = JSON.parse(page.rows[0]!.info);
	expect(user.summary.diffs).toBeUndefined();
	expect(user.summary.title).toBe("t");
	const tool = JSON.parse(page.rows[1]!.parts[0]!.data);
	expect(tool.state.output.length).toBeLessThan(1100);
	expect(tool.state.output).toContain("more characters in the cmx db, part prt_2");
	expect(page.rows[1]).toMatchObject({ model: "anthropic/claude-opus-5-5", effort: "max", tokens_cache_read: 7, stop_reason: "stop" });
	expect(JSON.parse(page.rows[2]!.info)).toMatchObject({ id: "msg_huge", role: "user", oversized: { bytes: expect.any(Number) } });

	// a re-run is an upsert, not a duplicate
	const again = importCmx(store, { from: src, cap: 1000, since: 0 });
	expect(again.sessions).toBe(2);
	expect(store.sessionCount("cmx")).toBe(2);
	expect(store.messageCount("ses_a")).toBe(3);
	expect(store.imports().length).toBe(2);
});

test("a cmx2 session with the same id is never overwritten by an import", () => {
	const src = cmxFixture();
	const store = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "cmx2.db"));
	store.putSession({ id: "ses_a", directory: "/mine", title: "mine", model: "anthropic/m", session_file: null, created_at: 1 });
	const counts = importCmx(store, { from: src, since: 0 });
	expect(counts.inMain).toBe(1);
	expect(store.session("ses_a")!.title).toBe("mine");
	expect(store.session("ses_b")!.source).toBe("cmx");
});

test("without a cap strings are kept whole, compressed", () => {
	const src = cmxFixture();
	const store = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "cmx2.db"));
	const counts = importCmx(store, { from: src, since: 0 });
	expect(counts.truncated).toBe(0);
	expect(counts.bytes.partStored).toBeLessThan(counts.bytes.partRaw / 20);
	const tool = JSON.parse(store.messages("ses_a").rows[1]!.parts[0]!.data);
	expect(tool.state.output).toBe("x".repeat(200_000));
});

test("since: the default is 90 days back on a first run, then the previous run's start minus a day", () => {
	const src = cmxFixture();
	const store = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "cmx2.db"));
	const t0 = Date.now();
	const first = importCmx(store, { from: src });
	expect(first.sessions).toBe(0);
	expect(Math.abs(first.since - (t0 - DEFAULT_SINCE_DAYS * 86_400_000))).toBeLessThan(5_000);
	const second = importCmx(store, { from: src });
	expect(Math.abs(second.since - (t0 - 86_400_000))).toBeLessThan(5_000);
	expect(parseSince("all")).toBe(0);
	expect(parseSince("0")).toBe(0);
	expect(parseSince("30d", 100 * 86_400_000)).toBe(70 * 86_400_000);
	expect(parseSince("2026-08-01")).toBe(Date.parse("2026-08-01"));
	expect(parseSince(undefined)).toBeUndefined();
	expect(() => parseSince("yesterday")).toThrow(ImportError);
});

test("a missing or foreign database is refused with the fix in the message", () => {
	const store = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "cmx2.db"));
	expect(() => importCmx(store, { from: "/nope/opencode.db" })).toThrow(ImportError);
	const other = join(mkdtempSync(join(tmpdir(), "cmx2-import-")), "other.db");
	new Database(other, { create: true }).exec("create table x (a)");
	expect(() => importCmx(store, { from: other })).toThrow(/does not look like a cmx database/);
});
