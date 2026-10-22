import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, projectMessage, Store } from "../src/index.ts";

/**
 * fork lineage in the store (migration 14): the session a fork came from and the parent's message it was cut before.
 * the migration keeps every session and message (rule 14); the lineage survives a re-read and later upserts
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-lineage-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = (s: Store, id: string, extra: Partial<Parameters<Store["putSession"]>[0]> = {}) =>
	s.putSession({ id, directory: "/w", title: id, model: "anthropic/m", session_file: null, created_at: 1, ...extra });

test("migration 14 adds the lineage columns and keeps every session, message and part", () => {
	const path = join(dir, "migrate.db");
	const s = new Store(path, { archivePath: null });
	for (let i = 0; i < 20; i++) {
		session(s, `ses_l${i}`);
		for (let n = 1; n <= 4; n++) projectMessage(s, { sessionId: `ses_l${i}`, cwd: "/w", seq: n * 2 }, { role: "user", content: `hi ${i} ${n}`, timestamp: n });
	}
	s.close();
	// the store as migration 13 left it
	const raw = new Database(path);
	raw.exec("alter table session drop column forked_from; alter table session drop column forked_at_message");
	raw.exec("pragma user_version = 13");
	const count = (t: string) => (raw.query(`select count(*) as n from ${t}`).get() as { n: number }).n;
	const before = { sessions: count("session"), messages: count("message"), parts: count("part") };
	raw.close();
	expect(before).toEqual({ sessions: 20, messages: 80, parts: 80 });

	const m = new Store(path, { archivePath: null });
	expect(m.version).toBe(MIGRATIONS.length);
	expect({ sessions: m.sessionCount(), messages: m.messageCount(), parts: m.partCount() }).toEqual(before);
	expect(m.db.query("select count(*) as n from session where forked_from is not null or forked_at_message is not null").get()).toEqual({ n: 0 });
	expect(m.session("ses_l3")?.forked_from).toBeNull();
	m.close();
});

test("lineage survives a re-read from the db and an upsert that does not name it", () => {
	const path = join(dir, "reread.db");
	const s = new Store(path, { archivePath: null });
	session(s, "ses_parent");
	session(s, "ses_cut", { forked_from: "ses_parent", forked_at_message: "msg_parent_00003" });
	session(s, "ses_whole", { forked_from: "ses_parent" });
	session(s, "ses_grand", { forked_from: "ses_cut", forked_at_message: "msg_cut_00001" });
	s.close();
	const r = new Store(path, { archivePath: null });
	const pick = (id: string) => {
		const x = r.session(id)!;
		return [x.forked_from, x.forked_at_message];
	};
	expect(pick("ses_parent")).toEqual([null, null]);
	expect(pick("ses_cut")).toEqual(["ses_parent", "msg_parent_00003"]);
	expect(pick("ses_whole")).toEqual(["ses_parent", null]);
	expect(pick("ses_grand")).toEqual(["ses_cut", "msg_cut_00001"]);
	// a rename writes the row again without the lineage; it stays
	session(r, "ses_cut", { title: "renamed" });
	expect(r.session("ses_cut")?.title).toBe("renamed");
	expect(pick("ses_cut")).toEqual(["ses_parent", "msg_parent_00003"]);
	expect(r.sessionsByUpdated({ limit: 10 }).find((x) => x.id === "ses_grand")?.forked_from).toBe("ses_cut");
	r.close();
});
