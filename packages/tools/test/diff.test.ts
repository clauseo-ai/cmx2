import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { CREATED_PATCH_CAP, DIFF_MAX_BYTES, diffOnDisk, fileDiff, MIDDLE_MAX_BYTES, PATCH_CAP, snapshot } from "../src/diff.ts";
import { editTool, writeTool, type EditDetails, type WriteDetails } from "../src/fs.ts";
import { runTool } from "../src/run.ts";
import type { NestedCall } from "../src/types.ts";
import { scratch } from "./helpers.ts";

/** the diff an edit or write carries is a true patch with true counts */

/** the diff of a change that can be diffed: undefined is a failure of the test, not an answer */
function diffOf(file: string, before: Buffer | null, after: Buffer) {
	const r = fileDiff(file, before, after);
	if (!r) throw new Error(`no diff for ${file}`);
	return r;
}

/** a seeded generator, so a failing case replays */
function rng(seed: number) {
	return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function mutate(lines: string[], r: () => number): string[] {
	const out = [...lines];
	const n = 1 + Math.floor(r() * 6);
	for (let i = 0; i < n; i++) {
		const at = Math.floor(r() * (out.length + 1));
		const kind = r();
		if (kind < 0.4) out.splice(at, 0, `new ${Math.floor(r() * 50)}`);
		else if (kind < 0.7) out.splice(at, 1);
		else out[at] = `changed ${Math.floor(r() * 50)}`;
	}
	return out.filter((l) => l !== undefined);
}

test("counts match git's numstat and the patch applies, over random edits (including a missing final newline)", async () => {
	const env = scratch("diff");
	const r = rng(7);
	for (let i = 0; i < 60; i++) {
		const base = Array.from({ length: Math.floor(r() * 40) }, (_, j) => `line ${j % 9}`);
		const next = mutate(base, r);
		const eolA = r() < 0.7 ? "\n" : "";
		const eolB = r() < 0.7 ? "\n" : "";
		const a = base.length ? base.join("\n") + eolA : "";
		const b = next.length ? next.join("\n") + eolB : "";
		const file = join(env.cwd, `f${i}.txt`);
		const pa = join(env.cwd, `a${i}.txt`);
		const pb = join(env.cwd, `b${i}.txt`);
		writeFileSync(pa, a);
		writeFileSync(pb, b);
		const d = diffOf(file, Buffer.from(a), Buffer.from(b)).filediff;
		const numstat = (await $`git diff --no-index --numstat ${pa} ${pb}`.nothrow().text()).trim().split("\t");
		if (a === b) {
			expect([d.additions, d.deletions, d.patch]).toEqual([0, 0, ""]);
			continue;
		}
		expect([i, d.additions, d.deletions]).toEqual([i, Number(numstat[0] ?? 0), Number(numstat[1] ?? 0)]);
		// the patch, applied to the old bytes, gives the new ones
		writeFileSync(file, a);
		const p = join(env.cwd, `p${i}.patch`);
		writeFileSync(p, d.patch);
		const applied = await $`patch -s ${file} ${p}`.nothrow().quiet();
		expect([i, applied.exitCode]).toEqual([i, 0]);
		expect([i, readFileSync(file, "utf8")]).toEqual([i, b]);
	}
});

/** git's counts for two texts, and whether our patch turns the first into the second */
async function againstGit(env: { cwd: string }, name: string, a: string, b: string) {
	const pa = join(env.cwd, `${name}.a`);
	const pb = join(env.cwd, `${name}.b`);
	writeFileSync(pa, a);
	writeFileSync(pb, b);
	const d = diffOf(join(env.cwd, `${name}.f`), Buffer.from(a), Buffer.from(b));
	const numstat = (await $`git diff --no-index --numstat ${pa} ${pb}`.nothrow().text()).trim().split("\t");
	const file = join(env.cwd, `${name}.f`);
	writeFileSync(file, a);
	const p = join(env.cwd, `${name}.patch`);
	writeFileSync(p, d.filediff.patch);
	const applied = d.truncated ? undefined : await $`patch -s ${file} ${p}`.nothrow().quiet();
	const out = { d, git: [Number(numstat[0]), Number(numstat[1])], applied: applied?.exitCode, result: d.truncated ? undefined : readFileSync(file, "utf8") };
	for (const f of [pa, pb, file, p]) rmSync(f, { force: true });
	return out;
}

test("a change further apart than Myers searches is split on the lines both sides have once, and the counts are git's", async () => {
	const env = scratch("far");
	// a replace_all changing 600 of 6000 lines: 1200 edits, past the 1000 Myers is allowed
	const lines = Array.from({ length: 6000 }, (_, i) => `row ${i} of the table`);
	const changed = lines.map((l, i) => (i % 10 === 3 ? l.replace("row", "ROW") : l));
	const r = await againstGit(env, "r600", lines.join("\n") + "\n", changed.join("\n") + "\n");
	expect(r.git).toEqual([600, 600]);
	expect([r.d.filediff.additions, r.d.filediff.deletions]).toEqual([600, 600]);
	// its patch is one 6000-line hunk, cut at the cap: the counts are the whole change
	expect(r.d.truncated).toBe(true);
	// the same shape with room for the whole patch (short lines, a change every 25 lines: 1040 edits): the patch applies
	const long = Array.from({ length: 13_000 }, (_, i) => `r${i}`);
	const next = long.map((l, i) => (i % 25 === 3 ? `R${i}` : l));
	const q = await againstGit(env, "r12000", long.join("\n") + "\n", next.join("\n") + "\n");
	expect(q.git).toEqual([520, 520]);
	expect([q.d.filediff.additions, q.d.filediff.deletions]).toEqual([520, 520]);
	expect(q.d.truncated).toBe(false);
	expect(q.applied).toBe(0);
	expect(q.result).toBe(next.join("\n") + "\n");
});

test("a big file with a change every hundred lines is counted as git counts it, quickly", async () => {
	// about 10 MB: 200,000 lines of 50 bytes, every 100th changed
	const lines = Array.from({ length: 200_000 }, (_, i) => `${String(i).padStart(7, "0")} ${"payload ".repeat(5)}`);
	const a = lines.join("\n") + "\n";
	const b = lines.map((l, i) => (i % 100 === 99 ? `${l}!` : l)).join("\n") + "\n";
	expect(a.length).toBeGreaterThan(9_000_000);
	const t0 = performance.now();
	const d = diffOf("/x/big.log", Buffer.from(a), Buffer.from(b));
	const ms = performance.now() - t0;
	const env = scratch("scatter");
	writeFileSync(join(env.cwd, "a.log"), a);
	writeFileSync(join(env.cwd, "b.log"), b);
	const git = (await $`git diff --no-index --numstat ${join(env.cwd, "a.log")} ${join(env.cwd, "b.log")}`.nothrow().text()).trim().split("\t");
	expect([Number(git[0]), Number(git[1])]).toEqual([2000, 2000]);
	expect([d.filediff.additions, d.filediff.deletions]).toEqual([2000, 2000]);
	expect(d.truncated).toBe(true);
	expect(Buffer.byteLength(d.filediff.patch)).toBeLessThanOrEqual(PATCH_CAP);
	expect(d.filediff.patch).toContain("@@ ");
	console.log(`10 MB, 2000 scattered changes: ${ms.toFixed(0)} ms`);
	expect(ms).toBeLessThan(2000);
});

test("a region replaced whole when there is nothing to split on counts what the patch shows", () => {
	// every line occurs many times on both sides: no unique lines to anchor on, and a distance past Myers
	const a = Array.from({ length: 1500 }, (_, i) => `a${i % 3}`).join("\n") + "\n";
	const b = Array.from({ length: 1500 }, (_, i) => `b${i % 3}`).join("\n") + "\n";
	const d = diffOf("/x/f.txt", Buffer.from(a), Buffer.from(b)).filediff;
	expect([d.additions, d.deletions]).toEqual([1500, 1500]);
	expect(d.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length + d.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length).toBeLessThanOrEqual(3000);
});

test("a patch is cut at a hunk boundary at the cap, with no marker in it, and what is kept applies", async () => {
	const env = scratch("cut");
	const a = Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join("\n") + "\n";
	const b = a.replaceAll("row 1", "ROW 1");
	const r = diffOf("/x/big.txt", Buffer.from(a), Buffer.from(b));
	expect(r.truncated).toBe(true);
	expect(r.filediff.additions).toBe(r.filediff.deletions);
	expect(r.filediff.additions).toBeGreaterThan(5000);
	expect(Buffer.byteLength(r.filediff.patch)).toBeLessThanOrEqual(PATCH_CAP);
	expect(r.filediff.patch).not.toContain("patch cut");
	// every hunk is whole: its header counts its own lines
	const hunks = r.filediff.patch.split(/^@@ /m).slice(1);
	expect(hunks.length).toBeGreaterThan(1);
	for (const h of hunks) {
		const [head, ...body] = h.split("\n");
		const m = head!.match(/^-(\d+),(\d+) \+(\d+),(\d+) @@$/)!;
		const lines = body.filter((l) => l !== "");
		expect([lines.filter((l) => l[0] !== "+").length, lines.filter((l) => l[0] !== "-").length]).toEqual([Number(m[2]), Number(m[4])]);
	}
	// the patch applies to the old file and changes the lines it shows
	const file = join(env.cwd, "big.txt");
	writeFileSync(file, a);
	const p = join(env.cwd, "cut.patch");
	writeFileSync(p, r.filediff.patch);
	expect((await $`patch -s ${file} ${p}`.nothrow().quiet()).exitCode).toBe(0);
	const done = readFileSync(file, "utf8");
	expect(done.startsWith("row 0\nROW 1\n")).toBe(true);
	expect(done).toContain("ROW 1000\n");
	expect(done.endsWith("row 19999\n")).toBe(true);
	// the first hunk alone over the cap (a file the call created) is cut inside, its header counting what is kept
	const first = diffOf("/x/one.txt", null, Buffer.from(b));
	const head = first.filediff.patch.match(/^@@ -0,0 \+1,(\d+) @@$/m)!;
	expect(first.filediff.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length).toBe(Number(head[1]));
});

test("a file the call created keeps its counts and a much smaller patch", () => {
	const b = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + "\n";
	const r = diffOf("/x/new.txt", null, Buffer.from(b));
	expect([r.filediff.additions, r.filediff.deletions, r.truncated]).toEqual([3000, 0, true]);
	expect(Buffer.byteLength(r.filediff.patch)).toBeLessThanOrEqual(CREATED_PATCH_CAP);
	expect(Buffer.byteLength(r.filediff.patch)).toBeGreaterThan(CREATED_PATCH_CAP - 200);
	// a file that already existed gets the full cap
	const over = diffOf("/x/old.txt", Buffer.from("old\n"), Buffer.from(b));
	expect(Buffer.byteLength(over.filediff.patch)).toBeGreaterThan(CREATED_PATCH_CAP * 4);
});

test("a change too big to diff carries no diff, and a local change in a big file still does", () => {
	const line = `${"y".repeat(99)}\n`;
	const n = Math.ceil(MIDDLE_MAX_BYTES / 100) + 10;
	const a = Buffer.from(line.repeat(n));
	// every line changed: no counts are better than counts made up
	expect(fileDiff("/x/huge.log", a, Buffer.from(`${"z".repeat(99)}\n`.repeat(n)))).toBeUndefined();
	// only the first and last line changed, in a file of 21 MB (git: 2 and 2): the changed region is the whole file, so no diff, not +100,000 -100,000
	const lines = Array.from({ length: 210_000 }, (_, i) => `${String(i).padStart(7, "0")} ${"payload ".repeat(11)}`);
	const old = Buffer.from(lines.join("\n") + "\n");
	const edges = Buffer.from(["EDGE one", ...lines.slice(1, -1), "EDGE two"].join("\n") + "\n");
	expect(old.length).toBeGreaterThan(20_000_000);
	expect(fileDiff("/x/edges.log", old, edges)).toBeUndefined();
	// the same file with one line changed is a local change, however big the file
	const c = Buffer.from(line.repeat(n - 1) + `${"z".repeat(99)}\n`);
	const local = diffOf("/x/huge.log", a, c);
	expect([local.filediff.additions, local.filediff.deletions, local.truncated]).toEqual([1, 1, false]);
});

test("a file that is not utf-8 is compared as bytes: caf\\xe9 to caf\\xe8 is a change", () => {
	const r = diffOf("/x/latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6b, 0x0a]), Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a, 0x6f, 0x6b, 0x0a]));
	expect([r.filediff.additions, r.filediff.deletions]).toEqual([1, 1]);
	expect(r.filediff.patch).toContain("-caf\u00e9\n+caf\u00e8\n ok");
	// valid utf-8 still reads as utf-8
	expect(diffOf("/x/u.txt", Buffer.from("héllo\n"), Buffer.from("héllo!\n")).filediff.patch).toContain("-héllo\n+héllo!");
});

test("binary on either side is a note with no counts", () => {
	expect(diffOf("/x/a.bin", Buffer.from([1, 0, 2]), Buffer.from("text\n")).filediff).toMatchObject({ additions: 0, deletions: 0, patch: expect.stringContaining("Binary files differ") });
	expect(diffOf("/x/a.bin", null, Buffer.from([0])).filediff.additions).toBe(0);
});

test("write and edit carry filediff without a hook; a file past the size ceiling is never held and its call carries no diff", async () => {
	const env = scratch("tools");
	const w = (await writeTool(env).execute("c", { path: "a.txt", content: "one\ntwo\n" })).details as WriteDetails;
	expect(w.filediff).toMatchObject({ file: join(env.cwd, "a.txt"), additions: 2, deletions: 0 });
	const e = (await editTool(env).execute("c", { path: "a.txt", old_text: "two", new_text: "2" })).details as EditDetails;
	expect(e.filediff).toMatchObject({ additions: 1, deletions: 1 });
	expect(e.truncated).toBe(false);
	// a no-op write: nothing changed, no patch
	const same = (await writeTool(env).execute("c", { path: "a.txt", content: "one\n2\n" })).details as WriteDetails;
	expect(same.filediff).toMatchObject({ additions: 0, deletions: 0, patch: "" });

	// a file that was over the ceiling before the write: it is not read, and the write carries no diff (and succeeds)
	const huge = join(env.cwd, "huge.log");
	writeFileSync(huge, `${"x".repeat(99)}\n`.repeat(Math.ceil((DIFF_MAX_BYTES + 1) / 100)));
	expect(snapshot(huge)).toBeUndefined();
	const over = await writeTool(env).execute("c", { path: "huge.log", content: "short\n" });
	expect((over.details as WriteDetails).filediff).toBeUndefined();
	expect((over.details as WriteDetails).truncated).toBeUndefined();
	expect(readFileSync(huge, "utf8")).toBe("short\n");
	// a file that is over the ceiling after it: the same
	const grown = join(env.cwd, "grown.log");
	writeFileSync(grown, `${"x".repeat(99)}\n`.repeat(Math.ceil((DIFF_MAX_BYTES + 1) / 100)));
	expect(diffOnDisk(grown, Buffer.from("x\n"))).toBeUndefined();
});

test("a hook that took the call's diff hands it to the tool, which takes none of its own; a diff that cannot be taken never fails the call", async () => {
	const diff = { filediff: { file: "/x/a.txt", patch: "the hook's patch", additions: 7, deletions: 8 }, truncated: false };
	const env = scratch("hook");
	// the hook's diff is the part's, not a fresh look at the file
	const w = await writeTool({ ...env, afterWrite: async () => ({ notes: "formatted", diff }) }).execute("c", { path: "a.txt", content: "one\n" });
	expect((w.details as WriteDetails).filediff).toEqual(diff.filediff);
	expect(w.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain("formatted");
	const e = await editTool({ ...env, afterWrite: async () => ({ diff }) }).execute("c", { path: "a.txt", old_text: "one", new_text: "two" });
	expect((e.details as EditDetails).filediff).toEqual(diff.filediff);
	// a hook that could not take it (it answers with an object and no diff): the part has none, and the tool does not try again
	const none = await editTool({ ...env, afterWrite: async () => ({ notes: "n" }) }).execute("c", { path: "a.txt", old_text: "two", new_text: "three" });
	expect((none.details as EditDetails).filediff).toBeUndefined();
	expect(readFileSync(join(env.cwd, "a.txt"), "utf8")).toBe("three\n");
	// a hook that answers with notes only: the tool takes the diff after it
	const old = await editTool({ ...env, afterWrite: async () => "note" }).execute("c", { path: "a.txt", old_text: "three", new_text: "four" });
	expect((old.details as EditDetails).filediff).toMatchObject({ additions: 1, deletions: 1 });
	// the file gone by the time the diff is taken: the call still succeeds, notes intact, no filediff
	const gone = await writeTool({ ...env, afterWrite: async (abs) => (rmSync(abs), "removed behind it") }).execute("c", { path: "b.txt", content: "x\n" });
	expect((gone.details as WriteDetails).filediff).toBeUndefined();
	expect(gone.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain("removed behind it");
});

test("a run script's edits and writes keep their counts on the nested record, the patch riding when it fits and going when it does not", async () => {
	const env = scratch("nested");
	// the real tools behind the nested call, as the daemon runs them
	const tools = { write: writeTool(env), edit: editTool(env) } as Record<string, ReturnType<typeof writeTool>>;
	const call: NestedCall = async (tool, args) => ({ result: await tools[tool]!.execute("n", args as never), isError: false, decision: { permission: "allow" } });
	const code = `
		await fs.write({ path: "n.txt", content: "a\\nb\\nc\\n" });
		await fs.edit({ path: "n.txt", old_text: "b", new_text: "B\\nB2" });
		await fs.write({ path: "big.txt", content: Array.from({ length: 3000 }, (_, i) => "line " + i + " " + "x".repeat(30)).join("\\n") + "\\n" });`;
	const r = await runTool(call).execute("t", { code });
	const nested = (r.details as { nested: any[] }).nested;
	expect(nested.map((n) => [n.helper, n.ok])).toEqual([["fs.write", true], ["fs.edit", true], ["fs.write", true]]);
	// small answers are kept whole, patch included
	expect(nested[0].details.filediff).toMatchObject({ file: join(env.cwd, "n.txt"), additions: 3, deletions: 0 });
	expect(nested[0].details.filediff.patch).toContain("+a\n+b\n+c\n");
	expect(nested[1].details.filediff).toMatchObject({ additions: 2, deletions: 1 });
	expect(nested[1].details.truncated).toBe(false);
	// a big write's answer is cut to fit the nested record: marked, and the counts stay when the patch goes
	expect(nested[2].details).toEqual({ truncated: true, path: join(env.cwd, "big.txt"), bytes: expect.any(Number), created: true, filediff: { file: join(env.cwd, "big.txt"), additions: 3000, deletions: 0 } });
	expect(JSON.stringify(nested[2].details).length).toBeLessThanOrEqual(2048);
});
