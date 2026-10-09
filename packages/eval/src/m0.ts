export {};
/**
 * m0 gate driver: talks to a running daemon over http only.
 *   bun src/m0.ts <base-url> <scratch-dir> effort|run|steer
 */
const [base = "http://127.0.0.1:4830", dir = "/tmp/cmx2-it", which = "effort"] = process.argv.slice(2);
const nonce = Math.random().toString(36).slice(2, 8);

async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
	const res = await fetch(base + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}

async function newSession(label: string, effort = "medium"): Promise<string> {
	const s = await api("/session", { directory: dir, title: `it-m0-${label}-${nonce}`, effort });
	return s.id;
}

async function idle(id: string, timeoutMs = 600_000) {
	const t0 = Date.now();
	await Bun.sleep(300);
	while (Date.now() - t0 < timeoutMs) {
		const st = await api("/session/status");
		if (st[id] === undefined || st[id].type === "idle") return;
		await Bun.sleep(1000);
	}
	throw new Error(`session ${id} still busy after ${timeoutMs} ms`);
}

async function turn(id: string, text: string, effort?: string) {
	await api(`/session/${id}/prompt`, { text, ...(effort ? { effort } : {}) });
	await idle(id);
}

function printSteps(rows: any[]) {
	const cols = ["seq", "effort", "input", "cache_read", "cache_write", "output", "cache_read_pct", "ttft_ms", "tool_calls", "tool_names", "cost", "stop_reason", "prefix_hash", "steered"];
	console.log(`| ${cols.join(" | ")} |`);
	console.log(`|${cols.map(() => "---").join("|")}|`);
	for (const r of rows) console.log(`| ${cols.map((c) => (c === "cost" ? Number(r[c]).toFixed(4) : String(r[c] ?? ""))).join(" | ")} |`);
	const tail = rows.slice(1);
	const read = tail.reduce((a, r) => a + r.cache_read, 0);
	const all = tail.reduce((a, r) => a + r.cache_read + r.cache_write + r.input, 0);
	const hashes = new Set(rows.map((r) => r.prefix_hash));
	console.log(`\nsteps ${rows.length}, tool calls ${rows.reduce((a, r) => a + r.tool_calls, 0)}, cost $${rows.reduce((a, r) => a + r.cost, 0).toFixed(4)}`);
	console.log(`cache-read share after step 1: ${all ? ((100 * read) / all).toFixed(1) : "n/a"}% (${read} of ${all} input tokens)`);
	console.log(`distinct prefix hashes across steps: ${hashes.size}`);
}

async function lastText(id: string): Promise<string> {
	const msgs = await api(`/session/${id}/messages`);
	const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
	return (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

if (which === "effort") {
	const id = await newSession("effort");
	const plan: Array<[string, string]> = [
		...(process.env.M0_WARM ? [["medium", "read vendor/a.js, vendor/b.js and vendor/c.js in full (three parallel read calls) and tell me in one line what each file is."] as [string, string]] : []),
		["medium", "list the files under src with the glob tool and tell me how many there are."],
		["high", "read src/math.ts and tell me what mul returns for 3 and 3."],
		["low", "grep for 'export' in src and list the function names."],
		["max", "does src/math.test.ts expect the right value for mul(3, 3)? answer yes or no with the line."],
		["medium", "read src/strings.ts again and quote its only line."],
		["high", "which test file imports strings? one line."],
	];
	for (const [effort, text] of plan) {
		await turn(id, text, effort);
		console.log(`turn at ${effort}: ${(await lastText(id)).replace(/\s+/g, " ").slice(0, 120)}`);
	}
	const reqs = await api(`/session/${id}/requests`);
	console.log("\neffort markers per request (historical..., active):");
	for (const r of reqs) console.log(`  req ${r.seq}: [${r.effort_markers.join(", ")}] betas=${r.betas.length}`);
	console.log();
	printSteps(await api(`/session/${id}/steps`));
	console.log(`\nsession ${id}`);
}

if (which === "run") {
	const id = await newSession("run");
	await turn(
		id,
		"in a single run script: read src/math.ts, src/strings.ts and src/math.test.ts, grep src for 'export', run `bun test` with shell.exec, and return only the failing test names with the expected and received values plus the exported function names. do it in one run call.",
	);
	const rows = await api(`/session/${id}/steps`);
	printSteps(rows);
	const msgs = await api(`/session/${id}/messages`);
	for (const m of msgs) {
		if (m.role === "toolResult" && m.toolName === "run") {
			console.log(`\nrun result (isError=${m.isError}, details=${JSON.stringify(m.details)}, nested calls=${m.nestedCalls?.calls?.length ?? "?"}):`);
			console.log(m.content.map((c: any) => c.text).join("\n").slice(0, 1500));
			if (m.nestedCalls) console.log("nested:", JSON.stringify(m.nestedCalls.calls?.map((c: any) => `${c.name}:${c.status}`)));
		}
		if (m.role === "assistant") {
			for (const c of m.content) if (c.type === "toolCall" && c.name === "run") console.log(`\nscript:\n${c.arguments.code}`);
		}
	}
	console.log(`\nfinal: ${await lastText(id)}`);
	console.log(`session ${id}`);
}

if (which === "steer") {
	const id = await newSession("steer");
	const steerText = `also, before you finish, say the word PAPRIKA-${nonce} on its own line.`;
	await api(`/session/${id}/prompt`, {
		text: "run the shell command `sleep 6 && echo first-done`, then run `sleep 2 && echo second-done`, one at a time, then report both outputs.",
	});
	// wait until the first tool is executing, then steer
	const t0 = Date.now();
	while (Date.now() - t0 < 120_000) {
		const reqs = await api(`/session/${id}/requests`);
		const msgs = await api(`/session/${id}/messages`);
		if (msgs.some((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "toolCall"))) break;
		await Bun.sleep(250);
		void reqs;
	}
	const before = (await api(`/session/${id}/requests`)).length;
	const r = await api(`/session/${id}/steer`, { text: steerText });
	console.log(`steer sent while busy after request ${before}: ${JSON.stringify(r)}`);
	await idle(id);
	const reqs = await api(`/session/${id}/requests`);
	for (const q of reqs) {
		const hit = q.tail.some((t: any) => t.text.includes(`PAPRIKA-${nonce}`));
		console.log(`req ${q.seq}: messages=${q.message_count} steer_in_tail=${hit}`);
		for (const t of q.tail) console.log(`    ${t.role}: ${t.text.replace(/\s+/g, " ").slice(0, 110)}`);
	}
	const rows = await api(`/session/${id}/steps`);
	printSteps(rows);
	console.log(`stop reasons: ${rows.map((r: any) => r.stop_reason).join(", ")} (no "aborted" means no abort)`);
	console.log(`final: ${(await lastText(id)).replace(/\s+/g, " ")}`);
	console.log(`session ${id}`);
}
