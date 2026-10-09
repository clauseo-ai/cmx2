import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Daemon, gitRepo, port } from "./harness.ts";

/**
 * how often does `run` carry exactly one nested call? the same few tasks in fresh sessions,
 * one daemon from this checkout, so the prompt profile on disk is the one measured:
 *
 *   bun packages/eval/src/small-run.ts <label> [repeats=3]
 *   bun packages/eval/src/small-run.ts --store <copy of cmx2.db>
 *
 * a real model answers (sonnet 5.5 at high effort, the model and effort most real `run` calls came from, through the profile's provider), a handful of short turns.
 * prints, per task and in total, the `run` calls by number of nested calls and which helper the lone ones used.
 */
// the other number: the share in a store. read a COPY (sqlite3 <live db> ".backup /tmp/copy.db"), never the live file
if (process.argv[2] === "--store") {
	const file = process.argv[3];
	if (!file) throw new Error("usage: small-run.ts --store <copy of cmx2.db>");
	const db = new Database(file, { readonly: true });
	const runs = `from part where type = 'tool' and json_extract(data, '$.tool') = 'run' and json_extract(data, '$.state.metadata.calls') is not null`;
	const one = `${runs} and json_extract(data, '$.state.metadata.calls') = 1`;
	const n = (q: string) => (db.query(`select count(*) as n ${q}`).get() as { n: number }).n;
	const total = n(runs);
	const lone = n(one);
	console.log(`run calls with a recorded call count: ${total}; exactly one nested call: ${lone} (${Math.round((1000 * lone) / total) / 10}%)`);
	for (const r of db.query(`select json_extract(data, '$.state.metadata.nested[0].helper') as helper, count(*) as n ${one} group by 1 order by 2 desc limit 6`).all() as { helper: string; n: number }[]) console.log(`  lone helper ${r.helper}: ${r.n}`);
	process.exit(0);
}
const label = process.argv[2] ?? "run";
// the label becomes a path that is removed recursively
if (!/^[\w-]+$/.test(label)) throw new Error(`label must be letters, digits, _ and -, got ${JSON.stringify(label)}`);
const repeats = Number(process.argv[3] ?? 3);
const scratch = `/tmp/cmx2-small-${label}`;
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const files: Record<string, string> = {
	"package.json": JSON.stringify({ name: "tally", version: "1.2.0", scripts: { test: "bun test" } }, null, 2),
	"README.md": "# tally\n\na tiny counting library.\n",
	"src/count.ts": "export function count(xs: string[]): Record<string, number> {\n\tconst out: Record<string, number> = {};\n\tfor (const x of xs) out[x] = (out[x] ?? 0) + 1;\n\treturn out;\n}\n\n// TODO: sort the keys\n",
	"src/parse.ts": "export function parse(line: string): string[] {\n\treturn line.split(\",\").map((s) => s.trim());\n}\n\n// TODO: quoted fields\n",
	"src/count.test.ts": 'import { expect, test } from "bun:test";\nimport { count } from "./count.ts";\n\ntest("counts", () => {\n\texpect(count(["a", "b", "a"])).toEqual({ a: 2, b: 1 });\n});\n',
};
// a dozen small modules so a question about the code takes more than one look
for (let i = 1; i <= 12; i++) {
	const fns = Array.from({ length: 1 + (i % 4) }, (_, j) => `export function f${i}_${j}(x: number): number {\n\treturn x * ${i + j};\n}\n`);
	files[`src/mod${i}.ts`] = `${i % 3 === 0 ? 'import { count } from "./count.ts";\n\n' : ""}${fns.join("\n")}`;
}
let made = 0;
async function freshRepo(): Promise<string> {
	const dir = join(scratch, `repo-${made++}`);
	await gitRepo(dir, files);
	return dir;
}

const TASKS = [
	"what is the package name and version, and which source files are there?",
	"show me the last git commit message",
	"run the tests and tell me if they pass",
	"list every TODO in the repo and the function each one sits next to",
	"check git status and whether the tests pass, then give me a two line summary",
	"how many lines is each source file?",
	"which modules export more than two functions, and which ones import count?",
	"make count return its keys sorted (the TODO), then run the tests and show me the diff",
];

const d = new Daemon({ port: port(4928), dataDir: `/tmp/cmx2-small-${label}-data`, log: `${scratch}/daemon.log` });
await d.start();
const byCalls: Record<number, number> = {};
const lone: Record<string, number> = {};
const tools: Record<string, number> = {};
try {
	for (const task of TASKS) {
		const per: Record<number, number> = {};
		for (let i = 0; i < repeats; i++) {
			const s = await d.api("/session", { directory: await freshRepo() });
			await d.api(`/session/${s.id}/prompt_async`, { parts: [{ type: "text", text: task }], model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "high" });
			await d.idle(s.id, 5 * 60_000);
			const msgs = await d.api(`/session/${s.id}/message?limit=100`);
			for (const m of msgs) {
				for (const p of m.parts ?? []) {
					if (p.type !== "tool") continue;
					tools[p.tool] = (tools[p.tool] ?? 0) + 1;
					if (p.tool !== "run") continue;
					const n = p.state?.metadata?.calls;
					if (typeof n !== "number") continue;
					per[n] = (per[n] ?? 0) + 1;
					byCalls[n] = (byCalls[n] ?? 0) + 1;
					if (n === 1) lone[p.state.metadata.nested?.[0]?.helper ?? "?"] = (lone[p.state.metadata.nested?.[0]?.helper ?? "?"] ?? 0) + 1;
				}
			}
		}
		console.log(`${JSON.stringify(task)}: run calls by nested count ${JSON.stringify(per)}`);
	}
} finally {
	await d.stop();
}
const total = Object.values(byCalls).reduce((a, b) => a + b, 0);
console.log(`[${label}] all tools used: ${JSON.stringify(tools)}`);
console.log(`[${label}] run calls ${total}, by nested count ${JSON.stringify(byCalls)}, lone helpers ${JSON.stringify(lone)}`);
console.log(`[${label}] share of run calls with exactly one nested call: ${total ? Math.round((1000 * (byCalls[1] ?? 0)) / total) / 10 : 0}%`);
