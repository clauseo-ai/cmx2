#!/usr/bin/env bun
/**
 * m7 evals against a real daemon and the real provider path.
 *   bun packages/eval/src/m7.ts compact [--port 4850] [--model anthropic/claude-sonnet-5-5]
 *       a 900k-token session: ~620k tokens of history already compacted away and ~235k live, seeded as a
 *       transcript; then one real turn reads a chain of files, one step each, past the prefire point and the
 *       300k threshold. prints every step, the background summary, the compaction (how long the turn
 *       waited, the summary's own time, its cache read) and rss.
 *   bun packages/eval/src/m7.ts idle [--port 4851]
 *       rss over ten idle minutes after turns and a compaction
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daemon, nonce, ROOT } from "./harness.ts";

const N = nonce();
const SCRATCH = `/tmp/cmx2-m7-eval-${N}`;
const CONFIG = join(SCRATCH, "config");
mkdirSync(CONFIG, { recursive: true });
const owner = join(homedir(), ".config", "cmx2", "cmx2.jsonc");
const log = (s: string) => console.log(s);
const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const MODEL = arg("model") ?? "anthropic/claude-sonnet-5-5";
/** characters per token for this repo's source, measured on the first run (232k estimated at 3.5 was 348k); the real count comes back from the provider */
const CHARS_PER_TOKEN = 2.34;

function profile(extra: Record<string, unknown>) {
	let base: Record<string, unknown> = {};
	if (existsSync(owner)) {
		const text = Bun.spawnSync(["bun", "-e", `import { parse } from "jsonc-parser"; console.log(JSON.stringify(parse(await Bun.file(${JSON.stringify(owner)}).text())))`], { cwd: join(import.meta.dir, "../../engine") }).stdout.toString();
		base = JSON.parse(text);
	}
	writeFileSync(join(CONFIG, "cmx2.jsonc"), JSON.stringify({ ...base, model: MODEL, effort: "low", ...extra }, null, 1));
}

/** the repo's own source, as the body of files the seeded history read */
function sourceText(): string {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".ts")) out.push(`// ${p.slice(ROOT.length + 1)}\n${readFileSync(p, "utf8")}`);
		}
	};
	walk(join(ROOT, "packages"));
	return out.join("\n");
}

/**
 * appends a history to a fresh session's transcript: `compacted` tokens of read turns, a compaction line
 * whose kept tail starts at the next message, then `live` tokens of read turns. returns what was written.
 */
function seed(file: string, compacted: number, live: number) {
	const src = sourceText();
	let cursor = 0;
	const chunk = (tokens: number) => {
		const chars = Math.round(tokens * CHARS_PER_TOKEN);
		let s = "";
		while (s.length < chars) {
			const take = Math.min(chars - s.length, src.length - cursor);
			s += src.slice(cursor, cursor + take);
			cursor = (cursor + take) % src.length;
		}
		return s;
	};
	const existing = readFileSync(file, "utf8").trim().split("\n").length - 1;
	let pos = existing;
	let t = Date.now() - 3 * 3_600_000;
	const lines: string[] = [];
	const add = (message: unknown) => {
		lines.push(JSON.stringify({ type: "message", message }));
		return ++pos;
	};
	const usage = (read: number) => ({ input: 40, output: 60, cacheRead: read, cacheWrite: 0, totalTokens: read + 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	let running = 6_000;
	let i = 0;
	const readTurn = (tokens: number) => {
		i++;
		const path = `docs/archive/part-${String(i).padStart(3, "0")}.ts`;
		const id = `toolu_seed_${N}_${i}`;
		add({ role: "user", content: `read ${path} and tell me what it covers`, timestamp: (t += 60_000) });
		add({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], api: "anthropic-messages", provider: "anthropic", model: MODEL.split("/")[1], usage: usage(running), stopReason: "toolUse", timestamp: (t += 2_000) });
		add({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: chunk(tokens) }], isError: false, timestamp: (t += 500) });
		running += tokens + 80;
		add({ role: "assistant", content: [{ type: "text", text: `${path} is more of the daemon's source; nothing in it needs a change.` }], api: "anthropic-messages", provider: "anthropic", model: MODEL.split("/")[1], usage: usage(running), stopReason: "stop", timestamp: (t += 3_000) });
		running += 120;
		return tokens + 200;
	};
	let a = 0;
	while (a < compacted) a += readTurn(20_000);
	const summary = `## goal\n- review the daemon's source file by file and say what each part covers\n\n## constraints and preferences\n- read only; change nothing\n\n## done\n- read docs/archive/part-001.ts through part-${String(i).padStart(3, "0")}.ts; none needed a change\n\n## in progress\n- (none)\n\n## blocked\n- (none)\n\n## key decisions\n- read whole files, one per step\n\n## ruled out\n- (none)\n\n## live state\n- (none)\n\n## next steps\n- keep reading the next parts when asked\n\n## critical context\n- the parts are the daemon's own typescript\n\n## relevant files\n- docs/archive/: the parts being read`;
	running = 6_000 + 2_000;
	const tailFrom = pos + 2;
	add({ role: "compaction", summary, state: "turn context: seeded\n\nno processes running", tailFrom, cleared: [], trigger: "auto", tokensBefore: a, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, model: MODEL, summaryMs: 0, prefire: false, timestamp: (t += 1_000) });
	let b = 0;
	while (b < live) b += readTurn(Math.min(20_000, live - b + 200));
	appendFileSync(file, `${lines.join("\n")}\n`);
	return { compacted: a, live: b, messages: lines.length, bytes: lines.reduce((n, l) => n + l.length + 1, 0) };
}

/** the session's events as they arrive, stamped with seconds since `t0` */
function watch(d: Daemon, id: string, t0: number, into: string[]) {
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${d.base}/global/event`, { signal: ctl.signal, headers: d.headers() });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let k: number;
				while ((k = buf.indexOf("\n\n")) >= 0) {
					const line = buf.slice(0, k).split("\n").find((l) => l.startsWith("data: "));
					buf = buf.slice(k + 2);
					if (!line) continue;
					const e = JSON.parse(line.slice(6)).payload;
					if (e.properties?.sessionID !== id) continue;
					const at = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
					if (e.type === "step.recorded") {
						const s = e.properties.step;
						into.push(`${at}s  step ${String(s.seq).padStart(3)}  ${s.tool_names || "(text)"}  in ${s.input} + read ${s.cache_read} + write ${s.cache_write} = ${s.input + s.cache_read + s.cache_write} tokens, cache read ${s.cache_read_pct}%, ${s.duration_ms} ms`);
					} else if (e.type === "compaction.prefire") {
						const p = e.properties;
						into.push(`${at}s  prefire ${p.state} at ${p.tokens} tokens${p.ms ? `: summary in ${p.ms} ms, ${p.chars} chars, cache read ${p.cacheRead} of ${p.cacheRead + p.cacheWrite + p.input} (${p.cacheReadPct}%)` : ""}${p.message ? `: ${p.message}` : ""}`);
					} else if (e.type === "session.compacted") {
						const c = e.properties;
						into.push(`${at}s  COMPACTED (${c.trigger}${c.prefire ? ", from the prefire" : ""}): ${c.tokensBefore} -> ~${c.tokensAfter} tokens; the turn waited ${c.durationMs} ms (${c.waitedMs} ms of it on the background summary); summary request ${c.summaryMs} ms, cache read ${c.cacheRead} of ${c.cacheRead + c.cacheWrite + c.input} (${c.cacheReadPct}%), $${c.cost.toFixed(4)}; ${c.cleared} outputs cleared`);
					} else if (e.type === "compaction.failed" || e.type === "session.error") into.push(`${at}s  ${e.type} ${JSON.stringify(e.properties).slice(0, 300)}`);
				}
			}
		} catch {}
	})();
	return () => ctl.abort();
}

async function compact() {
	profile({});
	const port = Number(arg("port") ?? 4850);
	const proj = join(SCRATCH, "proj");
	mkdirSync(proj, { recursive: true });
	// the chain the real turn reads: each file names the next, so the reads cannot be batched into one step
	const src = sourceText();
	const CHAIN = 16;
	for (let k = 1; k <= CHAIN; k++) {
		const body = src.slice(k * 20_000, k * 20_000 + 14_000);
		const tail = k < CHAIN ? `\n// the next file to read is chain-${k + 1}.txt\n` : "\n// this is the last file in the chain.\n";
		writeFileSync(join(proj, `chain-${k}.txt`), body + tail);
	}
	const d = new Daemon({ port, dataDir: join(SCRATCH, "data"), log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	await d.start();
	try {
		log(`daemon pid ${d.pid} on ${port}, model ${MODEL}, scratch ${SCRATCH}; boot rss ${d.rssMb()} MB`);
		const info = await d.api("/session", { directory: proj, title: `m7-900k-${N}` });
		const file = join(SCRATCH, "data", "sessions", `${info.id}.jsonl`);
		const s = seed(file, 620_000, Number(arg("live") ?? 228_000));
		log(`seeded ${info.id}: ${s.messages} transcript lines, ${(s.bytes / 1e6).toFixed(1)} MB; ~${s.compacted} tokens compacted away, ~${s.live} tokens live (estimated at ${CHARS_PER_TOKEN} chars a token)`);
		const lines: string[] = [];
		const t0 = Date.now();
		const stop = watch(d, info.id, t0, lines);
		await d.api(`/session/${info.id}/prompt`, { text: "reply with the single word ready." });
		await d.idle(info.id, 10 * 60_000);
		const cal = (await d.api(`/session/${info.id}/steps`)).at(-1);
		log(`calibration step: ${cal.input + cal.cache_read + cal.cache_write} tokens in context by the provider's count; rss ${d.rssMb()} MB`);
		for (const l of lines.splice(0)) log(l);
		const t1 = Date.now();
		await d.api(`/session/${info.id}/prompt`, {
			text: "read chain-1.txt with the read tool. every file names the next one at its end; read that one next, one file per step, until a file says it is the last. then reply with the word done and nothing else.",
		});
		await d.idle(info.id, 15 * 60_000);
		await Bun.sleep(1_000);
		stop();
		for (const l of lines) log(l);
		const steps = (await d.api(`/session/${info.id}/steps`)).filter((x: any) => x.at >= t1);
		const rec = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((l) => l.message?.role === "compaction")
			.at(-1)?.message;
		const msgs = await d.api(`/session/${info.id}/message`);
		const answer = msgs.at(-1).parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
		const reads = steps.filter((x: any) => x.tool_names.includes("read")).length;
		log(`turn: ${steps.length} steps, ${reads} with reads, ${((Date.now() - t1) / 1000).toFixed(1)} s wall, answer ${JSON.stringify(answer.slice(0, 80))}`);
		if (rec && rec.tokensBefore > 0 && rec.summaryMs > 0) {
			const denom = rec.usage.input + rec.usage.cacheRead + rec.usage.cacheWrite;
			log(`compaction line in the transcript: trigger ${rec.trigger}, prefire ${rec.prefire}, tokens before ${rec.tokensBefore}, summary ${rec.summary.length} chars in ${rec.summaryMs} ms, cache read ${rec.usage.cacheRead}/${denom} = ${((100 * rec.usage.cacheRead) / denom).toFixed(1)}%, tail from ${rec.tailFrom}, cleared ${rec.cleared.length}`);
		} else log("no compaction happened in the turn");
		const info2 = await d.api(`/session/${info.id}`);
		log(`session row after: context ${JSON.stringify(info2.context)}, cost $${info2.cost.toFixed(4)}; rss ${d.rssMb()} MB`);
		const mem = await d.api("/global/memory?gc=true");
		log(`after gc: rss ${(mem.rss / 1048576).toFixed(1)} MB, heap ${(mem.heapUsed / 1048576).toFixed(1)} MB; contract_violations ${mem.contract_violations}`);
	} finally {
		await d.stop();
	}
}

async function idle() {
	profile({ compaction: { at: 40_000, keep: 0.3 } });
	const port = Number(arg("port") ?? 4851);
	const proj = join(SCRATCH, "idle");
	mkdirSync(proj, { recursive: true });
	writeFileSync(join(proj, "big.txt"), sourceText().slice(0, 120_000));
	const d = new Daemon({ port, dataDir: join(SCRATCH, "data-idle"), log: join(SCRATCH, "idle.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	await d.start();
	try {
		const at = (label: string) => log(`${label.padEnd(26)} rss ${d.rssMb()} MB`);
		at("boot");
		const id = (await d.api("/session", { directory: proj, title: `m7-idle-${N}` })).id;
		await d.api(`/session/${id}/prompt`, { text: "read big.txt with the read tool, then reply with its first word only." });
		await d.idle(id, 5 * 60_000);
		await d.api(`/session/${id}/prompt`, { text: "use the notes tool to write: idle eval ran. then say ok." });
		await d.idle(id, 5 * 60_000);
		await d.api(`/session/${id}/summarize`, {});
		const row = await d.api(`/session/${id}`);
		at("after turns and a compaction");
		log(`session context ${JSON.stringify(row.context)}`);
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

const cmd = process.argv[2];
if (cmd === "compact") await compact();
else if (cmd === "idle") await idle();
else {
	console.error("usage: bun packages/eval/src/m7.ts compact|idle [--port n]");
	process.exit(2);
}
