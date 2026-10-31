import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, projectMessage, Store } from "../src/index.ts";

/**
 * cache refreshes in the store (migration 16): each refresh is a row, and its spend is added to the session's totals in
 * the same transaction. nothing here drops a session or a message (rule 14)
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-refresh-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = (s: Store, id: string) => s.putSession({ id, directory: "/w", title: id, model: "anthropic/m", session_file: null, created_at: 1 });
const counts = (s: Store) => ({ sessions: s.sessionCount(), messages: s.messageCount(), parts: s.partCount() });

test("migration 16 adds the cache_refresh table and keeps every session, message and part", () => {
	const path = join(dir, "migrate.db");
	const s = new Store(path, { archivePath: null });
	for (let i = 0; i < 12; i++) {
		session(s, `ses_r${i}`);
		for (let n = 1; n <= 3; n++) projectMessage(s, { sessionId: `ses_r${i}`, cwd: "/w", seq: n * 2 }, { role: "user", content: `hi ${i} ${n}`, timestamp: n });
	}
	s.close();
	// the store as migration 15 left it
	const raw = new Database(path);
	raw.exec("drop table cache_refresh");
	raw.exec("alter table session drop column moved_from");
	raw.exec("pragma user_version = 15");
	const count = (t: string) => (raw.query(`select count(*) as n from ${t}`).get() as { n: number }).n;
	const before = { sessions: count("session"), messages: count("message"), parts: count("part") };
	raw.close();
	expect(before).toEqual({ sessions: 12, messages: 36, parts: 36 });
	const m = new Store(path, { archivePath: null });
	expect(m.version).toBe(MIGRATIONS.length);
	expect(counts(m)).toEqual(before);
	expect(m.refreshes("ses_r1")).toEqual([]);
	m.close();
});

test("recordRefresh keeps the row and adds its spend to the session's totals; other sessions and messages are untouched", () => {
	const s = new Store(join(dir, "record.db"), { archivePath: null });
	session(s, "ses_x");
	session(s, "ses_y");
	for (let n = 1; n <= 4; n++) projectMessage(s, { sessionId: "ses_x", cwd: "/w", seq: n }, { role: "user", content: `m${n}`, timestamp: n });
	const before = counts(s);
	const totals = (id: string) => {
		const r = s.session(id)!;
		return { cost: r.cost ?? 0, input: r.tokens_input ?? 0, output: r.tokens_output ?? 0, read: r.tokens_cache_read ?? 0, write: r.tokens_cache_write ?? 0 };
	};
	const t0 = totals("ses_x");
	const y0 = totals("ses_y");

	s.recordRefresh("ses_x", { input: 3, cache_read: 9000, cache_write: 12, output: 2, cost: 0.0025, ms: 410 }, 100);
	s.recordRefresh("ses_x", { input: 1, cache_read: 9010, cache_write: 0, output: 5, cost: 0.0026 }, 200);

	const rows = s.refreshes("ses_x");
	expect(rows.map((r) => [r.at, r.input, r.cache_read, r.cache_write, r.output, r.ms])).toEqual([
		[100, 3, 9000, 12, 2, 410],
		[200, 1, 9010, 0, 5, null],
	]);
	const t1 = totals("ses_x");
	expect(t1.input - t0.input).toBe(4);
	expect(t1.output - t0.output).toBe(7);
	expect(t1.read - t0.read).toBe(18010);
	expect(t1.write - t0.write).toBe(12);
	expect(t1.cost - t0.cost).toBeCloseTo(0.0051, 10);
	expect(totals("ses_y")).toEqual(y0);
	expect(s.refreshes("ses_y")).toEqual([]);
	expect(counts(s)).toEqual(before);
	s.close();
});
