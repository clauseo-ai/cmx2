/**
 * m0 comparison: the same three VERIFICATION tasks on cmx2 (daemon over http) and on cmx (`cmx run`),
 * against separate scratch clones. repo paths come from env so nothing private lives here:
 *   CMX2_TASK_WEB=<next.js web client repo> CMX2_TASK_MONO=<large ts monorepo> CMX2_TASK_FN=<function name>
 *   bun src/tasks.ts
 * against a daemon that is already running (an installed service) instead of a throwaway one, cmx2 only,
 * with an earlier run's json rows printed beside the new ones:
 *   CMX2_TASK_BASE=http://127.0.0.1:<port> CMX2_TASK_PASSWORD=... CMX2_TASK_ONLY=cmx2 CMX2_TASK_BASELINE=<rows.jsonl>
 * the dev-server task asks for port 4836 unless CMX2_TASK_DEV_PORT names another
 * its sessions are archived at the end (archived, not deleted: they stay in the store).
 */
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

const WEB = process.env.CMX2_TASK_WEB!;
const MONO = process.env.CMX2_TASK_MONO!;
const FN = process.env.CMX2_TASK_FN ?? "findMessage";
const CMX_DB = process.env.CMX_DB ?? join(homedir(), ".local/share/opencode/opencode.db");
const MODEL = "anthropic/claude-opus-5-5";
const EFFORT = "medium";
const PORT = 4830;
/** the port the dev-server task asks for; a lane on other ports moves it with CMX2_TASK_DEV_PORT */
const DEV_PORT = Number(process.env.CMX2_TASK_DEV_PORT) || 4836;
const BASE = process.env.CMX2_TASK_BASE?.replace(/\/$/, "");
const PASSWORD = process.env.CMX2_TASK_PASSWORD;
const ONLY = process.env.CMX2_TASK_ONLY;
const BASELINE = process.env.CMX2_TASK_BASELINE;
const nonce = Math.random().toString(36).slice(2, 7);
const root = `/tmp/cmx2-tasks-${nonce}`;

interface Row {
	task: string;
	system: string;
	steps: number;
	calls: number;
	cache: string;
	ttft: string;
	cost: number;
	wall_s: number;
	rss_mb: number;
	outcome: string;
}

const tasks = [
	{
		key: "1 decoder",
		repo: "web",
		prompt: (_dir: string) =>
			"this web client decodes server-sent events from a coding-agent daemon. add a typed decoder for a new event `session.parked` with properties `{ sessionID: string, agents: number, jobs: number }`, following how existing events are decoded, and add a pinned decode test next to the existing tests. run that test with bun test and make sure it passes. do not change unrelated files.",
	},
	{
		key: "2 callers",
		repo: "mono",
		prompt: () =>
			`find every call site of the function \`${FN}\` across this repository (not its definition) and summarise each: file path, line, and what the caller uses it for. read only; change nothing.`,
	},
	{
		key: "3 dev server",
		repo: "web",
		prompt: (_dir: string, port: number) =>
			`start this project's dev server on port ${port}, wait until it answers http requests, fetch / and report the http status code and the page <title>, then stop the dev server and confirm nothing is still listening on ${port}.`,
	},
];

async function sh(cmd: string): Promise<string> {
	return (await $`sh -c ${cmd}`.nothrow().quiet()).stdout.toString();
}

async function listeners(port: number): Promise<string[]> {
	return (await sh(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`)).split("\n").filter(Boolean);
}

function rssPoller(pidOf: () => Promise<number[]>) {
	let peak = 0;
	const t = setInterval(async () => {
		for (const pid of await pidOf()) {
			const kb = Number((await sh(`ps -o rss= -p ${pid}`)).trim()) || 0;
			peak = Math.max(peak, kb);
		}
	}, 1000);
	return () => {
		clearInterval(t);
		return Math.round(peak / 1024);
	};
}

async function check(taskKey: string, dir: string, answer: string, port: number, truth: string[]): Promise<string> {
	if (taskKey.startsWith("1")) {
		const changed = (await sh(`cd ${dir} && git status --porcelain`)).split("\n").filter(Boolean);
		const tests = changed.map((l) => l.slice(3).trim()).filter((f) => /\.test\.tsx?$/.test(f));
		if (!tests.length) return `fail: no test file changed (${changed.length} files changed)`;
		const r = await $`sh -c ${`cd ${dir} && bun test ${tests.map((t) => `./${t}`).join(" ")}`}`.nothrow().quiet();
		return r.exitCode === 0 ? `pass: ${tests.join(",")} green, ${changed.length} files changed` : `fail: bun test exit ${r.exitCode}`;
	}
	if (taskKey.startsWith("2")) {
		const found = truth.filter((f) => answer.includes(f.split("/").pop()!));
		return `${found.length === truth.length ? "pass" : "partial"}: ${found.length}/${truth.length} caller files named`;
	}
	const left = await listeners(port);
	const status = /\b200\b/.test(answer) ? "status 200 reported" : "no 200 in answer";
	if (left.length) await sh(`kill ${left.join(" ")}`);
	return `${left.length === 0 && status.startsWith("status") ? "pass" : "fail"}: ${status}, orphans on ${port} after: ${left.length}`;
}

async function clones(system: string) {
	const web = `${root}/${system}-web`;
	const mono = `${root}/${system}-mono`;
	await sh(`mkdir -p ${root} && cp -c -R ${WEB} ${web} && rm -rf ${web}/.next && git clone -q --shared ${MONO} ${mono}`);
	return { web, mono };
}

async function groundTruth(mono: string): Promise<string[]> {
	const out = await sh(`cd ${mono} && rg -l "\\b${FN}\\(" --glob '!**/*.test.ts' . | xargs rg -n "\\b${FN}\\(" | rg -v "(function|async|const|let) +${FN}\\b|^[^:]+:[0-9]+:\\s*(export )?(async )?${FN}\\(" | cut -d: -f1 | sort -u`);
	return out.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
}

// ---------- cmx2 ----------
async function runCmx2(): Promise<Row[]> {
	const { web, mono } = await clones("cmx2");
	const truth = await groundTruth(mono);
	console.log(`ground truth callers of ${FN}: ${truth.join(", ")}`);
	const daemon = BASE
		? undefined
		: Bun.spawn(["bun", "packages/cli/src/index.ts", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
				cwd: join(import.meta.dir, "../../.."),
				env: { ...process.env, CMX2_DATA_DIR: `${root}/cmx2-data` },
				stdout: "ignore",
				stderr: "inherit",
			});
	if (daemon) await Bun.sleep(2500);
	const base = BASE ?? `http://127.0.0.1:${PORT}`;
	const auth: Record<string, string> = PASSWORD ? { authorization: `Basic ${btoa(`cmx2:${PASSWORD}`)}` } : {};
	const api = async (p: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
		const r = await fetch(base + p, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		if (!r.ok) throw new Error(`${method} ${p} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
		return r.json() as Promise<any>;
	};
	const pid: number = daemon?.pid ?? (await api("/global/health")).pid;
	const made: string[] = [];
	const rows: Row[] = [];
	try {
		for (const t of tasks) {
			const dir = t.repo === "web" ? web : mono;
			const stopRss = rssPoller(async () => [pid]);
			const t0 = performance.now();
			const s = await api("/session", { directory: dir, title: `it-m0-task-${nonce}`, model: MODEL, effort: EFFORT });
			made.push(s.id);
			await api(`/session/${s.id}/prompt`, { text: t.prompt(dir, DEV_PORT) });
			await Bun.sleep(500);
			for (;;) {
				const st = await api("/session/status");
				if (st[s.id] === undefined || st[s.id].type === "idle") break;
				if (performance.now() - t0 > 20 * 60_000) break;
				await Bun.sleep(1000);
			}
			const wall = (performance.now() - t0) / 1000;
			const steps: any[] = await api(`/session/${s.id}/steps`);
			const msgs: any[] = await api(`/session/${s.id}/messages`);
			const answer = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text)).join("\n");
			const read = steps.reduce((a, r) => a + r.cache_read, 0);
			const all = steps.reduce((a, r) => a + r.cache_read + r.cache_write + r.input, 0);
			const ttfts = steps.map((r) => r.ttft_ms).filter((x) => x != null).sort((a, b) => a - b);
			rows.push({
				task: t.key,
				system: "cmx2",
				steps: steps.length,
				calls: steps.reduce((a, r) => a + r.tool_calls, 0),
				cache: all ? `${((100 * read) / all).toFixed(1)}%` : "n/a",
				ttft: ttfts.length ? `${(ttfts[Math.floor(ttfts.length / 2)] / 1000).toFixed(1)}s` : "n/a",
				cost: steps.reduce((a, r) => a + r.cost, 0),
				wall_s: Math.round(wall),
				rss_mb: stopRss(),
				outcome: await check(t.key, dir, answer, DEV_PORT, truth),
			});
			console.log(JSON.stringify(rows.at(-1)));
		}
	} finally {
		if (daemon) {
			daemon.kill();
			await daemon.exited;
		} else for (const id of made) await api(`/session/${id}`, undefined, "DELETE").catch((e) => console.error(`could not archive ${id}: ${e}`));
	}
	return rows;
}

// ---------- cmx ----------
async function runCmx(): Promise<Row[]> {
	const { web, mono } = await clones("cmx");
	const truth = await groundTruth(mono);
	const rows: Row[] = [];
	for (const t of tasks) {
		const dir = t.repo === "web" ? web : mono;
		const title = `it-m0-cmx-${t.key.split(" ")[0]}-${nonce}`;
		const t0 = performance.now();
		const proc = Bun.spawn(
			["cmx", "run", "--dir", dir, "-m", MODEL, "--variant", EFFORT, "--title", title, "--dangerously-skip-permissions", t.prompt(dir, 4837)],
			{ cwd: dir, env: { ...process.env, OPENCODE_DISABLE_CHANNEL_DB: "true" }, stdout: "pipe", stderr: "pipe" },
		);
		const stopRss = rssPoller(async () => [proc.pid]);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const wall = (performance.now() - t0) / 1000;
		const db = new Database(CMX_DB, { readonly: true });
		const ses = db.query("select id from session where title = ? order by time_created desc limit 1").get(title) as { id: string } | null;
		let steps = 0,
			calls = 0,
			read = 0,
			all = 0,
			cost = 0;
		if (ses) {
			const ids = (db.query("select id from session where id = ? or parent_id = ?").all(ses.id, ses.id) as { id: string }[]).map((r) => r.id);
			for (const id of ids) {
				for (const { data } of db.query("select data from part where session_id = ?").all(id) as { data: string }[]) {
					const p = JSON.parse(data);
					if (p.type === "step-finish") {
						steps++;
						cost += p.cost ?? 0;
						read += p.tokens?.cache?.read ?? 0;
						all += (p.tokens?.input ?? 0) + (p.tokens?.cache?.read ?? 0) + (p.tokens?.cache?.write ?? 0);
					}
					if (p.type === "tool") calls++;
				}
			}
		}
		db.close();
		rows.push({
			task: t.key,
			system: "cmx",
			steps,
			calls,
			cache: all ? `${((100 * read) / all).toFixed(1)}%` : "n/a",
			ttft: "not recorded",
			cost,
			wall_s: Math.round(wall),
			rss_mb: stopRss(),
			outcome: ses ? await check(t.key, dir, out, 4837, truth) : `fail: no session titled ${title}`,
		});
		console.log(JSON.stringify(rows.at(-1)));
	}
	return rows;
}

const baseline: Array<Row & { system: string }> = BASELINE
	? (await Bun.file(BASELINE).text())
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => ({ ...JSON.parse(l), system: `${JSON.parse(l).system} (baseline)` }))
	: [];
const rows = [...(await runCmx2()), ...(ONLY === "cmx2" ? [] : await runCmx()), ...baseline];
console.log(`\n| task | system | steps | tool calls | calls/step | cache-read | median ttft | cost $ | wall s | peak rss MB | outcome |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows.sort((a, b) => a.task.localeCompare(b.task) || a.system.localeCompare(b.system))) {
	console.log(`| ${r.task} | ${r.system} | ${r.steps} | ${r.calls} | ${r.steps ? (r.calls / r.steps).toFixed(2) : "n/a"} | ${r.cache} | ${r.ttft} | ${r.cost.toFixed(3)} | ${r.wall_s} | ${r.rss_mb} | ${r.outcome} |`);
}
console.log(`\nscratch: ${root}`);
