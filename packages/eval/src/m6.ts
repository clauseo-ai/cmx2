#!/usr/bin/env bun
/**
 * m6 evals against a real daemon and the real provider path.
 *   bun packages/eval/src/m6.ts mcp     port 4830: a stdio and an http mcp server answer tool calls in sessions; reload reconnects
 *   bun packages/eval/src/m6.ts mcp-caller  port 4831 (recording mcp server on 4837): calls to a caller: true server carry
 *                                         the session; a sessions: "root" server is out of a helper's reach, and
 *                                         switching to it drops a tool a helper had loaded
 *   bun packages/eval/src/m6.ts idle    port 4839: rss over ten idle minutes after a turn
 *   bun packages/eval/src/m6.ts formatters  biome, ruff and rustfmt through the write tool, each in a project that
 *                                         declares it (biome and ruff installed into a scratch directory, not the machine)
 *   bun packages/eval/src/m6.ts worktree  port 4834 (dev server on 4838): a driver makes a checkout, spawns an
 *                                         helper into it, the helper starts the project's dev server; zero
 *                                         orphans after the session ends
 *
 * the mcp scenario needs npx (the reference servers are fetched on first use) and a free port 4838 for
 * the http server.
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daemon, nonce, port } from "./harness.ts";

const N = nonce();
const SCRATCH = `/tmp/cmx2-m6-${N}`;
const CONFIG = join(SCRATCH, "config");
mkdirSync(CONFIG, { recursive: true });
const owner = join(homedir(), ".config", "cmx2", "cmx2.jsonc");
const log = (s: string) => console.log(s);

function profile(extra: Record<string, unknown>) {
	// the user's providers (the proxy), plus what the scenario needs; written as json, which jsonc reads
	let base: Record<string, unknown> = {};
	if (existsSync(owner)) {
		const text = Bun.spawnSync(["bun", "-e", `import { parse } from "jsonc-parser"; console.log(JSON.stringify(parse(await Bun.file(${JSON.stringify(owner)}).text())))`], { cwd: join(import.meta.dir, "../../engine") }).stdout.toString();
		base = JSON.parse(text);
	}
	writeFileSync(join(CONFIG, "cmx2.jsonc"), JSON.stringify({ ...base, model: "anthropic/claude-sonnet-5-5", effort: "low", ...extra }, null, 1));
}

async function turn(d: Daemon, id: string, text: string) {
	await d.api(`/session/${id}/prompt`, { text });
	await d.idle(id, 5 * 60_000);
	const msgs = await d.api(`/session/${id}/message`);
	const tools = msgs.flatMap((m: any) => m.parts.filter((p: any) => p.type === "tool"));
	const answer = msgs.at(-1).parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	return { tools, answer };
}

async function mcp() {
	const files = join(SCRATCH, "files");
	mkdirSync(files, { recursive: true });
	const codeword = `heron-${N}`;
	writeFileSync(join(files, "notes.txt"), `the codeword is ${codeword}\n`);
	const http = Bun.spawn(["npx", "-y", "@modelcontextprotocol/server-everything", "streamableHttp"], { env: { ...process.env, PORT: "4838" }, stdout: "ignore", stderr: "ignore" });
	const d = new Daemon({ port: 4830, dataDir: join(SCRATCH, "data"), log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	try {
		for (let i = 0; i < 120 && !(await fetch("http://127.0.0.1:4838/mcp", { method: "POST" }).catch(() => undefined)); i++) await Bun.sleep(500);
		profile({
			mcp: {
				fs: { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", files] },
				everything: { url: "http://127.0.0.1:4838/mcp" },
			},
		});
		await d.start();
		const status = await d.until(async () => {
			const s = await d.api("/mcp");
			return s.every((m: any) => m.status !== "connecting") ? s : undefined;
		}, "mcp servers to settle", 90_000);
		log("GET /mcp after boot:");
		for (const m of status) log(`  ${m.name} ${m.transport} ${m.status} ${m.tools.length} tools (${m.server?.name} ${m.server?.version})${m.error ? ` ${m.error}` : ""}`);
		log((await $`bun packages/cli/src/index.ts mcp --port 4830`.cwd(join(import.meta.dir, "../../..")).env({ ...process.env, CMX2_CONFIG_DIR: CONFIG }).nothrow().text()).trimEnd().replace(/^/gm, "  cmx2 mcp | "));

		const a = (await d.api("/session", { directory: files, title: `it-mcp-fs-${N}` })).id;
		const r1 = await turn(d, a, `use the fs mcp server's tools (not your own read tool) to read ${join(files, "notes.txt")} and tell me the codeword.`);
		const fsCalls = r1.tools.filter((t: any) => t.tool.startsWith("fs_"));
		log(`stdio (fs): tools called ${r1.tools.map((t: any) => `${t.tool}:${t.state.status}`).join(", ")}; answer: ${r1.answer.trim().slice(0, 160)}`);
		log(`  fs tool output: ${JSON.stringify(fsCalls.at(-1)?.state.output ?? "").slice(0, 160)}`);

		const b = (await d.api("/session", { directory: files, title: `it-mcp-http-${N}` })).id;
		const r2 = await turn(d, b, `use the everything mcp server's echo tool to echo the text "ping-${N}", then tell me exactly what it returned.`);
		const echo = r2.tools.filter((t: any) => t.tool.startsWith("everything_"));
		log(`http (everything): tools called ${r2.tools.map((t: any) => `${t.tool}:${t.state.status}`).join(", ")}; answer: ${r2.answer.trim().slice(0, 160)}`);
		log(`  echo output: ${JSON.stringify(echo.at(-1)?.state.output ?? "").slice(0, 160)}`);

		const pids = async () => (await $`pgrep -f server-filesystem`.nothrow().text()).trim().split("\n").filter(Boolean).join(",");
		const before = await pids();
		const reload = await d.api("/global/reload", {});
		const after = await pids();
		log(`POST /global/reload: flushed ${reload.flushed.join(", ")}; mcp ${reload.mcp.map((m: any) => `${m.name} ${m.status} ${m.tools.length} tools`).join(", ")}`);
		log(`  filesystem server pids before ${before || "none"}, after ${after || "none"}`);
		writeFileSync(join(files, "notes.txt"), `the codeword is now ${codeword}-two\n`);
		const r3 = await turn(d, a, "the file changed. read it again with the fs mcp server and say the codeword it holds now.");
		const again = r3.tools.slice(r1.tools.length).filter((t: any) => t.tool.startsWith("fs_"));
		log(`after reload, fs: ${again.map((t: any) => `${t.tool}:${t.state.status}`).join(", ")}; output ${JSON.stringify(again.at(-1)?.state.output ?? "")}; answer: ${r3.answer.trim().slice(0, 120)}`);
		const ok =
			r1.answer.includes(codeword) &&
			fsCalls.some((t: any) => t.state.status === "completed") &&
			echo.some((t: any) => t.state.status === "completed" && String(t.state.output).includes(`ping-${N}`)) &&
			before !== after &&
			again.some((t: any) => t.state.status === "completed" && String(t.state.output).includes(`${codeword}-two`));
		log(ok ? "mcp: ok" : "mcp: FAILED");
		if (!ok) process.exitCode = 1;
	} finally {
		await d.stop();
		http.kill();
		await $`pkill -f "server-everything streamableHttp"`.nothrow().quiet();
	}
}

/**
 * a streamable http mcp server that records every tools/call it gets: one tool, zephyr_ping, that answers with
 * a codeword. json answers only; no GET stream (405), which pi-mcp's transport accepts
 */
function recorder(at: number, codeword: string) {
	const calls: Array<{ name: string; arguments: Record<string, unknown>; _meta?: Record<string, any> }> = [];
	const server = Bun.serve({
		port: at,
		hostname: "127.0.0.1",
		async fetch(req) {
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const m = (await req.json()) as { id?: number; method: string; params?: any };
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "mcp-session-id": "rec" } });
			if (m.id === undefined) return new Response(null, { status: 202 });
			if (m.method === "initialize") return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "recorder", version: "1.0.0" } });
			if (m.method === "tools/list") return reply({ tools: [{ name: "zephyr_ping", description: "answers with the zephyr codeword", inputSchema: { type: "object", properties: {} } }] });
			if (m.method === "tools/call") {
				calls.push(m.params);
				return reply({ content: [{ type: "text", text: `the zephyr codeword is ${codeword}` }] });
			}
			return reply({});
		},
	});
	return { calls, stop: () => server.stop(true) };
}

async function mcpCaller() {
	const work = join(SCRATCH, "work");
	mkdirSync(work, { recursive: true });
	const codeword = `zephyr-${N}`;
	const rec = recorder(port(4837), codeword);
	const recProfile = (sessions: "all" | "root") => profile({ mcp: { rec: { url: `http://127.0.0.1:${port(4837)}/mcp`, caller: true, sessions } } });
	const d = new Daemon({ port: port(4831), dataDir: join(SCRATCH, "data-caller"), log: join(SCRATCH, "caller.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	const checks: Array<[string, boolean]> = [];
	const check = (what: string, ok: boolean) => {
		checks.push([what, ok]);
		log(`${ok ? "ok  " : "FAIL"} ${what}`);
	};
	const toolParts = async (id: string) => (await d.api(`/session/${id}/message`)).flatMap((m: any) => m.parts.filter((p: any) => p.type === "tool"));
	const fromSession = (id: string) => rec.calls.filter((c) => c._meta?.["cmx2/caller"]?.sessionID === id);
	const ask = `call tool_search with the query "zephyr codeword", then call the tool it loads, rec_zephyr_ping, with no arguments, and say the codeword it returns.`;
	try {
		recProfile("all");
		await d.start();
		const status = await d.until(async () => (await d.api("/mcp")).find((m: any) => m.name === "rec" && m.status !== "connecting"), "the recorder to connect", 30_000);
		log(`GET /mcp: rec ${status.status}, sessions ${status.sessions}, caller ${status.caller}, tools ${status.tools.join(",")}`);
		check("GET /mcp says sessions all, caller true", status.status === "connected" && status.sessions === "all" && status.caller === true);
		log((await $`bun packages/cli/src/index.ts mcp --port ${port(4831)}`.cwd(join(import.meta.dir, "../../..")).env({ ...process.env, CMX2_CONFIG_DIR: CONFIG, CMX2_DATA_DIR: join(SCRATCH, "data-caller") }).nothrow().text()).trimEnd().replace(/^/gm, "  cmx2 mcp | "));

		// the root's call names it: depth 0, its own root, no parent, the call id the model used
		const root = (await d.api("/session", { directory: work, title: `it-mcp-caller-${N}` })).id;
		const r1 = await turn(d, root, ask);
		const rootPing = r1.tools.find((t: any) => t.tool === "rec_zephyr_ping");
		const c1 = fromSession(root)[0]?._meta?.["cmx2/caller"];
		log(`root ${root}: tools ${r1.tools.map((t: any) => `${t.tool}:${t.state.status}`).join(", ")}; caller ${JSON.stringify(c1)}`);
		check("the root's call carries depth 0 and rootID == sessionID, no parent, its directory and call id", !!c1 && c1.depth === 0 && c1.rootID === root && c1.parentID === null && c1.path === "/root" && c1.directory === realpathSync(work) && c1.callID === rootPing?.callID && typeof c1.host === "string");
		check("a model-visible answer came back", r1.answer.includes(codeword));

		// a helper under sessions: all reaches it and is named as a helper
		const spawned = await d.api(`/session/${root}/agents`, { brief: `${ask} report the codeword.`, name: "pinger", model: "anthropic/claude-haiku-5-5", effort: "low" });
		const kid = spawned.agents.find((a: any) => a.name === "pinger").id;
		await Bun.sleep(1000);
		await d.idle(kid, 5 * 60_000);
		const c2 = fromSession(kid)[0]?._meta?.["cmx2/caller"];
		log(`helper ${kid} under all: caller ${JSON.stringify(c2)}`);
		check("under sessions all, a helper's call carries depth 1, its parent and its root", !!c2 && c2.depth === 1 && c2.parentID === root && c2.rootID === root && c2.path === "/root/pinger");

		// switch to root: the loaded tool drops out of the helper; a fresh helper finds nothing
		const seenBefore = (await toolParts(kid)).length;
		const callsBefore = fromSession(kid).length;
		recProfile("root");
		const reload = await d.api("/global/reload", {});
		const after = reload.mcp.find((m: any) => m.name === "rec");
		log(`POST /global/reload: rec ${after?.status}, sessions ${after?.sessions}`);
		await d.until(async () => (await d.api("/mcp")).find((m: any) => m.name === "rec" && m.status === "connected" && m.sessions === "root"), "the recorder back as root", 30_000);
		log((await $`bun packages/cli/src/index.ts mcp --port ${port(4831)}`.cwd(join(import.meta.dir, "../../..")).env({ ...process.env, CMX2_CONFIG_DIR: CONFIG, CMX2_DATA_DIR: join(SCRATCH, "data-caller") }).nothrow().text()).trimEnd().replace(/^/gm, "  cmx2 mcp | "));
		await d.api(`/session/${root}/agents/message`, { to: kid, body: `call rec_zephyr_ping again with no arguments, without searching first, and say exactly what happened. then call tool_search with the query "zephyr codeword" and say which tools it loaded.` });
		await Bun.sleep(1000);
		await d.idle(kid, 5 * 60_000);
		const later = (await toolParts(kid)).slice(seenBefore);
		log(`helper after the switch: ${later.map((t: any) => `${t.tool}:${t.state.status} ${JSON.stringify(t.state.output ?? t.state.error ?? "").slice(0, 100)}`).join(" | ")}`);
		check("after the switch the server got no call from the helper that had loaded the tool", fromSession(kid).length === callsBefore);
		const retried = later.filter((t: any) => t.tool === "rec_zephyr_ping");
		check(`after the switch any rec_zephyr_ping call by that helper failed (it tried ${retried.length} times)`, retried.every((t: any) => t.state.status === "error"));
		const kidSearch = later.filter((t: any) => t.tool === "tool_search");
		check("after the switch that helper's tool_search loads no rec tool", kidSearch.length > 0 && kidSearch.every((t: any) => !String(t.state.output ?? "").includes("rec_")));

		const spawned2 = await d.api(`/session/${root}/agents`, { brief: `call tool_search with the query "zephyr codeword" and report verbatim what it returned. do not do anything else.`, name: "searcher", model: "anthropic/claude-haiku-5-5", effort: "low" });
		const kid2 = spawned2.agents.find((a: any) => a.name === "searcher").id;
		await Bun.sleep(1000);
		await d.idle(kid2, 5 * 60_000);
		const s2 = (await toolParts(kid2)).filter((t: any) => t.tool === "tool_search");
		log(`fresh helper ${kid2}: tool_search ${s2.map((t: any) => JSON.stringify(t.state.output ?? "").slice(0, 160)).join(" | ")}`);
		check("a helper spawned under sessions root finds nothing with tool_search", s2.length > 0 && s2.every((t: any) => !String(t.state.output ?? "").includes("rec_")) && fromSession(kid2).length === 0);

		// the root still reaches it
		const r3 = await turn(d, root, "call rec_zephyr_ping once more with no arguments and say the codeword.");
		const c3 = fromSession(root).at(-1)?._meta?.["cmx2/caller"];
		check("under sessions root the root's call still lands, depth 0", fromSession(root).length >= 2 && c3?.depth === 0 && r3.answer.includes(codeword));
		log(`recorder: ${rec.calls.length} calls; rss ${d.rssMb()} MB`);
		const ok = checks.every(([, v]) => v);
		log(ok ? "mcp-caller: ok" : "mcp-caller: FAILED");
		if (!ok) process.exitCode = 1;
	} finally {
		await d.stop();
		rec.stop();
	}
}

async function idle() {
	profile({});
	const d = new Daemon({ port: 4839, dataDir: join(SCRATCH, "data-idle"), log: join(SCRATCH, "idle.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	await d.start();
	try {
		const at = (label: string) => log(`${label.padEnd(26)} rss ${d.rssMb()} MB`);
		at("boot");
		const id = (await d.api("/session", { directory: SCRATCH, title: `it-idle-${N}` })).id;
		await turn(d, id, "say hi in three words");
		at("after a turn");
		for (let m = 1; m <= 10; m++) {
			await Bun.sleep(60_000);
			at(`idle minute ${m}`);
		}
		const mem = await d.api("/global/memory");
		log(`contract_violations ${mem.contract_violations}; live sessions ${mem.live_sessions}`);
	} finally {
		await d.stop();
	}
}

/**
 * a pass-through in front of the provider proxy that answers 529 overloaded to the next n model
 * requests once armed (`POST /arm?n=2`), so a client can be shown the retry status on a real turn.
 * everything else is forwarded byte for byte; the answers are the real model's.
 */
async function flaky() {
	const upstream = process.env.UPSTREAM;
	if (!upstream) throw new Error("set UPSTREAM to the provider proxy's base url (the one your profile's anthropic provider uses)");
	const port = Number(process.env.PORT ?? 4831);
	let armed = 0;
	Bun.serve({
		port,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/arm") {
				armed = Number(url.searchParams.get("n") ?? 2);
				log(`armed: the next ${armed} model requests get 529`);
				return Response.json({ armed });
			}
			if (armed > 0 && url.pathname.endsWith("/messages")) {
				armed--;
				log(`529 for ${url.pathname} (${armed} left)`);
				return Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 });
			}
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(upstream + url.pathname + url.search, { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
		},
	});
	log(`flaky pass-through on 127.0.0.1:${port} -> ${upstream}`);
	await new Promise(() => {});
}

/**
 * the m6 gate: a child helper in a checkout runs the project's dev server on the first try. the fixture's
 * server needs two things git does not track: a gitignored .env (its port and a greeting) and a package in
 * a gitignored node_modules. both have to reach the checkout for the first start to answer.
 */
async function worktree() {
	profile({});
	const shop = join(SCRATCH, "shop");
	const port = 4838;
	const greeting = `ahoy-${N}`;
	mkdirSync(join(shop, "node_modules", "shop-greeter"), { recursive: true });
	writeFileSync(join(shop, ".gitignore"), "node_modules/\n.env\n");
	writeFileSync(join(shop, "package.json"), JSON.stringify({ name: "shop", private: true, scripts: { dev: "bun server.ts" } }, null, 1));
	writeFileSync(
		join(shop, "server.ts"),
		[
			'import { greet } from "shop-greeter";',
			'const port = Number(process.env.PORT ?? "");',
			'if (!port || !process.env.GREETING) throw new Error("PORT and GREETING come from .env; copy .env into this checkout");',
			"Bun.serve({ port, hostname: \"127.0.0.1\", fetch: () => new Response(greet(process.env.GREETING!)) });",
			'console.log(`shop listening on http://127.0.0.1:${port} from ${process.cwd()}`);',
			"",
		].join("\n"),
	);
	writeFileSync(join(shop, "README.md"), "# shop\n\nbun run dev starts the dev server (port and greeting from .env).\n");
	await $`git init -q -b main && git add -A && git -c user.email=it@cmx2 -c user.name=it commit -qm shop`.cwd(shop).quiet();
	writeFileSync(join(shop, ".env"), `PORT=${port}\nGREETING=${greeting}\n`);
	writeFileSync(join(shop, "node_modules", "shop-greeter", "package.json"), JSON.stringify({ name: "shop-greeter", main: "index.js" }));
	writeFileSync(join(shop, "node_modules", "shop-greeter", "index.js"), "exports.greet = (g) => `${g} from the shop greeter`;\n");

	const d = new Daemon({ port: 4834, dataDir: join(SCRATCH, "data-wt"), log: join(SCRATCH, "worktree.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	await d.start();
	try {
		const root = (await d.api("/session", { directory: shop, title: `it-worktree-${N}` })).id;
		await d.api(`/session/${root}/prompt`, {
			text: [
				"put this work in a separate checkout so the main working tree stays untouched:",
				"1. make a checkout of this repository with worktree_create (tool_search finds it).",
				"2. spawn one helper on sonnet to work in that checkout (spawn's directory). its brief: start the project's dev server the way the README says, as a background job; once it is listening, curl it once and report the exact response body and the server's first output line. start it without keep and leave it running when you report; the session's end stops it. do not change any files.",
				"3. when its report arrives, tell me the checkout's directory and exactly what the helper reported.",
			].join("\n"),
		});
		// done when the driver has settled with nothing outstanding and its helper is not running a turn. the
		// helper stays parked on its dev server job (it notifies on exit), which is what a running dev server is
		await d.until(async () => {
			const st = await d.api("/session/status?parked=true");
			const kids = await d.api(`/session/${root}/children`);
			const driverDone = !st[root] || (st[root].type === "idle" && !st[root].parked?.agents && !st[root].parked?.jobs);
			const kidsIdle = kids.every((k: any) => st[k.id]?.type !== "busy");
			return driverDone && kidsIdle && kids.length ? true : undefined;
		}, "the driver and its helper to finish", 12 * 60_000);
		const kids = await d.api(`/session/${root}/children`);
		const child = kids[0];
		const tools = async (id: string) => (await d.api(`/session/${id}/message`)).flatMap((m: any) => m.parts.filter((p: any) => p.type === "tool"));
		const rootTools = await tools(root);
		const made = rootTools.find((t: any) => t.tool === "worktree_create" && t.state.status === "completed");
		const spawned = rootTools.find((t: any) => t.tool === "spawn");
		log(`driver: ${rootTools.map((t: any) => `${t.tool}:${t.state.status}`).join(", ")}`);
		log(`worktree_create said:\n${String(made?.state.output ?? "(not called)").replace(/^/gm, "  | ")}`);
		log(`spawn input: ${JSON.stringify(spawned?.state.input ?? {}).slice(0, 400)}`);
		log(`helper ${child?.id} works in ${child?.directory}`);
		const childTools = await tools(child.id);
		for (const t of childTools) log(`  helper ${t.tool}:${t.state.status} ${JSON.stringify(t.state.input ?? {}).slice(0, 160)}\n${String(t.state.output ?? "").slice(0, 600).replace(/^/gm, "    | ")}`);
		const procs = await d.api("/proc");
		const devs = procs.filter((p: any) => p.sessionID === child.id && /bun (run dev|server\.ts)/.test(p.command));
		log(`dev server processes the helper started: ${devs.map((p: any) => `${p.id} "${p.command}" in ${p.cwd} ${p.status}${p.exitCode != null ? ` exit ${p.exitCode}` : ""} ports ${JSON.stringify(p.ports ?? [])}`).join("; ") || "none"}`);
		const answer = (await d.api(`/session/${root}/message`)).at(-1).parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
		log(`driver's answer:\n${answer.replace(/^/gm, "  | ")}`);
		const inCheckout = child.directory !== shop && child.directory.includes("/worktree/");
		const curl = childTools.some((t: any) => String(t.state.output ?? "").includes(`${greeting} from the shop greeter`));
		const firstTry = devs.length === 1;
		// the session ends: its agents close and every process they own is reaped
		await d.api(`/session/${root}`, undefined, "DELETE");
		await Bun.sleep(1500);
		const listening = (await $`lsof -nP -tiTCP:${port} -sTCP:LISTEN`.nothrow().quiet()).stdout.toString().trim();
		// any process whose working directory is in the checkout, whatever its command line says
		const cwds = (await $`lsof -a -d cwd -Fpn`.nothrow().quiet()).stdout.toString().split("\n");
		let pid = "";
		const stray = cwds
			.flatMap((l) => {
				if (l.startsWith("p")) pid = l.slice(1);
				return l.startsWith("n") && l.slice(1).startsWith(child.directory) ? [pid] : [];
			})
			.join(",");
		const running = (await d.api("/proc")).filter((p: any) => p.status === "running");
		log(`after the session ended: port ${port} ${listening ? `still held by pid ${listening}` : "free"}; processes working in the checkout ${stray || "none"}; running in the registry ${running.length}`);
		const ok = !!made && inCheckout && curl && firstTry && !listening && !stray && running.length === 0;
		log(ok ? "worktree: ok (the helper's first dev server start answered from the checkout; zero orphans)" : `worktree: FAILED (made ${!!made}, in checkout ${inCheckout}, curl ${curl}, first try ${firstTry}, port free ${!listening}, no stray ${!stray}, registry empty ${running.length === 0})`);
		if (!ok) process.exitCode = 1;
	} finally {
		await d.stop();
	}
}

/**
 * the formatters the tools package detects besides prettier and gofmt, each run for real: a write lands a
 * badly formatted file in a project that declares the formatter, the session's after-write step runs it
 * (formatFile, as EngineSession.afterWrite does), and the write's result carries the note the model reads.
 */
async function formatters() {
	const { formatFile } = await import("../../tools/src/index.ts");
	const { writeTool } = await import("../../tools/src/fs.ts");
	const F = join(SCRATCH, "fmt");
	const js = join(F, "js");
	const py = join(F, "py");
	const rs = join(F, "rs");
	for (const d of [js, py, join(rs, "src")]) mkdirSync(d, { recursive: true });
	writeFileSync(join(js, "package.json"), '{"name":"fmt","private":true}\n');
	writeFileSync(join(js, "biome.json"), '{ "formatter": { "indentStyle": "space" } }\n');
	await $`bun add -d @biomejs/biome@2`.cwd(js).quiet();
	await $`uv venv -q .venv && uv pip install -q --python .venv/bin/python ruff`.cwd(py).quiet();
	writeFileSync(join(py, "pyproject.toml"), "[tool.ruff]\nline-length = 88\n");
	writeFileSync(join(rs, "Cargo.toml"), '[package]\nname = "fmt"\nversion = "0.1.0"\nedition = "2021"\n');
	// ruff lives in the project's virtualenv, not on the daemon's path
	const cases = [
		{ dir: js, file: "a.ts", body: "const  x={a:1,b:[1,2,3]}\nexport   default x\n" },
		{ dir: py, file: "a.py", body: "def f( a,b ):\n  return {'a':a,'b':b}\n" },
		{ dir: rs, file: "src/main.rs", body: "fn main(){let x=vec![1,2,3];println!(\"{:?}\",x);}\n" },
	];
	let ok = true;
	for (const c of cases) {
		const w = writeTool({ cwd: c.dir, spillDir: join(F, "spill"), afterWrite: async (abs: string) => {
			const f = await formatFile(abs, c.dir);
			return f?.changed ? `${f.tool} reformatted the file; read it before editing it again` : f?.error ? `${f.tool} could not format the file: ${f.error}` : undefined;
		} });
		const r = await w.execute("call", { path: c.file, content: c.body } as never);
		const said = r.content.map((x: any) => x.text).join("\n");
		const after = readFileSync(join(c.dir, c.file), "utf8");
		log(`${c.file}: write said ${JSON.stringify(said)}\n  before ${JSON.stringify(c.body)}\n  after  ${JSON.stringify(after)}`);
		if (!/reformatted the file/.test(said) || after === c.body) ok = false;
	}
	log(ok ? "formatters: ok" : "formatters: FAILED");
	if (!ok) process.exitCode = 1;
}

const cmd = process.argv[2];
if (cmd === "mcp") await mcp();
else if (cmd === "mcp-caller") await mcpCaller();
else if (cmd === "idle") await idle();
else if (cmd === "flaky") await flaky();
else if (cmd === "worktree") await worktree();
else if (cmd === "formatters") await formatters();
else {
	console.error("usage: bun packages/eval/src/m6.ts mcp|mcp-caller|idle|flaky|worktree|formatters");
	process.exit(2);
}
