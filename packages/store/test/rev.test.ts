import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSession, MIGRATIONS, projectMessage, projectTranscript, Store } from "../src/index.ts";

/**
 * the transcript revision in the store (protocol 14a): the migration that adds it keeps every session and message
 * (rule 14) and starts existing sessions at 0; a replay of the transcript moves it once when it changed a row and never
 * when it only rewrote what was stored; imported history stays at 0
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-rev-store-"));
const header = (id: string) => `${JSON.stringify({ type: "header", version: 1, id, cwd: "/w", created: 1, profile: "p" })}\n`;
const line = (m: unknown) => `${JSON.stringify({ type: "message", message: m })}\n`;
let call = 0;
function turn(t: number, text: string): unknown[] {
	const id = `call_${call++}`;
	return [
		{ role: "user", content: text, timestamp: t },
		{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.txt" } }], provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }, stopReason: "toolUse", timestamp: t + 1 },
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `body ${text}` }], isError: false, timestamp: t + 2 },
		{ role: "assistant", content: [{ type: "text", text: `done ${text}` }], provider: "anthropic", model: "m", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, stopReason: "stop", timestamp: t + 3 },
	];
}
const session = (s: Store, id: string, file: string | null = null) => s.putSession({ id, directory: "/w", title: id, model: "anthropic/m", session_file: file, created_at: 1 });

test("the migration keeps every session, message and part, and starts each session at revision 0", () => {
	const path = join(dir, "migrate.db");
	const s = new Store(path, { archivePath: null });
	for (let i = 0; i < 30; i++) {
		const id = `ses_m${i}`;
		session(s, id);
		for (let n = 1; n <= 5; n++) projectMessage(s, { sessionId: id, cwd: "/w", seq: n * 2 }, { role: "user", content: `hello ${i} ${n}`, timestamp: n });
		s.appendEvent({ at: 1, directory: "/w", project: null, type: "session.updated", properties: "{}" });
	}
	s.close();
	// the store as the version before this one left it: no revision columns
	const raw = new Database(path);
	raw.exec("alter table session drop column transcript_rev; alter table event_log drop column rev");
	// and without the fork lineage columns of migration 14, which runs again on top
	raw.exec("alter table session drop column forked_from; alter table session drop column forked_at_message");
	raw.exec("alter table session drop column moved_from");
	raw.exec("pragma user_version = 12");
	const count = (t: string) => (raw.query(`select count(*) as n from ${t}`).get() as { n: number }).n;
	const before = { sessions: count("session"), messages: count("message"), parts: count("part"), events: count("event_log") };
	raw.close();
	expect(before).toEqual({ sessions: 30, messages: 150, parts: 150, events: 30 });

	const m = new Store(path, { archivePath: null });
	expect(m.version).toBe(MIGRATIONS.length);
	expect({ sessions: m.sessionCount(), messages: m.messageCount(), parts: m.partCount(), events: (m.db.query("select count(*) as n from event_log").get() as { n: number }).n }).toEqual(before);
	expect(m.db.query("select distinct transcript_rev as r from session").all()).toEqual([{ r: 0 }]);
	expect(m.db.query("select count(*) as n from event_log where rev is not null").get()).toEqual({ n: 0 });
	expect(m.session("ses_m3")?.transcript_rev).toBe(0);
	expect(m.bumpTranscriptRev("ses_m3")).toBe(1);
	expect(m.transcriptRev("ses_m3")).toBe(1);
	expect(m.transcriptRev("ses_nope")).toBe(0);
	m.close();
});

test("a replay moves the revision once when it changed a row, and never when it only rewrote what was stored", () => {
	const path = join(dir, "t.jsonl");
	writeFileSync(path, header("ses_r"));
	for (const m of turn(10, "one")) appendFileSync(path, line(m));
	const s = new Store(join(dir, "replay.db"), { archivePath: null });
	session(s, "ses_r", path);
	projectTranscript(s, "ses_r", path, "/w");
	expect(s.transcriptRev("ses_r")).toBe(1);
	// read again: the same file, then every line again, then a fresh process with no memo of the file
	projectTranscript(s, "ses_r", path, "/w");
	projectTranscript(s, "ses_r", path, "/w", { all: true });
	expect(s.transcriptRev("ses_r")).toBe(1);
	const fresh = new Store(join(dir, "replay.db"), { archivePath: null });
	projectTranscript(fresh, "ses_r", path, "/w");
	projectTranscript(fresh, "ses_r", path, "/w", { all: true });
	expect(fresh.transcriptRev("ses_r")).toBe(1);
	// a turn cut after its tool call (the last row is a step still waiting on its tool): replayed from that row, its call
	// reopens and nothing else comes, so the row is not what it was; then its result lands and a re-read is the same
	const cut = turn(25, "cut");
	for (const m of cut.slice(0, 2)) appendFileSync(path, line(m));
	projectTranscript(fresh, "ses_r", path, "/w");
	expect(fresh.transcriptRev("ses_r")).toBe(2);
	const again = new Store(join(dir, "replay.db"), { archivePath: null });
	projectTranscript(again, "ses_r", path, "/w");
	expect(again.transcriptRev("ses_r")).toBe(2);
	again.close();
	for (const m of cut.slice(2)) appendFileSync(path, line(m));
	projectTranscript(fresh, "ses_r", path, "/w");
	expect(fresh.transcriptRev("ses_r")).toBe(3);
	const third = new Store(join(dir, "replay.db"), { archivePath: null });
	projectTranscript(third, "ses_r", path, "/w");
	projectTranscript(third, "ses_r", path, "/w", { all: true });
	expect(third.transcriptRev("ses_r")).toBe(3);
	third.close();
	// a turn the projection does not have yet (a crash between the transcript and the rows): one move for the heal
	for (const m of turn(20, "two")) appendFileSync(path, line(m));
	projectTranscript(fresh, "ses_r", path, "/w");
	expect(fresh.transcriptRev("ses_r")).toBe(4);
	const listed = fresh.messages("ses_r").rows.length;
	// a revert made permanent: the marked messages leave the list, one move; replayed again, nothing
	appendFileSync(path, line({ role: "revert", from: 6, timestamp: 30 }));
	projectTranscript(fresh, "ses_r", path, "/w");
	expect(fresh.transcriptRev("ses_r")).toBe(5);
	expect(fresh.messages("ses_r").rows.length).toBeLessThan(listed);
	projectTranscript(fresh, "ses_r", path, "/w", { all: true });
	expect(fresh.transcriptRev("ses_r")).toBe(5);
	expect(fresh.revertedCount("ses_r")).toBeGreaterThan(0);
	s.close();
	fresh.close();
});

test("a tracked write tells a change from a rewrite of what was stored", () => {
	const s = new Store(join(dir, "writes.db"), { archivePath: null });
	session(s, "ses_w");
	const user = (content: string) => () => projectMessage(s, { sessionId: "ses_w", cwd: "/w", seq: 2 }, { role: "user", content, timestamp: 5 });
	expect(s.trackTranscript(user("same")).changed).toBe(true);
	expect(s.trackTranscript(user("same")).changed).toBe(false);
	expect(s.trackTranscript(user("changed")).changed).toBe(true);
	const p = s.part("prt_w_00002_0")!;
	expect(s.trackTranscript(() => s.putPart(p)).changed).toBe(false);
	expect(s.trackTranscript(() => s.putPart({ ...p, data: p.data.replace("changed", "again") })).changed).toBe(true);
	// changed and changed back inside one replay: the read is the same
	expect(s.trackTranscript(() => {
		s.putPart({ ...p, data: p.data.replace("changed", "for a moment") });
		s.putPart(s.part(p.id)!.data.includes("for a moment") ? { ...p, data: p.data.replace("changed", "again") } : p);
	}).changed).toBe(false);
	s.close();
});

test("an export leaves the revision behind: an import starts its own at 0", () => {
	const s = new Store(join(dir, "export.db"), { archivePath: null });
	session(s, "ses_x");
	s.bumpTranscriptRev("ses_x");
	const e = exportSession(s, "ses_x");
	expect("transcript_rev" in e.session).toBe(false);
	s.close();
});

test("cleanup", () => {
	rmSync(dir, { recursive: true, force: true });
});
