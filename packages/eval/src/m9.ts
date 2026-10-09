#!/usr/bin/env bun
/**
 * m9 (SCOPE-ROUTING R10): does the model table (routing v2) beat the seat matrix (v1), and does either beat the main
 * model alone? Real daemons, the user's providers, real merged commits as tasks; nothing is mocked.
 *
 *   bun packages/eval/src/m9.ts list    [--tasks f]                       the task list as a table
 *   bun packages/eval/src/m9.ts prepare [--a-root dir] [--a-commit sha]   arm a's checkout: a worktree of 8e78255, the eval knob patched in, bun install
 *   bun packages/eval/src/m9.ts check   [--tasks f] [--only ids] [--write] hidden tests fail at base and pass at the commit
 *   bun packages/eval/src/m9.ts run     [--arm a,b,c] [--pilot | --only ids] [--trials n] [--model ref] [--effort e] [--review] ...
 *   bun packages/eval/src/m9.ts table   [results.jsonl ...]                the per-arm table
 *
 * arms (the main session is the same model and effort in all three):
 *   a  the version-1 seat matrix: the daemon runs from --a-root (default /tmp/cmx2-m9-arm-a), a worktree of --a-commit
 *      (default 8e78255: main before routing v2 merged, phase 1 done, seats in place) with that commit's
 *      examples/routing.jsonc (its v1 shipped default, not the user's file). `prepare` also patches that worktree with the
 *      same CMX2_EXCLUDE_TOOLS knob arms b and c have, so every arm drops the question tool; rows say "+eval-knob"
 *   b  the version-2 model table: this checkout's daemon and examples/routing.jsonc (its shipped default)
 *   c  the main model alone: this checkout's daemon with CMX2_EXCLUDE_TOOLS=spawn,message,wait,agents,question (eval only, read
 *      by the server's hooks() for root sessions; the routing text leaves the turn context too, so nothing invites a spawn)
 *
 * every arm drops the `question` tool for the main session (nobody is there to answer; a root parked on a question looks hung)
 * and its prompt ends with a line saying so. a run is killed and marked after --timeout minutes, or --stall minutes (default 8)
 * in which the tree's cost does not move.
 *
 * a run: a scratch clone at `base` (history up to base only, no later commit is in the repo), `setup`, a fresh daemon with a
 * scratch data dir and a config dir holding the user's cmx2.jsonc plus the arm's routing.jsonc, the prompt, wait for the
 * tree to settle, metrics, the daemon stops, the commit's hidden tests are checked out over the work, test_cmd runs.
 *
 * the task list: --tasks, $M9_TASKS, or the shipped packages/eval/m9-tasks.example.json (placeholders: copy it, point
 * `repo` at a real checkout, set the commits). results are appended to <tasks dir>/m9-<date>.jsonl, one row per run, and a run
 * that is already in the file is skipped (--redo to repeat it).
 *
 * ports: the daemon takes port(4830), so CMX2_PORT_SHIFT=40 gives 4870. the tests run after the daemon stops, with
 * CMX2_PORT_SHIFT=--test-shift (default 40, or the task's test_shift), so a test that starts its own daemon cannot meet this one.
 * flags: --port n, --keep (scratch dirs stay), --max-cost usd (default 20 per run, then the run is killed and marked), --timeout min (default 30)
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Daemon, nonce, port, ROOT } from "./harness.ts";

// ---------- args ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string, d: number) => (arg(name) !== undefined ? Number(arg(name)) : d);

// ---------- tasks ----------

export interface Task {
	/** a short name; defaults to <repo dir name>-<commit> */
	id?: string;
	/** a local checkout (a leading ~/ is expanded); the clone never contains a commit after `base` */
	repo: string;
	/** the merged commit the task replays */
	commit: string;
	/** where the work starts: the commit's parent */
	base: string;
	/** what the main session is asked; defaults to the commit message */
	prompt?: string;
	/** exits 0 when the behaviour is there; run in the scratch clone after the hidden tests are checked out */
	test_cmd: string;
	/** test files taken from `commit` and laid over the work before test_cmd runs; the model never sees them */
	hidden_tests: string[];
	/** the files the commit touched, tests included; work outside them is counted */
	files: string[];
	/** run once in the clone before the session; defaults to `bun install --frozen-lockfile` when a bun lockfile exists */
	setup?: string;
	/** CMX2_PORT_SHIFT for this task's tests when --test-shift is not given (default 40, which puts the 4830 lane at 4870); a test that listens on 4840 or 4929 needs 30 or -59 to stay in 4870-4879 */
	test_shift?: number;
	/** one of the three small tasks of the pilot */
	pilot?: boolean;
	/** filled in by `check --write` */
	base_fails?: boolean;
	commit_passes?: boolean;
	test_seconds?: number;
	checked_at?: string;
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const idOf = (t: Task) => t.id ?? `${basename(expand(t.repo))}-${t.commit.slice(0, 7)}`;

function tasksPath(): string {
	const p = arg("tasks") ?? process.env.M9_TASKS ?? join(dirname(import.meta.dir), "m9-tasks.example.json");
	if (!existsSync(p)) throw new Error(`no task list at ${p}; pass --tasks or set M9_TASKS; packages/eval/m9-tasks.example.json shows the shape`);
	return resolve(p);
}

function loadTasks(): Task[] {
	const tasks = JSON.parse(readFileSync(tasksPath(), "utf8")) as Task[];
	const seen = new Set<string>();
	for (const t of tasks) {
		for (const k of ["repo", "commit", "base", "test_cmd", "hidden_tests", "files"] as const) if (!t[k] || (Array.isArray(t[k]) && !(t[k] as unknown[]).length && k !== "files")) throw new Error(`task ${idOf(t)} has no ${k}`);
		for (const k of ["commit", "base"] as const) if (!/^[0-9a-f]{40}$/.test(t[k])) throw new Error(`task ${idOf(t)}: ${k} must be a full 40-character sha (git fetch does not take short ones)`);
		if (seen.has(idOf(t))) throw new Error(`two tasks are called ${idOf(t)}`);
		seen.add(idOf(t));
	}
	return tasks;
}

function pick(tasks: Task[]): Task[] {
	const only = arg("only")?.split(",");
	if (only) {
		const out = only.map((id) => tasks.find((t) => idOf(t) === id || t.commit.startsWith(id)) ?? (() => { throw new Error(`no task ${id}`); })());
		return out;
	}
	return flag("pilot") ? tasks.filter((t) => t.pilot) : tasks;
}

// ---------- shell ----------

/** the environment for git and tests: the helper shells' push guard and this process's CMX2_ variables stay out of the way */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || k.startsWith("GIT_CONFIG_") || k.startsWith("CMX2_")) continue;
		env[k] = v;
	}
	return { ...env, ...extra };
}

async function sh(command: string, cwd: string, opts: { timeoutS?: number; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; seconds: number; timedOut: boolean }> {
	const t0 = Date.now();
	const p = Bun.spawn(["bash", "-c", command], { cwd, env: opts.env ?? cleanEnv(), stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = opts.timeoutS ? setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutS * 1000) : undefined;
	const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	await p.exited;
	if (timer) clearTimeout(timer);
	return { code: timedOut ? 124 : (p.exitCode ?? -1), out: o + e, seconds: Math.round((Date.now() - t0) / 100) / 10, timedOut };
}

const git = async (args: string, cwd: string) => {
	const r = await sh(`git ${args}`, cwd);
	if (r.code) throw new Error(`git ${args} failed in ${cwd}: ${r.out.trim().slice(-400)}`);
	return r.out.trim();
};

// ---------- scratch clones and tests ----------

/** a repo whose history ends at `base`: fetch only that commit's ancestry, so a later commit (the answer) is not in the objects */
async function scratchClone(task: Task, dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await git("init -q -b main", dir);
	await git(`fetch -q ${JSON.stringify(expand(task.repo))} ${task.base}`, dir);
	await git("-c advice.detachedHead=false checkout -q -B main FETCH_HEAD", dir);
	// installed dependencies never count as the model's work, whether or not the repo ignores them
	appendFileSync(join(dir, ".git/info/exclude"), "node_modules/\n");
	const setup = task.setup ?? (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")) ? "bun install --frozen-lockfile" : "");
	if (setup) {
		const r = await sh(setup, dir, { timeoutS: 600 });
		if (r.code) throw new Error(`setup (${setup}) failed in ${dir}: ${r.out.trim().slice(-400)}`);
	}
}

/** lays the commit's hidden tests over the work and runs test_cmd */
async function runHidden(task: Task, dir: string, timeoutS: number, rev: "tests" | "all" = "tests"): Promise<{ pass: boolean; code: number; seconds: number; tail: string }> {
	await git(`fetch -q ${JSON.stringify(expand(task.repo))} ${task.commit}`, dir);
	if (rev === "all") await git("checkout -q -f FETCH_HEAD", dir);
	else await git(`checkout -q FETCH_HEAD -- ${task.hidden_tests.map((f) => JSON.stringify(f)).join(" ")}`, dir);
	const r = await sh(task.test_cmd, dir, { timeoutS, env: cleanEnv({ CMX2_PORT_SHIFT: String(arg("test-shift") ?? task.test_shift ?? 40) }) });
	return { pass: r.code === 0, code: r.code, seconds: r.seconds, tail: r.out.trim().split("\n").slice(-25).join("\n") };
}

// ---------- the daemon side ----------

interface Frame {
	directory?: string;
	payload: { type: string; properties: any };
}

/** frames from the daemon's global stream, collected until stopped */
function listen(d: Daemon) {
	const frames: Frame[] = [];
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${d.base}/global/event`, { headers: d.headers(), signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const chunk = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const data = chunk.split("\n").find((l) => l.startsWith("data: "));
					if (data) frames.push(JSON.parse(data.slice(6)));
				}
			}
		} catch {}
	})();
	return { frames, stop: () => ctl.abort() };
}

/** a session and everything under it, by parent links (the roster keeps only a few closed agents) */
async function tree(d: Daemon, rootId: string): Promise<Array<{ id: string; cost: number; title: string }>> {
	const out: Array<{ id: string; cost: number; title: string }> = [];
	const walk = async (id: string) => {
		const s = await d.api(`/session/${id}`);
		out.push({ id, cost: s.cost ?? 0, title: s.title });
		for (const c of (await d.api(`/session/${id}/children`)) as Array<{ id: string }>) await walk(c.id);
	};
	await walk(rootId);
	return out;
}

async function lastText(d: Daemon, id: string): Promise<string> {
	const msgs = (await d.api(`/session/${id}/message`)) as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
	const last = [...msgs].reverse().find((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text"));
	return (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

/** the user's providers, and the arm's routing file: its checkout's shipped default */
function configDir(dir: string, armRoot: string): string {
	mkdirSync(dir, { recursive: true });
	const owner = join(process.env.CMX2_M9_PROFILE ?? join(homedir(), ".config", "cmx2"), "cmx2.jsonc");
	if (existsSync(owner)) copyFileSync(owner, join(dir, "cmx2.jsonc"));
	else writeFileSync(join(dir, "cmx2.jsonc"), "{}\n");
	copyFileSync(join(armRoot, "examples/routing.jsonc"), join(dir, "routing.jsonc"));
	return dir;
}

/** the short commit a daemon runs from; arm a's worktree carries the knob patch, which shows as +eval-knob */
async function head(dir: string): Promise<string> {
	const at = await git("rev-parse --short HEAD", dir);
	return dir !== ROOT && (await sh("git diff --quiet", dir)).code ? `${at}+eval-knob` : at;
}

// ---------- one run ----------

type ArmName = "a" | "b" | "c";

export interface Row {
	at: string;
	arm: ArmName;
	task: string;
	trial: number;
	model: string;
	effort: string;
	/** the checkout the daemon ran from */
	daemon_commit: string;
	pass: boolean;
	test_exit: number | null;
	test_seconds: number | null;
	test_tail: string;
	files: string[];
	files_out: string[];
	cost: number;
	cost_root: number;
	cost_helpers: number;
	wall_s: number;
	steps: number;
	steps_root: number;
	helpers: Array<{ label: string; model: string; effort: string; state: string; steps: number; cost: number; agent_type?: string }>;
	step_ups: Array<{ from_model: string; from_effort: string; to_model: string; to_effort: string }>;
	escalations: number;
	review?: { blocking: number | null; cost: number; text: string };
	capped?: boolean;
	timed_out?: boolean;
	error_note?: string;
	error?: string;
}

async function armRoot(arm: ArmName): Promise<string> {
	if (arm !== "a") return ROOT;
	const dir = resolve(arg("a-root") ?? "/tmp/cmx2-m9-arm-a");
	if (!existsSync(join(dir, "packages/cli/src/index.ts"))) throw new Error(`arm a needs a checkout at ${dir}: run \`bun packages/eval/src/m9.ts prepare\` first`);
	return dir;
}

async function runOne(task: Task, arm: ArmName, trial: number, outFile: string): Promise<Row> {
	const id = idOf(task);
	const model = arg("model") ?? "anthropic/claude-opus-5-5";
	const effort = arg("effort") ?? "medium";
	const runId = `${id}.${arm}${trial}`;
	const scratch = `/tmp/cmx2-m9-${runId}-${nonce()}`;
	const root = await armRoot(arm);
	const row: Row = { at: new Date().toISOString(), arm, task: id, trial, model, effort, daemon_commit: await head(root), pass: false, test_exit: null, test_seconds: null, test_tail: "", files: [], files_out: [], cost: 0, cost_root: 0, cost_helpers: 0, wall_s: 0, steps: 0, steps_root: 0, helpers: [], step_ups: [], escalations: 0 };
	const proj = join(scratch, "proj");
	const runsDir = join(dirname(outFile), `${basename(outFile, ".jsonl")}-runs`);
	mkdirSync(runsDir, { recursive: true });
	let d: Daemon | undefined;
	let ev: ReturnType<typeof listen> | undefined;
	try {
		await scratchClone(task, proj);
		const config = configDir(join(scratch, "config"), root);
		d = new Daemon({
			port: num("port", port(4830)),
			dataDir: join(scratch, "data"),
			log: join(scratch, "daemon.log"),
			env: { CMX2_CONFIG_DIR: config, CMX2_EXCLUDE_TOOLS: arm === "c" ? "spawn,message,wait,agents,question" : "question" },
			...(arm === "a" ? { root } : {}),
		});
		await d.start();
		ev = listen(d);
		const s = await d.api("/session", { directory: proj, title: `it-m9-${runId}-${nonce()}`, model, effort });
		const t0 = Date.now();
		const ask = (task.prompt ?? (await git(`log -1 --format=%B ${task.commit}`, expand(task.repo)))).trim();
		await d.api(`/session/${s.id}/prompt_async`, { text: `${ask}\n\nnobody is here to answer questions; decide with what you have and say what you assumed.` });
		// the tree settles when the root is idle, no helper works or waits in the queue, and that stays true for three seconds
		const deadline = t0 + num("timeout", 30) * 60_000;
		const maxCost = num("max-cost", 20);
		let lastCostCheck = 0;
		let lastTotal = -1;
		let lastMove = Date.now();
		await Bun.sleep(2000);
		for (;;) {
			if (Date.now() > deadline) {
				row.timed_out = true;
				break;
			}
			if (Date.now() - lastCostCheck > 10_000) {
				lastCostCheck = Date.now();
				const total = (await tree(d, s.id)).reduce((n, x) => n + x.cost, 0);
				if (total > maxCost) {
					row.capped = true;
					break;
				}
				if (total !== lastTotal) {
					lastTotal = total;
					lastMove = Date.now();
				} else if (Date.now() - lastMove > num("stall", 8) * 60_000) {
					row.timed_out = true;
					row.error_note = `stalled: no cost for ${num("stall", 8)} minutes`;
					break;
				}
			}
			const st = await d.api("/session/status");
			const r = await d.api(`/session/${s.id}/agents`);
			const quiet = !st[s.id] && r.agents.every((a: any) => a.state !== "working" && a.state !== "queued");
			if (quiet) {
				await Bun.sleep(3000);
				const st2 = await d.api("/session/status");
				const r2 = await d.api(`/session/${s.id}/agents`);
				if (!st2[s.id] && r2.agents.every((a: any) => a.state !== "working" && a.state !== "queued")) break;
			}
			await Bun.sleep(1000);
		}
		row.wall_s = Math.round((Date.now() - t0) / 1000);
		if (row.capped || row.timed_out) {
			await d.raw(`/session/${s.id}/abort`, {}).catch(() => {});
			await Bun.sleep(1000);
		}
		await Bun.sleep(500);
		ev.stop();

		// metrics: every session under the main one
		const sessions = await tree(d, s.id);
		row.cost = sessions.reduce((n, x) => n + x.cost, 0);
		row.cost_root = sessions[0]!.cost;
		row.cost_helpers = row.cost - row.cost_root;
		const stepCounts = new Map<string, number>();
		for (const x of sessions) stepCounts.set(x.id, ((await d.api(`/session/${x.id}/steps`)) as unknown[]).length);
		row.steps = [...stepCounts.values()].reduce((a, b) => a + b, 0);
		row.steps_root = stepCounts.get(s.id) ?? 0;
		const agents = new Map<string, any>();
		for (const f of ev.frames) if ((f.payload.type === "agent.updated" || f.payload.type === "agent.spawned") && f.payload.properties.agent) agents.set(f.payload.properties.agent.id, f.payload.properties.agent);
		for (const x of sessions.slice(1)) {
			const a = agents.get(x.id) ?? (((await d.api(`/session/${s.id}/agents`)).agents as any[]).find((y) => y.id === x.id));
			row.helpers.push({ label: a?.seat ?? "?", model: a?.model ?? "?", effort: a?.effort ?? "?", state: a?.state ?? "?", steps: stepCounts.get(x.id) ?? 0, cost: x.cost, ...(a?.agentType ? { agent_type: a.agentType } : {}) });
		}
		row.escalations = ev.frames.filter((f) => f.payload.type === "session.escalated").length;
		try {
			const m = await d.api(`/session/${s.id}/agents/metrics`);
			row.step_ups = (m.events as any[]).filter((e) => e.kind === "step_up").map((e) => ({ from_model: e.from_model, from_effort: e.from_effort, to_model: e.to_model, to_effort: e.to_effort }));
		} catch {}

		// files touched, relative to base (new files count)
		await git("add -A", proj);
		row.files = (await git(`diff --cached --name-only ${task.base}`, proj)).split("\n").filter(Boolean);
		const allowed = new Set([...task.files, ...task.hidden_tests]);
		row.files_out = row.files.filter((f) => !allowed.has(f));
		writeFileSync(join(runsDir, `${runId}.diff`), await git(`diff --cached ${task.base}`, proj));

		if (flag("review") && !row.capped && !row.timed_out) {
			const rm = arg("review-model") ?? "anthropic/claude-opus-5-5";
			const rs = await d.api("/session", { directory: proj, title: `it-m9-review-${runId}-${nonce()}`, model: rm, effort: "medium" });
			const msg = task.prompt ?? (await git(`log -1 --format=%B ${task.commit}`, expand(task.repo)));
			await d.api(`/session/${rs.id}/prompt_async`, {
				text: `you review a change in this working copy. the base commit is ${task.base}; run \`git diff ${task.base}\` to see the change. it was asked to do this:\n\n${msg}\n\nread the diff and the code around it, run what you need to check it, and do not edit any file or start helpers. count blocking findings: a bug, behaviour the request names that is missing, or an existing behaviour the change breaks. style and taste are not blocking. end with one line, exactly: BLOCKING: <number>`,
			});
			await Bun.sleep(2000);
			await d.idle(rs.id, 15 * 60_000);
			const text = await lastText(d, rs.id);
			const n = text.match(/BLOCKING:\s*(\d+)/g)?.pop()?.match(/(\d+)/)?.[1];
			row.review = { blocking: n === undefined ? null : Number(n), cost: (await d.api(`/session/${rs.id}`)).cost ?? 0, text: text.slice(-1500) };
		}
	} catch (e) {
		row.error = String((e as Error).message ?? e).slice(0, 600);
	} finally {
		ev?.stop();
		if (d) await d.stop();
	}

	// the hidden tests, with no daemon of ours running
	if (!row.error && !row.capped && !row.timed_out) {
		try {
			const t = await runHidden(task, proj, num("test-timeout", 600));
			row.pass = t.pass;
			row.test_exit = t.code;
			row.test_seconds = t.seconds;
			row.test_tail = t.tail;
			writeFileSync(join(runsDir, `${runId}.test.txt`), t.tail);
		} catch (e) {
			row.error = String((e as Error).message ?? e).slice(0, 600);
		}
	}
	if (!flag("keep")) rmSync(scratch, { recursive: true, force: true });
	else console.log(`  kept ${scratch}`);
	return row;
}

// ---------- subcommands ----------

function outPath(): string {
	return resolve(arg("out") ?? join(dirname(tasksPath()), `m9-${new Date().toISOString().slice(0, 10)}.jsonl`));
}

function readRows(file: string): Row[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

async function list() {
	const tasks = loadTasks();
	console.log(`${tasks.length} tasks (${tasks.filter((t) => t.pilot).length} pilot) from ${tasksPath()}`);
	console.log("  id                          pilot  repo         commit   base_fails  commit_passes  test_s  files  test_cmd");
	for (const t of tasks) {
		console.log(`  ${idOf(t).padEnd(27)} ${(t.pilot ? "yes" : "").padEnd(6)} ${basename(expand(t.repo)).slice(0, 12).padEnd(12)} ${t.commit.slice(0, 7)}  ${String(t.base_fails ?? "?").padEnd(11)} ${String(t.commit_passes ?? "?").padEnd(14)} ${String(t.test_seconds ?? "?").padEnd(7)} ${String(t.files.length).padEnd(6)} ${t.test_cmd}`);
	}
}

/** the eval knob (CMX2_EXCLUDE_TOOLS for root sessions, and no routing text when spawn is excluded) in a v1 checkout's server hooks */
function patchKnob(dir: string) {
	const file = join(dir, "packages/server/src/index.ts");
	let src = readFileSync(file, "utf8");
	if (src.includes("CMX2_EXCLUDE_TOOLS")) return;
	const fn = "\tfunction hooks(id: string, directory: string, child = !!store.session(id)?.parent_id) {";
	if (!src.includes(fn)) throw new Error(`${file}: hooks() is not where the knob patch expects it`);
	src = src.replace(fn, `\t/** eval only (m9): CMX2_EXCLUDE_TOOLS takes tools away from root sessions */\n\tconst evalExclude = (process.env.CMX2_EXCLUDE_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean);\n\n${fn}`);
	const m = src.match(/\texcludeTools: (actors\.isChild\(id\) && .*? : \[\]),\n/);
	if (!m) throw new Error(`${file}: the excludeTools line is not where the knob patch expects it`);
	src = src.replace(m[0], `\texcludeTools: [...(${m[1]}), ...(child ? [] : evalExclude)],\n`);
	const r = '["routing", actors.routingText(id, model)]';
	if (!src.includes(r)) throw new Error(`${file}: the routing appendix is not where the knob patch expects it`);
	src = src.replace(r, '["routing", !child && evalExclude.includes("spawn") ? undefined : actors.routingText(id, model)]');
	writeFileSync(file, src);
}

async function prepare() {
	const dir = resolve(arg("a-root") ?? "/tmp/cmx2-m9-arm-a");
	const want = await git(`rev-parse ${arg("a-commit") ?? "8e78255"}`, ROOT);
	if (!existsSync(dir)) await git(`worktree add --detach ${JSON.stringify(dir)} ${want}`, ROOT);
	const at = await git("rev-parse HEAD", dir);
	if (at !== want) throw new Error(`${dir} is at ${at.slice(0, 7)}, not at ${want.slice(0, 7)}; remove it (git worktree remove --force) and run again`);
	patchKnob(dir);
	const r = await sh("bun install --frozen-lockfile", dir, { timeoutS: 600 });
	if (r.code) throw new Error(`bun install failed in ${dir}: ${r.out.slice(-400)}`);
	const routing = readFileSync(join(dir, "examples/routing.jsonc"), "utf8");
	console.log(`arm a: ${dir} at ${at.slice(0, 7)} with the eval knob patched in, installed in ${r.seconds} s`);
	console.log(`  its routing file ${join(dir, "examples/routing.jsonc")} is ${/"preset"|"seats"/.test(routing) ? "version 1 (seats)" : "NOT version 1: check --a-commit"}`);
}

async function check() {
	const all = loadTasks();
	const tasks = pick(all);
	console.log(`checking ${tasks.length} tasks: hidden tests must fail at base and pass at the commit (tests run with CMX2_PORT_SHIFT=${arg("test-shift") ?? "40, or the task's test_shift"})`);
	console.log("  id                          base      commit    seconds");
	for (const t of tasks) {
		const scratch = `/tmp/cmx2-m9-check-${idOf(t)}-${nonce()}`;
		try {
			await scratchClone(t, scratch);
			const atBase = await runHidden(t, scratch, num("test-timeout", 600));
			// the commit itself: tests and source
			await git("checkout -q -f FETCH_HEAD", scratch);
			const setup = t.setup ?? (existsSync(join(scratch, "bun.lock")) || existsSync(join(scratch, "bun.lockb")) ? "bun install --frozen-lockfile" : "");
			if (setup) await sh(setup, scratch, { timeoutS: 600 });
			const atCommit = await runHidden(t, scratch, num("test-timeout", 600), "all");
			t.base_fails = !atBase.pass;
			t.commit_passes = atCommit.pass;
			t.test_seconds = Math.max(atBase.seconds, atCommit.seconds);
			t.checked_at = new Date().toISOString().slice(0, 10);
			console.log(`  ${idOf(t).padEnd(27)} ${(atBase.pass ? "PASSES" : "fails").padEnd(9) } ${(atCommit.pass ? "passes" : "FAILS").padEnd(9)} ${t.test_seconds}`);
			if (atBase.pass || !atCommit.pass) console.log(`    ${(atBase.pass ? atCommit.tail : atCommit.tail).split("\n").slice(-4).join("\n    ")}`);
		} catch (e) {
			console.log(`  ${idOf(t).padEnd(27)} ERROR ${(e as Error).message.slice(0, 200)}`);
		} finally {
			if (!flag("keep")) rmSync(scratch, { recursive: true, force: true });
		}
	}
	if (flag("write")) {
		writeFileSync(tasksPath(), `${JSON.stringify(all, null, "\t")}\n`);
		console.log(`wrote the check results into ${tasksPath()}`);
	}
}

async function run() {
	const tasks = pick(loadTasks());
	const arms = (arg("arm") ?? "a,b,c").split(",") as ArmName[];
	for (const a of arms) if (!["a", "b", "c"].includes(a)) throw new Error(`unknown arm ${a}; a, b or c`);
	const trials = num("trials", flag("pilot") ? 1 : 2);
	const out = outPath();
	mkdirSync(dirname(out), { recursive: true });
	const done = new Set(readRows(out).map((r) => `${r.arm}/${r.task}/${r.trial}`));
	const cmx2 = await head(ROOT);
	console.log(`m9: ${tasks.length} tasks x ${trials} trials x arms ${arms.join(",")}; main ${arg("model") ?? "anthropic/claude-opus-5-5"} at ${arg("effort") ?? "medium"}; this checkout ${cmx2}${arms.includes("a") ? `; arm a ${await head(await armRoot("a"))}` : ""}; results ${out}`);
	for (const t of tasks) {
		for (let trial = 1; trial <= trials; trial++) {
			for (const arm of arms) {
				const key = `${arm}/${idOf(t)}/${trial}`;
				if (done.has(key) && !flag("redo")) {
					console.log(`skip ${key} (already in ${basename(out)})`);
					continue;
				}
				console.log(`run ${key} ...`);
				const row = await runOne(t, arm, trial, out);
				appendFileSync(out, `${JSON.stringify(row)}\n`);
				console.log(`  ${row.error ? `ERROR ${row.error}` : row.capped ? "CAPPED" : row.timed_out ? "TIMED OUT" : row.pass ? "pass" : "FAIL"}  $${row.cost.toFixed(2)} (root $${row.cost_root.toFixed(2)}, helpers $${row.cost_helpers.toFixed(2)})  ${row.wall_s}s  ${row.steps} steps  ${row.helpers.length} helpers${row.helpers.length ? ` [${row.helpers.map((h) => `${h.label}@${h.effort}`).join(" ")}]` : ""}  ${row.step_ups.length} step-ups  files ${row.files.length}${row.files_out.length ? ` (${row.files_out.length} out of scope)` : ""}${row.review ? `  review blocking ${row.review.blocking}` : ""}`);
			}
		}
	}
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

function table() {
	const files = argv.slice(1).filter((a) => !a.startsWith("--"));
	const rows = (files.length ? files : [outPath()]).flatMap((f) => readRows(f));
	if (!rows.length) throw new Error("no rows; run first, or pass a results file");
	const label: Record<string, string> = { a: "a seats (v1)", b: "b table (v2)", c: "c alone" };
	console.log(`${rows.length} runs; main ${[...new Set(rows.map((r) => `${r.model} ${r.effort}`))].join(", ")}; daemons ${[...new Set(rows.map((r) => `${r.arm}:${r.daemon_commit}`))].join(" ")}\n`);
	console.log("arm            runs  pass      mean $   total $   median min  mean steps  helpers  step-ups  out-of-scope files  errors  review blocking");
	for (const arm of ["a", "b", "c"]) {
		const rs = rows.filter((r) => r.arm === arm);
		if (!rs.length) continue;
		const ok = rs.filter((r) => !r.error);
		const reviewed = rs.filter((r) => r.review?.blocking != null);
		console.log(
			`${label[arm]!.padEnd(14)} ${String(rs.length).padEnd(5)} ${`${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(9)} ${mean(ok.map((r) => r.cost)).toFixed(2).padStart(6)}   ${ok.reduce((n, r) => n + r.cost, 0).toFixed(2).padStart(7)}   ${(median(ok.map((r) => r.wall_s)) / 60).toFixed(1).padStart(9)}   ${mean(ok.map((r) => r.steps)).toFixed(0).padStart(9)}   ${mean(ok.map((r) => r.helpers.length)).toFixed(1).padStart(6)}   ${mean(ok.map((r) => r.step_ups.length)).toFixed(2).padStart(7)}   ${mean(ok.map((r) => r.files_out.length)).toFixed(2).padStart(17)}   ${String(rs.filter((r) => r.error || r.capped || r.timed_out).length).padEnd(6)}  ${reviewed.length ? mean(reviewed.map((r) => r.review!.blocking!)).toFixed(2) : "-"}`,
		);
	}
	console.log("\nper task (pass/trials, mean $):");
	console.log(`  ${"task".padEnd(28)} ${["a", "b", "c"].map((a) => `${a}`.padEnd(16)).join(" ")}`);
	for (const t of [...new Set(rows.map((r) => r.task))]) {
		const cell = (arm: string) => {
			const rs = rows.filter((r) => r.task === t && r.arm === arm);
			return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length} $${mean(rs.map((r) => r.cost)).toFixed(2)}`.padEnd(16) : "-".padEnd(16);
		};
		console.log(`  ${t.padEnd(28)} ${cell("a")} ${cell("b")} ${cell("c")}`);
	}
	for (const arm of ["a", "b"]) {
		const hs = rows.filter((r) => r.arm === arm).flatMap((r) => r.helpers);
		if (!hs.length) continue;
		console.log(`\narm ${arm}: helpers by label and effort`);
		const by = new Map<string, { n: number; cost: number; steps: number }>();
		for (const h of hs) {
			const k = `${h.label} @ ${h.effort}`;
			const v = by.get(k) ?? { n: 0, cost: 0, steps: 0 };
			v.n++;
			v.cost += h.cost;
			v.steps += h.steps;
			by.set(k, v);
		}
		for (const [k, v] of [...by.entries()].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)} spawns  mean $${(v.cost / v.n).toFixed(3)}  mean steps ${(v.steps / v.n).toFixed(0)}`);
	}
	const ups = rows.flatMap((r) => r.step_ups);
	if (ups.length) {
		console.log(`\nstep-ups (${ups.length}):`);
		const by = new Map<string, number>();
		for (const u of ups) by.set(`${u.from_model} ${u.from_effort} -> ${u.to_model} ${u.to_effort}`, (by.get(`${u.from_model} ${u.from_effort} -> ${u.to_model} ${u.to_effort}`) ?? 0) + 1);
		for (const [k, n] of by) console.log(`  ${String(n).padStart(3)}  ${k}`);
	}
}

if (import.meta.main) {
	const which = argv[0] ?? "list";
	try {
		if (which === "list") await list();
		else if (which === "prepare") await prepare();
		else if (which === "check") await check();
		else if (which === "run") await run();
		else if (which === "table") table();
		else throw new Error(`unknown m9 command ${which}; one of list, prepare, check, run, table`);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
	process.exit(0);
}
