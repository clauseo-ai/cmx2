/**
 * m1 gate driver. every check runs against a real daemon it starts itself on a dev port (never 4096)
 * and stops before exiting, through whatever providers the profile configures.
 *   bun src/m1.ts prefix|turnmsg|toolsearch|run3|providers|ab|idle [--port 4831]
 */
import { $ } from "bun";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const which = process.argv[2] ?? "prefix";
const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 4831;
const ROOT = join(import.meta.dir, "../../..");
const nonce = Math.random().toString(36).slice(2, 7);
const scratch = `/tmp/cmx2-m1-${which}-${nonce}`;
mkdirSync(scratch, { recursive: true });
const DATA = join(scratch, "data");
const CAPTURE = join(scratch, "capture");

// ---------- daemon lifecycle ----------
class Daemon {
	proc: ReturnType<typeof Bun.spawn> | undefined;
	base = `http://127.0.0.1:${PORT}`;
	async start() {
		const busy = (await $`lsof -nP -tiTCP:${PORT} -sTCP:LISTEN`.nothrow().quiet()).stdout.toString().trim();
		if (busy) throw new Error(`port ${PORT} is taken by pid ${busy}; pick another with --port`);
		this.proc = Bun.spawn(["bun", "packages/cli/src/index.ts", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
			cwd: ROOT,
			env: { ...process.env, CMX2_DATA_DIR: DATA, CMX2_CAPTURE_DIR: CAPTURE },
			stdout: Bun.file(join(scratch, `daemon-${Date.now()}.log`)),
			stderr: "inherit",
		});
		for (let i = 0; i < 50; i++) {
			await Bun.sleep(100);
			try {
				if ((await fetch(`${this.base}/global/health`)).ok) return console.log(`daemon pid ${this.proc.pid} up on ${PORT}`);
			} catch {}
		}
		throw new Error("daemon did not come up in 5 s");
	}
	async stop() {
		if (!this.proc) return;
		this.proc.kill("SIGTERM");
		await this.proc.exited;
		console.log(`daemon pid ${this.proc.pid} stopped`);
		this.proc = undefined;
	}
	rssMb(): number {
		const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(this.proc?.pid)]).stdout.toString().trim();
		return Math.round((Number(out) / 1024) * 10) / 10;
	}
}
const daemon = new Daemon();

async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
	const res = await fetch(daemon.base + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}

async function session(label: string, dir: string, extra: Record<string, unknown> = {}): Promise<string> {
	return (await api("/session", { directory: dir, title: `it-m1-${label}-${nonce}`, ...extra })).id;
}

async function idle(id: string, timeoutMs = 20 * 60_000) {
	const t0 = Date.now();
	await Bun.sleep(300);
	while (Date.now() - t0 < timeoutMs) {
		const st = await api("/session/status");
		if (st[id] === undefined || st[id].type === "idle") return;
		await Bun.sleep(700);
	}
	throw new Error(`session ${id} still busy after ${timeoutMs} ms`);
}

async function turn(id: string, text: string, extra: Record<string, unknown> = {}) {
	await api(`/session/${id}/prompt`, { text, ...extra });
	await idle(id);
}

async function lastText(id: string): Promise<string> {
	const msgs = await api(`/session/${id}/messages`);
	const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
	return (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

/** a minimal sse subscriber (bun has no EventSource) */
function subscribe(dir: string, onEvent: (e: any) => void): () => void {
	const ctl = new AbortController();
	(async () => {
		try {
			const res = await fetch(`${daemon.base}/event?directory=${encodeURIComponent(dir)}`, { signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)));
				}
			}
		} catch {}
	})();
	return () => ctl.abort();
}

const STEP_COLS = ["seq", "effort", "input", "cache_read", "cache_write", "cache_read_pct", "ttft_ms", "tool_calls", "nested_calls", "calls", "tool_names", "stop_reason", "refusal", "prefix_same", "dropped_blocks"];
function printSteps(rows: any[], cols = STEP_COLS) {
	console.log(`| ${cols.join(" | ")} |`);
	console.log(`|${cols.map(() => "---").join("|")}|`);
	for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`);
}
function cacheShare(rows: any[]) {
	const read = rows.reduce((a, r) => a + r.cache_read, 0);
	const all = rows.reduce((a, r) => a + r.cache_read + r.cache_write + r.input, 0);
	return { read, all, pct: all ? Math.round((1000 * read) / all) / 10 : 0 };
}

function stripCache(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(stripCache);
	if (v && typeof v === "object") {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (k !== "cache_control") o[k] = stripCache(x);
		return o;
	}
	return v;
}

function captures(id: string, ext: "json" | "prefix"): string[] {
	return readdirSync(CAPTURE)
		.filter((f) => f.startsWith(id) && f.endsWith(`.${ext}`))
		.sort()
		.map((f) => join(CAPTURE, f));
}

// ---------- fixtures ----------
function words(seed: number, n: number): string {
	const vocab = "cache prefix engine daemon parked steer effort marker budget worker scout review ledger mailbox roster seat preset proxy vertex token".split(" ");
	let x = seed;
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.push(vocab[x % vocab.length]!);
	}
	return out.join(" ");
}

async function gitRepo(dir: string) {
	await $`cd ${dir} && git init -q && git add -A && git -c user.email=it@cmx2 -c user.name=it commit -qm init`.quiet();
}

function chainRepo(n: number): { dir: string; secret: string } {
	const dir = join(scratch, "chain-repo");
	mkdirSync(join(dir, "chain"), { recursive: true });
	const names = Array.from({ length: n }, (_, i) => (i === 0 ? "start" : `c${Math.random().toString(36).slice(2, 10)}`));
	const secret = `ORCHID-${nonce}`;
	names.forEach((name, i) => {
		const next = i + 1 < n ? `next file: chain/${names[i + 1]}.txt` : `END. the secret word is ${secret}.`;
		writeFileSync(join(dir, "chain", `${name}.txt`), `file ${i + 1} of ${n}. ${next}\n\n${words(i + 7, 420)}\n`);
	});
	writeFileSync(join(dir, "README.md"), "a scratch repository for cmx2 m1 checks.\n");
	return { dir, secret };
}

function smallRepo(): string {
	const dir = join(scratch, "small-repo");
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "hello.txt"), "hello from the scratch repo\n");
	writeFileSync(join(dir, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\nexport const mul = (a: number, b: number) => a + b;\n");
	writeFileSync(join(dir, "src/strings.ts"), "export const shout = (s: string) => s.toUpperCase();\n");
	writeFileSync(
		join(dir, "src/math.test.ts"),
		'import { expect, test } from "bun:test";\nimport { add, mul } from "./math";\ntest("add", () => expect(add(2, 3)).toBe(5));\ntest("mul", () => expect(mul(3, 3)).toBe(9));\n',
	);
	writeFileSync(join(dir, "docs/manual.md"), Array.from({ length: 60 }, (_, i) => `## section ${i + 1}\n\n${words(i + 99, 110)}\n`).join("\n"));
	return dir;
}

// ---------- prefix: 40 steps, restart, resume; effort per message and marker replay ----------
async function checkPrefix() {
	const { dir, secret } = chainRepo(40);
	const small = smallRepo();
	await gitRepo(dir);
	await gitRepo(small);
	await daemon.start();
	const chain = await session("chain", dir, { nudge: false });
	const t0 = performance.now();
	await turn(
		chain,
		"follow the file chain that starts at chain/start.txt. each file names the next one, so read them one at a time with the read tool: one read call per response, no run, no shell, no guessing names. when a file says END, answer with its secret word and the number of files you read.",
	);
	const answer = await lastText(chain);
	console.log(`\nchain answer (${Math.round((performance.now() - t0) / 1000)} s): ${answer.replace(/\s+/g, " ").slice(0, 200)}`);
	console.log(`secret found: ${answer.includes(secret)}`);

	// effort dial across user turns on a second session
	const eff = await session("effort", small);
	const plan: Array<[string, string]> = [
		["medium", "read docs/manual.md and tell me in one line what section 3 is about."],
		["high", "read src/math.ts and tell me what mul returns for 3 and 3."],
		["low", "grep for 'export' in src and list the function names."],
		["max", "does src/math.test.ts expect the right value for mul(3, 3)? yes or no with the line."],
	];
	for (const [effort, text] of plan) await turn(eff, text, { effort });

	const pre = { chain: await api(`/session/${chain}/requests`), eff: await api(`/session/${eff}/requests`) };
	const preSteps = await api(`/session/${chain}/steps`);
	console.log(`\nrss before restart: ${daemon.rssMb()} MB`);
	await daemon.stop();

	// a new daemon process: sessions reopen from their transcripts on first use
	await daemon.start();
	await api(`/session/${chain}/effort`, { effort: "high" });
	await turn(chain, "how many files did you read, and what was the secret word? one line.");
	await turn(eff, "which file did you read first in this conversation? one line.", { effort: "medium" });
	const post = { chain: await api(`/session/${chain}/requests`), eff: await api(`/session/${eff}/requests`) };
	const steps = await api(`/session/${chain}/steps`);

	console.log(`\n## recorded prefix across 40+ steps and a resume (session ${chain})`);
	console.log("| boot | req | prefix_hash | prefix_bytes | diff_at | tools | messages | effort_markers |");
	console.log("|---|---|---|---|---|---|---|---|");
	for (const [boot, list] of [["1", pre.chain], ["2", post.chain]] as const) {
		for (const r of list) console.log(`| ${boot} | ${r.seq} | ${r.prefix_hash} | ${r.prefix_bytes} | ${r.prefix_diff_at ?? "identical"} | ${r.tools.length} | ${r.message_count} | ${r.effort_markers.slice(-3).join(",")} |`);
	}
	const all = [...pre.chain, ...post.chain];
	console.log(`requests: ${all.length}; distinct prefix hashes: ${new Set(all.map((r: any) => r.prefix_hash)).size}; differing from the record: ${all.filter((r: any) => r.prefix_diff_at !== null).length}`);

	// independent byte diff of the captured wire prefixes with cmp(1)
	const files = captures(chain, "prefix");
	let differ = 0;
	for (const f of files.slice(1)) {
		const r = Bun.spawnSync(["cmp", files[0]!, f]);
		if (r.exitCode !== 0) {
			differ++;
			console.log(`cmp: ${f} differs: ${r.stdout.toString().trim()}`);
		}
	}
	console.log(`cmp of ${files.length} captured prefix files against request 1: ${differ} differ (${readFileSync(files[0]!).length} bytes each)`);

	console.log(`\n## chain steps (boot 1 then resume), cache-read share after step 1: ${cacheShare(steps.slice(1)).pct}% (${cacheShare(steps.slice(1)).read} of ${cacheShare(steps.slice(1)).all})`);
	printSteps(steps);
	console.log(`steps before restart: ${preSteps.length}`);

	// effort recorded on every assistant message, as persisted
	const tr = readFileSync(join(DATA, "sessions", `${eff}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const assistants = tr.filter((r) => r.message?.role === "assistant").map((r) => r.message);
	console.log(`\n## effort per assistant message (transcript ${eff}.jsonl)`);
	console.log("| # | providerThinkingLevel | thinkingLevel | stop |");
	console.log("|---|---|---|---|");
	assistants.forEach((m, i) => console.log(`| ${i + 1} | ${m.providerThinkingLevel ?? "MISSING"} | ${m.thinkingLevel ?? "MISSING"} | ${m.stopReason} |`));
	console.log(`assistant messages: ${assistants.length}; missing provider effort: ${assistants.filter((m) => !m.providerThinkingLevel).length}; missing requested level: ${assistants.filter((m) => !m.thinkingLevel).length}`);

	// markers rebuilt on replay: the last pre-restart body against the first post-restart body
	for (const [label, id] of [["chain", chain], ["effort", eff]] as const) {
		const bodies = captures(id, "json");
		const bootOf = (f: string) => f.split("-").at(-2);
		const boots = [...new Set(bodies.map(bootOf))];
		const lastPre = JSON.parse(readFileSync(bodies.filter((f) => bootOf(f) === boots[0]).at(-1)!, "utf8"));
		const firstPost = JSON.parse(readFileSync(bodies.find((f) => bootOf(f) === boots[1])!, "utf8"));
		const a = stripCache(lastPre.messages.slice(0, -1)) as unknown[];
		const b = stripCache(firstPost.messages.slice(0, a.length)) as unknown[];
		const same = JSON.stringify(a) === JSON.stringify(b);
		const markers = (ms: any[]) => ms.filter((m) => m.role === "system" && m.output_config).map((m) => m.output_config.effort);
		console.log(`\nreplay ${label}: first ${a.length} messages byte-identical after restart (cache_control stripped): ${same}`);
		console.log(`  markers before restart: [${markers(lastPre.messages).join(", ")}]`);
		console.log(`  markers after restart:  [${markers(firstPost.messages).join(", ")}]`);
		console.log(`  system+tools identical: ${JSON.stringify(lastPre.system) === JSON.stringify(firstPost.system) && JSON.stringify(lastPre.tools) === JSON.stringify(firstPost.tools)}`);
	}
	console.log(`\nfinal answer after resume: ${(await lastText(chain)).replace(/\s+/g, " ").slice(0, 160)}`);
	console.log(`rss after resume turns: ${daemon.rssMb()} MB`);
	await daemon.stop();
}

// ---------- turn-scoped messages, both paths ----------
async function checkTurnMessages() {
	const dir = smallRepo();
	await gitRepo(dir);
	await daemon.start();
	for (const mode of ["system", "user-part"] as const) {
		const id = await session(`turn-${mode}`, dir, { turn_messages: mode });
		await turn(id, "according to your turn context, what is today's date and your working directory? one line, nothing else.");
		const a1 = await lastText(id);
		await turn(id, "read hello.txt and quote it.");
		const reqs = await api(`/session/${id}/requests`);
		const bodies = captures(id, "json").map((f) => JSON.parse(readFileSync(f, "utf8")));
		const tr = readFileSync(join(DATA, "sessions", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).message).filter(Boolean);
		console.log(`\n## turn messages: ${mode} (session ${id})`);
		console.log(`answer 1: ${a1.replace(/\s+/g, " ").slice(0, 160)}`);
		console.log(`answer names today's date: ${a1.includes(new Date().toISOString().slice(0, 10)) || a1.includes(localDate())}; names cwd: ${a1.includes(dir)}`);
		const where = (b: any) =>
			b.messages
				.map((m: any, i: number) => {
					const s = JSON.stringify(m.content);
					if (m.role === "system" && s.includes("batching") === false && s.includes("turn context")) return `${i}:system(turn context)`;
					if (m.role === "system" && s.includes("privately list")) return `${i}:system(nudge)`;
					if (m.role === "user" && s.includes("system-reminder")) return `${i}:user+reminder`;
					return null;
				})
				.filter(Boolean)
				.join(" ");
		bodies.forEach((b, i) => console.log(`  req ${i + 1}: messages=${b.messages.length} turn-scoped at [${where(b)}] prefix_diff_at=${reqs[i]?.prefix_diff_at ?? "identical"}`));
		const persisted = tr.filter((m: any) => (m.role === "system" && typeof m.content === "string" && m.content.includes("privately list")) || (m.role === "user" && JSON.stringify(m.content).includes("system-reminder")));
		console.log(`  transcript carries ${persisted.length} turn-scoped entries for 2 turns (append-only, never edited)`);
		const steps = await api(`/session/${id}/steps`);
		printSteps(steps, ["seq", "input", "cache_read", "cache_write", "cache_read_pct", "tool_calls", "stop_reason", "prefix_same", "dropped_blocks"]);
	}
	await daemon.stop();
}

function localDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- tool search: a deferred tool loaded mid-session ----------
async function checkToolSearch(reps = 3) {
	const dir = smallRepo();
	await gitRepo(dir);
	await daemon.start();
	for (let rep = 1; rep <= reps; rep++) {
		const id = await session(`toolsearch-${rep}`, dir);
		await turn(id, "read docs/manual.md in full and tell me in one line how many sections it has.");
		await turn(
			id,
			`use tool_search to load a tool that fetches urls, then use it to fetch ${daemon.base}/global/health and tell me the version field. one line.`,
		);
		const reqs = await api(`/session/${id}/requests`);
		const steps = await api(`/session/${id}/steps`);
		const bodies = captures(id, "json").map((f) => JSON.parse(readFileSync(f, "utf8")));
		console.log(`\n## tool search rep ${rep} (session ${id}): ${(await lastText(id)).replace(/\s+/g, " ").slice(0, 120)}`);
		console.log("| req | rendered tools | deferred declared | tool_addition in messages | prefix diff_at | cache_read | cache_write | input | read % |");
		console.log("|---|---|---|---|---|---|---|---|---|");
		reqs.forEach((r: any, i: number) => {
			const s = steps[i] ?? {};
			const additions = (bodies[i]?.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_addition").map((b: any) => b.tool.name);
			console.log(`| ${r.seq} | ${r.tools.length} | ${r.deferred.join(",") || "-"} | ${additions.join(",") || "-"} | ${r.prefix_diff_at ?? "identical"} | ${s.cache_read} | ${s.cache_write} | ${s.input} | ${s.cache_read_pct} |`);
		});
		const firstWith = reqs.findIndex((r: any) => r.deferred.length > 0);
		if (firstWith >= 0) {
			const s = steps[firstWith];
			const prev = steps[firstWith - 1];
			console.log(`first request carrying the deferred tool: req ${firstWith + 1}; cache_read ${s.cache_read} of ${s.cache_read + s.cache_write + s.input} input tokens (${s.cache_read_pct}%); previous request's total context ${prev.cache_read + prev.cache_write + prev.input}`);
		} else console.log("the model never loaded a deferred tool in this rep");
	}
	await daemon.stop();
}

// ---------- run counts its nested calls ----------
async function checkRun3() {
	const dir = smallRepo();
	await gitRepo(dir);
	await daemon.start();
	const id = await session("run3", dir);
	await turn(
		id,
		"in a single run script: read src/math.ts, src/strings.ts and src/math.test.ts with fs.read, grep src for 'export' with fs.grep, run `bun test` with shell.exec, and return only the failing test names with expected and received values plus the exported function names. one run call.",
	);
	const steps = await api(`/session/${id}/steps`);
	console.log(`\n## run nested calls (session ${id})`);
	printSteps(steps);
	const msgs = await api(`/session/${id}/messages`);
	for (const m of msgs) {
		if (m.role === "toolResult" && m.toolName === "run") console.log(`run details: calls=${m.details.calls} nested=${m.details.nested.map((n: any) => `${n.helper}:${n.ok ? "ok" : "err"}`).join(",")}`);
	}
	console.log(`answer: ${(await lastText(id)).replace(/\s+/g, " ").slice(0, 300)}`);
	await daemon.stop();
}

// ---------- providers: tool use, forced tool use, structured output, refusal ----------
const PROVIDER_MODELS = (process.env.M1_MODELS ?? "anthropic/claude-fable-5-1,anthropic/claude-opus-5-5,anthropic/claude-sonnet-5-5,google/gemini-3.8-flash,glm/zai-org/glm-5-maas").split(",");
async function checkProviders() {
	const dir = smallRepo();
	await gitRepo(dir);
	await daemon.start();
	const rows: string[][] = [];
	const schema = {
		type: "object",
		properties: { file: { type: "string" }, lines: { type: "integer" } },
		required: ["file", "lines"],
		additionalProperties: false,
	};
	for (const model of PROVIDER_MODELS) {
		const errors: string[] = [];
		const id = await session(`prov-${model.split("/").pop()}`, dir, { model, effort: "low" });
		const closeEvents = subscribe(dir, (p) => {
			if (p.type === "session.error" && p.properties.sessionID === id) errors.push(`${p.properties.name}: ${p.properties.message}`);
		});
		const stepCount = async () => (await api(`/session/${id}/steps`)).length;
		// 1: plain tool use
		await turn(id, "read hello.txt with the read tool and quote its content.");
		let steps = await api(`/session/${id}/steps`);
		const toolUse = steps.some((s: any) => s.tool_names.includes("read")) && (await lastText(id)).includes("hello from the scratch repo");
		// 2: forced tool use on a prompt that needs no tool
		const before = await stepCount();
		await turn(id, "say hi in one word.", { tool_choice: { name: "glob" } });
		steps = await api(`/session/${id}/steps`);
		const forcedSteps = steps.slice(before);
		const reqs = await api(`/session/${id}/requests`);
		const forcedGate = reqs.at(-forcedSteps.length)?.gates?.join(",") ?? "?";
		const forced = forcedSteps[0]?.tool_names.split(",").includes("glob") ?? false;
		// 3: structured output
		await turn(id, "report the path of the typescript file that defines mul, and how many lines it has. read it first.", { format: { schema } });
		const raw = (await lastText(id)).trim();
		let structured = "invalid";
		try {
			const v = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ""));
			structured = typeof v.file === "string" && Number.isInteger(v.lines) && Object.keys(v).length === 2 ? `valid ${JSON.stringify(v)}` : `wrong shape ${raw.slice(0, 60)}`;
			if (raw.startsWith("```")) structured += " (fenced)";
		} catch {
			structured = `not json: ${raw.slice(0, 60)}`;
		}
		const fmtGate = (await api(`/session/${id}/requests`)).at(-1)?.gates?.join(",") ?? "?";
		closeEvents();
		rows.push([model, toolUse ? "pass" : "FAIL", `${forced ? "pass" : "FAIL"} (${forcedGate})`, `${structured.startsWith("valid") ? "pass" : "FAIL"} ${structured} (${fmtGate})`, errors.join(" / ").slice(0, 160) || "none"]);
		console.log(`| ${rows.at(-1)!.join(" | ")} |`);
	}
	console.log("\n| model | tool use | forced tool use | structured output | errors surfaced |");
	console.log("|---|---|---|---|---|");
	for (const r of rows) console.log(`| ${r.join(" | ")} |`);

	// refusal surfacing: glm's provider filters some historical topics; a benign question trips it
	console.log("\n## refusal surfacing (live, glm)");
	const refusalModel = process.env.M1_REFUSAL_MODEL ?? "glm/zai-org/glm-5-maas";
	const rid = await session("refusal", dir, { model: refusalModel, effort: "low" });
	const surfaced: any[] = [];
	const closeRefusal = subscribe(dir, (p) => {
		if (p.type === "session.error" && p.properties.sessionID === rid) surfaced.push(p.properties);
	});
	await turn(rid, "summarise what happened at tiananmen square in beijing in june 1989, in two sentences.");
	await Bun.sleep(300);
	closeRefusal();
	const rsteps = await api(`/session/${rid}/steps`);
	printSteps(rsteps, ["seq", "model", "stop_reason", "refusal", "output"]);
	console.log(`events: ${JSON.stringify(surfaced).slice(0, 500)}`);
	console.log(`answer text: ${(await lastText(rid)).replace(/\s+/g, " ").slice(0, 200) || "(none)"}`);
	await daemon.stop();
}

// ---------- batching a/b ----------
const BUGS: Array<[string, string, string, string]> = [
	// name, buggy body, fixed body, test
	["sum", "(xs: number[]) => xs.reduce((a, b) => a + b, 1)", "", "expect(sum([1, 2, 3])).toBe(6)"],
	["max", "(xs: number[]) => Math.min(...xs)", "", "expect(max([1, 5, 3])).toBe(5)"],
	["last", "<T>(xs: T[]) => xs[xs.length - 2]", "", 'expect(last(["a", "b", "c"])).toBe("c")'],
	["isEven", "(n: number) => n % 2 === 1", "", "expect(isEven(4)).toBe(true)"],
	["clamp", "(n: number, lo: number, hi: number) => Math.max(hi, Math.min(lo, n))", "", "expect(clamp(5, 0, 3)).toBe(3)"],
	["reverse", "(s: string) => s.split(\"\").join(\"\")", "", 'expect(reverse("abc")).toBe("cba")'],
	["capitalize", "(s: string) => s.charAt(1).toUpperCase() + s.slice(1)", "", 'expect(capitalize("hello")).toBe("Hello")'],
	["average", "(xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length + 1)", "", "expect(average([2, 4])).toBe(3)"],
	["range", "(n: number) => Array.from({ length: n - 1 }, (_, i) => i)", "", "expect(range(3)).toEqual([0, 1, 2])"],
	["unique", "<T>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) !== i)", "", "expect(unique([1, 1, 2])).toEqual([1, 2])"],
	["countVowels", "(s: string) => (s.match(/[aeio]/g) ?? []).length", "", 'expect(countVowels("queue")).toBe(4)'],
	["factorial", "(n: number): number => (n <= 1 ? 0 : n * factorial(n - 1))", "", "expect(factorial(4)).toBe(24)"],
	["isPalindrome", "(s: string) => s === s.split(\"\").reverse().join(\"\").slice(1)", "", 'expect(isPalindrome("level")).toBe(true)'],
	["chunk", "<T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n - 1))", "", "expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])"],
	["flatten", "(xs: number[][]) => xs.reduce((a, b) => b.concat(a), [] as number[])", "", "expect(flatten([[1], [2, 3]])).toEqual([1, 2, 3])"],
	["words", "(s: string) => s.split(\" \").length - 1", "", 'expect(words("a b c")).toBe(3)'],
	["percent", "(part: number, whole: number) => Math.round((whole / part) * 100)", "", "expect(percent(1, 4)).toBe(25)"],
	["median", "(xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2) + 1]", "", "expect(median([3, 1, 2])).toBe(2)"],
	["pad2", "(n: number) => String(n).padEnd(2, \"0\")", "", 'expect(pad2(7)).toBe("07")'],
	["initials", "(name: string) => name.split(\" \").map((w) => w[1]).join(\"\")", "", 'expect(initials("ada lovelace")).toBe("al")'],
];

function abRepo(tag: string): string {
	const dir = join(scratch, `ab-${tag}`);
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, body, , test] of BUGS) {
		writeFileSync(join(dir, "src", `${name}.ts`), `export const ${name} = ${body};\n`);
		writeFileSync(join(dir, "src", `${name}.test.ts`), `import { expect, test } from "bun:test";\nimport { ${name} } from "./${name}";\ntest("${name}", () => ${test});\n`);
	}
	writeFileSync(join(dir, "package.json"), '{ "name": "ab-fixture", "private": true, "type": "module" }\n');
	return dir;
}

async function checkAB() {
	const MODEL = "anthropic/claude-opus-5-5";
	const EFFORT = "medium";
	const PROMPT =
		"every test under src fails because of a bug in the module it tests. fix each module (not the tests) so that `bun test` passes, and confirm the final run is green. report how many modules you changed.";
	await daemon.start();
	const rows: Array<Record<string, any>> = [];
	for (const rep of [1, 2]) {
		for (const nudge of [true, false]) {
			const tag = `${nudge ? "on" : "off"}-${rep}`;
			const dir = abRepo(tag);
			await gitRepo(dir);
			const id = await session(`ab-${tag}`, dir, { model: MODEL, effort: EFFORT, nudge });
			const t0 = performance.now();
			await turn(id, PROMPT);
			const wall = Math.round((performance.now() - t0) / 1000);
			const steps = await api(`/session/${id}/steps`);
			const test = await $`cd ${dir} && bun test 2>&1`.nothrow().quiet();
			const passed = Number(test.stdout.toString().match(/(\d+) pass/)?.[1] ?? 0);
			const changed = (await $`cd ${dir} && git status --porcelain src`.quiet()).stdout.toString().split("\n").filter((l) => l.trim()).length;
			const calls = steps.reduce((a: number, s: any) => a + s.calls, 0);
			const native = steps.reduce((a: number, s: any) => a + s.tool_calls, 0);
			const single = steps.filter((s: any) => s.tool_calls === 1).length;
			const cs = cacheShare(steps.slice(1));
			rows.push({
				arm: nudge ? "nudge on" : "nudge off",
				rep,
				session: id,
				steps: steps.length,
				native_calls: native,
				calls,
				calls_per_step: (calls / steps.length).toFixed(2),
				single_call_steps: single,
				runs: steps.reduce((a: number, s: any) => a + s.tool_names.split(",").filter((n: string) => n === "run").length, 0),
				cache_read_pct: cs.pct,
				cost: steps.reduce((a: number, s: any) => a + s.cost, 0).toFixed(3),
				wall_s: wall,
				outcome: `${passed}/20 pass, ${changed} files changed`,
			});
			console.log(JSON.stringify(rows.at(-1)));
			console.log(`  per step calls: ${steps.map((s: any) => `${s.tool_calls}${s.nested_calls ? `+${s.nested_calls}n` : ""}`).join(" ")}`);
		}
	}
	const cols = ["arm", "rep", "steps", "native_calls", "calls", "calls_per_step", "single_call_steps", "runs", "cache_read_pct", "cost", "wall_s", "outcome", "session"];
	console.log(`\n| ${cols.join(" | ")} |`);
	console.log(`|${cols.map(() => "---").join("|")}|`);
	for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(" | ")} |`);
	for (const arm of ["nudge on", "nudge off"]) {
		const rs = rows.filter((r) => r.arm === arm);
		const steps = rs.reduce((a, r) => a + r.steps, 0);
		const calls = rs.reduce((a, r) => a + r.calls, 0);
		console.log(`${arm}: mean steps ${(steps / rs.length).toFixed(1)}, calls/step ${(calls / steps).toFixed(2)}`);
	}
	await daemon.stop();
}

// ---------- batching a/b on a task with a 20-step floor ----------
// a 20-hop chain: each hop names the next hop and two evidence files. the chain forces at least 21
// steps; the evidence reads are independent of the next hop, so batching them into the same response
// is the only way calls per step rise. both arms get the same prompt, model, effort and tools.
function hopRepo(tag: string): { dir: string; total: number } {
	const dir = join(scratch, `hop-${tag}`);
	mkdirSync(join(dir, "hops"), { recursive: true });
	mkdirSync(join(dir, "evidence"), { recursive: true });
	const n = 20;
	const names = Array.from({ length: n }, (_, i) => (i === 0 ? "start" : `h${Math.random().toString(36).slice(2, 9)}`));
	let total = 0;
	names.forEach((name, i) => {
		const ev = [0, 1].map((k) => {
			const v = 10 + ((i * 7 + k * 13) % 50);
			total += v;
			const f = `e${Math.random().toString(36).slice(2, 9)}.txt`;
			writeFileSync(join(dir, "evidence", f), `value: ${v}\n\n${words(i * 3 + k, 60)}\n`);
			return `evidence/${f}`;
		});
		const next = i + 1 < n ? `next hop: hops/${names[i + 1]}.txt` : "this is the last hop.";
		writeFileSync(join(dir, "hops", `${name}.txt`), `hop ${i + 1} of ${n}. evidence files: ${ev.join(", ")}. ${next}\n\n${words(i + 500, 80)}\n`);
	});
	return { dir, total };
}

async function checkABHops() {
	const MODEL = process.env.M1_MODEL ?? "anthropic/claude-opus-5-5";
	const EFFORT = process.env.M1_EFFORT ?? "medium";
	console.log(`abhops: ${MODEL} at ${EFFORT}`);
	const PROMPT =
		"start at hops/start.txt. every hop file names two evidence files and the next hop. add up the value in every evidence file across all hops and tell me the total. use only the read tool (no run, no shell, no grep, no glob).";
	await daemon.start();
	const rows: Array<Record<string, any>> = [];
	for (const rep of [1, 2]) {
		for (const nudge of [true, false]) {
			const tag = `${nudge ? "on" : "off"}-${rep}`;
			const { dir, total } = hopRepo(tag);
			await gitRepo(dir);
			const id = await session(`abhop-${tag}`, dir, { model: MODEL, effort: EFFORT, nudge });
			const t0 = performance.now();
			await turn(id, PROMPT);
			const wall = Math.round((performance.now() - t0) / 1000);
			const steps = await api(`/session/${id}/steps`);
			const answer = await lastText(id);
			const calls = steps.reduce((a: number, s: any) => a + s.calls, 0);
			const cs = cacheShare(steps.slice(1));
			rows.push({
				arm: nudge ? "nudge on" : "nudge off",
				rep,
				steps: steps.length,
				calls,
				calls_per_step: (calls / steps.length).toFixed(2),
				single_call_steps: steps.filter((s: any) => s.tool_calls === 1).length,
				max_calls_in_a_step: Math.max(...steps.map((s: any) => s.calls)),
				cache_read_pct: cs.pct,
				cost: steps.reduce((a: number, s: any) => a + s.cost, 0).toFixed(3),
				wall_s: wall,
				outcome: answer.includes(String(total)) ? `correct (${total})` : `wrong (want ${total}): ${answer.replace(/\s+/g, " ").slice(0, 60)}`,
				session: id,
			});
			console.log(JSON.stringify(rows.at(-1)));
			console.log(`  per step calls: ${steps.map((s: any) => s.calls).join(" ")}`);
		}
	}
	const cols = ["arm", "rep", "steps", "calls", "calls_per_step", "single_call_steps", "max_calls_in_a_step", "cache_read_pct", "cost", "wall_s", "outcome", "session"];
	console.log(`\n| ${cols.join(" | ")} |`);
	console.log(`|${cols.map(() => "---").join("|")}|`);
	for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(" | ")} |`);
	for (const arm of ["nudge on", "nudge off"]) {
		const rs = rows.filter((r) => r.arm === arm);
		const steps = rs.reduce((a, r) => a + r.steps, 0);
		const calls = rs.reduce((a, r) => a + r.calls, 0);
		console.log(`${arm}: mean steps ${(steps / rs.length).toFixed(1)}, calls/step ${(calls / steps).toFixed(2)}`);
	}
	await daemon.stop();
}

// ---------- idle rss over ten minutes ----------
async function checkIdle() {
	const dir = smallRepo();
	await gitRepo(dir);
	await daemon.start();
	console.log(`rss at start, no sessions: ${daemon.rssMb()} MB`);
	const id = await session("idle", dir);
	await turn(id, "read hello.txt and src/math.ts and tell me in one line what they contain.");
	console.log(`rss after one session turn: ${daemon.rssMb()} MB`);
	const samples: number[] = [];
	for (let m = 1; m <= 10; m++) {
		await Bun.sleep(60_000);
		samples.push(daemon.rssMb());
		const mem = await api("/global/memory");
		console.log(`idle minute ${m}: rss ${samples.at(-1)} MB (heapUsed ${(mem.heapUsed / 1048576).toFixed(1)} MB, live sessions ${mem.live_sessions}, uptime ${mem.uptime_s} s)`);
	}
	console.log(`idle rss after 10 minutes: ${samples.at(-1)} MB (max ${Math.max(...samples)} MB), budget 150 MB: ${samples.at(-1)! < 150 ? "under" : "OVER"}`);
	await daemon.stop();
}

try {
	console.log(`m1 ${which}: scratch ${scratch}, port ${PORT}`);
	if (which === "prefix") await checkPrefix();
	else if (which === "turnmsg") await checkTurnMessages();
	else if (which === "toolsearch") await checkToolSearch();
	else if (which === "run3") await checkRun3();
	else if (which === "providers") await checkProviders();
	else if (which === "ab") await checkAB();
	else if (which === "abhops") await checkABHops();
	else if (which === "idle") await checkIdle();
	else throw new Error(`unknown check ${which}`);
} finally {
	await daemon.stop();
	if (process.env.M1_KEEP !== "1") rmSync(join(scratch, "data", "tool-output"), { recursive: true, force: true });
}
