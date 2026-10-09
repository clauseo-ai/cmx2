/**
 * prompt-cache forensics against an anthropic-compatible endpoint (a proxy), with raw requests so
 * every byte is ours. each experiment prints the prompt tokens beside what was read and written, so a miss
 * can be told apart from a prefix under the model's minimum.
 *   CACHE_BASE=http://127.0.0.1:8080 bun packages/eval/src/cache.ts <experiment> [model]
 * experiments: min, replay, delay, chain, concurrent, stream, ttl, maxtokens, all
 * and, over a daemon's store, which earlier entry each step read (no requests sent):
 *   bun packages/eval/src/cache.ts classify <cmx2.db> [title-like]
 */

export {};

if (!process.env.CACHE_BASE) throw new Error("set CACHE_BASE to the anthropic-compatible endpoint to probe, e.g. CACHE_BASE=http://127.0.0.1:8080");
const BASE = process.env.CACHE_BASE.replace(/\/$/, "");
const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Usage {
	input: number;
	read: number;
	write: number;
	write1h: number;
	total: number;
	status: number;
	ms: number;
	error?: string;
}

/** deterministic filler: seeded words, so two builds of the same (seed, size) are byte-identical */
function filler(seed: string, words: number): string {
	let h = 2166136261;
	for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
	const vocab = ["session", "cache", "prefix", "token", "daemon", "proxy", "vertex", "region", "stream", "request", "breakpoint", "window", "model", "step", "tool", "result", "write", "read", "entry", "ttl", "context", "message", "system", "block", "hash", "route", "replica", "phone", "fleet", "agent", "turn", "effort"];
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
		out.push(`${vocab[h % vocab.length]}${h % 7 === 0 ? `-${(h >>> 8) % 997}` : ""}`);
		if (i % 17 === 16) out.push(".\n");
	}
	return out.join(" ");
}

const TOOLS = ["read", "grep", "shell"].map((name) => ({
	name,
	description: `${name}: ${filler(`tool-${name}`, 120)}`,
	input_schema: { type: "object", properties: { arg: { type: "string", description: "the argument" } }, required: ["arg"] },
}));

async function send(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Usage> {
	const t0 = performance.now();
	const res = await fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": "proxy-ignores-this", "anthropic-version": "2023-06-01", ...headers },
		body: JSON.stringify(body),
	});
	const ms = Math.round(performance.now() - t0);
	const text = await res.text();
	if (!res.ok) return { input: 0, read: 0, write: 0, write1h: 0, total: 0, status: res.status, ms, error: text.slice(0, 300) };
	let u: any;
	if (body.stream) {
		// message_start carries the prompt usage; message_delta may restate it
		for (const line of text.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const ev = JSON.parse(line.slice(6));
			if (ev.type === "message_start") u = ev.message.usage;
		}
	} else u = JSON.parse(text).usage;
	const read = u.cache_read_input_tokens ?? 0;
	const write = u.cache_creation_input_tokens ?? 0;
	return { input: u.input_tokens, read, write, write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, total: u.input_tokens + read + write, status: res.status, ms };
}

const cc = (ttl?: "1h") => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });

function base(model: string, system: string, messages: unknown[], extra: Record<string, unknown> = {}) {
	return { model, max_tokens: 1024, system: [{ type: "text", text: system, cache_control: cc() }], messages, ...extra };
}

const fmt = (u: Usage) => (u.error ? `status ${u.status}: ${u.error}` : `prompt ${u.total} · read ${u.read} · write ${u.write}${u.write1h ? ` (1h ${u.write1h})` : ""} · input ${u.input} · ${u.ms} ms`);

// ---------- experiments ----------

/** a system prompt of growing size, sent twice: a prefix under the minimum is neither written nor read */
async function min(model: string) {
	console.log(`\n## min · ${model} (breakpoint on the system block; the prefix is everything up to it)`);
	for (const words of [600, 1100, 1700, 2300, 2900, 3500, 4200, 5200]) {
		const sys = `${nonce}-min-${words}\n${filler(`${nonce}-min-${words}`, words)}`;
		const body = base(model, sys, [{ role: "user", content: "say ok" }], { max_tokens: 16 });
		const a = await send(body);
		const b = await send(body);
		const cached = a.write || b.read;
		console.log(`words ${words}: first ${fmt(a)} | second ${fmt(b)} | ${cached ? `cached prefix ${cached}` : `not cached (prompt ${a.total})`}`);
	}
}

/** the same bytes, sent again and again: the reads an identical request gets */
async function replay(model: string, words = 6000, reps = 6) {
	console.log(`\n## replay · ${model} · ${words} words, ${reps} identical sends after the first`);
	const body = base(model, `${nonce}-replay-${words}\n${filler(`${nonce}-replay`, words)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { max_tokens: 16, tools: TOOLS });
	console.log(`write: ${fmt(await send(body))}`);
	for (let i = 0; i < reps; i++) {
		await Bun.sleep(1500);
		console.log(`rep ${i + 1}: ${fmt(await send(body))}`);
	}
}

/**
 * an agent's append-only chain: each request is the previous one plus an assistant tool call and its
 * result, with cmx2's breakpoints (last tool, system, where the previous request put its last one, the
 * last message). a hit reads the whole previous prompt; a miss reads the system+tools entry or nothing.
 */
async function chain(model: string, preambleWords: number, steps = 8, label = "") {
	const sys = `${nonce}-chain-sys\n${filler(`${nonce}-sys`, 3500)}`;
	const tag = `${nonce}-${label || preambleWords}`;
	const first = `${tag}\n${preambleWords ? filler(`${tag}-pre`, preambleWords) : ""}\nuse the read tool once per step.`;
	const msgs: any[] = [{ role: "user", content: [{ type: "text", text: first }] }];
	console.log(`\n## chain · ${model} · preamble ${preambleWords} words · ${steps} steps ${label} · layout ${process.env.CACHE_LAYOUT ?? "cmx2"}`);
	let prev: Usage | undefined;
	let prevPrefix = 0;
	const rows: string[] = [];
	for (let k = 0; k < steps; k++) {
		// CACHE_LAYOUT: cmx2 (last tool, system, rolling, last message), norolling (no rolling), lastonly (last message only)
		const layout = process.env.CACHE_LAYOUT ?? "cmx2";
		const body: any = base(model, sys, structuredClone(msgs), { tools: structuredClone(TOOLS), max_tokens: 16 });
		if (layout === "lastonly") delete body.system[0].cache_control;
		else body.tools[body.tools.length - 1].cache_control = cc();
		const lastUser = body.messages.length - 1;
		const lb = body.messages[lastUser].content;
		lb[lb.length - 1].cache_control = cc();
		if (lastUser >= 2 && layout === "cmx2") {
			const rb = body.messages[lastUser - 2].content;
			rb[rb.length - 1].cache_control = cc();
		}
		const u = await send(body);
		// prefix up to the last breakpoint: everything this request wrote or read at its last message
		const prefix = u.read + u.write;
		const verdict = !prev ? "first" : u.read >= prevPrefix - 5 ? "HIT" : u.read === 0 ? "ZERO" : `PARTIAL(${u.read} of ${prevPrefix})`;
		rows.push(`step ${k + 1}: ${fmt(u)} · prefix ${prefix} · ${verdict}`);
		console.log(rows.at(-1));
		prev = u;
		prevPrefix = prefix;
		msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${k + 1}` }, { type: "tool_use", id: `toolu_${tag.replace(/[^a-z0-9]/gi, "")}_${k}`, name: "read", input: { arg: `file-${k}.ts` } }] });
		msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${tag.replace(/[^a-z0-9]/gi, "")}_${k}`, content: filler(`${tag}-res-${k}`, 900) }] });
		await Bun.sleep(1000);
	}
	return rows;
}

/** a fresh write, then the identical request after a pause: how long before a write can be read */
async function delay(model: string, reps = 3) {
	console.log(`\n## write-to-read delay · ${model} · ${reps} fresh prefixes per delay`);
	for (const d of [0, 1000, 3000, 6000, 12000]) {
		const out: string[] = [];
		for (let r = 0; r < reps; r++) {
			const body = base(model, `${nonce}-delay-${d}-${r}\n${filler(`${nonce}-delay-${d}-${r}`, 3000)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { max_tokens: 16 });
			const a = await send(body);
			await Bun.sleep(d);
			const b = await send(body);
			out.push(b.read ? `hit ${b.read}` : `MISS (rewrote ${b.write} of prompt ${b.total})`);
			if (!a.write) out.push(`(first did not write: ${fmt(a)})`);
		}
		console.log(`pause ${d / 1000}s after the write answered: ${out.join(" | ")}`);
	}
}

/** identical requests at the same moment, cold and then warm */
async function concurrent(model: string, n = 4) {
	console.log(`\n## concurrent · ${model} · ${n} identical requests at once`);
	const body = base(model, `${nonce}-conc\n${filler(`${nonce}-conc`, 6000)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { max_tokens: 16 });
	const cold = await Promise.all(Array.from({ length: n }, () => send(body)));
	cold.forEach((u, i) => console.log(`cold ${i + 1}: ${fmt(u)}`));
	await Bun.sleep(2000);
	const warm = await Promise.all(Array.from({ length: n }, () => send(body)));
	warm.forEach((u, i) => console.log(`warm ${i + 1}: ${fmt(u)}`));
	// a fresh prefix: one request, then n at once 200 ms after it started (before it has answered)
	const body2 = base(model, `${nonce}-conc2\n${filler(`${nonce}-conc2`, 6000)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { max_tokens: 16 });
	const lead = send(body2);
	await Bun.sleep(200);
	const trail = await Promise.all(Array.from({ length: n - 1 }, () => send(body2)));
	console.log(`staggered lead: ${fmt(await lead)}`);
	trail.forEach((u, i) => console.log(`staggered +200ms ${i + 1}: ${fmt(u)}`));
}

/** the same prompt through streamRawPredict and rawPredict */
async function stream(model: string) {
	console.log(`\n## stream vs non-stream · ${model}`);
	for (const [a, b] of [
		[true, false],
		[false, true],
	] as const) {
		const body = base(model, `${nonce}-stream-${a}\n${filler(`${nonce}-stream-${a}`, 6000)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { max_tokens: 16 });
		const first = await send({ ...body, stream: a });
		await Bun.sleep(1500);
		const second = await send({ ...body, stream: b });
		await Bun.sleep(1500);
		const third = await send({ ...body, stream: b });
		console.log(`write ${a ? "stream" : "sync"}: ${fmt(first)}\nread ${b ? "stream" : "sync"}: ${fmt(second)}\nagain ${b ? "stream" : "sync"}: ${fmt(third)}`);
	}
}

/** ttl order and whether a 5m entry is read by a request marked 1h */
async function ttl(model: string) {
	console.log(`\n## ttl · ${model}`);
	const sys = `${nonce}-ttl\n${filler(`${nonce}-ttl`, 6000)}`;
	const msg = (c: object) => [{ role: "user", content: [{ type: "text", text: `${nonce} ${filler(`${nonce}-ttl-msg`, 400)}`, cache_control: c }] }];
	const body = (s: object, m: object) => ({ model, max_tokens: 16, system: [{ type: "text", text: sys, cache_control: s }], messages: msg(m) });
	console.log(`5m, 5m (write): ${fmt(await send(body(cc(), cc())))}`);
	console.log(`1h, 1h (same prompt): ${fmt(await send(body(cc("1h"), cc("1h"))))}`);
	console.log(`1h then 5m: ${fmt(await send(body(cc("1h"), cc())))}`);
	console.log(`5m then 1h (the rolling breakpoint's order under a long ttl): ${fmt(await send(body(cc(), cc("1h"))))}`);
}

/** the same prompt with a different max_tokens */
async function maxtokens(model: string) {
	console.log(`\n## max_tokens · ${model}`);
	const b = base(model, `${nonce}-mt\n${filler(`${nonce}-mt`, 6000)}`, [{ role: "user", content: [{ type: "text", text: "say ok", cache_control: cc() }] }], { thinking: { type: "adaptive" } });
	console.log(`max_tokens 1024: ${fmt(await send({ ...b, max_tokens: 1024 }))}`);
	console.log(`max_tokens 1024 again: ${fmt(await send({ ...b, max_tokens: 1024 }))}`);
	console.log(`max_tokens 2048: ${fmt(await send({ ...b, max_tokens: 2048 }))}`);
	console.log(`max_tokens 1: ${fmt(await send({ ...b, max_tokens: 1 }))}`);
}

/**
 * every step of a store's sessions, by the entry it read: the previous request's (a hit), an older step's,
 * the system+tools entry only, or nothing. a changed prefix shows as a partial read; routing does not.
 */
async function classify(path: string, like = "%") {
	const { Database } = await import("bun:sqlite");
	const db = new Database(path, { readonly: true });
	const rows = db
		.query("select s.session_id sid, s.seq, s.cache_read rd, s.cache_write wr, s.model, s.prefix_same ps from step s join session x on x.id = s.session_id where x.title like ? order by s.session_id, s.seq")
		.all(like) as Array<{ sid: string; seq: number; rd: number; wr: number; model: string; ps: number }>;
	const tally: Record<string, number> = {};
	const prefixes = new Map<string, number[]>();
	for (const r of rows) {
		const seen = prefixes.get(r.sid) ?? [];
		const near = (p: number) => Math.abs(r.rd - p) <= 3;
		const older = seen.slice(0, -1).findIndex(near);
		const kind = !seen.length ? "first" : near(seen.at(-1)!) ? "hit" : r.rd === 0 ? "miss: read 0" : older >= 0 ? "miss: read an older step's entry" : r.rd < 7000 ? "miss: read system+tools only" : "miss: partial";
		if (seen.length) tally[kind] = (tally[kind] ?? 0) + 1;
		const detail = kind.startsWith("miss") ? ` · prefix ${r.rd + r.wr} tokens, wrote ${r.wr}${older >= 0 ? ` (read step ${older + 1}'s)` : ""}` : "";
		console.log(`${r.sid.slice(0, 14)} step ${r.seq} · ${r.model.split("/").pop()} · read ${r.rd}${detail} · ${kind}${r.ps ? "" : " · PREFIX CHANGED"}`);
		seen.push(r.rd + r.wr);
		prefixes.set(r.sid, seen);
	}
	console.log(JSON.stringify(tally));
}

const [exp = "all", model = "claude-opus-5-5"] = process.argv.slice(2);
if (exp === "classify") {
	await classify(model, process.argv[4]);
	process.exit(0);
}
console.log(`cache forensics · ${BASE} · nonce ${nonce} · ${new Date().toISOString()}`);
const run: Record<string, () => Promise<unknown>> = {
	min: () => min(model),
	replay: () => replay(model),
	chain: async () => {
		// CACHE_PREAMBLES: comma-separated preamble sizes in words (opus 5.5 reads about 2.4 tokens a word)
		const sizes = (process.env.CACHE_PREAMBLES ?? "0,30000").split(",").map(Number);
		const reps = Number(process.env.CACHE_REPS) || 2;
		for (const words of sizes) for (let rep = 1; rep <= reps; rep++) await chain(model, words, 8, `rep${rep}`);
	},
	delay: () => delay(model),
	concurrent: () => concurrent(model),
	stream: () => stream(model),
	ttl: () => ttl(model),
	maxtokens: () => maxtokens(model),
};
if (exp === "all") for (const k of Object.keys(run)) await run[k]!();
else if (run[exp]) await run[exp]();
else throw new Error(`unknown experiment ${exp}; one of ${Object.keys(run).join(", ")}, all`);
