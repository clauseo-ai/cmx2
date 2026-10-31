import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSession, exportStream, importSession, MIGRATIONS, movedText, projectMessage, projectTranscript, readExport, Store } from "../src/index.ts";

/**
 * a session moved to another machine: the export's origin, the moved record an import writes (moved_from, a notice at
 * the end of the transcript, its projected timeline entry) and migration 17, which keeps every session and message
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-move-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function source() {
	const data = join(dir, "data-a");
	mkdirSync(join(data, "sessions"), { recursive: true });
	const s = new Store(join(data, "cmx2.db"), { archivePath: null });
	const id = "ses_move0001";
	const file = join(data, "sessions", `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "header", version: 1, id, cwd: "/Users/rohan/x", created: 1 })}\n`);
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "read /Users/rohan/x/a.txt", timestamp: 10 } })}\n`);
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: 11 } })}\n`);
	s.putSession({ id, directory: "/Users/rohan/x", title: "a thread", model: "anthropic/m", session_file: file, created_at: 1 });
	projectTranscript(s, id, file, "/Users/rohan/x");
	return { s, id };
}

test("an import onto another machine writes one moved record: moved_from, a notice the model reads, a synthetic timeline entry", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	expect(e.origin?.directory).toBe("/Users/rohan/x");
	// the export the cli wrote, with the origin of a mac
	e.origin = { machine: "macmini", os: "macos", arch: "arm64", directory: "/Users/rohan/x", home: "/Users/rohan" };
	let streamed = "";
	for await (const c of exportStream(s, id)) streamed += c;
	expect(readExport(streamed).session.id).toBe(id);
	s.close();

	const data = join(dir, "data-b");
	const t = new Store(join(data, "cmx2.db"), { archivePath: null });
	const before = { sessions: t.sessionCount(), messages: t.messageCount() };
	const r = importSession(t, readExport(JSON.stringify(e)), { dataDir: data, directory: "/home/rohan/x", here: { machine: "boxbox", os: "linux", arch: "x64", home: "/home/rohan" }, now: 500 });
	expect(r.moved).toEqual({ from: e.origin, to: { machine: "boxbox", os: "linux", arch: "x64", directory: "/home/rohan/x", home: "/home/rohan" }, at: 500 });
	const line = movedText(r.moved!);
	expect(line).toBe(
		"this thread moved from macmini (macos, /Users/rohan/x) to boxbox (linux, /home/rohan/x): a path under /Users/rohan/x is under /home/rohan/x now, and the home folder /Users/rohan is /home/rohan. paths, processes and dev servers from before the move belong to the old machine: re-check paths and restart anything you need.",
	);
	expect(JSON.parse(t.session(id)!.moved_from!)).toEqual(r.moved);
	// two copied messages and the notice
	expect({ sessions: t.sessionCount(), messages: t.messageCount() }).toEqual({ sessions: before.sessions + 1, messages: before.messages + 3 });
	const lines = readFileSync(r.transcript!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	expect(lines[0]).toMatchObject({ type: "header", cwd: "/home/rohan/x" });
	expect(lines.filter((l) => l.message?.role === "notice")).toEqual([{ type: "message", message: { role: "notice", source: "moved", text: line, moved: r.moved, timestamp: 500 } }]);
	const rows = t.messages(id).rows;
	const last = rows.at(-1)!;
	expect(JSON.parse(last.info)).toMatchObject({ role: "user", notice: { source: "moved" }, moved: r.moved });
	expect(JSON.parse(last.parts[0]!.data)).toMatchObject({ type: "text", synthetic: true, notice: true, moved: r.moved, text: `moved: ${line}` });
	// a second import of the moved session onto the same place is no move
	t.close();
});

test("an export with no origin (from before 0.9.6) imports with no move", () => {
	const s = new Store(join(dir, "data-a", "cmx2.db"), { archivePath: null });
	const e = exportSession(s, "ses_move0001");
	s.close();
	delete e.origin;
	const data = join(dir, "data-c");
	const t = new Store(join(data, "cmx2.db"), { archivePath: null });
	const r = importSession(t, e, { dataDir: data, directory: "/home/rohan/x" });
	expect(r.moved).toBeUndefined();
	expect(t.session(r.id)!.moved_from).toBeNull();
	t.close();
});

test("migration 17 adds moved_from and keeps every session, message and part", () => {
	const path = join(dir, "migrate.db");
	const s = new Store(path, { archivePath: null });
	for (let i = 0; i < 10; i++) {
		s.putSession({ id: `ses_m${i}`, directory: "/w", title: "t", model: "anthropic/m", session_file: null, created_at: 1 });
		for (let n = 1; n <= 3; n++) projectMessage(s, { sessionId: `ses_m${i}`, cwd: "/w", seq: n * 2 }, { role: "user", content: `hi ${n}`, timestamp: n });
	}
	s.close();
	const raw = new Database(path);
	raw.exec("alter table session drop column moved_from");
	raw.exec("pragma user_version = 16");
	const count = (q: string) => (raw.query(`select count(*) as n from ${q}`).get() as { n: number }).n;
	const before = { sessions: count("session"), messages: count("message"), parts: count("part") };
	raw.close();
	expect(before).toEqual({ sessions: 10, messages: 30, parts: 30 });
	const m = new Store(path, { archivePath: null });
	expect(m.version).toBe(MIGRATIONS.length);
	expect({ sessions: m.sessionCount(), messages: m.messageCount(), parts: m.partCount() }).toEqual(before);
	expect(m.session("ses_m1")?.moved_from).toBeNull();
	m.close();
});
