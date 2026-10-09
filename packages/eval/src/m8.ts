#!/usr/bin/env bun
/**
 * m8 checks against real daemons on dev ports (4866-4869) and the configured provider:
 *   bun packages/eval/src/m8.ts init     /init writes AGENTS.md in a project that has none, and leaves one alone
 *   bun packages/eval/src/m8.ts notify   a permission ask with no client watching shows a desktop note (a
 *                                        screenshot is kept); with a client watching, none
 *   bun packages/eval/src/m8.ts pair     cmx2 pair, the exchange over the network, a bearer that works, --list,
 *                                        --revoke, all through the cli against a cli daemon
 * outputs go to stdout; tee them to /tmp/cmx2-m8/.
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, gitRepo, nonce, ROOT } from "./harness.ts";

const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
const log = (s: string) => console.log(s);

/** a scratch profile: the user's providers (or none, for anthropic direct) plus overrides */
function profile(dir: string, extra: Record<string, unknown> = {}): string {
	mkdirSync(dir, { recursive: true });
	const owner = join(homedir(), ".config", "cmx2", "cmx2.jsonc");
	if (existsSync(owner)) copyFileSync(owner, join(dir, "cmx2.jsonc"));
	else writeFileSync(join(dir, "cmx2.jsonc"), "{}\n");
	// overrides are appended as top-level keys, so the rest of the copy stays byte for byte the user's
	if (Object.keys(extra).length) {
		const text = readFileSync(join(dir, "cmx2.jsonc"), "utf8").trimEnd();
		const close = text.lastIndexOf("}");
		const body = Object.entries(extra)
			.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
			.join(",\n  ");
		writeFileSync(join(dir, "cmx2.jsonc"), `${text.slice(0, close).trimEnd().replace(/,?$/, ",")}\n  ${body}\n}\n`);
	}
	return dir;
}

async function init() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-m8-init-")));
	const project = join(root, "proj");
	await gitRepo(project, {
		"package.json": JSON.stringify({ name: "tally", type: "module", scripts: { test: "bun test", start: "bun src/index.ts" } }, null, 2),
		"src/index.ts": 'import { tally } from "./tally.ts";\nconsole.log(tally(process.argv.slice(2)));\n',
		"src/tally.ts": "/** counts words; ties keep first-seen order */\nexport function tally(words: string[]): Record<string, number> {\n\tconst out: Record<string, number> = {};\n\tfor (const w of words) out[w] = (out[w] ?? 0) + 1;\n\treturn out;\n}\n",
		"src/tally.test.ts": 'import { expect, test } from "bun:test";\nimport { tally } from "./tally.ts";\ntest("counts", () => expect(tally(["a", "b", "a"])).toEqual({ a: 2, b: 1 }));\n',
	});
	const d = new Daemon({ port: 4867, dataDir: join(root, "data"), log: join(root, "daemon.log"), env: { CMX2_CONFIG_DIR: profile(join(root, "config")) } });
	await d.start();
	try {
		const cmds = (await d.api(`/command?directory=${encodeURIComponent(project)}`)) as Array<{ name: string; description?: string }>;
		log(`GET /command lists: ${cmds.map((c) => `/${c.name}`).join(" ")}; /init: ${cmds.find((c) => c.name === "init")?.description}`);
		log(`AGENTS.md before: ${existsSync(join(project, "AGENTS.md")) ? "present" : "absent"}`);
		const s = await d.api("/session", { directory: project, title: `m8-init-${nonce()}` });
		const t0 = Date.now();
		const r = await d.raw(`/session/${s.id}/command`, { command: "init", model: `${MODEL.providerID}/${MODEL.modelID}` });
		const answer = JSON.parse((await r.text()).trim());
		log(`/init turn: ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s; finish ${answer?.info?.finish}`);
		const steps = (await d.api(`/session/${s.id}/steps`)) as Array<{ calls: number }>;
		log(`steps: ${steps.length}, calls: ${steps.reduce((a, x) => a + (x.calls ?? 0), 0)}`);
		const written = existsSync(join(project, "AGENTS.md")) ? readFileSync(join(project, "AGENTS.md"), "utf8") : "";
		log(`AGENTS.md after: ${written ? `${written.length} bytes` : "absent"}`);
		log(written.split("\n").slice(0, 25).map((l) => `  | ${l}`).join("\n"));
		const r2 = await d.raw(`/session/${s.id}/command`, { command: "init" });
		const again = JSON.parse((await r2.text()).trim());
		const text = (again.parts as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join(" ");
		const same = readFileSync(join(project, "AGENTS.md"), "utf8") === written;
		log(`second /init: file unchanged: ${same}; the model said: ${text.slice(0, 300)}`);
		if (!written || !same) process.exitCode = 1;
	} finally {
		await d.stop();
	}
}

async function notify() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-m8-notify-")));
	const project = join(root, "proj");
	await gitRepo(project, { ".cmx2/cmx2.jsonc": JSON.stringify({ permission: { shell: "ask" } }) });
	const d = new Daemon({ port: 4868, dataDir: join(root, "data"), log: join(root, "daemon.log"), env: { CMX2_CONFIG_DIR: profile(join(root, "config"), { notify: true }) } });
	await d.start();
	try {
		const cfg = await d.api("/config");
		log(`GET /config notify: ${JSON.stringify(cfg.notify)}`);
		const ask = async (label: string) => {
			const s = await d.api("/session", { directory: project, title: `m8 notify ${label} ${nonce()}` });
			await d.raw(`/session/${s.id}/prompt_async`, { parts: [{ type: "text", text: "run the shell command `echo hello` with the shell tool, then say done" }], model: MODEL });
			const asked = await d.until(async () => ((await d.api("/permission")) as Array<{ id: string; sessionID: string }>).find((p) => p.sessionID === s.id), "the permission ask", 120_000);
			return { s, asked };
		};
		// nobody watching: a note
		const a = await ask("unwatched");
		await Bun.sleep(1200);
		log(`permission ${a.asked.id} asked with no client watching`);
		await d.api(`/permission/${a.asked.id}/reply`, { reply: "once" });
		await d.idle(a.s.id);
		// a client watching the event stream: no note
		const ctl = new AbortController();
		const sse = await fetch(`${d.base}/global/event`, { headers: d.headers(), signal: ctl.signal });
		const b = await ask("watched");
		await Bun.sleep(800);
		await d.api(`/permission/${b.asked.id}/reply`, { reply: "once" });
		await d.idle(b.s.id);
		ctl.abort();
		await sse.body?.cancel().catch(() => {});
		const err = readFileSync(`${join(root, "daemon.log")}.err`, "utf8");
		const notes = err.split("\n").filter((l) => l.includes("desktop note"));
		log(`daemon log, desktop notes (${notes.length}):\n${notes.map((l) => `  ${l}`).join("\n")}`);
		log(`unwatched session noted: ${notes.some((l) => l.includes("unwatched"))}; watched session noted: ${notes.some((l) => l.includes(" watched"))}`);
		// macos keeps what notification center delivered; read it back rather than trusting the spawn
		const db = join(homedir(), "Library/Group Containers/group.com.apple.usernoted/db2/db");
		if (process.platform === "darwin" && existsSync(db)) {
			const rows = (await $`sqlite3 -readonly ${db} ${"select rec_id from record where delivered_date > strftime('%s','now') - 978307200 - 600 order by delivered_date"}`.nothrow().text()).trim().split("\n").filter(Boolean);
			const delivered: string[] = [];
			for (const id of rows) {
				const file = join(root, `note-${id}.plist`);
				await $`sqlite3 -readonly ${db} ${`select writefile('${file}', data) from record where rec_id = ${Number(id)}`}`.nothrow().quiet();
				// the record holds binary plist data json cannot carry, so read plutil's printout
				const p = await $`plutil -p ${file}`.nothrow().text();
				const titl = p.match(/"titl" => "(.*)"/)?.[1];
				if (titl?.startsWith("cmx2 · m8 notify")) delivered.push(`${titl}: ${p.match(/"body" => "(.*)"/)?.[1]}`);
			}
			log(`notification center delivered in the last 10 minutes (cmx2 notes):\n${delivered.map((l) => `  ${l}`).join("\n") || "  none"}`);
			if (!delivered.some((l) => l.includes("unwatched")) || delivered.some((l) => l.includes(" watched"))) process.exitCode = 1;
		}
		if (notes.length !== 1 || !notes[0]!.includes("unwatched")) process.exitCode = 1;
	} finally {
		await d.stop();
	}
}

async function pair() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-m8-pair-")));
	const env = { ...process.env, CMX2_DATA_DIR: join(root, "data"), CMX2_CONFIG_DIR: profile(join(root, "config")) };
	const cli = (args: string[]) => $`bun packages/cli/src/index.ts ${args}`.cwd(ROOT).env(env).nothrow();
	const d = new Daemon({ port: 4869, dataDir: join(root, "data"), log: join(root, "daemon.log"), env: { CMX2_CONFIG_DIR: env.CMX2_CONFIG_DIR } });
	await d.start();
	try {
		const out = (await cli(["pair", "--port", "4869", "--name", "boxbox-test", "--url", "http://127.0.0.1:4869"]).text()).trimEnd();
		log(`$ cmx2 pair --port 4869 --name boxbox-test --url http://127.0.0.1:4869\n${out.replace(/cmx2p_[\w-]+/g, (t) => `${t.slice(0, 10)}…`)}`);
		const token = out.match(/token\s+(cmx2p_[\w-]+)/)?.[1];
		if (!token) throw new Error("no token printed");
		const r = await fetch(`${d.base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
		const cred = (await r.json()) as { id: string; name: string; credential: string };
		log(`POST /pair → ${r.status} {id: ${cred.id}, name: ${cred.name}, credential: ${cred.credential.slice(0, 9)}…}`);
		const anon = await fetch(`${d.base}/session`);
		log(`GET /session without a credential → ${anon.status}`);
		const withBearer = await fetch(`${d.base}/session`, { headers: { authorization: `Bearer ${cred.credential}` } });
		log(`GET /session with the bearer → ${withBearer.status}`);
		const mcp = (await cli(["mcp", "--port", "4869"]).text()).trimEnd();
		log(`$ cmx2 mcp --port 4869 (the cli rides local.token)\n  ${mcp}`);
		log(`$ cmx2 pair --list\n${(await cli(["pair", "--list"]).text()).trimEnd()}`);
		log(`$ cmx2 pair --revoke ${cred.id}\n${(await cli(["pair", "--revoke", cred.id]).text()).trimEnd()}`);
		const revoked = await fetch(`${d.base}/session`, { headers: { authorization: `Bearer ${cred.credential}` } });
		log(`GET /session with the revoked bearer → ${revoked.status}`);
		const nope = await cli(["pair", "--revoke", "nobody"]);
		log(`$ cmx2 pair --revoke nobody → exit ${nope.exitCode}: ${nope.stderr.toString().trim()}`);
		if (withBearer.status !== 200 || revoked.status !== 401 || anon.status !== 401) process.exitCode = 1;
	} finally {
		await d.stop();
	}
}

mkdirSync("/tmp/cmx2-m8", { recursive: true });
const which = process.argv[2];
if (which === "init") await init();
else if (which === "notify") await notify();
else if (which === "pair") await pair();
else {
	console.error("usage: bun packages/eval/src/m8.ts init | notify | pair");
	process.exit(2);
}
