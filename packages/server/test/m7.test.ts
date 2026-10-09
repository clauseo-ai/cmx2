/**
 * m7 against a real daemon and the real provider path:
 * file snapshots per turn, the session diff and its summary on the row, revert, unrevert, the revert made
 * permanent by the next send (nothing deleted: rule 15), fork, context fill, and compaction with recall
 * and notes: a tool output cleared from the context is found by recall, the notes ride the summary.
 *
 * one cli daemon on port 4839 (shifted by CMX2_PORT_SHIFT), sonnet 5.5 at low. the profile is the config dir in
 * $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else ANTHROPIC_API_KEY from the env.
 *
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it every test here is skipped and no daemon starts.
 * run: CMX2_LIVE_TESTS=1 bun test packages/server/test/m7.test.ts (a few minutes)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Daemon, LIVE, gitRepo, liveDescribe, liveNote, liveProfile, nonce, port } from "../../eval/src/harness.ts";

const N = nonce();
const SCRATCH = realpathSync((mkdirSync(`/tmp/cmx2-m7-${N}`, { recursive: true }), `/tmp/cmx2-m7-${N}`));
const CONFIG = join(SCRATCH, "config");
const DATA = join(SCRATCH, "data");
let d: Daemon;
liveNote("m7 (real model turns)");

beforeAll(async () => {
	if (!LIVE) return;
	liveProfile(CONFIG);
	d = new Daemon({ port: port(4839), dataDir: DATA, log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG, CMX2_MODEL: "anthropic/claude-sonnet-5-5", CMX2_EFFORT: "low" } });
	await d.start();
	console.log(`daemon pid ${d.pid} on ${port(4839)}, scratch ${SCRATCH}`);
}, 30_000);
afterAll(() => d?.stop());

/** what the store holds for a session, read straight from sqlite: rule 15 counts every row, reverted ones too */
function counts(id: string) {
	const db = new Database(join(DATA, "cmx2.db"), { readonly: true });
	try {
		const q = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
		return { messages: q("select count(*) as n from message where session_id = ?"), reverted: q("select count(*) as n from message where session_id = ? and reverted = 1"), sessions: (db.query("select count(*) as n from session").get() as { n: number }).n };
	} finally {
		db.close();
	}
}

async function turn(id: string, text: string) {
	await d.api(`/session/${id}/prompt`, { text });
	await d.idle(id, 240_000);
}

const userTexts = (msgs: any[]) => msgs.filter((m) => m.info.role === "user").map((m) => m.parts.filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text).join(""));
const lastAnswer = (msgs: any[]) => msgs.filter((m) => m.info.role === "assistant").at(-1)!.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");

liveDescribe("snapshots, diff, revert, unrevert, fork", () => {
	const proj = join(SCRATCH, "proj");
	beforeAll(() => gitRepo(proj, { "README.md": "# m7\n" }));

	test(
		"two turns change a file; the diff, revert, unrevert, the permanent revert and a fork all tell the truth",
		async () => {
			const id = (await d.api("/session", { directory: proj, title: `m7-revert-${N}` })).id;
			const file = join(proj, "list.txt");
			await turn(id, "use the write tool once to create list.txt with exactly these two lines: alpha, beta (one word per line, a newline at the end). then stop.");
			const one = readFileSync(file, "utf8");
			await turn(id, "use the edit tool on list.txt: change beta to gamma, and add a third line delta. then stop.");
			const two = readFileSync(file, "utf8");
			console.log(`after turn 1: ${JSON.stringify(one)}; after turn 2: ${JSON.stringify(two)}`);
			expect(one).toBe("alpha\nbeta\n");
			expect(two).toContain("gamma");

			const msgs = await d.api(`/session/${id}/message`);
			const users = msgs.filter((m: any) => m.info.role === "user");
			const u2 = users[1].info.id;

			// the session's diff: list.txt did not exist before the first turn
			const diff = await d.api(`/session/${id}/diff`);
			console.log(`session diff: ${JSON.stringify(diff.map((f: any) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })))}`);
			expect(diff).toHaveLength(1);
			expect(diff[0]).toMatchObject({ file: "list.txt", status: "added", before: "", after: two });
			const turnDiff = await d.api(`/session/${id}/diff?messageID=${u2}`);
			console.log(`turn 2 diff: ${JSON.stringify(turnDiff.map((f: any) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })))}`);
			expect(turnDiff[0]).toMatchObject({ file: "list.txt", status: "modified", before: one, after: two });

			// the row carries cost, tokens, context fill and the diff summary, in the list too
			const info = await d.api(`/session/${id}`);
			const listed = (await d.api("/session")).find((s: any) => s.id === id);
			console.log(`a10 on the row: cost ${info.cost}, tokens ${JSON.stringify(info.tokens)}, context ${JSON.stringify(info.context)}, summary ${JSON.stringify(info.summary)}`);
			expect(info.summary).toEqual({ files: 1, additions: diff[0].additions, deletions: 0 });
			expect(info.context.used).toBeGreaterThan(1000);
			expect(info.context.limit).toBeGreaterThanOrEqual(200_000);
			expect(info.cost).toBeGreaterThan(0);
			expect(listed.summary).toEqual(info.summary);
			expect(listed.context.limit).toBe(info.context.limit);

			// revert to before turn 2: the file is back, the messages are parked, not gone
			const reverted = await d.api(`/session/${id}/revert`, { messageID: u2 });
			expect(reverted.revert.messageID).toBe(u2);
			expect(readFileSync(file, "utf8")).toBe(one);
			expect((await d.api(`/session/${id}/message`)).length).toBe(msgs.length);
			console.log(`revert: ${JSON.stringify(reverted.revert.diff)} undone, file ${JSON.stringify(readFileSync(file, "utf8"))}`);

			// unrevert: the second turn's file comes back
			const back = await d.api(`/session/${id}/unrevert`, {});
			expect(back.revert).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(two);

			// revert again, then send: the revert is permanent, the parked messages leave every list and stay stored
			await d.api(`/session/${id}/revert`, { messageID: u2 });
			const before = counts(id);
			const lines = readFileSync(join(DATA, "sessions", `${id}.jsonl`), "utf8").trim().split("\n").length;
			await turn(id, "what lines does list.txt hold now? read it and answer with the lines only, comma separated.");
			const after = counts(id);
			const now = await d.api(`/session/${id}/message`);
			const transcript = readFileSync(join(DATA, "sessions", `${id}.jsonl`), "utf8");
			console.log(`rule 15: rows ${before.messages} -> ${after.messages} (reverted ${after.reverted}), sessions ${before.sessions} -> ${after.sessions}, transcript lines ${lines} -> ${transcript.trim().split("\n").length}; listed user messages ${JSON.stringify(userTexts(now).map((t) => t.slice(0, 40)))}; answer ${JSON.stringify(lastAnswer(now))}`);
			expect(after.messages).toBeGreaterThanOrEqual(before.messages);
			expect(after.sessions).toBe(before.sessions);
			expect(after.reverted).toBeGreaterThan(0);
			expect(transcript).toContain("gamma");
			expect(now.some((m: any) => m.info.id === u2)).toBe(false);
			expect(lastAnswer(now).toLowerCase()).toContain("beta");
			expect(lastAnswer(now).toLowerCase()).not.toContain("gamma");
			expect((await d.api(`/session/${id}`)).revert).toBeUndefined();

			// fork before the last prompt: the fork holds turn one only (turn two was reverted), and runs on its own
			const u3 = now.filter((m: any) => m.info.role === "user").at(-1).info.id;
			const f = await d.api(`/session/${id}/fork`, { messageID: u3 });
			expect(f.title).toBe(`m7-revert-${N} (fork #1)`);
			const fm = await d.api(`/session/${f.id}/message`);
			expect(userTexts(fm)).toEqual([userTexts(msgs)[0]]);
			await turn(f.id, "what did you write into list.txt earlier? answer from memory in one line.");
			const fsteps = await d.api(`/session/${f.id}/steps`);
			const fork2 = await d.api(`/session/${id}/fork`, {});
			console.log(`fork: ${f.id} "${f.title}", ${fm.length} messages copied, first step cache_read ${fsteps[0].cache_read} (${fsteps[0].cache_read_pct}%); a second fork is "${fork2.title}"; answer ${JSON.stringify(lastAnswer(await d.api(`/session/${f.id}/message`)))}`);
			expect(fsteps[0].cache_read).toBeGreaterThan(0);
			expect(fork2.title).toBe(`m7-revert-${N} (fork #2)`);
			expect(counts(id).messages).toBe(after.messages);
		},
		900_000,
	);
});

liveDescribe("compaction, recall, notes", () => {
	const proj = join(SCRATCH, "recall");
	const needle = `ZX-${N}-QUILL`;
	const word = `heliotrope-${N}`;
	beforeAll(async () => {
		const filler = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${i}: the quick brown fox jumps over the lazy dog, again and again, for the record.`).join("\n");
		const a = `${filler("a", 200)}\nneedle: ${needle}\n${filler("a2", 200)}\n`;
		await gitRepo(proj, { "big-a.txt": a, "big-b.txt": `${filler("b", 300)}\n`, ".cmx2/cmx2.jsonc": JSON.stringify({ compaction: { at: 60_000, keep: 0.5, protect: 11_000, prefire: false } }) });
	});

	test(
		"a manual compaction clears an old tool output; recall finds it, the notes ride the post-compaction block",
		async () => {
			const id = (await d.api("/session", { directory: proj, title: `m7-recall-${N}` })).id;
			await turn(id, `use the notes tool to write exactly this and nothing else: the code word is ${word}. then stop.`);
			await turn(id, "read big-a.txt with the read tool (the whole file), then reply with its last line number only.");
			await turn(id, "read big-b.txt with the read tool (the whole file), then reply with its first word only.");
			const before = counts(id);
			const t0 = Date.now();
			expect(await d.api(`/session/${id}/summarize`, { providerID: "anthropic", modelID: "claude-sonnet-5-5" })).toBe(true);
			const ms = Date.now() - t0;
			const after = counts(id);
			const lines = readFileSync(join(DATA, "sessions", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			const rec = lines.find((l) => l.message?.role === "compaction")!.message;
			const readA = lines.find((l) => l.message?.role === "assistant" && JSON.stringify(l.message.content).includes("big-a.txt"))!.message.content.find((b: any) => b.type === "toolCall");
			const pct = Math.round((1000 * rec.usage.cacheRead) / (rec.usage.input + rec.usage.cacheRead + rec.usage.cacheWrite)) / 10;
			console.log(`compaction: ${ms} ms (summary ${rec.summaryMs} ms), tokens before ${rec.tokensBefore}, summary ${rec.summary.length} chars, cache read ${rec.usage.cacheRead} of ${rec.usage.input + rec.usage.cacheRead + rec.usage.cacheWrite} (${pct}%), cleared ${JSON.stringify(rec.cleared)}, rows ${before.messages} -> ${after.messages}`);
			expect(rec.cleared).toContain(readA.id);
			expect(rec.state).toContain(word);
			expect(rec.summary).toMatch(/^##\s*goal/im);
			expect(after.messages).toBeGreaterThan(before.messages);
			const msgs = await d.api(`/session/${id}/message`);
			const pit = msgs.find((m: any) => m.parts.some((p: any) => p.type === "compaction"));
			const summaryTurn = msgs.find((m: any) => m.info.summary === true);
			expect(pit).toBeDefined();
			expect(summaryTurn.info.agent).toBe("compaction");

			await turn(id, "a line in big-a.txt starts with 'needle:'. that file's output is no longer in your context. use the recall tool to find the line, then answer with the needle value only.");
			const m2 = await d.api(`/session/${id}/message`);
			const recall = m2.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool" && p.tool === "recall");
			console.log(`recall output: ${JSON.stringify(recall?.state.output?.slice(0, 400))}`);
			console.log(`recall answer: ${JSON.stringify(lastAnswer(m2))}`);
			expect(recall.state.output).toContain("[recovered from tool output cleared from your context]");
			expect(recall.state.output).toContain(needle);
			expect(lastAnswer(m2)).toContain(needle);

			await turn(id, "what is the code word in your notes? answer with the code word only.");
			const m3 = await d.api(`/session/${id}/message`);
			console.log(`notes answer after compaction: ${JSON.stringify(lastAnswer(m3))}`);
			expect(lastAnswer(m3)).toContain(word);
			expect(readFileSync(join(DATA, "notes", `${id}.md`), "utf8")).toContain(word);
		},
		900_000,
	);
});
