/**
 * checkouts on a real daemon (m6b): the routes in the shape boxbox v1 sends them (spawn's create with
 * x-opencode-directory and an empty body; diff, merge and discard with {directory}), both ways a checkout
 * is made, setup commands and their events, the project index, the run lock refusing merge and discard
 * (held by another process, then by a real turn), request_review through a real model, merge, discard's
 * rescue ref, a conflict, and every session and message still there after a checkout goes (rule 15).
 *
 * one cli daemon on port 4833 (sonnet 5.5 at low effort). the checkout, lock, discard and conflict tests need no
 * model and always run, against a daemon with an empty profile. the two tests that drive a real model turn (the
 * run lock mid-turn with request_review, and the prefix check of a session outside a checkout) need a provider
 * key or profile and CMX2_LIVE_TESTS=1, else they are skipped. the live profile is the config dir in
 * $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else ANTHROPIC_API_KEY from the env.
 *
 * run: bun test packages/server/test/worktree.test.ts (add CMX2_LIVE_TESTS=1 for the model turns; a few minutes)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { machineName } from "@cmx2/engine/config";
import { Daemon, LIVE, liveNote, liveProfile, liveTest, nonce, port } from "../../eval/src/harness.ts";

const N = nonce();
const SCRATCH = realpathSync((mkdirSync(`/tmp/cmx2-wt-${N}`, { recursive: true }), `/tmp/cmx2-wt-${N}`));
const CONFIG = join(SCRATCH, "config");
const DATA = join(SCRATCH, "data");
const WEB = join(SCRATCH, "web");
const PLAIN = join(SCRATCH, "plain");

function put(root: string, files: Record<string, string>) {
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), body);
	}
}

async function repo(dir: string, tracked: Record<string, string>, untracked: Record<string, string>) {
	put(dir, tracked);
	await $`git init -q -b main && git add -A && git -c user.email=it@cmx2 -c user.name=it commit -qm init`.cwd(dir).quiet();
	put(dir, untracked);
}

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=it@cmx2", "-c", "user.name=it", ...args], { cwd }).stdout.toString().trim();

/** every event on the host, with the directory it was framed with */
class Events {
	frames: Array<{ directory?: string; type: string; properties: any }> = [];
	private ctl = new AbortController();
	constructor(base: string) {
		void (async () => {
			try {
				const res = await fetch(`${base}/global/event`, { signal: this.ctl.signal });
				const reader = res.body!.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
						buf = buf.slice(i + 2);
						if (!line) continue;
						const f = JSON.parse(line.slice(6));
						this.frames.push({ directory: f.directory, type: f.payload.type, properties: f.payload.properties });
					}
				}
			} catch {}
		})();
	}
	async wait(pred: (f: Events["frames"][number]) => boolean, what: string, ms = 60_000) {
		const t0 = Date.now();
		for (;;) {
			const hit = this.frames.find(pred);
			if (hit) return hit;
			if (Date.now() - t0 > ms) throw new Error(`no ${what} within ${ms} ms`);
			await Bun.sleep(50);
		}
	}
	close() {
		this.ctl.abort();
	}
}

let d: Daemon;
let ev: Events;
const V1 = (dir: string) => {
	// an empty directory would send the request to the daemon's own cwd: a failed earlier step stops here instead
	if (!dir) throw new Error("no checkout: an earlier step failed to make one");
	return { "x-opencode-directory": dir };
};

liveNote("the model turns in worktree.test.ts");

beforeAll(async () => {
	mkdirSync(CONFIG, { recursive: true });
	if (LIVE) liveProfile(CONFIG);
	// checkouts get made whatever the laptop's disk holds; the disk floor has its own tests
	writeFileSync(join(CONFIG, `cmx2.${machineName()}.jsonc`), JSON.stringify({ worktree: { minFreeGB: 0, minFreeRatio: 0 } }));
	await repo(
		WEB,
		{
			".gitignore": ["node_modules/", ".env", ".env.*", ".npmrc", "*.pem", ".setup-ran"].join("\n"),
			".cmx2/cmx2.jsonc": JSON.stringify({ worktree: { setup: "echo \"setup ran in $CMX2_WORKTREE_NAME\" > .setup-ran" } }),
			"src/server.ts": "export const port = 3000;\n",
		},
		{ "node_modules/dep/index.js": "module.exports = 1;\n", ".env": "PORT=3000\n", ".env.local": "TOKEN=dev\n", ".npmrc": "//registry.npmjs.org/:_authToken=npm_live\n", "deploy.pem": "private\n" },
	);
	await repo(PLAIN, { ".gitignore": ".env\n", ".cmx2/cmx2.jsonc": JSON.stringify({ worktree: { clone: false } }), "a.txt": "a\n" }, { ".env": "A=1\n" });
	d = new Daemon({ port: port(4833), dataDir: DATA, log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG, CMX2_MODEL: "anthropic/claude-sonnet-5-5", CMX2_EFFORT: "low" } });
	await d.start();
	ev = new Events(d.base);
	await Bun.sleep(200);
}, 30_000);

afterAll(async () => {
	ev?.close();
	await d?.stop();
}, 30_000); // the daemon gives snapshot work in flight up to 3 s on shutdown

let checkout = "";
let session = "";

describe("making checkouts", () => {
	test("boxbox v1's create: empty body, the repo in x-opencode-directory; the clone path, env carried, secrets left behind, setup then worktree.ready", async () => {
		const res = await d.raw("/experimental/worktree", {}, "POST", V1(WEB));
		const c = await res.json();
		console.log(`create: ${res.status} ${c.name} ${c.branch} mode ${c.mode} in ${c.ms} ms${c.fallback ? ` (${c.fallback})` : ""}\n  carried ${c.carried.join(", ")}\n  left behind ${c.left.join(", ")}`);
		expect(res.status).toBe(200);
		expect(c).toMatchObject({ project: WEB, base: "main", source: WEB });
		expect(c.branch).toBe(`cmx2/${c.name}`);
		expect(c.directory.startsWith(realpathSync(DATA))).toBe(true);
		if (process.platform === "darwin") expect(c.mode).toBe("clone");
		checkout = c.directory;
		expect(readFileSync(join(checkout, ".env"), "utf8")).toBe("PORT=3000\n");
		expect(existsSync(join(checkout, ".env.local"))).toBe(true);
		expect(existsSync(join(checkout, "node_modules/dep/index.js"))).toBe(true);
		// the secrets allowlist: .npmrc and the key stay in the main checkout only
		expect(c.left).toEqual([".npmrc", "deploy.pem"]);
		for (const f of c.left) expect([existsSync(join(WEB, f)), existsSync(join(checkout, f))]).toEqual([true, false]);
		const upd = await ev.wait((f) => f.type === "project.updated" && f.properties.sandboxes.includes(checkout), "project.updated with the checkout");
		expect(upd.properties.worktree).toBe(WEB);
		const ready = await ev.wait((f) => f.type === "worktree.ready" && f.directory === checkout, "worktree.ready framed with the checkout");
		expect(ready.properties).toMatchObject({ name: c.name, branch: c.branch });
		expect(readFileSync(join(checkout, ".setup-ran"), "utf8")).toBe(`setup ran in ${c.name}\n`);
		console.log(`events: project.updated sandboxes ${JSON.stringify(upd.properties.sandboxes)}; worktree.ready ${JSON.stringify(ready.properties)} on ${ready.directory}; setup wrote ${JSON.stringify(readFileSync(join(checkout, ".setup-ran"), "utf8"))}`);
	});

	test("the git path: clone off in the project's config, .env carried, which path ran is in the answer", async () => {
		const res = await d.raw("/experimental/worktree", { name: "plain one", wait: true }, "POST", V1(PLAIN));
		const c = await res.json();
		console.log(`create (clone off): ${res.status} ${c.name} mode ${c.mode} in ${c.ms} ms; carried ${c.carried.join(", ")}; setup ${JSON.stringify(c.setup)}`);
		expect(c.mode).toBe("git");
		expect(c.name).toBe("plain-one");
		expect(readFileSync(join(c.directory, ".env"), "utf8")).toBe("A=1\n");
		expect(c.setup).toEqual([]);
	});

	test("a failing setup command is worktree.failed with the output's tail; outside a repository is a typed 400", async () => {
		const r = await (await d.raw("/experimental/worktree", { startCommand: "echo 'it broke here' >&2; exit 3" }, "POST", V1(PLAIN))).json();
		const failed = await ev.wait((f) => f.type === "worktree.failed" && f.directory === r.directory, "worktree.failed");
		console.log(`worktree.failed: ${JSON.stringify(failed.properties)}`);
		expect(failed.properties.message).toContain("exit 3");
		expect(failed.properties.log).toContain("it broke here");
		const outside = await d.raw("/experimental/worktree", {}, "POST", V1(SCRATCH));
		const body = await outside.json();
		expect([outside.status, body.name]).toEqual([400, "WorktreeNotGitError"]);
		await d.api("/experimental/worktree/discard", { directory: r.directory });
	});

	test("/project?worktrees=true lists the checkouts; a session in a checkout belongs to the repo's project", async () => {
		const s = await (await d.raw("/session", { title: `it-wt-${N}` }, "POST", V1(checkout))).json();
		session = s.id;
		expect(s.directory).toBe(checkout);
		expect(s.projectID).toBe(WEB);
		expect(s.vcs.branch).toMatch(/^cmx2\//);
		const projects = await d.api("/project?worktrees=true");
		const row = projects.find((p: any) => p.id === WEB);
		console.log(`/project row: ${JSON.stringify(row)}`);
		expect(row.sandboxes).toEqual([checkout]);
		expect(row.worktrees.map((w: any) => w.directory)).toEqual([checkout]);
		expect((await (await d.raw("/experimental/worktree", undefined, "GET", V1(WEB))).json()).map((w: any) => w.directory)).toEqual([checkout]);
	});
});

describe("the run lock", () => {
	test("merge and discard refuse while another process holds the lock of a session in the checkout", async () => {
		const lockFile = join(DATA, "locks", `${session}.lock`);
		const holder = Bun.spawn(
			[
				"python3",
				"-c",
				`import fcntl,json,os,time,sys\nf=open(sys.argv[1],"a+")\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nf.truncate(0)\nf.write(json.dumps({"pid":os.getpid(),"host":"another-daemon","since":int(time.time()*1000)}))\nf.flush()\nprint("held",flush=True)\ntime.sleep(60)`,
				lockFile,
			],
			{ stdout: "pipe" },
		);
		const reader = holder.stdout.getReader();
		await reader.read();
		try {
			for (const verb of ["merge", "discard"]) {
				const r = await d.raw(`/experimental/worktree/${verb}`, { directory: checkout }, "POST", V1(checkout));
				const b = await r.json();
				console.log(`${verb} under another process's lock: ${r.status} ${JSON.stringify(b)}`);
				expect(r.status).toBe(409);
				expect(b.name).toBe("BusyError");
				expect(b.data.sessionID).toBe(session);
				expect(b.data.holder.pid).toBe(holder.pid);
			}
			expect(existsSync(checkout)).toBe(true);
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	liveTest(
		"a real turn: merge and discard refuse mid-turn; request_review raises worktree.review.requested; the diff; merge lands it; every session and message is still there",
		async () => {
			await d.api(`/session/${session}/prompt_async`, {
				text: "do these in order, one shell call each: 1) create hello.txt containing exactly `hello from the checkout`, then git add it and git commit -m 'add hello'. 2) run `sleep 15`. 3) call request_review with the note 'adds hello.txt'. then say done.",
			});
			// mid-turn: the shell is sleeping inside the checkout
			await d.until(async () => {
				const st = await d.api("/session/status");
				const msgs = await d.api(`/session/${session}/message`);
				const sleeping = msgs.flatMap((m: any) => m.parts).some((p: any) => p.type === "tool" && p.state.status === "running" && JSON.stringify(p.state.input ?? {}).includes("sleep"));
				return st[session] && sleeping ? true : undefined;
			}, "the turn to reach the sleep", 180_000);
			for (const verb of ["merge", "discard"]) {
				const r = await d.raw(`/experimental/worktree/${verb}`, { directory: checkout }, "POST");
				const b = await r.json();
				console.log(`${verb} mid-turn: ${r.status} ${JSON.stringify(b)}`);
				expect([r.status, b.name]).toEqual([409, "BusyError"]);
				expect(b.data.message).toContain("mid-turn");
			}
			await d.idle(session, 240_000);
			const review = await ev.wait((f) => f.type === "worktree.review.requested" && f.directory === checkout, "worktree.review.requested", 5_000);
			console.log(`worktree.review.requested on ${review.directory}: ${JSON.stringify(review.properties)}`);
			expect(review.properties.sessionID).toBe(session);
			expect(review.properties.note).toContain("hello");
			const prefix = await d.api(`/session/${session}/prefix`);
			expect(prefix.bytes).toContain("request_review");

			const diff = await d.api(`/experimental/worktree/diff?${new URLSearchParams({ directory: checkout })}`, undefined, "GET");
			console.log(`diff: ${JSON.stringify({ ...diff, diff: `${diff.diff.length} bytes` })}`);
			expect(diff).toMatchObject({ base: "main", commits: 1, dirty: false, mergeable: true });
			expect(diff.files.map((f: any) => f.path)).toEqual(["hello.txt"]);

			const sql = (q: string) => Number(Bun.spawnSync(["sqlite3", join(DATA, "cmx2.db"), q]).stdout.toString().trim());
			const count = () => ({ sessions: sql("select count(*) from session"), messages: sql("select count(*) from message") });
			const before = count();
			const r = await d.raw("/experimental/worktree/merge", { directory: checkout }, "POST", V1(checkout));
			const m = await r.json();
			console.log(`merge: ${r.status} ${JSON.stringify(m)}; main now: ${git(WEB, "log", "--oneline", "-2").replace(/\n/g, " | ")}`);
			expect(r.status).toBe(200);
			expect(m).toMatchObject({ merged: true, base: "main", commits: 1, into: WEB });
			expect(git(WEB, "rev-parse", "HEAD")).toBe(m.commit);
			expect(readFileSync(join(WEB, "hello.txt"), "utf8").trim()).toBe("hello from the checkout");
			expect(existsSync(checkout)).toBe(false);
			const merged = await ev.wait((f) => f.type === "worktree.merged" && f.directory === checkout, "worktree.merged", 5_000);
			expect(merged.properties.commit).toBe(m.commit);
			const gone = await ev.wait((f) => f.type === "project.updated" && f.properties.worktree === WEB && !f.properties.sandboxes.includes(checkout), "project.updated without the checkout", 5_000);
			expect(gone.properties.sandboxes).toEqual([]);
			const after = count();
			console.log(`rule 15: sessions ${before.sessions} -> ${after.sessions}, messages ${before.messages} -> ${after.messages}`);
			expect(after).toEqual(before);
			expect((await d.api(`/session/${session}/message`)).length).toBeGreaterThan(1);
			// the thread now lives where its work landed, so lists fold it under the repository
			expect((await d.api(`/session/${session}`)).directory).toBe(WEB);
		},
		420_000,
	);

	liveTest("a session outside a checkout has no request_review", async () => {
		const s = (await d.api("/session", { directory: WEB, title: `it-wt-main-${N}` })).id;
		await d.api(`/session/${s}/prompt`, { text: "say ok" });
		await d.idle(s, 120_000);
		const prefix = await d.api(`/session/${s}/prefix`);
		expect(prefix.bytes).not.toContain("request_review");
		expect(prefix.bytes).toContain("tool_search");
	}, 150_000);
});

describe("discard and conflicts", () => {
	test("discard keeps the last state under refs/cmx2/rescue, uncommitted work included", async () => {
		const c = await (await d.raw("/experimental/worktree", { name: "idea" }, "POST", V1(WEB))).json();
		put(c.directory, { "idea.md": "half an idea\n" });
		const r = await d.raw("/experimental/worktree/discard", { directory: c.directory }, "POST", V1(c.directory));
		const b = await r.json();
		console.log(`discard: ${r.status} ${JSON.stringify(b)}`);
		expect(r.status).toBe(200);
		expect(b.ref).toBe(`refs/cmx2/rescue/${c.name}`);
		expect(git(WEB, "show", `${b.ref}:idea.md`)).toBe("half an idea");
		expect(existsSync(c.directory)).toBe(false);
		await ev.wait((f) => f.type === "worktree.discarded" && f.directory === c.directory && f.properties.snapshot === b.snapshot, "worktree.discarded", 5_000);
	});

	test("a conflict is 409 WorktreeMergeConflictError naming the file, which boxbox v1 reads as MergeConflict", async () => {
		const c = await (await d.raw("/experimental/worktree", { name: "clash" }, "POST", V1(WEB))).json();
		put(c.directory, { "src/server.ts": "export const port = 4000;\n" });
		git(c.directory, "commit", "-qam", "port 4000");
		put(WEB, { "src/server.ts": "export const port = 5000;\n" });
		git(WEB, "commit", "-qm", "port 5000", "--", "src/server.ts");
		const r = await d.raw("/experimental/worktree/merge", { directory: c.directory }, "POST", V1(c.directory));
		const text = await r.text();
		console.log(`conflict: ${r.status} ${text}`);
		expect(r.status).toBe(409);
		expect(text).toContain("MergeConflict");
		expect(JSON.parse(text).data.files).toEqual(["src/server.ts"]);
		expect((await d.api(`/experimental/worktree/diff?${new URLSearchParams({ directory: c.directory })}`)).mergeable).toBe(false);
	});

	test("no contract violations on the wire", async () => {
		const mem = await d.api("/global/memory");
		console.log(`contract_violations ${mem.contract_violations}; rss ${(mem.rss / 1e6).toFixed(1)} MB`);
		expect(mem.contract_violations).toBe(0);
	});
});
