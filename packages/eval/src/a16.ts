/**
 * a16 driver: a real daemon on a dev port (never 4096), the real provider path, one short turn that writes a file
 * and edits it. the turn's events are tapped; the completed edit and write parts must carry metadata.filediff, the
 * file.edited events the same counts, and the counts must match `git diff --numstat` against the repo's first commit.
 *   bun packages/eval/src/a16.ts [--port 4927] [--model anthropic/claude-sonnet-5-5]
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Daemon, gitRepo, nonce, port } from "./harness.ts";

const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1]! : fallback;
};
const PORT = Number(arg("port", String(port(4832))));
const MODEL = arg("model", "anthropic/claude-sonnet-5-5");
const scratch = process.env.CMX2_DATA_DIR ?? `/tmp/cmx2-a16-${nonce()}`;
const config = join(scratch, "config");
const repo = join(scratch, "repo");
mkdirSync(config, { recursive: true });
const owner = join(homedir(), ".config", "cmx2", "cmx2.jsonc");
if (existsSync(owner)) copyFileSync(owner, join(config, "cmx2.jsonc"));
else writeFileSync(join(config, "cmx2.jsonc"), "{}\n");
await gitRepo(repo, { "README.md": "# a16\n" });

const d = new Daemon({ port: PORT, dataDir: join(scratch, "data"), log: join(scratch, "daemon.log"), env: { CMX2_CONFIG_DIR: config, CMX2_MODEL: MODEL } });
let failed = 0;
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed++;
};
const events: any[] = [];
const ctl = new AbortController();
try {
	await d.start();
	void (async () => {
		const res = await fetch(`${d.base}/global/event`, { headers: d.headers(), signal: ctl.signal }).catch(() => undefined);
		if (!res) return;
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const r = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
			if (r.done) return;
			buf += dec.decode(r.value, { stream: true });
			let i: number;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
				buf = buf.slice(i + 2);
				if (data) events.push(JSON.parse(data.slice(6)).payload);
			}
		}
	})();
	const s = await d.api("/session", { directory: repo, title: `it-a16-${nonce()}` });
	await d.api(`/session/${s.id}/prompt_async`, {
		text: "use the write tool to create src.ts with exactly this one line: `export const   a=1;export const b  =  2`. then use the edit tool to change `a=1` to `a=100` in it. reply with the word done and nothing else.",
	});
	await Bun.sleep(1000);
	await d.idle(s.id, 4 * 60_000);
	const messages: any[] = await d.api(`/session/${s.id}/message`);
	const tools = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p.tool === "write" || p.tool === "edit"));
	console.log(`tool parts: ${tools.map((t) => `${t.tool}:${t.state.status}`).join(", ")}`);
	check(tools.length >= 2 && tools.every((t) => t.state.status === "completed"), "a write and an edit completed");
	for (const t of tools) {
		const fd = t.state.metadata?.filediff;
		console.log(`${t.tool}: filediff +${fd?.additions} -${fd?.deletions}, patch ${fd?.patch?.length} chars, truncated ${t.state.metadata?.truncated}`);
		check(!!fd && typeof fd.patch === "string" && typeof fd.additions === "number" && typeof fd.deletions === "number", `${t.tool} part carries filediff {patch, additions, deletions}`);
	}
	const edited = events.filter((e) => e.type === "file.edited" && e.properties.sessionID === s.id).map((e) => [e.properties.file, e.properties.additions, e.properties.deletions]);
	console.log(`file.edited: ${JSON.stringify(edited)}`);
	check(edited.length >= 2 && edited.every((e) => typeof e[1] === "number" && typeof e[2] === "number"), "file.edited carries additions and deletions");
	const sum = (xs: any[]) => xs.reduce((a, b) => a + b, 0);
	console.log(`part counts +${sum(tools.map((t) => t.state.metadata.filediff.additions))} -${sum(tools.map((t) => t.state.metadata.filediff.deletions))}; event counts +${sum(edited.map((e) => e[1]))} -${sum(edited.map((e) => e[2]))}`);
	check(JSON.stringify(tools.map((t) => [t.state.metadata.filediff.additions, t.state.metadata.filediff.deletions])) === JSON.stringify(edited.map((e) => [e[1], e[2]])), "each event's counts equal its part's");
	await $`git add -A -N`.cwd(repo).quiet();
	const numstat = (await $`git diff --numstat HEAD`.cwd(repo).text()).trim();
	const [a, del] = numstat.split("\t");
	const last = tools.at(-1)!.state.metadata.filediff;
	console.log(`git numstat vs HEAD: ${numstat}; the file now: ${(await Bun.file(join(repo, "src.ts")).text()).trim()}`);
	check(Number(a) >= 1, "git sees the file as added");
	console.log(`last part patch:\n${last.patch}`);
} finally {
	ctl.abort();
	await d.stop();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
