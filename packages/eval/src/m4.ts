/**
 * m3/m4 gate driver: real daemons on dev ports (never 4096), the real provider path, cleanup at exit.
 *   bun packages/eval/src/m4.ts devserver    a dev server as a job: start, wait for the port, check, end the session (port 4837)
 *   bun packages/eval/src/m4.ts run          one run script: three reads, a grep, the tests, only the failures back (port 4838)
 *   bun packages/eval/src/m4.ts notify       job notices (exit, pattern, port) as turn messages that wake an idle session (port 4836)
 *   bun packages/eval/src/m4.ts idle         idle rss over ten minutes after turns, a pty and history reads (port 4839)
 * the kill -9 and sweep test: bun test packages/server/test/integration/sweep.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, gitRepo, nonce } from "./harness.ts";

const which = process.argv[2] ?? "devserver";
const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const tag = nonce();
const scratch = `/tmp/cmx2-m4-${which}-${tag}`;
mkdirSync(scratch, { recursive: true });
const MODEL = process.env.CMX2_IT_MODEL;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd]).stdout.toString().trim();

function transcript(msgs: any[]) {
	for (const m of msgs) {
		const bits = m.parts
			.map((p: any) => {
				if (p.type === "text") return p.synthetic ? "" : JSON.stringify(p.text.length > 220 ? `${p.text.slice(0, 217)}...` : p.text);
				if (p.type === "tool") {
					const input = JSON.stringify(p.state.input);
					return `[${p.tool} ${input.length > 200 ? `${input.slice(0, 197)}...` : input} -> ${p.state.status}]`;
				}
				return "";
			})
			.filter(Boolean)
			.join(" ");
		console.log(`  ${m.info.role.padEnd(9)} ${m.info.notice ? "(notice) " : ""}${bits}`);
	}
}

function stepTable(steps: any[]) {
	console.log("  step  model                        effort  calls  tools                      poll_only  cache_read%");
	for (const s of steps) console.log(`  ${String(s.seq).padEnd(5)} ${s.model.padEnd(28)} ${String(s.effort).padEnd(7)} ${String(s.calls).padEnd(6)} ${(s.tool_names || "-").padEnd(26)} ${String(s.poll_only).padEnd(10)} ${s.cache_read_pct}`);
}

async function startDaemon(port: number) {
	const d = new Daemon({ port, dataDir: arg("data") ?? join(scratch, "data"), log: join(scratch, "daemon.log") });
	await d.start();
	cleanups.push(() => d.stop());
	console.log(`daemon pid ${d.pid} on ${port}, data ${d.opts.dataDir}`);
	return d;
}

// ---------- a dev server as a background job ----------
async function devserver() {
	const d = await startDaemon(4837);
	// a port nothing listens on (a random pick once landed on a local postgres)
	let port = 0;
	for (let p = 5300 + Math.floor(Math.random() * 500); !port; p++) if (!sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t`)) port = p;
	const app = join(scratch, "app");
	await gitRepo(app, {
		"package.json": JSON.stringify({ name: "app", private: true, scripts: { dev: "bun server.ts" } }, null, 2),
		// a dev server that takes a few seconds to come up, like a framework compiling on start
		"server.ts": `const port = Number(process.env.PORT ?? ${port});\nconsole.log("compiling...");\nawait Bun.sleep(4000);\nBun.serve({ port, fetch(req) { const u = new URL(req.url); return u.pathname === "/health" ? Response.json({ ok: true, app: "app", port }) : new Response("not found", { status: 404 }); } });\nconsole.log(\`ready on http://localhost:\${port}\`);\n`,
		"README.md": `# app\n\n\`bun run dev\` serves on port ${port}; \`GET /health\` answers \`{ok: true}\` once it is up.\n`,
	});
	const s = await d.api("/session", { directory: app, title: `it-m4-devserver-${tag}`, ...(MODEL ? { model: MODEL } : {}) });
	console.log(`session ${s.id} (${s.model.providerID}/${s.model.id}, effort ${s.effort})`);
	const t0 = Date.now();
	const prompt = `start this project's dev server, wait until it serves on port ${port}, then check that GET /health answers ok and tell me the body in one line.`;
	console.log(`prompt: ${prompt}`);
	await d.api(`/session/${s.id}/message`, { parts: [{ type: "text", text: prompt }] });
	// the job's notice may wake the session for more turns; wait until it settles for good
	for (let quiet = 0; quiet < 12; ) {
		const st = await d.api("/session/status");
		quiet = st[s.id] ? 0 : quiet + 1;
		await Bun.sleep(500);
	}
	console.log(`task settled after ${((Date.now() - t0) / 1000).toFixed(1)} s\n\ntranscript:`);
	transcript(await d.api(`/session/${s.id}/message`));
	const procs = await d.api(`/session/${s.id}/procs`);
	console.log(`\nprocesses the session owns before it ends: ${JSON.stringify(procs.map((p: any) => ({ id: p.id, pid: p.pid, status: p.status, ports: p.ports, command: p.command })))}`);
	console.log(`lsof :${port} before session end: ${sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`) || "(nothing)"}`);
	const steps = await d.api(`/session/${s.id}/steps`);
	console.log("\nsteps (from telemetry):");
	stepTable(steps);
	const polls = steps.filter((x: any) => x.poll_only).length;
	console.log(`poll-only steps: ${polls} of ${steps.length}`);

	await d.api(`/session/${s.id}`, undefined, "DELETE");
	await Bun.sleep(3000);
	const lsof = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
	// each job leads its own process group (pgid = pid): anything left of it would still be in that group
	const groups = procs.map((p: any) => sh(`pgrep -g ${p.pid} || true`)).filter(Boolean).join(" ");
	const pgrep = [groups, sh(`pgrep -fl "bun server.ts" | grep -v pgrep || true`)].filter(Boolean).join(" ");
	const pids = procs.map((p: any) => p.pid).join(",");
	const ps = pids ? sh(`ps -o pid=,command= -p ${pids} || true`) : "";
	console.log(`\nafter session end (DELETE, archived):`);
	console.log(`  lsof -nP -iTCP:${port} -sTCP:LISTEN: ${lsof || "(nothing)"}`);
	console.log(`  pgrep -g <job pgid> and pgrep -fl "bun server.ts": ${pgrep || "(nothing)"}`);
	console.log(`  ps -p ${pids || "(none)"}: ${ps || "(nothing)"}`);
	console.log(`orphans after session end: ${lsof || pgrep || ps ? "SOME" : 0}`);
	console.log(`daemon rss ${d.rssMb()} MB`);
}

// ---------- one run script ----------
async function runScript() {
	const d = await startDaemon(4838);
	const proj = join(scratch, "calc");
	await gitRepo(proj, {
		"src/add.ts": "export const add = (a: number, b: number) => a + b;\n",
		"src/sub.ts": "export const sub = (a: number, b: number) => a + b; // wrong on purpose\n",
		"src/mul.ts": "export const mul = (a: number, b: number) => a * b;\n",
		"test/math.test.ts":
			'import { expect, test } from "bun:test";\nimport { add } from "../src/add";\nimport { sub } from "../src/sub";\nimport { mul } from "../src/mul";\ntest("adds", () => expect(add(2, 3)).toBe(5));\ntest("subtracts", () => expect(sub(5, 3)).toBe(2));\ntest("multiplies", () => expect(mul(2, 3)).toBe(6));\n',
		".cmx2/cmx2.jsonc": '{ "permission": { "shell": { "*": "allow", "rm *": "deny" } } }\n',
	});
	const s = await d.api("/session", { directory: proj, title: `it-m3-run-${tag}`, ...(MODEL ? { model: MODEL } : {}) });
	console.log(`session ${s.id} (${s.model.providerID}/${s.model.id}); project rule: shell rm *: deny`);
	const prompt =
		"in one run script: read src/add.ts, src/sub.ts and src/mul.ts, grep src for 'wrong', run `bun test` with shell.exec, also try `rm -rf build` (catch it if it is refused), and return only the names of failing tests plus which calls were refused. one step, no other tools.";
	console.log(`prompt: ${prompt}`);
	await d.api(`/session/${s.id}/message`, { parts: [{ type: "text", text: prompt }] });
	await d.idle(s.id);
	const transcriptRows = await d.api(`/session/${s.id}/messages`);
	const runResults = transcriptRows.filter((m: any) => m.role === "toolResult" && m.toolName === "run");
	console.log("\nrun calls and their nested permission decisions (from the tool result details):");
	for (const r of runResults) {
		console.log(`  run ok=${r.details?.ok} calls=${r.details?.calls}`);
		for (const n of r.details?.nested ?? []) console.log(`    ${n.helper.padEnd(12)} ${String(n.permission).padEnd(10)} ${n.rule ?? ""}${n.ok ? "" : `  refused/failed: ${(n.error ?? "").slice(0, 100)}`}`);
		console.log(`  script output: ${JSON.stringify(r.content.map((c: any) => c.text).join("\n").slice(0, 400))}`);
	}
	console.log("\ntranscript:");
	transcript(await d.api(`/session/${s.id}/message`));
	console.log("\nsteps (from telemetry):");
	stepTable(await d.api(`/session/${s.id}/steps`));
	await d.api(`/session/${s.id}`, undefined, "DELETE");
}

// ---------- idle rss ----------
async function idle() {
	const d = await startDaemon(4839);
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const at = (label: string) => console.log(`${label.padEnd(44)} rss ${d.rssMb()} MB`);
	at("boot");
	const s = await d.api("/session", { directory: proj, title: `it-m4-idle-${tag}`, ...(MODEL ? { model: MODEL } : {}), effort: "low" });
	await d.api(`/session/${s.id}/message`, { parts: [{ type: "text", text: "run `ls` with the shell tool and say what is here in one line" }] });
	at("after a turn");
	const pty = await d.api("/pty", { origin: "tui", cwd: proj });
	const ws = new WebSocket(`${d.base.replace("http", "ws")}/pty/${pty.id}/connect`);
	await new Promise((r) => (ws.onopen = r));
	ws.send("ls -la\r");
	await Bun.sleep(1500);
	ws.close();
	await d.api(`/pty/${pty.id}`, undefined, "DELETE");
	at("after a pty session");
	const list = await d.api("/session?limit=500");
	let pages = 0;
	for (const x of list.slice(0, 40)) {
		await d.api(`/session/${x.id}/message?limit=100`);
		pages++;
	}
	at(`after listing ${list.length} sessions, ${pages} pages`);
	await d.api(`/session/${s.id}`, undefined, "DELETE");
	for (let min = 1; min <= 10; min++) {
		await Bun.sleep(60_000);
		at(`idle minute ${min}`);
	}
	const mem = await d.api("/global/memory");
	console.log(`/global/memory: ${JSON.stringify(mem)}`);
}

// ---------- job notices ----------
async function notify() {
	const d = await startDaemon(4836);
	const proj = join(scratch, "proj");
	await gitRepo(proj);
	const s = await d.api("/session", { directory: proj, title: `it-m4-notify-${tag}`, ...(MODEL ? { model: MODEL } : {}), effort: "low" });
	console.log(`session ${s.id}`);
	const t0 = Date.now();
	await d.api(`/session/${s.id}/message`, {
		parts: [{ type: "text", text: "start `sleep 4 && echo build finished` as a background job that notifies you when it exits. then end your turn right away; do not wait for it. when the notice arrives, tell me in one line what the job printed." }],
	});
	console.log(`turn 1 settled after ${Date.now() - t0} ms; status: ${JSON.stringify(await d.api("/session/status"))}`);
	let woke = 0;
	for (let i = 0; i < 80 && !woke; i++) {
		if ((await d.api("/session/status"))[s.id]) woke = Date.now() - t0;
		else await Bun.sleep(250);
	}
	console.log(`the idle session went busy by itself after ${woke} ms (the exit notice)`);
	await d.idle(s.id);
	let port = 0;
	for (let p = 5300 + Math.floor(Math.random() * 500); !port; p++) if (!sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t`)) port = p;
	await d.api(`/session/${s.id}/procs`, { command: `sleep 1; echo "compiled ok"; sleep 1; bun -e 'Bun.serve({port:${port},fetch(){return new Response("up")}}); await Bun.sleep(4000)'`, notify: { on_pattern: "compiled ok", on_port: port } });
	for (let quiet = 0; quiet < 10; ) {
		quiet = (await d.api("/session/status"))[s.id] ? 0 : quiet + 1;
		await Bun.sleep(500);
	}
	console.log("\ntranscript:");
	transcript(await d.api(`/session/${s.id}/message`));
	console.log("\nsteps (from telemetry):");
	stepTable(await d.api(`/session/${s.id}/steps`));
	await d.api(`/session/${s.id}`, undefined, "DELETE");
}

const run = { devserver, run: runScript, idle, notify }[which];
if (!run) {
	console.error(`unknown check ${which}; one of devserver, run, notify, idle`);
	process.exit(2);
}
try {
	await run();
} finally {
	for (const c of cleanups.reverse()) await c();
}
