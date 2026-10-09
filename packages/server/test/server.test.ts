import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cmx2Error, createClient } from "@cmx2/client";
import { DEFAULTS } from "@cmx2/engine/config";
import { importCmx } from "@cmx2/store";
import { serve } from "../src/index.ts";

/**
 * routes through the generated client, in process (the daemon's handler as fetch, no socket). no
 * model is called here: turns are driven against a real daemon and the real provider in the m2 eval.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-server-")));
const work = join(root, "work");
mkdirSync(work);
const config = { ...structuredClone(DEFAULTS), sources: [] };
const daemon = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(root, "data"), password: "pw", checkEvents: true, reload: () => config });
const client = createClient({ baseUrl: "http://in-process", password: "pw", fetch: daemon.handle });
afterAll(() => daemon.stop());

async function error(p: Promise<unknown>): Promise<Cmx2Error> {
	try {
		await p;
	} catch (e) {
		if (e instanceof Cmx2Error) return e;
		throw e;
	}
	throw new Error("expected an error");
}

test("auth: no password is a typed 401, the cmx user name is accepted during cutover", async () => {
	const anon = createClient({ baseUrl: "http://in-process", fetch: daemon.handle });
	const e = await error(anon.health());
	expect(e.status).toBe(401);
	expect(e.name).toBe("UnauthorizedError");
	const legacy = createClient({ baseUrl: "http://in-process", password: "pw", user: "opencode", fetch: daemon.handle });
	expect((await legacy.health()).data).toMatchObject({ healthy: true, name: "cmx2" });
});

test("bodies are checked against the manifest: typed 400s that say what to send", async () => {
	const e = await error(client.createSession({ effort: "huge" as never, directory: work }));
	expect(e.status).toBe(400);
	expect(e.message).toBe("effort must be one of low, medium, high, xhigh, max. see openapi.json for createSession");
	const missing = await error(client.createSession({ directory: join(root, "nope") }));
	expect(missing.message).toContain("does not exist");
	const route = await error(client.getSession({ sessionID: "ses_missing" }));
	expect(route.status).toBe(404);
});

test("sessions: create with either routing header, list with a cursor, rename, delete", async () => {
	const a = (await client.createSession({ title: "it-a" }, { directory: work })).data;
	expect(a).toMatchObject({ directory: work, projectID: work, source: "cmx2", title: "it-a" });
	const legacy = await daemon.handle(
		new Request("http://in-process/session", { method: "POST", headers: { authorization: `Basic ${btoa("cmx2:pw")}`, "x-opencode-directory": work }, body: JSON.stringify({ title: "it-b" }) }),
	);
	expect(legacy.status).toBe(201);
	const b = (await legacy.json()) as { id: string; directory: string };
	expect(b.directory).toBe(work);

	const page1 = await client.listSessions({ limit: "1", scope: "project", roots: "true" }, { directory: work });
	expect(page1.data.length).toBe(1);
	expect(page1.next).toBeDefined();
	const page2 = await client.listSessions({ limit: "1", before: page1.next }, { directory: work });
	expect(page2.data.length).toBe(1);
	expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);

	const v2 = await client.pageSessions({ limit: "1", order: "asc" }, { directory: work });
	expect(v2.data.items[0]!.id).toBe(a.id);
	const v2next = await client.pageSessions({ cursor: v2.data.cursor.next!, limit: "1" });
	expect(v2next.data.items[0]!.id).toBe(b.id);
	const end = await client.pageSessions({ cursor: v2next.data.cursor.next!, limit: "1" });
	expect(end.data.items).toEqual([]);
	const mixed = await error(client.pageSessions({ cursor: v2.data.cursor.next!, search: "x" }));
	expect(mixed.message).toContain("a cursor carries its own filters");

	expect((await client.updateSession({ sessionID: a.id }, { title: "renamed" })).data.title).toBe("renamed");
	expect((await client.deleteSession({ sessionID: b.id })).data).toBe(true);
	// archived, not deleted (rule 15): still readable, gone from the list
	expect((await client.getSession({ sessionID: b.id })).data.time.archived).toBeGreaterThan(0);
	expect((await client.listSessions({ limit: "10" }, { directory: work })).data.map((s) => s.id)).not.toContain(b.id);
	expect((await client.sessionStatus()).data).toEqual({});
});

test("imported cmx history lists and reads, and refuses to run", async () => {
	const src = join(root, "opencode.db");
	const { Database } = await import("bun:sqlite");
	const db = new Database(src, { create: true });
	db.exec(`create table project (id text primary key, worktree text not null);
		create table session (id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, share_url text,
		  summary_additions integer, summary_deletions integer, summary_files integer, time_created integer, time_updated integer, model text, cost real,
		  tokens_input integer, tokens_output integer, tokens_cache_read integer, tokens_cache_write integer, agent text);
		create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
		create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
		insert into project values ('p', '${work}');
		insert into session values ('ses_cmxold', 'p', null, 's', '${work}', 'old cmx work', '1', null, null, null, null, 1, 2, null, 0, 0, 0, 0, 0, 'build');
		insert into message values ('msg_a', 'ses_cmxold', 1, 1, '{"role":"user","time":{"created":1}}');
		insert into part values ('prt_a', 'msg_a', 'ses_cmxold', 1, 1, '{"type":"text","text":"hello from cmx"}');`);
	db.close();
	importCmx(daemon.store, { from: src, since: 0 });
	const msgs = (await client.messages({ sessionID: "ses_cmxold" })).data;
	expect(msgs[0]!.parts[0]).toMatchObject({ type: "text", text: "hello from cmx" });
	const e = await error(client.prompt({ sessionID: "ses_cmxold" }, { text: "go on" }));
	expect(e.status).toBe(409);
	expect(e.name).toBe("ConflictError");
});

test("replies to unknown asks are a typed 404 (cmx answered true)", async () => {
	expect((await error(client.replyPermission({ requestID: "per_gone" }, { reply: "once" }))).status).toBe(404);
	expect((await error(client.replyQuestion({ requestID: "que_gone" }, { answers: [["a"]] }))).status).toBe(404);
	const e = await error(client.rejectQuestion({ requestID: "que_gone" }, {}));
	expect([e.status, e.name]).toEqual([404, "NotFoundError"]);
	expect((await client.permissions()).data).toEqual([]);
	expect((await client.questions()).data).toEqual([]);
});

test("global: fs browse, reload, health, projects", async () => {
	mkdirSync(join(root, ".hidden"), { recursive: true });
	writeFileSync(join(root, "file.txt"), "x");
	const fs = (await client.browse({ path: root })).data;
	expect(fs.entries.map((e) => e.name)).toEqual(["data", "work"]);
	expect(fs.parent).toBe(join(root, ".."));
	expect((await client.browse({ path: root, hidden: "true" })).data.entries.map((e) => e.name)[0]).toBe("data");
	expect((await error(client.browse({ path: "rel" }))).message).toContain("must be absolute");
	expect((await error(client.browse({ path: join(root, "file.txt") }))).message).toContain("not a directory");
	expect((await client.reload()).data).toMatchObject({ changed: [] });
	expect((await client.projects()).data.map((p) => p.worktree)).toContain(work);
	expect(daemon.violations()).toBe(0);
});

test("reload flushes skills, agents and commands: a file added on disk lists after /global/reload, not before", async () => {
	const dir = join(root, "reload");
	mkdirSync(join(dir, ".cmx2", "skills", "first"), { recursive: true });
	writeFileSync(join(dir, ".cmx2", "skills", "first", "SKILL.md"), "---\nname: first\ndescription: the first skill\n---\ndo the first thing\n");
	const names = async () => (await client.commands({ directory: dir })).data.map((c) => c.name);
	const agents = async () => (await client.agents({ directory: dir })).data.map((a) => a.name);
	expect(await names()).toContain("first");
	expect(await agents()).toEqual(["build"]);
	mkdirSync(join(dir, ".cmx2", "skills", "second"), { recursive: true });
	writeFileSync(join(dir, ".cmx2", "skills", "second", "SKILL.md"), "---\nname: second\ndescription: the second skill\n---\ndo the second thing\n");
	mkdirSync(join(dir, ".cmx2", "agent"), { recursive: true });
	writeFileSync(join(dir, ".cmx2", "agent", "reviewer.md"), "---\ndescription: reviews\nmode: subagent\n---\nreview.\n");
	expect(await names()).not.toContain("second");
	expect(await agents()).toEqual(["build"]);
	const r = (await client.reload()).data;
	console.log(`reload: ${JSON.stringify(r)}`);
	expect(r.flushed).toEqual(expect.arrayContaining(["skills", "agents"]));
	expect(await names()).toEqual(expect.arrayContaining(["first", "second"]));
	expect(await agents()).toEqual(["build", "reviewer"]);
});

test("steps: per-step telemetry for the stats card (calls, tokens, cache-read, effort, duration), in step order", async () => {
	const s = (await client.createSession({ title: "it-steps" }, { directory: work })).data;
	const row = (seq: number, extra: Record<string, unknown> = {}) => ({
		session_id: s.id,
		seq,
		at: 1_000 + seq,
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		input: 120,
		cache_read: 9_000,
		cache_write: 300,
		output: 40 * seq,
		cache_read_pct: 95.5,
		ttft_ms: 800,
		duration_ms: 2_000 + seq,
		tool_calls: seq,
		nested_calls: 0,
		calls: seq,
		tool_names: "read",
		tool_ms: 15,
		cost: 0.002,
		stop_reason: seq === 2 ? "stop" : "toolUse",
		refusal: null,
		prefix_hash: "abc",
		prefix_same: 1,
		steered: 0,
		dropped_blocks: 0,
		poll_only: 0,
		escalation: null,
		warm: 0,
		continued: 0,
		...extra,
	});
	daemon.store.putStep(row(2));
	daemon.store.putStep(row(1, { escalation: "low→medium: the same read error twice" }));
	const auth = { authorization: `Basic ${btoa("cmx2:pw")}` };
	const res = await daemon.handle(new Request(`http://in-process/session/${s.id}/steps`, { headers: auth }));
	expect(res.status).toBe(200);
	const steps = (await res.json()) as Array<Record<string, unknown>>;
	expect(steps.map((x) => x.seq)).toEqual([1, 2]);
	expect(steps[0]).toMatchObject({ calls: 1, input: 120, output: 40, cache_read: 9_000, cache_read_pct: 95.5, effort: "low", duration_ms: 2_001, escalation: "low→medium: the same read error twice", continued: 0 });
	expect(steps[1]).toMatchObject({ calls: 2, stop_reason: "stop" });
	const missing = await daemon.handle(new Request("http://in-process/session/ses_nope/steps", { headers: auth }));
	expect(missing.status).toBe(404);
});

test("titles: only an unnamed session's title is replaced, and a rename that lands first wins", () => {
	const at = Date.now();
	daemon.store.putSession({ id: "ses_titlecas", directory: work, title: `new session ${new Date(at).toISOString()}`, model: "anthropic/claude-sonnet-5-5", session_file: null, created_at: at });
	const before = daemon.store.session("ses_titlecas")!.title;
	expect(daemon.store.setSessionTitle("ses_titlecas", "it-renamed")).toBe(true);
	// the generator started from the default title; the rename moved it, so the generated one is dropped
	expect(daemon.store.setGeneratedTitle("ses_titlecas", "a generated title", before)).toBe(false);
	expect(daemon.store.session("ses_titlecas")!.title).toBe("it-renamed");
	expect(daemon.store.setGeneratedTitle("ses_titlecas", "a generated title", "it-renamed")).toBe(true);
});
