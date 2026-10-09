import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCursor, encodeCursor, MIGRATIONS, messageId, projectMessage, Store } from "../src/index.ts";

const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), "cmx2-store-")), "cmx2.db"));

test("a fresh database runs every migration", () => {
	const s = fresh();
	expect(s.version).toBe(MIGRATIONS.length);
	const tables = (s.db.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
	for (const t of ["session", "step", "prefix", "message", "part", "permission", "question", "permission_rule", "import_run"]) expect(tables).toContain(t);
});

test("an m1 database (schema version 3) upgrades in place and keeps its rows", () => {
	const path = join(mkdtempSync(join(tmpdir(), "cmx2-store-")), "cmx2.db");
	const old = new Database(path, { create: true });
	for (let i = 0; i < 3; i++) old.exec(MIGRATIONS[i]!);
	old.exec("pragma user_version = 3");
	old.query("insert into session (id, directory, title, model, session_file, created_at) values ('ses_old', '/tmp', 'old', 'anthropic/x', null, 123)").run();
	old.close();
	const s = new Store(path);
	expect(s.version).toBe(MIGRATIONS.length);
	const r = s.session("ses_old")!;
	expect(r.updated_at).toBe(123);
	expect(r.source).toBe("cmx2");
});

test("processes opening one fresh database at once migrate it exactly once", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "cmx2-store-")), "cmx2.db");
	const code = `import { Store } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))}; const s = new Store(${JSON.stringify(path)}); console.log(s.version); s.close();`;
	const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" }));
	const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text() })));
	for (const r of results) {
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toBe(String(MIGRATIONS.length));
	}
});

function seed(s: Store, n: number) {
	for (let i = 0; i < n; i++) {
		// two sessions per timestamp, so keyset paging has ties to break by id
		const t = 1000 + Math.floor(i / 2);
		s.putSession({ id: `ses_${String(i).padStart(3, "0")}`, directory: i % 3 ? "/a" : "/b", title: `t${i}`, model: "anthropic/m", session_file: null, created_at: t, updated_at: 5000 - i, parent_id: i % 5 === 4 ? "ses_000" : null });
	}
}

test("listing by updated time pages with before and filters roots and directory", () => {
	const s = fresh();
	seed(s, 12);
	const p1 = s.sessionsByUpdated({ limit: 5 });
	expect(p1.map((r) => r.id)).toEqual(["ses_000", "ses_001", "ses_002", "ses_003", "ses_004"]);
	const p2 = s.sessionsByUpdated({ limit: 5, before: p1.at(-1)!.updated_at! });
	expect(p2[0]!.id).toBe("ses_005");
	expect(s.sessionsByUpdated({ limit: 100, roots: true }).some((r) => r.parent_id)).toBe(false);
	expect(s.sessionsByUpdated({ limit: 100, directory: "/b" }).every((r) => r.directory === "/b")).toBe(true);
});

test("listing by created time walks every row exactly once in both orders and back", () => {
	const s = fresh();
	seed(s, 11);
	for (const order of ["asc", "desc"] as const) {
		const seen: string[] = [];
		let after: { time: number; id: string } | undefined;
		for (;;) {
			const page = s.sessionsByCreated({ limit: 3, order, after, direction: "next" });
			if (!page.length) break;
			seen.push(...page.map((r) => r.id));
			after = { time: page.at(-1)!.created_at, id: page.at(-1)!.id };
		}
		expect(seen.length).toBe(11);
		expect(new Set(seen).size).toBe(11);
		// previous from the last page's first item returns the page before it, in the same order
		const all = s.sessionsByCreated({ limit: 100, order });
		const pivot = all[6]!;
		const prev = s.sessionsByCreated({ limit: 3, order, after: { time: pivot.created_at, id: pivot.id }, direction: "previous" });
		expect(prev.map((r) => r.id)).toEqual(all.slice(3, 6).map((r) => r.id));
	}
});

test("cursors round-trip and reject what this daemon did not issue", () => {
	const c = { id: "ses_1", time: 5, order: "desc" as const, direction: "next" as const, roots: true };
	expect(decodeCursor(encodeCursor(c))).toEqual(c);
	expect(decodeCursor("garbage")).toBeUndefined();
	expect(decodeCursor(Buffer.from(JSON.stringify({ id: 1 })).toString("base64url"))).toBeUndefined();
});

test("the projection turns a transcript into opencode-shaped messages and lands tool results on their calls", () => {
	const s = fresh();
	const sid = "ses_proj";
	s.putSession({ id: sid, directory: "/w", title: "p", model: "anthropic/m", session_file: null, created_at: 1 });
	const ctx = (seq: number) => ({ sessionId: sid, cwd: "/w", seq, completedAt: 99 });
	expect(projectMessage(s, ctx(1), { role: "system", content: "prefix", timestamp: 1 })).toEqual({ parts: [] });
	projectMessage(s, ctx(2), { role: "user", content: "hello", timestamp: 2 });
	const turn = projectMessage(s, ctx(3), { role: "system", content: "turn context: date: 2026-09-30", timestamp: 2 });
	expect(turn.parts.length).toBe(1);
	projectMessage(s, ctx(4), {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hm" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
		],
		provider: "anthropic",
		model: "claude-opus-5-5",
		providerThinkingLevel: "medium",
		usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, cost: { total: 0.01 } },
		stopReason: "toolUse",
		timestamp: 3,
	});
	const touched = projectMessage(s, ctx(5), { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 4 });
	expect(touched.parts.length).toBe(1);
	const page = s.messages(sid);
	expect(page.rows.map((r) => r.role)).toEqual(["user", "assistant"]);
	const user = page.rows[0]!;
	expect(user.parts.map((p) => JSON.parse(p.data).synthetic ?? false)).toEqual([false, true]);
	const asst = JSON.parse(page.rows[1]!.info);
	expect(asst).toMatchObject({ id: messageId(sid, 4), role: "assistant", parentID: user.id, finish: "tool-calls", variant: "medium", tokens: { input: 10, cache: { read: 90 } } });
	const tool = JSON.parse(page.rows[1]!.parts[1]!.data);
	expect(tool).toMatchObject({ type: "tool", callID: "call_1", tool: "read", state: { status: "completed", output: "file body" } });
	// totals roll up once, even when the same line is projected again
	projectMessage(s, ctx(4), { role: "assistant", content: [], provider: "anthropic", model: "m", usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: "toolUse", timestamp: 3 });
	expect(s.session(sid)!.cost).toBeCloseTo(0.01);
	expect(s.session(sid)!.tokens_cache_read).toBe(90);
});

test("a streamed part's start and end ride its final part, by content position; a transcript without them projects none", () => {
	const s = fresh();
	const sid = "ses_times";
	s.putSession({ id: sid, directory: "/w", title: "t", model: "anthropic/m", session_file: null, created_at: 1 });
	const base = { role: "assistant", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: 3 };
	projectMessage(s, { sessionId: sid, cwd: "/w", seq: 2, completedAt: 99 }, { ...base, content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "four" }], partTimes: { 0: { start: 10, end: 20 }, 1: { start: 20, end: 30 } } });
	projectMessage(s, { sessionId: sid, cwd: "/w", seq: 3, completedAt: 99 }, { ...base, content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "four" }] });
	const [streamed, plain] = s.messages(sid).rows.map((r) => r.parts.map((p) => JSON.parse(p.data)));
	expect(streamed!.map((p) => [p.type, p.text, p.time])).toEqual([["reasoning", "hm", { start: 10, end: 20 }], ["text", "four", { start: 20, end: 30 }]]);
	expect(streamed!.every((p) => p.streaming === undefined)).toBe(true);
	expect(plain!.map((p) => [p.type, p.time])).toEqual([["reasoning", undefined], ["text", undefined]]);
});

test("message pages come newest-last with a cursor to the older page", () => {
	const s = fresh();
	const sid = "ses_page";
	s.putSession({ id: sid, directory: "/w", title: "p", model: "anthropic/m", session_file: null, created_at: 1 });
	for (let seq = 2; seq <= 11; seq++) projectMessage(s, { sessionId: sid, cwd: "/w", seq }, { role: "user", content: `m${seq}`, timestamp: seq });
	const newest = s.messages(sid, { limit: 4 });
	expect(newest.rows.map((r) => r.seq)).toEqual([8, 9, 10, 11]);
	const older = s.messages(sid, { limit: 4, before: newest.next! });
	expect(older.rows.map((r) => r.seq)).toEqual([4, 5, 6, 7]);
	const oldest = s.messages(sid, { limit: 4, before: older.next! });
	expect(oldest.rows.map((r) => r.seq)).toEqual([2, 3]);
	expect(oldest.next).toBeNull();
});

test("asks left open by a dead process expire at startup", () => {
	const s = fresh();
	s.putPermission({ id: "per_1", session_id: "ses_x", directory: "/w", permission: "shell", patterns: ["ls"], metadata: {}, always: ["ls *"], tool: null, created_at: 1 });
	s.putQuestion({ id: "que_1", session_id: "ses_x", directory: "/w", questions: [], tool: null, created_at: 1 });
	expect(s.pendingPermissions().length).toBe(1);
	expect(s.expireOrphanedAsks()).toEqual({ permissions: 1, questions: 1 });
	expect(s.pendingPermissions()).toEqual([]);
	expect(s.pendingQuestions()).toEqual([]);
	expect(s.replyPermission("per_1", "once")).toBe(false);
});
