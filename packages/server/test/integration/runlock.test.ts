import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, LIVE, gitRepo, liveNote, liveProfile, nonce, port } from "../../../eval/src/harness.ts";

/**
 * run lock across processes: two real daemons share one data dir (one db, one transcript per session)
 * and drive one session through the real provider. at most one of them may run its turn at a time, the
 * refused one gets a typed 409 naming the holder, and whoever runs next sees the other's turn.
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it the test is skipped and no daemon starts.
 * the live profile is the config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else
 * ANTHROPIC_API_KEY from the env. ports 4832 and 4833.
 */
const IT = LIVE;
liveNote("runlock.test.ts (a real model turn)");
const MODEL = process.env.CMX2_IT_MODEL ?? "anthropic/claude-sonnet-5-5";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-it-lock-")));
const data = join(root, "data");
const repo = join(root, "repo");
const a = new Daemon({ port: port(4832), dataDir: data, password: "pw", log: join(root, "a.log"), env: { CMX2_CONFIG_DIR: join(root, "config") } });
const b = new Daemon({ port: port(4833), dataDir: data, password: "pw", log: join(root, "b.log"), env: { CMX2_CONFIG_DIR: join(root, "config") } });
let id = "";

beforeAll(async () => {
	if (!IT) return;
	liveProfile(join(root, "config"));
	await gitRepo(repo);
	await Promise.all([a.start(), b.start()]);
	console.log(`daemon a pid ${a.pid} on ${port(4832)}, daemon b pid ${b.pid} on ${port(4833)}, shared data ${data}`);
}, 30_000);

afterAll(async () => {
	if (!IT) return;
	if (id) await a.raw(`/session/${id}`, undefined, "DELETE").catch(() => {});
	await Promise.all([a.stop(), b.stop()]);
	console.log("both daemons stopped");
}, 30_000);

async function refused(d: Daemon, path: string, text: string, holder: Daemon) {
	const res = await d.raw(path, { text });
	const body = (await res.json()) as { name: string; data: { message: string; holder?: { pid: number } } };
	console.log(`  ${d === a ? "a" : "b"} POST ${path.split("/").pop()} → ${res.status} ${body.name}: ${body.data.message}`);
	expect(res.status).toBe(409);
	expect(body.name).toBe("BusyError");
	expect(body.data.holder?.pid).toBe(holder.pid!);
}

test.skipIf(!IT)(
	"two daemon processes cannot run one session concurrently",
	async () => {
		id = (await a.api("/session", { directory: repo, title: `it-lock-${nonce()}`, model: MODEL, effort: "low" })).id;
		console.log(`session ${id} (${MODEL})`);

		await a.api(`/session/${id}/prompt`, { text: "run `sleep 8 && echo first-turn-ran` with the shell tool, then reply with its output only." });
		await a.until(async () => (await a.api("/session/status"))[id], "a busy");
		console.log(`a runs turn 1; a status: ${JSON.stringify((await a.api("/session/status"))[id])}`);
		await refused(b, `/session/${id}/prompt`, "hello from b", a);
		await refused(b, `/session/${id}/steer`, "steer from b", a);
		await refused(b, `/session/${id}/queue`, "queue from b", a);
		await a.idle(id);
		console.log("a finished turn 1");

		const r = await b.raw(`/session/${id}/prompt`, { text: "run `sleep 6 && echo second-turn-ran` with the shell tool. then reply with two lines: what the previous turn's command printed, and what this one printed." });
		console.log(`  b POST prompt → ${r.status}`);
		expect(r.status).toBe(202);
		await b.until(async () => (await b.api("/session/status"))[id], "b busy");
		await refused(a, `/session/${id}/prompt`, "hello from a", b);
		await b.idle(id);
		const bView = await b.api(`/session/${id}/message`);
		const bAnswer = bView.at(-1).parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
		console.log(`b finished turn 2; b's answer: ${JSON.stringify(bAnswer)}`);
		expect(bAnswer).toContain("first-turn-ran");
		expect(bAnswer).toContain("second-turn-ran");

		// a still holds its old copy in memory; its next turn must start from the transcript b extended
		const r3 = await a.raw(`/session/${id}/prompt`, { text: "how many shell commands have run in this session so far? reply with the number only." });
		expect(r3.status).toBe(202);
		await a.idle(id);
		const raw = (await a.api(`/session/${id}/messages`)) as any[];
		const sawB = raw.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("second-turn-ran"));
		const last = raw.at(-1);
		const aAnswer = (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
		console.log(`a turn 3 reopened from disk: saw b's turn in its transcript: ${sawB}; a's answer: ${JSON.stringify(aAnswer)}`);
		expect(sawB).toBe(true);
		expect(aAnswer).toContain("2");

		const steps = (await a.api(`/session/${id}/steps`)) as any[];
		console.log(`steps recorded across both daemons: ${steps.length}; assistant messages in the projection: ${(await a.api(`/session/${id}/message`)).filter((m: any) => m.info.role === "assistant").length}`);
		for (const d of [a, b]) {
			const mem = await d.api("/global/memory");
			console.log(`  ${d === a ? "a" : "b"}: rss ${(mem.rss / 1048576).toFixed(1)} MB, contract violations ${mem.contract_violations}`);
			expect(mem.contract_violations).toBe(0);
		}
	},
	5 * 60_000,
);
