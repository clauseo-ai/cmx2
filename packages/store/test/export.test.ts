/**
 * session export and import, through real daemons: a real turn on one daemon (port 4834, shifted by CMX2_PORT_SHIFT),
 * its export imported into a second daemon's store (port 4835), where the session lists, reads the same
 * messages and continues with one more real turn that remembers the first. counts of sessions and
 * messages are printed before and after every write (rule 15). markdown carries both sides' words.
 *
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it both tests are skipped. the live profile is the
 * config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else ANTHROPIC_API_KEY from the env.
 * run: CMX2_LIVE_TESTS=1 bun test packages/store/test/export.test.ts (about ten seconds; two short sonnet turns)
 */
import { liveNote, liveProfile, liveTest, port } from "../../eval/src/harness.ts";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../engine/src/config.ts";
import { serve } from "../../server/src/index.ts";
import { exportSession, importSession, readExport, sessionMarkdown, Store } from "../src/index.ts";

const N = Date.now().toString(36);
const SCRATCH = realpathSync((mkdirSync(`/tmp/cmx2-export-${N}/proj`, { recursive: true }), `/tmp/cmx2-export-${N}`));
const PROJ = join(SCRATCH, "proj");
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
const daemons: Array<ReturnType<typeof serve>> = [];
liveNote("export.test.ts (real model turns)");

afterAll(async () => {
	for (const d of daemons) await d.stop();
	// made at load, so a run that skips the live tests leaves it too
	rmSync(SCRATCH, { recursive: true, force: true });
});

async function send(base: string, id: string, text: string) {
	const r = await fetch(`${base}/session/${id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text }], model: MODEL, effort: "low" }) });
	expect(r.status).toBe(200);
	const m = (await r.json()) as { info: { error?: unknown }; parts: Array<{ type: string; text?: string }> };
	expect(m.info.error).toBeUndefined();
	return m.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
}

const counts = (s: Store) => ({ sessions: s.sessionCount(), messages: s.messageCount() });

liveTest("a session exported from one daemon lists, reads and continues on another", async () => {
	writeFileSync(join(PROJ, "note.txt"), `the codeword is kestrel-${N}\n`);
	liveProfile(join(SCRATCH, "config"));
	const config = loadConfig({ env: { ...process.env, CMX2_CONFIG_DIR: join(SCRATCH, "config") } });
	const a = serve({ config, port: port(4834), hostname: "127.0.0.1", dataDir: join(SCRATCH, "a"), checkEvents: true });
	daemons.push(a);
	const baseA = `http://127.0.0.1:${a.server.port}`;
	const created = (await (await fetch(`${baseA}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: PROJ, title: `export-${N}`, model: "anthropic/claude-sonnet-5-5" }) })).json()) as { id: string };
	const first = await send(baseA, created.id, "read note.txt and answer with the codeword only");
	console.log(`daemon a answered: ${first}`);
	expect(first).toContain(`kestrel-${N}`);
	await a.stop();
	daemons.pop();

	// export from a's store (read-only use), as `cmx2 session export` does
	const storeA = new Store(join(SCRATCH, "a", "cmx2.db"));
	const e = exportSession(storeA, created.id, { cmx2: "test" });
	const file = join(SCRATCH, "session.json");
	writeFileSync(file, JSON.stringify(e, null, 1));
	console.log(`exported ${e.messages.length} messages, ${e.messages.reduce((n, m) => n + m.parts.length, 0)} parts, ${e.steps.length} steps, transcript ${e.transcript?.split("\n").filter(Boolean).length} lines`);
	const md = sessionMarkdown(e);
	expect(md).toContain("read note.txt and answer with the codeword only");
	expect(md).toContain(`kestrel-${N}`);
	storeA.close();

	// import into b's store before b starts, then again with b running
	const dataB = join(SCRATCH, "b");
	const storeB = new Store(join(dataB, "cmx2.db"));
	const before = counts(storeB);
	const r = await importSession(storeB, readExport(await Bun.file(file).text()), { dataDir: dataB });
	const after = counts(storeB);
	console.log(`import into b: sessions ${before.sessions} -> ${after.sessions}, messages ${before.messages} -> ${after.messages}`);
	expect(r.id).toBe(created.id);
	expect(after).toEqual({ sessions: before.sessions + 1, messages: before.messages + e.messages.length });
	expect(existsSync(join(dataB, "sessions", `${created.id}.jsonl`))).toBe(true);
	// a second import of the same file changes nothing (and deletes nothing)
	await expect(importSession(storeB, readExport(JSON.stringify(e)), { dataDir: dataB })).rejects.toThrow(/already in this database; nothing was changed/);
	expect(counts(storeB)).toEqual(after);
	storeB.close();

	const b = serve({ config, port: port(4835), hostname: "127.0.0.1", dataDir: dataB, checkEvents: true });
	daemons.push(b);
	const baseB = `http://127.0.0.1:${b.server.port}`;
	const list = (await (await fetch(`${baseB}/session`)).json()) as Array<{ id: string; title: string }>;
	expect(list.find((s) => s.id === created.id)?.title).toBe(e.session.title);
	const msgsB = (await (await fetch(`${baseB}/session/${created.id}/message`)).json()) as Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string; synthetic?: boolean }> }>;
	const shape = (ms: Array<{ id: string; role: string; texts: string[] }>) => ms.map((m) => `${m.id} ${m.role} ${m.texts.join("|")}`);
	const fromExport = e.messages.map((m) => ({ id: m.id, role: m.role, texts: m.parts.filter((p) => p.data.type === "text" && !p.data.synthetic).map((p) => String(p.data.text)) }));
	const fromB = msgsB.map((m) => ({ id: m.info.id, role: m.info.role, texts: m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => String(p.text)) }));
	console.log(`b lists ${list.length} session(s); its messages:\n  ${shape(fromB).join("\n  ")}`);
	expect(shape(fromB)).toEqual(shape(fromExport));

	// no tool this time: the answer can only come from the history the import carried
	const second = await send(baseB, created.id, "without reading any file: which codeword did you give me? repeat it exactly, nothing else");
	console.log(`daemon b continued: ${second}`);
	expect(second).toContain(`kestrel-${N}`);
	const final = new Store(join(dataB, "cmx2.db"));
	console.log(`b after the turn: sessions ${final.sessionCount()}, messages ${final.messageCount()}`);
	expect(final.messageCount()).toBeGreaterThan(after.messages);
	expect(final.sessionCount()).toBe(after.sessions);
	final.close();
}, 180_000);

liveTest("as-new imports a copy under a fresh id with every id moved, and leaves the original alone", async () => {
	const src = new Store(join(SCRATCH, "a", "cmx2.db"));
	const [row] = src.sessionsByUpdated({ limit: 1 });
	const e = exportSession(src, row!.id);
	src.close();
	const dataC = join(SCRATCH, "c");
	const c = new Store(join(dataC, "cmx2.db"));
	await importSession(c, e, { dataDir: dataC });
	const copy = await importSession(c, e, { dataDir: dataC, asNew: true, directory: PROJ });
	expect(copy.id).not.toBe(e.session.id);
	const bare = e.session.id.replace(/^ses_/, "");
	const leaked = c.db.query("select count(*) as n from message where session_id = ? and (id like ? or info like ?)").get(copy.id, `%${bare}%`, `%${bare}%`) as { n: number };
	expect(leaked.n).toBe(0);
	expect(c.messageCount(copy.id)).toBe(e.messages.length);
	expect(c.messageCount(e.session.id)).toBe(e.messages.length);
	const head = JSON.parse((await Bun.file(copy.transcript!).text()).split("\n")[0]!);
	expect([head.id, head.cwd]).toEqual([copy.id, PROJ]);
	console.log(`copy ${copy.id} of ${e.session.id}: ${copy.messages} messages, sessions now ${c.sessionCount()}`);
	c.close();
});
