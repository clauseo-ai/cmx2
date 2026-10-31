import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportError, exportSession, exportStream, importSession, projectTranscript, type SessionExport, Store } from "../src/index.ts";

/**
 * imports that must leave nothing half done, exports that hold what was there when they began, and the checks on what a
 * bundle may say (its session id, its folder, its parent). each store and data dir is its own scratch folder
 */

const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-import-store-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** a store with one session of `count` turns on disk and projected; each answer is `size` characters */
function source(count = 2, size = 10, id = `ses_src${String(++n).padStart(4, "0")}aaaaaaaaaaaaa`) {
	const data = join(dir, `src-${n}`);
	mkdirSync(join(data, "sessions"), { recursive: true });
	const s = new Store(join(data, "cmx2.db"), { archivePath: null });
	const file = join(data, "sessions", `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "header", version: 1, id, cwd: dir, created: 1 })}\n`);
	for (let i = 1; i <= count; i++) {
		appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: `question ${i} about ${id}`, timestamp: i * 10 } })}\n`);
		appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `answer ${i} ${"x".repeat(size)}` }], provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: i * 10 + 1 } })}\n`);
	}
	s.putSession({ id, directory: dir, title: "a thread", model: "anthropic/m", session_file: file, created_at: 1 });
	projectTranscript(s, id, file, dir);
	return { s, id, file, data };
}

function target(name: string) {
	const data = join(dir, name);
	mkdirSync(data, { recursive: true });
	return { t: new Store(join(data, "cmx2.db"), { archivePath: null }), data };
}

const counts = (t: Store) => ({ sessions: t.sessionCount(), messages: t.messageCount(), parts: t.partCount() });

test("a failed import leaves nothing: no rows, no transcript, and a retry is not an id clash", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-atomic");
	// a sessions path the transcript cannot be written under
	writeFileSync(join(data, "sessions"), "not a folder");
	const before = counts(t);
	await expect(importSession(t, e, { dataDir: data })).rejects.toThrow();
	expect(counts(t)).toEqual(before);
	expect(t.session(id)).toBeUndefined();
	rmSync(join(data, "sessions"));
	// a message that cannot be stored: the rows roll back and the transcript written before them is removed
	const bad = structuredClone(e) as SessionExport;
	(bad.messages[1] as any).seq = null;
	await expect(importSession(t, bad, { dataDir: data })).rejects.toThrow(ExportError);
	expect(counts(t)).toEqual(before);
	expect(existsSync(join(data, "sessions", `${id}.jsonl`))).toBe(false);
	const r = await importSession(t, e, { dataDir: data });
	expect(r.id).toBe(id);
	expect(counts(t).messages).toBe(before.messages + e.messages.length);
	t.close();
});

test("an export holds what was there when it began: a turn appending mid-stream neither tears nor adds a line", async () => {
	const { s, id, file } = source();
	const want = readFileSync(file, "utf8");
	const it = exportStream(s, id);
	let out = (await it.next()).value as string;
	// a turn lands while the export streams: a whole line, a torn one, and a projected message
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "late", timestamp: 99 } })}\n{"type":"message","mess`);
	projectTranscript(s, id, file, dir);
	for await (const c of it) out += c;
	const e = JSON.parse(out) as SessionExport;
	expect(e.transcript).toBe(want);
	expect(e.messages).toHaveLength(4);
	// a transcript that was torn when the export began is cut back to its last whole line
	const torn = exportSession(s, id);
	expect(torn.transcript).toBe(`${want}${JSON.stringify({ type: "message", message: { role: "user", content: "late", timestamp: 99 } })}\n`);
	s.close();
});

test("export chunks stay near 1 MB however large the messages are", async () => {
	const { s, id } = source(120, 20_000);
	let biggest = 0;
	let joined = "";
	for await (const c of exportStream(s, id)) {
		biggest = Math.max(biggest, c.length);
		joined += c;
	}
	expect(JSON.parse(joined).messages).toHaveLength(240);
	expect(biggest).toBeLessThan(1024 * 1024 + 64 * 1024);
	s.close();
});

test("an import takes an absolute directory only, and stores its real path", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-dir");
	await expect(importSession(t, e, { dataDir: data, directory: "relative/folder" })).rejects.toThrow("not an absolute path");
	const real = join(dir, "real-folder");
	mkdirSync(real);
	const link = join(dir, "link-folder");
	symlinkSync(real, link);
	const r = await importSession(t, e, { dataDir: data, directory: link });
	expect(r.directory).toBe(real);
	expect(t.session(id)!.directory).toBe(real);
	expect(JSON.parse(readFileSync(r.transcript!, "utf8").split("\n")[0]!).cwd).toBe(real);
	t.close();
});

test("a short session id is refused; a copy renames id fields only, never the text", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-ids");
	await expect(importSession(t, { ...e, session: { ...e.session, id: "ses_a" } }, { dataDir: data })).rejects.toThrow("is not a cmx2 session id");
	await importSession(t, e, { dataDir: data });
	const r = await importSession(t, e, { dataDir: data, asNew: true });
	expect(r.id).not.toBe(id);
	const rows = t.messages(r.id).rows;
	expect(rows.every((m) => m.id.includes(r.id.slice(4)) && m.session_id === r.id)).toBe(true);
	const parts = rows.flatMap((m) => m.parts.map((p) => JSON.parse(p.data)));
	expect(parts.every((p) => p.sessionID === r.id && p.messageID.includes(r.id.slice(4)) && p.id.includes(r.id.slice(4)))).toBe(true);
	// the person's words that name the old id keep it, in the rows and in the transcript
	expect(parts.find((p) => p.text?.startsWith("question 1"))!.text).toBe(`question 1 about ${id}`);
	const lines = readFileSync(r.transcript!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	expect(lines[0].id).toBe(r.id);
	expect(lines[1].message.content).toBe(`question 1 about ${id}`);
	t.close();
});

test("a subagent whose parent is not here imports as a session of its own", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-parent");
	const r = await importSession(t, { ...e, session: { ...e.session, parent_id: "ses_notherebbbbbbbbbbbbb" } }, { dataDir: data });
	expect(t.session(r.id)!.parent_id).toBeNull();
	// a parent that is here stays
	t.putSession({ id: "ses_parenthereccccccccc", directory: dir, title: "p", model: "anthropic/m", session_file: null, created_at: 1 });
	const c = await importSession(t, { ...e, session: { ...e.session, parent_id: "ses_parenthereccccccccc" } }, { dataDir: data, asNew: true });
	expect(t.session(c.id)!.parent_id).toBe("ses_parenthereccccccccc");
	expect(readdirSync(join(data, "import"))).toEqual([]);
	t.close();
});

test("an orphan from an interrupted import (a transcript, staged rows, no session row) is replaced, not an id clash", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-orphan");
	mkdirSync(join(data, "sessions"), { recursive: true });
	writeFileSync(join(data, "sessions", `${id}.jsonl`), "left by a crash\n");
	t.db.query("insert into message (id, session_id, seq, role, created_at, info) values (?, ?, 1, 'user', 1, '{}')").run(e.messages[0]!.id, id);
	const r = await importSession(t, e, { dataDir: data });
	expect(r.id).toBe(id);
	expect(readFileSync(r.transcript!, "utf8")).not.toContain("left by a crash");
	expect(t.messages(id).rows).toHaveLength(e.messages.length);
	t.close();
});

test("the bundle's own folder is checked like a given one: absolute, and stored as its real path", async () => {
	const { s, id } = source();
	const e = exportSession(s, id);
	s.close();
	const { t, data } = target("dst-own-folder");
	await expect(importSession(t, { ...e, session: { ...e.session, directory: "work" } }, { dataDir: data })).rejects.toThrow("not an absolute path");
	const link = join(dir, "own-link");
	symlinkSync(dir, link);
	const r = await importSession(t, { ...e, session: { ...e.session, directory: link } }, { dataDir: data });
	expect(t.session(r.id)!.directory).toBe(dir);
	t.close();
});
