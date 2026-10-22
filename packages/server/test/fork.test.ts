/**
 * fork lineage on the http contract: a fork says where it came from (`forkedFrom` on its session info), in the parent's
 * ids, on the fork answer, a get, the list, its session.created event and after a re-read from the db. a daemon in this
 * process (port 4952, shifted by CMX2_PORT_SHIFT); the parent's transcript is written to disk as a run would leave it, so
 * no model is called.
 *
 * run: bun test packages/server/test/fork.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { projectTranscript, Store } from "@cmx2/store";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-fork-"));
const WORK = join(SCRATCH, "work");
const CONFIG = join(SCRATCH, "config");
const DATA = join(SCRATCH, "data");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const PORT = port(4952);
const BASE = `http://127.0.0.1:${PORT}`;

let d: ReturnType<typeof serve>;
const PARENT = `ses_fork${nonce()}`.slice(0, 24);

beforeAll(() => {
	const c = { ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: "http://127.0.0.1:9", apiKey: "unused" } }, sources: [] };
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: DATA, checkEvents: true, reload: () => c });
	// a parent with three turns on disk, projected as the daemon projects a transcript it finds
	const file = join(DATA, "sessions", `${PARENT}.jsonl`);
	mkdirSync(join(DATA, "sessions"), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ type: "header", version: 1, id: PARENT, cwd: WORK, created: 1 })}\n`);
	for (let i = 1; i <= 3; i++) {
		appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: `question ${i}`, timestamp: i * 10 } })}\n`);
		appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: i * 10 + 1 } })}\n`);
	}
	d.store.putSession({ id: PARENT, directory: WORK, title: "fork-parent", model: "anthropic/claude-opus-5-5", session_file: file, created_at: Date.now() });
	projectTranscript(d.store, PARENT, file, WORK);
});
afterAll(async () => {
	try {
		expect(d.violations()).toBe(0);
	} finally {
		if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
		else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
		await d.stop();
		rmSync(SCRATCH, { recursive: true, force: true });
	}
});

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const messages = async (id: string) => ((await call("GET", `/session/${id}/message`)).json as Array<{ info: { id: string; role: string } }>).map((m) => m.info);
/** the session.created event the daemon logged for a session, as a listing client gets it */
const created = (id: string) =>
	(d.store.db.query("select properties from event_log where type = 'session.created'").all() as Array<{ properties: string }>).map((r) => JSON.parse(r.properties)).find((p) => p.info?.id === id);

let cutFork = "";
let cutAt = "";

test("a fork cut at a message names the parent and the parent's message, on the answer, a get, the list and session.created", async () => {
	const parent = await messages(PARENT);
	expect(parent.length).toBe(6);
	cutAt = parent[4]!.id; // the third question: the fork holds turns one and two
	const f = await call("POST", `/session/${PARENT}/fork`, { messageID: cutAt });
	expect(f.status).toBe(200);
	cutFork = f.json.id;
	expect(f.json.forkedFrom).toEqual({ sessionID: PARENT, messageID: cutAt });
	expect(f.json.parentID).toBeUndefined();
	expect((await call("GET", `/session/${cutFork}`)).json.forkedFrom).toEqual({ sessionID: PARENT, messageID: cutAt });
	const listed = ((await call("GET", "/session")).json as Array<{ id: string; forkedFrom?: unknown }>).find((s) => s.id === cutFork);
	expect(listed?.forkedFrom).toEqual({ sessionID: PARENT, messageID: cutAt });
	expect(created(cutFork)?.info.forkedFrom).toEqual({ sessionID: PARENT, messageID: cutAt });
	// the parent itself carries no lineage
	expect((await call("GET", `/session/${PARENT}`)).json.forkedFrom).toBeUndefined();
	// the fork's copies are its own rows under its own ids; the lineage id is the parent's
	const own = await messages(cutFork);
	expect(own.length).toBe(4);
	expect(own.map((m) => m.role)).toEqual(parent.slice(0, 4).map((m) => m.role));
	for (const m of own) expect(m.id.startsWith(`msg_${cutFork.slice(4)}_`)).toBe(true);
	expect(parent.some((m) => m.id === cutAt)).toBe(true);
	expect(own.some((m) => m.id === cutAt)).toBe(false);
});

test("a fork of the whole history names the parent without a message", async () => {
	const f = await call("POST", `/session/${PARENT}/fork`, {});
	expect(f.status).toBe(200);
	expect(f.json.forkedFrom).toEqual({ sessionID: PARENT });
	expect((await call("GET", `/session/${f.json.id}`)).json.forkedFrom).toEqual({ sessionID: PARENT });
	expect(created(f.json.id)?.info.forkedFrom).toEqual({ sessionID: PARENT });
	expect((await messages(f.json.id)).length).toBe(6);
});

test("a fork of a fork points at its direct parent, in that parent's ids", async () => {
	const mid = await messages(cutFork);
	const f = await call("POST", `/session/${cutFork}/fork`, { messageID: mid[2]!.id });
	expect(f.status).toBe(200);
	expect(f.json.forkedFrom).toEqual({ sessionID: cutFork, messageID: mid[2]!.id });
	expect((await messages(f.json.id)).length).toBe(2);
});

test("lineage survives a re-read from the db", async () => {
	const fresh = new Store(d.store.path, { archivePath: null });
	try {
		expect(fresh.session(cutFork)?.forked_from).toBe(PARENT);
		expect(fresh.session(cutFork)?.forked_at_message).toBe(cutAt);
		expect(fresh.session(PARENT)?.forked_from).toBeNull();
	} finally {
		fresh.close();
	}
});

test("a fork repeated with one clientID makes one session and answers the same id; without one, two calls make two", async () => {
	const count = () => (d.store.db.query("select count(*) as n from session where forked_from = ?").get(PARENT) as { n: number }).n;
	const before = count();
	const clientID = `fork-${nonce()}`;
	const a = await call("POST", `/session/${PARENT}/fork`, { clientID });
	const b = await call("POST", `/session/${PARENT}/fork`, { clientID });
	expect(a.status).toBe(200);
	expect(b.status).toBe(200);
	expect(b.json.id).toBe(a.json.id);
	expect(count()).toBe(before + 1);
	// two at once with a new id: the second waits for the first and answers it
	const id2 = `fork-${nonce()}`;
	const [c, e] = await Promise.all([call("POST", `/session/${PARENT}/fork`, { clientID: id2 }), call("POST", `/session/${PARENT}/fork`, { clientID: id2 })]);
	expect(e.json.id).toBe(c.json.id);
	expect(count()).toBe(before + 2);
	// the same id on another session is refused, as for prompts
	expect((await call("POST", `/session/${cutFork}/fork`, { clientID })).status).toBe(409);
	const x = await call("POST", `/session/${PARENT}/fork`, {});
	const y = await call("POST", `/session/${PARENT}/fork`, {});
	expect(x.json.id).not.toBe(y.json.id);
	expect(count()).toBe(before + 4);
});
