/**
 * m5 gate driver: real daemons on dev ports (never 4096), the real provider path, cleanup at exit.
 *   bun packages/eval/src/m5.ts refusal     a vertex content-filter stop surfaces as a typed refusal (port 4835)
 *   bun packages/eval/src/m5.ts rss300k     three sessions holding ~300k tokens each run one turn at once; rss sampled every 250 ms (port 4836)
 *   bun packages/eval/src/m5.ts team        two sonnet helpers in parallel, an opus review helper, the root parked between, a follow-up to a parked helper (port 4834)
 *   bun packages/eval/src/m5.ts warm        cache-read on the first turn after a park longer than the ttl, with and without warming (port 4834)
 *   bun packages/eval/src/m5.ts escalate    a check failing right after an edit raises the next turn's effort (port 4834)
 *   bun packages/eval/src/m5.ts idle        rss at boot, after a turn and two parked agents, then each minute for ten idle minutes (port 4839)
 * flags: --port n, --data dir, --model provider/id
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daemon, gitRepo, nonce, ROOT } from "./harness.ts";

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const cleanups: Array<() => Promise<unknown> | unknown> = [];

async function startDaemon(which: string, port: number, scratch: string, env: Record<string, string> = {}) {
	const d = new Daemon({ port, dataDir: arg("data") ?? join(scratch, "data"), log: join(scratch, "daemon.log"), env });
	await d.start();
	cleanups.push(() => d.stop());
	console.log(`daemon pid ${d.pid} on ${port}, data ${d.opts.dataDir} (${which})`);
	return d;
}

function scratchDir(which: string): string {
	const dir = `/tmp/cmx2-m5-${which}-${nonce()}`;
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** frames from the daemon's global stream, collected until `stop()` */
function listen(d: Daemon) {
	const frames: Array<{ directory?: string; payload: { type: string; properties: any } }> = [];
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
	cleanups.push(() => ctl.abort());
	return { frames, stop: () => ctl.abort() };
}

function stepTable(steps: any[]) {
	console.log("  step  model                        effort  in       cache_r   cache_w   out    stop_reason  refusal");
	for (const s of steps) {
		console.log(
			`  ${String(s.seq).padEnd(5)} ${s.model.padEnd(28)} ${String(s.effort).padEnd(7)} ${String(s.input).padEnd(8)} ${String(s.cache_read).padEnd(9)} ${String(s.cache_write).padEnd(9)} ${String(s.output).padEnd(6)} ${String(s.stop_reason).padEnd(12)} ${s.refusal ?? "-"}`,
		);
	}
}

// ---------- a vertex content-filter stop as a typed refusal ----------
async function refusal() {
	const scratch = scratchDir("refusal");
	const d = await startDaemon("refusal", Number(arg("port") ?? 4835), scratch);
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const ev = listen(d);
	const model = arg("model") ?? "anthropic/claude-sonnet-5-5";
	const s = await d.api("/session", { directory: proj, title: `it-m5-refusal-${nonce()}`, model, effort: "low" });
	console.log(`session ${s.id} on ${model} at low effort`);
	// the prompt vertex's output filter is known to stop (GOTCHAS, m3/m4 boxbox drive)
	const res = await d.raw(`/session/${s.id}/message`, { parts: [{ type: "text", text: "count from one to three hundred in words, one number per line, nothing else" }] });
	const body = await res.text();
	console.log(`POST /message → ${res.status}; assistant message error: ${JSON.stringify(JSON.parse(body.trim() || "null")?.info?.error ?? null)}`);
	await d.idle(s.id);
	await Bun.sleep(300);
	ev.stop();
	const errors = ev.frames.filter((f) => f.payload.type === "session.error" && f.payload.properties.sessionID === s.id);
	console.log(`session.error events: ${errors.length}`);
	for (const e of errors) console.log(`  ${JSON.stringify(e.payload.properties)}`);
	const steps = await d.api(`/session/${s.id}/steps`);
	stepTable(steps);
	const last = steps.at(-1);
	const typed = errors.some((e) => e.payload.properties.error?.name === "RefusalError") && last?.stop_reason === "refusal";
	console.log(typed ? `result: typed refusal, classifier ${last.refusal}` : "result: NOT a typed refusal (see above)");
	await d.api(`/session/${s.id}`, undefined, "DELETE");
	return typed;
}

// ---------- three sessions at ~300k tokens, one concurrent turn each, rss sampled ----------

/** real source text to read back as tool results: this repo's typescript, then pi's shipped javascript */
function corpus(): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const walk = (dir: string, ext: RegExp) => {
		for (const f of readdirSync(dir).sort()) {
			if (f === "node_modules" || f.startsWith(".")) continue;
			const p = join(dir, f);
			const st = statSync(p);
			if (st.isDirectory()) walk(p, ext);
			else if (ext.test(f) && st.size > 2_000 && st.size < 120_000) out.push({ path: relative(ROOT, p), text: readFileSync(p, "utf8") });
		}
	};
	walk(join(ROOT, "packages"), /\.ts$/);
	const pi = join(ROOT, "node_modules/.bun");
	for (const d of readdirSync(pi).filter((x) => x.startsWith("@earendil-works+pi-ai@") || x.startsWith("@earendil-works+pi-agent-core@"))) {
		const name = d.startsWith("@earendil-works+pi-ai@") ? "pi-ai" : "pi-agent-core";
		walk(join(pi, d, "node_modules/@earendil-works", name, "dist"), /\.js$/);
	}
	return out;
}

/**
 * appends read calls and their results to a transcript until it holds `chars` characters of file
 * content, in the shapes the engine writes (assistant toolCall, toolResult, a short assistant note).
 */
function seed(file: string, files: Array<{ path: string; text: string }>, chars: number, model: string): number {
	let total = 0;
	let n = 0;
	const at = Date.now() - 3_600_000;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const line = (message: unknown) => `${JSON.stringify({ type: "message", message })}\n`;
	let out = line({ role: "user", content: "read through the codebase so you can answer questions about it; keep your notes short", timestamp: at });
	for (let i = 0; total < chars; i = (i + 1) % files.length) {
		const f = files[i]!;
		const id = `toolu_seed_${String(++n).padStart(4, "0")}`;
		out += line({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: f.path } }], api: "anthropic-messages", provider: "anthropic", model, usage, stopReason: "toolUse", timestamp: at + n });
		const numbered = f.text
			.split("\n")
			.map((l, k) => `${String(k + 1).padStart(6)}\t${l}`)
			.join("\n");
		out += line({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: numbered }], isError: false, timestamp: at + n });
		total += numbered.length;
	}
	out += line({ role: "assistant", content: [{ type: "text", text: `read ${n} files; ready for questions.` }], api: "anthropic-messages", provider: "anthropic", model, usage, stopReason: "stop", timestamp: at + n + 1 });
	appendFileSync(file, out);
	return n;
}

function pct(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
}

async function rss300k() {
	const scratch = scratchDir("rss300k");
	const d = await startDaemon("rss300k", Number(arg("port") ?? 4836), scratch);
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const model = arg("model") ?? "anthropic/claude-sonnet-5-5";
	// numbered source tokenizes at about 2.5 characters per token on claude: 800k characters is ~320k tokens
	const chars = Number(arg("chars") ?? 800_000);
	const samples: Array<{ t: number; mb: number; phase: string }> = [];
	let phase = "boot";
	const t0 = Date.now();
	const timer = setInterval(() => samples.push({ t: Date.now() - t0, mb: d.rssMb(), phase }), 250);
	cleanups.push(() => clearInterval(timer));
	await Bun.sleep(2000);

	const files = corpus();
	console.log(`corpus: ${files.length} files, ${(files.reduce((a, f) => a + f.text.length, 0) / 1e6).toFixed(2)} M chars; seeding ${(chars / 1e6).toFixed(2)} M chars per session`);
	phase = "seed";
	const tag = nonce();
	const ids: string[] = [];
	for (let k = 0; k < 3; k++) {
		const s = await d.api("/session", { directory: proj, title: `it-m5-rss300k-${tag}-${k}`, model, effort: "low" });
		// a different rotation of the corpus per session, so the three contexts are not one shared cache entry
		const rotated = [...files.slice(k * 7), ...files.slice(0, k * 7)];
		const reads = seed(join(d.opts.dataDir, "sessions", `${s.id}.jsonl`), rotated, chars, model.split("/")[1]!);
		ids.push(s.id);
		console.log(`  ${s.id}: ${reads} read results appended to its transcript`);
	}
	await Bun.sleep(2000);
	const seeded = d.rssMb();

	phase = "turns";
	const tt = Date.now();
	const prompts = ["which file defines the Transcript class? one line.", "which file defines the Procs class? one line.", "which file defines the Store class? one line."];
	await Promise.all(ids.map((id, k) => d.api(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: prompts[k] }] }, "POST").catch((e) => console.log(`  prompt ${id} failed: ${e}`))));
	await Promise.all(ids.map((id) => d.idle(id, 15 * 60_000)));
	const turnMs = Date.now() - tt;
	phase = "settled";
	await Bun.sleep(10_000);
	clearInterval(timer);

	console.log(`\nturns: three concurrent, ${Math.round(turnMs / 1000)} s wall`);
	let counted = 0;
	for (const id of ids) {
		const steps = await d.api(`/session/${id}/steps`);
		const s = steps.at(-1);
		const ctx = s ? s.input + s.cache_read + s.cache_write : 0;
		if (ctx >= 300_000) counted++;
		const msgs = await d.api(`/session/${id}/message?limit=1`);
		const text = (msgs.at(-1)?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ").slice(0, 100);
		console.log(`  ${id}: context ${ctx} tokens (input ${s?.input} + cache_read ${s?.cache_read} + cache_write ${s?.cache_write}), stop ${s?.stop_reason}, ${ctx >= 300_000 ? "counts" : "UNDER 300k"}; answer: ${JSON.stringify(text)}`);
	}
	const of = (p: string) => samples.filter((s) => s.phase === p).map((s) => s.mb);
	console.log("\nrss (MB), sampled every 250 ms from ps:");
	for (const p of ["boot", "seed", "turns", "settled"]) {
		const xs = of(p);
		console.log(`  ${p.padEnd(8)} samples ${String(xs.length).padEnd(5)} median ${pct(xs, 50).toFixed(1).padStart(6)}  p95 ${pct(xs, 95).toFixed(1).padStart(6)}  peak ${Math.max(0, ...xs).toFixed(1).padStart(6)}`);
	}
	const peak = Math.max(0, ...of("turns"), ...of("settled"));
	const mem = await d.api("/global/memory");
	console.log(`  after seeding (idle, before the turns): ${seeded} MB; /global/memory after settle: rss ${(mem.rss / 1048576).toFixed(1)} MB, heapUsed ${(mem.heapUsed / 1048576).toFixed(1)} MB, live_sessions ${mem.live_sessions}, contract_violations ${mem.contract_violations}`);
	console.log(`\nresult: ${counted}/3 sessions at >= 300k tokens; peak rss during and after the turns ${peak.toFixed(1)} MB (budget 400) → ${counted === 3 && peak < 400 ? "within budget" : "NOT within budget or under 300k"}`);
	for (const id of ids) await d.api(`/session/${id}`, undefined, "DELETE");
	return counted === 3 && peak < 400;
}

// ---------- agents: two helpers in parallel, a review helper, root parked between, a follow-up to a parked helper ----------

const TEAM_REPO: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "team-eval", private: true, type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
	"src/math.ts": "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
	"src/strings.ts": "export function shout(s: string): string {\n\treturn s.toUpperCase();\n}\n",
	"test/math.test.ts": 'import { expect, test } from "bun:test";\nimport { add, multiply } from "../src/math.ts";\n\ntest("add", () => expect(add(2, 3)).toBe(5));\ntest("multiply", () => expect(multiply(4, 5)).toBe(20));\n',
	"test/strings.test.ts":
		'import { expect, test } from "bun:test";\nimport { capitalize, shout } from "../src/strings.ts";\n\ntest("shout", () => expect(shout("hi")).toBe("HI"));\ntest("capitalize", () => expect(capitalize("hello world")).toBe("Hello world"));\n',
};

function stepsLine(label: string, steps: any[]) {
	const calls = steps.reduce((n, s) => n + s.calls, 0);
	const input = steps.reduce((n, s) => n + s.input + s.cache_read + s.cache_write, 0);
	const read = steps.reduce((n, s) => n + s.cache_read, 0);
	const efforts = [...new Set(steps.map((s) => s.effort))].join("/");
	console.log(
		`  ${label.padEnd(26)} steps ${String(steps.length).padStart(3)}  calls ${String(calls).padStart(3)}  calls/step ${(steps.length ? calls / steps.length : 0).toFixed(2).padStart(5)}  cache-read ${(input ? (100 * read) / input : 0).toFixed(1).padStart(5)}%  poll-only ${steps.filter((x) => x.poll_only).length}  effort ${efforts}  cost $${steps.reduce((n, s) => n + s.cost, 0).toFixed(4)}`,
	);
}

async function team() {
	const scratch = scratchDir("team");
	const d = await startDaemon("team", Number(arg("port") ?? 4834), scratch);
	const proj = join(scratch, "proj");
	await gitRepo(proj, TEAM_REPO);
	const ev = listen(d);
	const root = await d.api("/session", { directory: proj, title: `it-m5-team-${nonce()}`, ...(arg("model") ? { model: arg("model") } : {}) });
	console.log(`root ${root.id} on ${root.model.providerID}/${root.model.id} (effort ${root.effort}); routing: the daemon's routing.jsonc (the shipped table unless the profile has one)`);
	const t0 = Date.now();
	const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
	// sampled roster and root status: helpers working at once, and the root parked while they work
	let maxEngineers = 0;
	let parkedWhileWorking = 0;
	let samples = 0;
	const timeline: string[] = [];
	let last = "";
	const sampler = setInterval(async () => {
		try {
			const [r, st] = await Promise.all([d.api(`/session/${root.id}/agents`), d.api(`/session/${root.id}`)]);
			const kids = r.agents.filter((a: any) => a.depth === 1);
			const working = kids.filter((a: any) => a.state === "working");
			maxEngineers = Math.max(maxEngineers, working.filter((a: any) => a.seat === "sonnet").length);
			samples++;
			const rootState = st.status?.type === "busy" ? "busy" : st.status?.parked ? `parked(${st.status.parked.agents} agents, ${st.status.parked.jobs} jobs)` : "idle";
			if (rootState.startsWith("parked") && working.length) parkedWhileWorking++;
			const line = `root ${rootState}; ${kids.map((a: any) => `${a.name}[${a.seat}] ${a.state}`).join(", ") || "no agents"}`;
			if (line !== last) timeline.push(`  ${at().padStart(7)}  ${line}`);
			last = line;
		} catch {}
	}, 500);
	cleanups.push(() => clearInterval(sampler));
	const settledAll = async (what: string) => {
		await d.until(
			async () => {
				const st = await d.api("/session/status");
				const r = await d.api(`/session/${root.id}/agents`);
				return !st[root.id] && r.agents.every((a: any) => a.state !== "working" && a.state !== "queued") ? true : undefined;
			},
			what,
			25 * 60_000,
		);
		await Bun.sleep(3000);
		const st = await d.api("/session/status");
		if (st[root.id]) await settledAll(what);
	};
	await d.api(`/session/${root.id}/prompt_async`, {
		text: "two independent fixes in this repo. one: make test/math.test.ts pass by adding multiply to src/math.ts. two: make test/strings.test.ts pass by adding capitalize to src/strings.ts. give each fix to its own helper on sonnet so they run at the same time, and once both have reported, have a helper on opus (agent type review) check both changes and run bun test for the whole repo. leave the edits to them.",
	});
	await settledAll("the first task (helpers and the review helper) to settle");
	console.log(`first task settled at ${at()}`);
	const engineers = (await d.api(`/session/${root.id}/agents`)).agents.filter((a: any) => a.seat === "sonnet");
	const mul = engineers.find((a: any) => (a.files ?? []).some((f: string) => f.includes("math"))) ?? engineers[0];
	await d.api(`/session/${root.id}/prompt_async`, {
		text: `now the helper who wrote multiply (${mul?.path ?? "the math helper"}) should also add divide to src/math.ts, throwing on division by zero, with tests in test/math.test.ts. send this to that same helper; it still has the context.`,
	});
	await settledAll("the follow-up to settle");
	clearInterval(sampler);
	console.log(`follow-up settled at ${at()}\n\ntimeline (root status and agents, sampled every 500 ms, changes only):`);
	for (const l of timeline) console.log(l);
	ev.stop();
	const frames = ev.frames.map((f) => f.payload);
	const agents = (await d.api(`/session/${root.id}/agents`)).agents.filter((a: any) => a.depth > 0);
	const spawned = frames.filter((f) => f.type === "agent.spawned" && f.properties.sessionID === root.id).length;
	const byId = new Map(agents.map((a: any) => [a.id, a]));
	// a follow-up: the root messaging an agent that had already reported once (a parked agent woken with its history)
	const reported = new Set<string>();
	let followups = 0;
	for (const f of frames) {
		if (f.type === "agent.report") reported.add(f.properties.childID);
		if (f.type === "agent.message" && f.properties.sessionID === root.id && reported.has(f.properties.toID)) followups++;
	}
	console.log(`\nagents:`);
	for (const a of agents) console.log(`  ${a.path.padEnd(22)} ${String(a.seat).padEnd(9)} ${String(a.model).padEnd(28)} ${String(a.effort).padEnd(7)} ${a.state.padEnd(8)} files ${a.files.join(", ") || "-"}`);
	console.log(`\ntelemetry (per session):`);
	stepsLine(`/root (${root.model.id})`, await d.api(`/session/${root.id}/steps`));
	for (const a of agents) stepsLine(a.path, await d.api(`/session/${a.id}/steps`));
	const allSteps = (await Promise.all([root.id, ...agents.map((a: any) => a.id)].map((id) => d.api(`/session/${id}/steps`)))).flat();
	stepsLine("all sessions", allSteps);
	// the follow-up: the helper's first step after it was woken again
	let warmFirst: any;
	if (mul) {
		const steps = await d.api(`/session/${mul.id}/steps`);
		const second = frames.filter((f) => f.type === "agent.updated" && f.properties.agent.id === mul.id && f.properties.agent.state === "working");
		const firstTurnSteps = steps.filter((s: any) => s.at < (second[1]?.properties.agent.updatedAt ?? Number.POSITIVE_INFINITY));
		warmFirst = steps[firstTurnSteps.length];
	}
	// siblings of one model and agent type share a prefix: the second helper's first request should read the first one's cache
	const firsts = await Promise.all(engineers.map(async (a: any) => ({ a, s: (await d.api(`/session/${a.id}/steps`))[0] })));
	const test = Bun.spawnSync(["bun", "test"], { cwd: proj, stderr: "pipe", stdout: "pipe" });
	const out = test.stderr.toString() + test.stdout.toString();
	const passLine = out.split("\n").find((l) => /\d+ pass/.test(l))?.trim();
	const failLine = out.split("\n").find((l) => /\d+ fail/.test(l))?.trim();
	console.log(`\nresults:`);
	console.log(`  spawns ${spawned}, follow-ups to parked agents ${followups}: warm reuse ${spawned ? ((100 * followups) / spawned).toFixed(0) : 0}% (goal >= 25%)`);
	console.log(`  sonnet helpers working at the same time: ${maxEngineers} (two in parallel: ${maxEngineers >= 2 ? "yes" : "no"})`);
	console.log(`  root parked while agents worked: ${parkedWhileWorking} of ${samples} samples`);
	for (const { a, s } of firsts) if (s) console.log(`  ${a.path} first request: cache-read ${s.cache_read_pct}% (${s.cache_read} read, ${s.cache_write} written)`);
	if (warmFirst) console.log(`  follow-up on ${mul.path}: first step cache-read ${warmFirst.cache_read_pct}% (${warmFirst.cache_read} read, ${warmFirst.cache_write} written), warm=${warmFirst.warm}`);
	console.log(`  bun test in the repo: ${passLine ?? "?"}, ${failLine ?? "?"}`);
	const math = await Bun.file(join(proj, "src/math.ts")).text();
	console.log(`  divide in src/math.ts: ${/divide/.test(math) ? "yes" : "no"}`);
	const ok = maxEngineers >= 2 && followups >= 1 && parkedWhileWorking > 0 && /0 fail/.test(failLine ?? "") && /divide/.test(math);
	console.log(`\nresult: ${ok ? "pass" : "FAIL"}`);
	await d.api(`/session/${root.id}`, undefined, "DELETE");
	return ok;
}

// ---------- cache warming: the first turn after a park longer than the cache ttl, with and without refreshes ----------

async function warm() {
	const scratch = scratchDir("warm");
	const d = await startDaemon("warm", Number(arg("port") ?? 4834), scratch, { ...(arg("warm-delay") ? { CMX2_WARM_DELAY_MS: arg("warm-delay")! } : {}), ...(arg("capture") ? { CMX2_CAPTURE_DIR: arg("capture")! } : {}) });
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const ev = listen(d);
	const parkMs = Number(arg("park") ?? 390) * 1000;
	const pairs = Number(arg("pairs") ?? 3);
	const root = await d.api("/session", { directory: proj, title: `it-m5-warm-${nonce()}`, model: "anthropic/claude-sonnet-5-5", effort: "low" });
	// about 95k tokens of real source attached to each brief: a context where cache-read is not bounded by arithmetic
	const files = corpus()
		.filter((f) => f.path.startsWith("packages/"))
		.slice(0, 24)
		.map((f) => join(ROOT, f.path));
	const brief = "the attached files are context for a question that comes later. reply with exactly: ready";
	const agents: Array<{ name: string; warm: boolean; id: string }> = [];
	for (let i = 1; i <= pairs; i++) for (const w of [false, true]) agents.push({ name: `${w ? "hot" : "cold"}${i}`, warm: w, id: "" });
	await Promise.all(
		agents.map(async (a) => {
			a.id = (await d.api(`/session/${root.id}/agents`, { name: a.name, model: "sonnet", effort: "low", warm: a.warm, files, brief })).agents[0].id;
		}),
	);
	await d.until(async () => ((await d.api(`/session/${root.id}/agents`)).agents.filter((x: any) => x.depth === 1 && x.state === "parked").length === agents.length ? true : undefined), "all parked", 10 * 60_000);
	const sizes = await Promise.all(agents.map(async (a) => (await d.api(`/session/${a.id}/steps`)).at(-1)));
	console.log(`${agents.length} helpers parked (${pairs} pairs), first turns ${Math.min(...sizes.map((s: any) => s.input + s.cache_read + s.cache_write))}-${Math.max(...sizes.map((s: any) => s.input + s.cache_read + s.cache_write))} tokens in. parking ${parkMs / 1000} s (cache ttl 300 s)`);
	await Bun.sleep(parkMs);
	const q = "in one line: name two files from the attachments.";
	await Promise.all(agents.map((a) => d.api(`/session/${root.id}/agents/message`, { to: a.id, body: q })));
	await d.until(async () => ((await Promise.all(agents.map(async (a) => (await d.api(`/session/${a.id}/steps`)).length > 1))).every(Boolean) ? true : undefined), "all answered", 10 * 60_000);
	ev.stop();
	const warmed = ev.frames.filter((f) => f.payload.type === "session.warmed");
	const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
	console.log(`\nrefreshes while parked (session.warmed):`);
	for (const f of warmed) {
		const p = f.payload.properties;
		console.log(`  ${nameOf(p.sessionID).padEnd(6)} cache_read ${p.cache_read}  cache_write ${p.cache_write}  input ${p.input}  output ${p.output}  $${p.cost.toFixed(4)}  ${p.ms} ms`);
	}
	console.log(`\nfirst turn after the park (${parkMs / 1000} s):`);
	const pct: Record<"cold" | "hot", number[]> = { cold: [], hot: [] };
	const cost: Record<"cold" | "hot", number[]> = { cold: [], hot: [] };
	for (const a of agents) {
		const s = (await d.api(`/session/${a.id}/steps`))[1];
		pct[a.warm ? "hot" : "cold"].push(s.cache_read_pct);
		cost[a.warm ? "hot" : "cold"].push(s.cost);
		console.log(`  ${a.name.padEnd(6)} warm=${s.warm}  cache-read ${String(s.cache_read_pct).padStart(5)}%  read ${String(s.cache_read).padStart(6)}  written ${String(s.cache_write).padStart(6)}  uncached ${s.input}  ttft ${s.ttft_ms} ms  $${s.cost.toFixed(4)}`);
	}
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
	console.log(`\nwithout warming: mean cache-read ${mean(pct.cold).toFixed(1)}%, mean cost $${mean(cost.cold).toFixed(4)}; with warming: ${mean(pct.hot).toFixed(1)}%, $${mean(cost.hot).toFixed(4)}; refresh cost $${warmed.reduce((n, f) => n + f.payload.properties.cost, 0).toFixed(4)} total`);
	const ok = warmed.length > 0 && mean(pct.hot) > mean(pct.cold);
	console.log(`result: ${ok ? "warming kept parked agents' caches" : "NO difference (see above)"}`);
	await d.api(`/session/${root.id}`, undefined, "DELETE");
	return ok;
}

// ---------- escalation: a helper whose check fails twice runs its next turn one rung up, and comes back after a clean turn ----------

/** the main session never escalates (its effort is the dial's), so this drives a helper: a check that fails twice in one turn raises the next turn, a turn without failures brings it back */
async function escalate() {
	const scratch = scratchDir("escalate");
	const d = await startDaemon("escalate", Number(arg("port") ?? 4834), scratch);
	const proj = join(scratch, "proj");
	await gitRepo(proj, {
		"package.json": `${JSON.stringify({ name: "esc", private: true, type: "module" })}\n`,
		"src/greet.ts": 'export const greet = () => "hi";\n',
		"test/greet.test.ts": 'import { expect, test } from "bun:test";\nimport { greet } from "../src/greet.ts";\n\ntest("greet", () => expect(greet()).toBe("hello there, friend"));\n',
	});
	const ev = listen(d);
	const s = await d.api("/session", { directory: proj, title: `it-m5-escalate-${nonce()}`, model: "anthropic/claude-sonnet-5-5", effort: "low" });
	const spawned = await d.api(`/session/${s.id}/agents`, {
		name: "fixer",
		model: "sonnet",
		effort: "low",
		brief: "do these steps in order and do not skip any. 1) use the edit tool to change greet in src/greet.ts to return 'hello there'. 2) run `bun test`. 3) use the edit tool to change the string to 'hello there, pal'. 4) run `bun test` again. leave the test file as it is, whatever the results say. then report both results.",
	});
	const child = spawned.agents[0];
	await d.until(async () => ((await d.api(`/session/${s.id}/agents`)).agents.find((a: any) => a.id === child.id)?.state === "parked" ? true : undefined), "the helper's first turn to settle", 5 * 60_000);
	await Bun.sleep(3000);
	// a second turn with no failures: it runs at the escalated effort and ends clean, so the third runs at the baseline
	await d.api(`/session/${s.id}/agents/message`, { to: child.id, body: "thanks. in one line, what does the test expect?" });
	await Bun.sleep(3000);
	await d.until(async () => ((await d.api(`/session/${s.id}/agents`)).agents.find((a: any) => a.id === child.id)?.state === "parked" ? true : undefined), "the helper's second turn to settle", 5 * 60_000);
	await Bun.sleep(3000);
	await d.api(`/session/${s.id}/agents/message`, { to: child.id, body: "and in one line, what file does it import from?" });
	await Bun.sleep(3000);
	await d.until(async () => ((await d.api(`/session/${s.id}/agents`)).agents.find((a: any) => a.id === child.id)?.state === "parked" ? true : undefined), "the helper's third turn to settle", 5 * 60_000);
	await d.idle(s.id, 60_000);
	ev.stop();
	const steps = await d.api(`/session/${child.id}/steps`);
	console.log("  step  effort  tools              stop_reason  escalation");
	for (const x of steps) console.log(`  ${String(x.seq).padEnd(5)} ${String(x.effort).padEnd(7)} ${String(x.tool_names || "-").padEnd(18)} ${String(x.stop_reason).padEnd(12)} ${x.escalation ?? "-"}`);
	const mine = (type: string) => ev.frames.filter((f) => f.payload.type === type && f.payload.properties.sessionID === child.id).map((f) => f.payload.properties);
	const up = mine("session.escalated");
	const down = mine("session.deescalated");
	console.log(`\nsession.escalated: ${up.length ? JSON.stringify(up[0]) : "none"}`);
	console.log(`session.deescalated: ${down.length ? JSON.stringify(down[0]) : "none"}`);
	const stored = (await d.api(`/session/${child.id}`)).effort ?? "?";
	const rootEscalated = ev.frames.some((f) => f.payload.type === "session.escalated" && f.payload.properties.sessionID === s.id);
	console.log(`stored effort of the helper: ${stored} (it was spawned at low); the main session escalated: ${rootEscalated}`);
	const ok = up.length > 0 && down.length > 0 && !rootEscalated && stored === "low";
	console.log(`result: ${ok ? "the helper escalated, came back down, and nothing was stored; the main session did not escalate" : "NOT as expected (see above)"}`);
	await d.api(`/session/${s.id}`, undefined, "DELETE");
	return ok;
}

// ---------- idle rss after agents ran: boot, a turn, two agents that report and park, then ten quiet minutes ----------

async function idle() {
	const scratch = scratchDir("idle");
	const d = await startDaemon("idle", Number(arg("port") ?? 4839), scratch);
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const at = (label: string) => {
		const mb = d.rssMb();
		console.log(`  ${label.padEnd(46)} rss ${mb} MB`);
		return mb;
	};
	await Bun.sleep(5000);
	const boot = at("boot (+5 s)");
	const s = await d.api("/session", { directory: proj, title: `it-m5-idle-${nonce()}`, model: "anthropic/claude-sonnet-5-5", effort: "low" });
	await d.api(`/session/${s.id}/message`, { parts: [{ type: "text", text: "run `ls` with the shell tool and say what is here in one line" }] });
	at("after a turn");
	await Promise.all(["one", "two"].map((name) => d.api(`/session/${s.id}/agents`, { name, model: "sonnet", effort: "low", brief: "read README or any file here and say in one line what this repo is" })));
	await d.until(async () => ((await d.api(`/session/${s.id}/agents`)).agents.filter((a: any) => a.depth === 1 && a.state === "parked").length === 2 ? true : undefined), "agents parked", 5 * 60_000);
	await d.idle(s.id, 5 * 60_000);
	at("after two agents reported and parked");
	const samples: number[] = [];
	for (let min = 1; min <= 10; min++) {
		await Bun.sleep(60_000);
		samples.push(at(`idle minute ${min}`));
	}
	const mem = await d.api("/global/memory");
	console.log(`  /global/memory: rss ${(mem.rss / 1048576).toFixed(1)} MB, heapUsed ${(mem.heapUsed / 1048576).toFixed(1)} MB, live_sessions ${mem.live_sessions}, contract_violations ${mem.contract_violations}`);
	const last = samples.at(-1)!;
	console.log(`\nresult: boot ${boot} MB; idle after 10 minutes ${last} MB (budget 150) → ${last < 150 ? "within budget" : "OVER budget"}`);
	await d.api(`/session/${s.id}`, undefined, "DELETE");
	return last < 150;
}

export async function main(which: string): Promise<boolean> {
	switch (which) {
		case "refusal":
			return refusal();
		case "rss300k":
			return rss300k();
		case "team":
			return team();
		case "warm":
			return warm();
		case "escalate":
			return escalate();
		case "idle":
			return idle();
		default:
			throw new Error(`unknown m5 check ${which}; one of refusal, rss300k, team, warm, escalate, idle`);
	}
}

if (import.meta.main) {
	const which = process.argv[2] ?? "refusal";
	let ok = false;
	try {
		ok = await main(which);
	} catch (e) {
		console.error(e);
	} finally {
		for (const c of cleanups.reverse()) await c();
	}
	process.exit(ok ? 0 : 1);
}
