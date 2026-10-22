import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { btwInfo, MIGRATIONS, projectMessage, Store } from "../src/index.ts";

/**
 * btws in the store (migration 15): their own table, so the projection and message reads never see them. finishing one
 * adds its spend to the session's totals once; dismissing is a flag; nothing here drops a session or a message (rule 14)
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-btw-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = (s: Store, id: string) => s.putSession({ id, directory: "/w", title: id, model: "anthropic/m", session_file: null, created_at: 1 });
const counts = (s: Store) => ({ sessions: s.sessionCount(), messages: s.messageCount(), parts: s.partCount() });
const usage = { tokens_input: 10, tokens_output: 20, tokens_cache_read: 3000, tokens_cache_write: 40, cost: 0.01 };

test("migration 15 adds the btw table and keeps every session, message and part", () => {
	const path = join(dir, "migrate.db");
	const s = new Store(path, { archivePath: null });
	for (let i = 0; i < 12; i++) {
		session(s, `ses_b${i}`);
		for (let n = 1; n <= 3; n++) projectMessage(s, { sessionId: `ses_b${i}`, cwd: "/w", seq: n * 2 }, { role: "user", content: `hi ${i} ${n}`, timestamp: n });
	}
	s.close();
	// the store as migration 14 left it
	const raw = new Database(path);
	raw.exec("drop table btw");
	raw.exec(`pragma user_version = ${MIGRATIONS.length - 1}`);
	raw.close();
	const m = new Store(path, { archivePath: null });
	expect(m.version).toBe(MIGRATIONS.length);
	expect(counts(m)).toEqual({ sessions: 12, messages: 36, parts: 36 });
	expect(m.btws("ses_b1")).toEqual([]);
	m.close();
});

test("a btw's life: asked, finished once into the totals, dismissed as a flag, promoted once; sessions and messages untouched", () => {
	const s = new Store(join(dir, "life.db"), { archivePath: null });
	session(s, "ses_x");
	session(s, "ses_y");
	for (let n = 1; n <= 4; n++) projectMessage(s, { sessionId: "ses_x", cwd: "/w", seq: n }, { role: "user", content: `m${n}`, timestamp: n });
	const before = counts(s);
	const totals = () => {
		const r = s.session("ses_x")!;
		return [r.cost, r.tokens_input, r.tokens_output, r.tokens_cache_read, r.tokens_cache_write];
	};
	const t0 = totals();

	s.putBtw({ id: "btw_2", session_id: "ses_x", text: "second", after_message_id: s.lastMessageId("ses_x") ?? null, created_at: 20, model: "anthropic/m" });
	s.putBtw({ id: "btw_1", session_id: "ses_x", text: "first", after_message_id: null, created_at: 10, model: null });
	s.putBtw({ id: "btw_o", session_id: "ses_y", text: "other", after_message_id: null, created_at: 5, model: null });
	expect(s.btws("ses_x").map((b) => b.id)).toEqual(["btw_1", "btw_2"]);
	expect(s.btw("btw_2")!.after_message_id).toBe("msg_x_00004");
	const running = btwInfo(s.btw("btw_2")!);
	expect(running).toEqual({ id: "btw_2", sessionID: "ses_x", text: "second", answer: "", status: "running", afterMessageID: "msg_x_00004", time: { created: 20 }, model: { providerID: "anthropic", modelID: "m" } });
	expect(btwInfo(s.btw("btw_2")!, "so far").answer).toBe("so far");

	// a promote before it is done changes nothing
	expect(s.promoteBtw("btw_2", "msg_a")).toBe(false);

	expect(s.finishBtw("btw_2", { status: "done", answer: "an answer", completed_at: 30, ...usage })).toBe(true);
	// a second finish is refused, and the totals move once
	expect(s.finishBtw("btw_2", { status: "error", answer: "", error: "late", completed_at: 31, ...usage })).toBe(false);
	expect(totals()).toEqual([t0[0]! + 0.01, t0[1]! + 10, t0[2]! + 20, t0[3]! + 3000, t0[4]! + 40]);
	const done = btwInfo(s.btw("btw_2")!);
	expect(done.status).toBe("done");
	expect(done.answer).toBe("an answer");
	expect(done.time).toEqual({ created: 20, completed: 30 });
	expect(done.tokens).toEqual({ input: 10, output: 20, cache: { read: 3000, write: 40 } });
	expect(done.cost).toBe(0.01);

	expect(s.dismissBtw("btw_2", 40)).toBe(true);
	expect(s.dismissBtw("btw_2", 50)).toBe(false);
	expect(s.btw("btw_2")!.dismissed_at).toBe(40);
	// dismissed is a flag: the row stays and lists
	expect(s.btws("ses_x").length).toBe(2);

	expect(s.promoteBtw("btw_2", "msg_queued")).toBe(true);
	expect(s.promoteBtw("btw_2", "msg_b")).toBe(false);
	expect(s.repointBtw("btw_2", "msg_x_00005")).toBe(true);
	expect(btwInfo(s.btw("btw_2")!).promotedMessageID).toBe("msg_x_00005");
	// repointing needs a promotion first
	expect(s.repointBtw("btw_1", "msg_c")).toBe(false);

	// a daemon that stopped with btws running: each becomes an error, nothing else moves
	const failed = s.failRunningBtws("the daemon restarted before it answered", 60);
	expect(failed.map((b) => b.id).sort()).toEqual(["btw_1", "btw_o"]);
	expect(s.btw("btw_1")).toMatchObject({ status: "error", error: "the daemon restarted before it answered", completed_at: 60 });
	expect(s.btw("btw_2")!.status).toBe("done");
	expect(s.promoteBtw("btw_1", "msg_d")).toBe(false);

	// the projection and message reads never see a btw
	expect(counts(s)).toEqual(before);
	expect(s.messages("ses_x").rows.map((r) => r.id)).toEqual(["msg_x_00001", "msg_x_00002", "msg_x_00003", "msg_x_00004"]);
	s.close();
});
