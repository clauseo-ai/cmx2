/**
 * a2 with git off the loop: a read stamped with x-cmx2-seq holds every event at or below the stamp, even
 * when the read waited for a slow git. git here is a stand-in that sleeps for one repository; a session in
 * another repository is renamed while the list waits. a git that hangs is stopped and reads as unknown.
 *
 * run: bun test packages/server/test/stamp.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const ROOT = realpathSync(mkdtempSync("/tmp/cmx2-stamp-"));
const FAST = join(ROOT, "fastrepo");
const SLOW = join(ROOT, "slowrepo");
const HUNG = join(ROOT, "hungrepo");
const SHIM = join(ROOT, "bin");
const realGit = Bun.which("git")!;
mkdirSync(SHIM, { recursive: true });
// the stand-in: git status in the slow repository takes 1.5 s, in the hung one 60 s; everything else is git
writeFileSync(join(SHIM, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in "${SLOW}") sleep 1.5;; "${HUNG}") sleep 60;; esac; done\nexec "${realGit}" "$@"\n`);
chmodSync(join(SHIM, "git"), 0o755);
for (const d of [FAST, SLOW, HUNG]) {
	mkdirSync(d, { recursive: true });
	Bun.spawnSync([realGit, "init", "-q", "-b", "trunk", d]);
}
const CONFIG = join(ROOT, "config");
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
const PATH_BEFORE = process.env.PATH;
const PORT = port(4895);
const BASE = `http://127.0.0.1:${PORT}`;
let d: ReturnType<typeof serve>;

beforeAll(() => {
	process.env.CMX2_CONFIG_DIR = CONFIG;
	process.env.PATH = `${SHIM}:${PATH_BEFORE}`;
	const c = { ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: "http://127.0.0.1:9", apiKey: "unused" } }, sources: [] };
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c, vcs: { freshMs: 400, timeoutMs: 3_000, unknownMs: 2_000 } });
});
afterAll(async () => {
	if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
	process.env.PATH = PATH_BEFORE;
	await d.stop();
	rmSync(ROOT, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown, dir = FAST) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(dir ? { "x-cmx2-directory": dir } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: r.status, json: (await r.json()) as any, seq: r.headers.get("x-cmx2-seq") };
};
const seqOf = (s: string) => Number(s.split(":").at(-1));

/** logged frames on the global stream: seq and payload */
function tap() {
	const frames: Array<{ seq: number; type: string; properties: any }> = [];
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${BASE}/global/event`, { signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const id = block.match(/^id: (.+)$/m)?.[1];
					const data = block.match(/^data: (.+)$/m)?.[1];
					if (!id || !data) continue;
					const e = JSON.parse(data);
					const ev = e.payload ?? e;
					frames.push({ seq: seqOf(id), type: ev.type, properties: ev.properties });
				}
			}
		} catch {}
	})();
	return { frames, stop: () => ctl.abort() };
}

test("a list that waited for a slow git holds every event at or below its stamp", async () => {
	const slow = await call("POST", "/session", { directory: SLOW, title: `slow-${nonce()}` }, SLOW);
	const fast = await call("POST", "/session", { directory: FAST, title: `orig-${nonce()}` });
	expect(slow.status).toBe(201);
	expect(fast.status).toBe(201);
	const t = tap();
	await Bun.sleep(500); // both statuses go stale
	const list = call("GET", "/session?limit=50", undefined, "");
	await Bun.sleep(300);
	const renamed = `renamed-${nonce()}`;
	expect((await call("PATCH", `/session/${fast.json.id}`, { title: renamed })).status).toBe(200);
	const answer = await list;
	await Bun.sleep(300);
	t.stop();
	const ev = t.frames.find((f) => f.type === "session.updated" && f.properties.sessionID === fast.json.id && f.properties.info.title === renamed);
	expect(ev).toBeDefined();
	const row = answer.json.find((s: any) => s.id === fast.json.id);
	// the boxbox rule: an event at or below the read's seq is dropped, so its change must be in the body
	if (ev!.seq <= seqOf(answer.seq!)) expect(row.title).toBe(renamed);
	// and the slow repository's status is there, loaded off the loop
	expect(answer.json.find((s: any) => s.id === slow.json.id).vcs).toEqual({ branch: "trunk", dirty: false });
});

test("a git that hangs is stopped: the list answers, the row has no branch, and the session's events still go out", async () => {
	const hung = await call("POST", "/session", { directory: HUNG, title: `hung-${nonce()}` }, HUNG);
	expect(hung.status).toBe(201);
	const t = tap();
	await Bun.sleep(2_100); // the unknown answer from the create expires
	const started = performance.now();
	const list = await call("GET", "/session?limit=50", undefined, "");
	expect(performance.now() - started).toBeLessThan(6_000);
	const row = list.json.find((s: any) => s.id === hung.json.id);
	expect(row).toBeDefined();
	expect(row.vcs).toBeUndefined();
	await Bun.sleep(2_100);
	const title = `still-${nonce()}`;
	expect((await call("PATCH", `/session/${hung.json.id}`, { title }, HUNG)).status).toBe(200);
	await Bun.sleep(3_500);
	t.stop();
	expect(t.frames.some((f) => f.type === "session.updated" && f.properties.info.title === title)).toBe(true);
	expect((await call("DELETE", `/session/${hung.json.id}`, undefined, HUNG)).status).toBe(200);
}, 60_000);
