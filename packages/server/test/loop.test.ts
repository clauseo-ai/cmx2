import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesJson } from "../src/pages.ts";
import { ProjectLists } from "../src/project-lists.ts";
import { SessionUpdates } from "../src/session-updates.ts";
import { VcsCache } from "../src/vcs.ts";

/** the event loop's helpers: spliced message pages, git off the loop, session.updated once per tick, cached checkout lists */

test("a spliced page is byte for byte what parse and stringify give, archived or not", () => {
	const values = [
		{ id: "m1", text: "é 日本 \u2028 \u2029 \"q\" \\ \t\n", n: 1e21, f: 5e-7, neg: -0.5, nested: { a: [1, null, true] } },
		{ id: "m2", lone: "\ud800", empty: "", big: "x".repeat(10_000) },
	];
	const rows = values.map((v) => ({ info: JSON.stringify(v), parts: [JSON.stringify({ type: "text", text: v.id }), JSON.stringify(v)].map((data, i) => ({ id: `prt_${v.id}_${i}`, data })) }));
	rows.push({ info: JSON.stringify({ id: "m3" }), parts: [] });
	const want = rows.map((m) => JSON.stringify({ info: JSON.parse(m.info), parts: m.parts.map((p) => JSON.parse(p.data)) }));
	expect(messagesJson(rows, false)).toEqual(want);
	expect(messagesJson(rows, true)).toEqual(want);
	expect(`[${messagesJson(rows, false).join(",")}]`).toBe(JSON.stringify(rows.map((m) => ({ info: JSON.parse(m.info), parts: m.parts.map((p) => JSON.parse(p.data)) }))));
});

test("a running shell's in-memory tail stands in for its stored part, as the read built from parse and stringify does", () => {
	const running = { id: "prt_s_0", type: "tool", tool: "shell", state: { status: "running", input: { command: "make" }, metadata: { output: "old" } } };
	const rows = [
		{ info: JSON.stringify({ id: "msg_s" }), parts: [{ id: "prt_s_0", data: JSON.stringify(running) }, { id: "prt_s_1", data: JSON.stringify({ id: "prt_s_1", type: "text", text: "é \u2028" }) }] },
	];
	const tails = new Map([["prt_s_0", JSON.stringify({ ...running, state: { ...running.state, metadata: { output: "line 1\nline 2 ✓", progress: 7 } } })]]);
	// the read the tail came with (bbed45f): parse the tail when there is one, else the stored row
	const want = rows.map((m) => JSON.stringify({ info: JSON.parse(m.info), parts: m.parts.map((p) => JSON.parse(tails.get(p.id) ?? p.data)) }));
	const tail = (id: string) => tails.get(id);
	expect(messagesJson(rows, false, tail)).toEqual(want);
	expect(messagesJson(rows, true, tail)).toEqual(want);
	expect(messagesJson(rows, false, tail)[0]).toContain('"progress":7');
	expect(messagesJson(rows, false)[0]).toContain('"output":"old"');
});

test("git loads off the loop: the same answer as an inline run, one run per directory, an edit during a run is not kept", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-vcs-")));
	Bun.spawnSync(["git", "init", "-q", "-b", "trunk", dir]);
	const a = new VcsCache();
	await Promise.all([a.load(dir), a.load(dir), a.load(dir)]);
	expect(a.fresh(dir)).toBe(true);
	expect(a.of(dir)).toEqual({ branch: "trunk", dirty: false });
	expect(a.inline).toBe(0);
	writeFileSync(join(dir, "new.txt"), "x");
	a.forget(dir);
	const run = a.load(dir);
	// an edit lands while git runs: that run is not kept, load asks again
	a.forget(dir);
	await run;
	expect(a.fresh(dir)).toBe(true);
	expect(a.of(dir)).toEqual({ branch: "trunk", dirty: true });
	expect(a.inline).toBe(0);
	// an inline read gives the same as a loaded one
	const b = new VcsCache();
	expect(b.of(dir)).toEqual(a.of(dir));
	expect(b.inline).toBe(1);
	const gone = new VcsCache();
	await gone.load(join(dir, "missing"));
	expect(gone.of(join(dir, "missing"))).toBeUndefined();
	expect(gone.inline).toBe(0);
});

test("session.updated: once per tick for activity, folded while one waits for git, created before updated", async () => {
	const emitted: string[] = [];
	let stale = new Set<string>(["ses_wait"]);
	let release: () => void = () => {};
	const u = new SessionUpdates({
		waitsOn: (id) => (id === "ses_gone" ? null : stale.has(id) ? `/dir/${id}` : undefined),
		load: () =>
			new Promise<void>((r) => {
				release = () => {
					stale = new Set();
					r();
				};
			}),
		emit: (type, id) => emitted.push(`${type} ${id}`),
	});
	for (let i = 0; i < 5; i++) u.touch("ses_a");
	u.touch("ses_b");
	expect(emitted).toEqual([]);
	await new Promise((r) => setImmediate(r));
	expect(emitted).toEqual(["session.updated ses_a", "session.updated ses_b"]);
	// an explicit update takes the place of a pending touch
	emitted.length = 0;
	u.touch("ses_a");
	u.publish("session.updated", "ses_a");
	await new Promise((r) => setImmediate(r));
	expect(emitted).toEqual(["session.updated ses_a"]);
	// waiting on git: nothing goes out until it answers, then one created and one updated
	emitted.length = 0;
	u.publish("session.created", "ses_wait");
	u.publish("session.updated", "ses_wait");
	u.touch("ses_wait");
	u.publish("session.updated", "ses_wait");
	await new Promise((r) => setImmediate(r));
	expect(emitted).toEqual([]);
	expect(u.pending).toBe(1);
	release();
	await new Promise((r) => setTimeout(r, 5));
	expect(emitted).toEqual(["session.created ses_wait", "session.updated ses_wait"]);
	expect(u.pending).toBe(0);
	u.publish("session.updated", "ses_gone");
	expect(emitted.length).toBe(2);
});

test("checkout lists: read once, kept, and a change while reading reads again", async () => {
	let reads = 0;
	let answer = ["a"];
	const lists = new ProjectLists(async () => {
		reads++;
		const seen = answer;
		await Bun.sleep(5);
		return seen.map((d) => ({ name: d, directory: `/w/${d}`, project: "/p" }));
	});
	const [x, y] = await Promise.all([lists.of("/p"), lists.of("/p")]);
	expect(x).toEqual(y);
	expect(reads).toBe(1);
	await lists.of("/p");
	expect(reads).toBe(1);
	const during = lists.of("/p2");
	answer = ["a", "b"];
	lists.forget("/p2");
	expect((await during).map((w) => w.name)).toEqual(["a", "b"]);
	lists.forget("/p");
	expect((await lists.of("/p")).map((w) => w.name)).toEqual(["a", "b"]);
	lists.set("/p", []);
	expect(await lists.of("/p")).toEqual([]);
});

test("a git that hangs is stopped: the last status known (none at first) for a short while, never run inline, then asked again", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-vcs-hung-")));
	const real = Bun.which("git")!;
	Bun.spawnSync([real, "init", "-q", "-b", "trunk", dir]);
	const bin = join(dir, ".bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), `#!/bin/sh\n[ -e "${bin}/hang" ] && sleep 30\nexec "${real}" "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);
	writeFileSync(join(bin, "hang"), "");
	const before = process.env.PATH;
	process.env.PATH = `${bin}:${before}`;
	try {
		const v = new VcsCache({ timeoutMs: 300, unknownMs: 400 });
		const t0 = performance.now();
		await v.load(dir);
		expect(performance.now() - t0).toBeLessThan(3_000);
		expect(v.timeouts).toBe(1);
		expect(v.fresh(dir)).toBe(true);
		expect(v.of(dir)).toBeUndefined();
		expect(v.inline).toBe(0);
		// git answers again: after the unknown spell the next load has the branch
		Bun.spawnSync(["rm", join(bin, "hang")]);
		await Bun.sleep(450);
		expect(v.fresh(dir)).toBe(false);
		await v.load(dir);
		// the stand-in lives in the repository, so the tree is dirty
		expect(v.of(dir)).toEqual({ branch: "trunk", dirty: true });
		// slow again after an edit: the last status known stands instead of flapping to none
		writeFileSync(join(bin, "hang"), "");
		v.forget(dir);
		await v.load(dir);
		expect(v.timeouts).toBe(2);
		expect(v.of(dir)).toEqual({ branch: "trunk", dirty: true });
		expect(v.inline).toBe(0);
	} finally {
		process.env.PATH = before;
	}
});

test("checkout lists: an unknown answer (git timed out) reads as none and is asked again shortly", async () => {
	let reads = 0;
	const lists = new ProjectLists(async () => {
		reads++;
		return reads === 1 ? undefined : [{ name: "a", directory: "/w/a", project: "/p" }];
	});
	expect(await lists.of("/p")).toEqual([]);
	expect(lists.peek("/p")).toEqual([]);
	expect(reads).toBe(1);
	await Bun.sleep(5_100);
	expect(lists.peek("/p")).toBeUndefined();
	expect((await lists.of("/p")).map((w) => w.name)).toEqual(["a"]);
}, 10_000);
