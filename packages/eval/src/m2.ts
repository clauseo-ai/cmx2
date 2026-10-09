/**
 * m2 gate driver: real daemons on dev ports (never 4096), the real provider path, cleanup at exit.
 *   bun packages/eval/src/m2.ts watcher [--data dir] [--boxbox path]   boxbox's HostWatcher against the dev daemon (port 4834)
 *   bun packages/eval/src/m2.ts idle [--data dir]                      idle rss over ten minutes after a turn and history reads (port 4835)
 *   bun packages/eval/src/m2.ts global                                 config watch, reload, fs, health, restart (port 4836)
 * the run lock across two processes is a test: CMX2_IT=1 bun test packages/server/test/integration
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Daemon, gitRepo, nonce, ROOT } from "./harness.ts";

const which = process.argv[2] ?? "watcher";
const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const tag = nonce();
const scratch = `/tmp/cmx2-m2-${which}-${tag}`;
mkdirSync(scratch, { recursive: true });
const MODEL = process.env.CMX2_IT_MODEL ?? "anthropic/claude-sonnet-5-5";
const cleanups: Array<() => Promise<unknown> | unknown> = [];

function textOf(messages: any[]): string {
	const last = messages.at(-1);
	return (last?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
}

// ---------- boxbox's watcher against the dev daemon ----------
async function checkWatcher() {
	const boxbox = resolve(arg("boxbox") ?? process.env.BOXBOX_DIR ?? join(ROOT, "..", "boxbox-web"));
	const watcherPath = join(boxbox, "lib/fleet/watcher.ts");
	if (!existsSync(watcherPath)) throw new Error(`no boxbox checkout at ${boxbox}; pass --boxbox <path> or set BOXBOX_DIR`);
	// boxbox is its own repo; its watcher is loaded from the checkout as-is, untyped here
	const { HostWatcher } = (await import(watcherPath)) as { HostWatcher: any };

	const d = new Daemon({ port: 4834, dataDir: arg("data") ?? join(scratch, "data"), password: "pw", log: join(scratch, "daemon.log") });
	await d.start();
	cleanups.push(() => d.stop());
	console.log(`daemon pid ${d.pid} on 4834, data ${d.opts.dataDir}`);

	const proj = join(scratch, "proj");
	await gitRepo(proj, { "hello.txt": "hello\n", ".cmx2/cmx2.jsonc": '{ "permission": { "shell": "ask" } }\n' });

	const w = new HostWatcher({ id: "dev", name: "cmx2 dev", url: d.base, password: "pw" }, { seedDirectories: [] });
	void w.run();
	cleanups.push(() => w.stop());
	await d.until(async () => w.reachable && w.version, "the watcher to connect");
	console.log(`watcher connected: reachable ${w.reachable}, version ${w.version}`);

	const ids: string[] = [];
	cleanups.push(async () => {
		for (const id of ids) await d.raw(`/session/${id}`, undefined, "DELETE").catch(() => {});
	});
	const s1 = (await d.api("/session", { directory: proj, title: `it-m2-watch-perm-${tag}`, model: MODEL, effort: "low" })).id;
	const s2 = (await d.api("/session", { directory: proj, title: `it-m2-watch-question-${tag}`, model: MODEL, effort: "low" })).id;
	ids.push(s1, s2);
	await d.api(`/session/${s1}/prompt`, { text: "run `git status --short` with the shell tool and tell me what it printed." });
	await d.api(`/session/${s2}/prompt`, { text: "use the question tool to ask me which of two names to use for a new module, parser or reader. then reply with my pick only." });
	await d.until(async () => w.pending.length >= 2, "a permission and a question in the watcher's pending list");

	const snap = w.snapshot();
	console.log("\nwatcher.snapshot():");
	console.log(JSON.stringify({ ...snap, projects: `${snap.projects.length} projects, first: ${JSON.stringify(snap.projects.slice(0, 2))}` }, null, 1));
	console.log("\nwatcher.pending:");
	for (const p of w.pending) {
		const raw = p.raw as any;
		console.log(`  ${p.kind} ${p.id} session ${p.sessionID} dir ${p.directory ?? "(default scope)"}: ${p.kind === "permission" ? `${raw.permission} ${JSON.stringify(raw.patterns)}` : raw.questions?.[0]?.question}`);
	}
	console.log(`\nwatcher.statusWithSince(): ${JSON.stringify(w.statusWithSince())}`);

	// the session list the way boxbox's fleet store builds it: bare scope plus every proven directory
	const scopes: Array<string | undefined> = [undefined, ...w.provenDirectories];
	const union = new Map<string, any>();
	for (const dir of scopes) {
		const res = await fetch(`${d.base}/session?scope=project&roots=true&limit=50`, { headers: w.headers(dir) });
		for (const s of (await res.json()) as any[]) union.set(s.id, s);
	}
	const list = [...union.values()];
	console.log(`\nsessions (boxbox's refreshSessions over ${scopes.length} scopes): ${list.length}, of which cmx2 ${list.filter((s) => s.source === "cmx2").length}, imported cmx ${list.filter((s) => s.source === "cmx").length}`);
	for (const s of list.slice(0, 6)) console.log(`  ${s.id} ${s.source} ${JSON.stringify(s.title).slice(0, 60)} ${s.directory}`);

	// answer both from the api and watch the watcher clear them off the stream
	const perm = w.pending.find((p: any) => p.kind === "permission");
	const question = w.pending.find((p: any) => p.kind === "question");
	const label = (question.raw as any).questions[0].options[0].label;
	await d.api(`/permission/${perm.id}/reply`, { reply: "once" });
	await d.api(`/question/${question.id}/reply`, { answers: [[label]] });
	await d.until(async () => w.pending.length === 0, "the watcher to drop both items");
	console.log(`\nafter replying: watcher.pending ${w.pending.length}, pendingCount ${w.snapshot().pendingCount}`);
	await d.idle(s1);
	await d.idle(s2);
	console.log(`session 1 answer: ${JSON.stringify(textOf(await d.api(`/session/${s1}/message`)).slice(0, 160))}`);
	console.log(`session 2 answer: ${JSON.stringify(textOf(await d.api(`/session/${s2}/message`)).slice(0, 160))} (picked ${label})`);
	console.log(`watcher.statusWithSince() after both settled: ${JSON.stringify(w.statusWithSince())}`);
	const mem = await d.api("/global/memory");
	console.log(`contract violations: ${mem.contract_violations}; daemon rss ${(mem.rss / 1048576).toFixed(1)} MB`);
}

// ---------- idle rss over ten minutes ----------
async function checkIdle() {
	const d = new Daemon({ port: 4835, dataDir: arg("data") ?? join(scratch, "data"), password: "pw", log: join(scratch, "daemon.log") });
	await d.start();
	cleanups.push(() => d.stop());
	const dir = join(scratch, "proj");
	await gitRepo(dir, { "hello.txt": "hello\n", "src/math.ts": "export const add = (a: number, b: number) => a + b;\n" });
	console.log(`daemon pid ${d.pid} on 4835, data ${d.opts.dataDir}`);
	console.log(`rss at start: ${d.rssMb()} MB`);
	const id = (await d.api("/session", { directory: dir, title: `it-m2-idle-${tag}`, model: MODEL, effort: "low" })).id;
	cleanups.push(() => d.raw(`/session/${id}`, undefined, "DELETE").catch(() => {}));
	await d.api(`/session/${id}/prompt`, { text: "read hello.txt and src/math.ts and tell me in one line what they contain." });
	await d.idle(id);
	console.log(`rss after one turn: ${d.rssMb()} MB`);
	// read history the way a client does after a reconnect: lists, a page walk, and the biggest imported session
	const list = await d.api("/session?limit=500");
	let pages = 0;
	let cursor: string | undefined;
	for (;;) {
		const page = await d.api(`/api/session?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
		if (!page.items.length) break;
		pages++;
		cursor = page.cursor.next;
	}
	const big = await d.api("/session?limit=5&search=fix");
	const biggest = list.sort((a: any, b: any) => b.tokens.input + b.tokens.cache.read - (a.tokens.input + a.tokens.cache.read))[0];
	const msgs = biggest ? await d.api(`/session/${biggest.id}/message?limit=200`) : [];
	console.log(`history reads: ${list.length} sessions listed, ${pages} cursor pages walked, ${msgs.length} messages of the largest session (${biggest?.id}) paged; ${big.length} search hits for "fix"`);
	console.log(`rss after history reads: ${d.rssMb()} MB`);
	const samples: number[] = [];
	for (let m = 1; m <= 10; m++) {
		await Bun.sleep(60_000);
		samples.push(d.rssMb());
		const mem = await d.api("/global/memory");
		console.log(`idle minute ${m}: rss ${samples.at(-1)} MB (heapUsed ${(mem.heapUsed / 1048576).toFixed(1)} MB, live sessions ${mem.live_sessions}, uptime ${mem.uptime_s} s)`);
	}
	console.log(`idle rss after 10 minutes: ${samples.at(-1)} MB (max ${Math.max(...samples)} MB), budget 150 MB: ${samples.at(-1)! < 150 ? "under" : "OVER"}`);
}

// ---------- config watch, reload, fs, health, restart ----------
async function checkGlobal() {
	const profile = join(scratch, "profile");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "cmx2.jsonc"), '{ "effort": "medium" }\n');
	const d = new Daemon({ port: 4836, dataDir: join(scratch, "data"), password: "pw", log: join(scratch, "daemon.log"), env: { CMX2_CONFIG_DIR: profile } });
	await d.start();
	cleanups.push(() => d.stop());
	console.log(`daemon pid ${d.pid} on 4836, profile ${profile}`);
	const frames: any[] = [];
	const ctl = new AbortController();
	cleanups.push(() => ctl.abort());
	void (async () => {
		try {
			const res = await fetch(`${d.base}/global/event`, { headers: d.headers(), signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const f = buf.slice(0, i);
					buf = buf.slice(i + 2);
					if (f.startsWith("data: ")) frames.push(JSON.parse(f.slice(6)));
				}
			}
		} catch {}
	})();
	await d.until(async () => frames.length > 0, "server.connected");
	console.log(`first frame: ${JSON.stringify(frames[0])}`);
	writeFileSync(join(profile, "cmx2.jsonc"), '{ "effort": "high", "nudge": true }\n');
	const upd = await d.until(async () => frames.find((f) => f.payload.type === "config.updated"), "config.updated after editing the profile", 10_000);
	console.log(`edited the profile on disk → ${JSON.stringify(upd)}`);
	console.log(`POST /global/reload → ${JSON.stringify(await d.api("/global/reload", {}))}`);
	console.log(`GET /global/fs?path=${scratch} → ${JSON.stringify(await d.api(`/global/fs?path=${encodeURIComponent(scratch)}`))}`);
	console.log(`GET /global/health → ${JSON.stringify(await d.api("/global/health"))}`);
	const pid = d.pid;
	console.log(`POST /global/restart → ${JSON.stringify(await d.api("/global/restart", {}))}`);
	const code = await d.proc!.exited;
	d.proc = undefined;
	const disposed = frames.find((f) => f.payload.type === "global.disposed");
	console.log(`daemon pid ${pid} exited with code ${code}; global.disposed frame: ${JSON.stringify(disposed)}; stream frames seen: ${frames.map((f) => f.payload.type).join(", ")}`);
	const err = await Bun.file(`${d.opts.log}.err`).text();
	if (err.includes("contract violation")) console.log(`contract violations in the daemon log:\n${err}`);
	else console.log("contract violations in the daemon log: none");
}

try {
	console.log(`m2 ${which}: scratch ${scratch}`);
	if (which === "watcher") await checkWatcher();
	else if (which === "idle") await checkIdle();
	else if (which === "global") await checkGlobal();
	else throw new Error(`unknown check ${which}`);
} finally {
	for (const c of cleanups.reverse()) await c();
	console.log("cleaned up; daemons stopped");
}
