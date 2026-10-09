import { afterAll, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Snapshots } from "../src/snapshot.ts";

/** git's empty tree: every repository knows it, so a diff from it lists everything a snapshot holds */
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const scratch: string[] = [];
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tmp(name: string): string {
	const d = mkdtempSync(join(tmpdir(), `cmx2-snap-${name}-`));
	scratch.push(d);
	return d;
}

function put(dir: string, file: string, text: string) {
	mkdirSync(dirname(join(dir, file)), { recursive: true });
	writeFileSync(join(dir, file), text);
}

function gitInit(dir: string) {
	const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", "-q", dir]);
	expect(r.exitCode).toBe(0);
}

function setup(opts: { repo?: boolean } = {}) {
	const dir = tmp("dir");
	if (opts.repo) gitInit(dir);
	const lines: string[] = [];
	const snaps = new Snapshots({ dataDir: tmp("data"), log: (l) => lines.push(l) });
	return { dir, snaps, lines };
}

async function recorded(snaps: Snapshots, dir: string, hash: string): Promise<string[]> {
	return snaps.changed(dir, EMPTY, hash);
}

test("tracking twice with nothing changed gives the same hash", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, "a.txt", "one\n");
	const a = await snaps.track(dir);
	const b = await snaps.track(dir);
	expect(a).toMatch(/^[0-9a-f]{40}$/);
	expect(b).toBe(a!);
});

test("a modified, an added and a deleted file show in changed, diff and stat", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, "keep.txt", "same\n");
	put(dir, "mod.txt", "one\ntwo\nthree\n");
	put(dir, "del.txt", "gone\nsoon\n");
	const before = (await snaps.track(dir))!;

	put(dir, "mod.txt", "one\n2\nthree\nfour\n");
	put(dir, "src/new.txt", "fresh\n");
	rmSync(join(dir, "del.txt"));

	expect((await snaps.changed(dir, before)).sort()).toEqual(["del.txt", "mod.txt", "src/new.txt"]);

	const diff = await snaps.diff(dir, before);
	expect(diff.map((d) => d.file)).toEqual(["del.txt", "mod.txt", "src/new.txt"]);
	expect(diff[0]).toEqual({ file: "del.txt", before: "gone\nsoon\n", after: "", additions: 0, deletions: 2, status: "deleted" });
	expect(diff[1]).toEqual({ file: "mod.txt", before: "one\ntwo\nthree\n", after: "one\n2\nthree\nfour\n", additions: 2, deletions: 1, status: "modified" });
	expect(diff[2]).toEqual({ file: "src/new.txt", before: "", after: "fresh\n", additions: 1, deletions: 0, status: "added" });

	expect(await snaps.stat(dir, before)).toEqual({ files: 3, additions: 3, deletions: 3 });

	// tree to tree gives the same answer as tree to work tree
	const after = (await snaps.track(dir))!;
	expect(await snaps.stat(dir, before, after)).toEqual({ files: 3, additions: 3, deletions: 3 });
	expect(await snaps.changed(dir, after)).toEqual([]);
});

test("binary files and files over the text cap come back without text", async () => {
	const { dir, snaps } = setup();
	const before = (await snaps.track(dir))!;
	writeFileSync(join(dir, "blob.bin"), new Uint8Array([0, 1, 2, 0, 255, 0]));
	put(dir, "big.txt", "x\n".repeat(200_000));
	const diff = await snaps.diff(dir, before);
	expect(diff).toEqual([
		{ file: "big.txt", before: "", after: "", additions: 200_000, deletions: 0, status: "added" },
		{ file: "blob.bin", before: "", after: "", additions: 0, deletions: 0, status: "added", binary: true },
	]);
});

test("restore brings back modified and deleted files and removes added ones", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, "mod.txt", "original\n");
	put(dir, "del.txt", "keep me\n");
	const tree = (await snaps.track(dir))!;

	put(dir, "mod.txt", "changed\n");
	rmSync(join(dir, "del.txt"));
	put(dir, "made/deep/new.txt", "added\n");

	await snaps.restore(dir, tree);
	expect(readFileSync(join(dir, "mod.txt"), "utf8")).toBe("original\n");
	expect(readFileSync(join(dir, "del.txt"), "utf8")).toBe("keep me\n");
	expect(existsSync(join(dir, "made/deep/new.txt"))).toBe(false);
	expect(existsSync(join(dir, "made"))).toBe(false);
	expect(await snaps.changed(dir, tree)).toEqual([]);
});

test("restore of a subset of files only touches those", async () => {
	const { dir, snaps } = setup();
	put(dir, "a.txt", "a0\n");
	put(dir, "b.txt", "b0\n");
	put(dir, "c.txt", "c0\n");
	const tree = (await snaps.track(dir))!;

	put(dir, "a.txt", "a1\n");
	put(dir, "b.txt", "b1\n");
	rmSync(join(dir, "c.txt"));
	put(dir, "d.txt", "d1\n");
	put(dir, "e.txt", "e1\n");

	await snaps.restore(dir, tree, ["a.txt", join(dir, "c.txt"), "d.txt"]);
	expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a0\n");
	expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("b1\n");
	expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("c0\n");
	expect(existsSync(join(dir, "d.txt"))).toBe(false);
	expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("e1\n");
	expect((await snaps.changed(dir, tree)).sort()).toEqual(["b.txt", "e.txt"]);

	await expect(snaps.restore(dir, tree, ["../outside.txt"])).rejects.toThrow(/restore takes files inside/);
	await expect(snaps.restore(dir, "--help")).rejects.toThrow(/not a snapshot hash/);
});

test("gitignored files and the repo's info/exclude are never recorded", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, ".gitignore", "node_modules/\n");
	put(dir, "node_modules/dep/index.js", "module.exports = 1\n");
	put(dir, ".git/info/exclude", "secret.txt\n");
	put(dir, "secret.txt", "hush\n");
	put(dir, "src/app.ts", "export {}\n");
	const tree = (await snaps.track(dir))!;
	expect((await recorded(snaps, dir, tree)).sort()).toEqual([".gitignore", "src/app.ts"]);

	put(dir, "node_modules/dep/index.js", "module.exports = 2\n");
	put(dir, "secret.txt", "louder\n");
	expect(await snaps.track(dir)).toBe(tree);
});

test("a subdirectory of a repo follows the repo's ignore rules above it", async () => {
	const root = tmp("root");
	gitInit(root);
	put(root, ".gitignore", "dist/\n/pkg/local.env\n");
	put(root, "pkg/src/a.ts", "a\n");
	put(root, "pkg/dist/a.js", "a\n");
	put(root, "pkg/local.env", "KEY=1\n");
	const snaps = new Snapshots({ dataDir: tmp("data"), log: () => {} });
	const dir = join(root, "pkg");
	const tree = (await snaps.track(dir))!;
	expect(await recorded(snaps, dir, tree)).toEqual(["src/a.ts"]);
});

test("a directory that is not a git repo works too", async () => {
	const { dir, snaps } = setup();
	put(dir, ".gitignore", "out/\n");
	put(dir, "out/x", "x\n");
	put(dir, "a.txt", "one\n");
	const tree = (await snaps.track(dir))!;
	expect((await recorded(snaps, dir, tree)).sort()).toEqual([".gitignore", "a.txt"]);
	put(dir, "a.txt", "two\n");
	expect(await snaps.stat(dir, tree)).toEqual({ files: 1, additions: 1, deletions: 1 });
	// the project has no .git and the snapshot never made one there
	expect(existsSync(join(dir, ".git"))).toBe(false);
});

test("the home directory, the root and a missing directory are refused once in the log", async () => {
	const { snaps, lines } = setup();
	expect(await snaps.track(homedir())).toBeUndefined();
	expect(await snaps.track(homedir())).toBeUndefined();
	expect(await snaps.track("/")).toBeUndefined();
	expect(await snaps.track(join(tmpdir(), "cmx2-snap-does-not-exist"))).toBeUndefined();
	expect(lines.filter((l) => l.includes("home directory"))).toHaveLength(1);
	expect(lines.some((l) => l.includes("filesystem root"))).toBe(true);
	expect(lines.some((l) => l.includes("no such directory"))).toBe(true);
	await expect(snaps.changed(homedir(), EMPTY)).rejects.toThrow(/has no snapshots/);
});

test("concurrent track calls on one directory resolve to the same hash", async () => {
	const { dir, snaps } = setup({ repo: true });
	for (let i = 0; i < 50; i++) put(dir, `f${i}.txt`, `${i}\n`);
	const hashes = await Promise.all([snaps.track(dir), snaps.track(dir), snaps.track(dir)]);
	expect(hashes[0]).toMatch(/^[0-9a-f]{40}$/);
	expect(new Set(hashes).size).toBe(1);
	expect(await recorded(snaps, dir, hashes[0]!)).toHaveLength(50);
});

test("the project's own .git is left alone", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, "a.txt", "one\n");
	await snaps.track(dir);
	expect(existsSync(join(dir, ".git/index"))).toBe(false);
	const log = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]);
	expect(log.stdout.toString()).toBe("?? a.txt\n");
});

test("close lets work in flight finish, then refuses new work and leaves no git running", async () => {
	const { dir, snaps } = setup({ repo: true });
	for (let i = 0; i < 200; i++) put(dir, `f${i}.txt`, `${i}\n`);
	const inflight = snaps.track(dir);
	await snaps.close(5_000);
	expect(await inflight).toMatch(/^[0-9a-f]{40}$/);
	expect(await snaps.track(dir)).toBeUndefined();
	const left = Bun.spawnSync(["pgrep", "-f", `git.*--work-tree ${dir}`]).stdout.toString().trim();
	expect(left).toBe("");
});

test("a work tree removed after its first snapshot is reported as gone, not as a missing git", async () => {
	const { dir, snaps } = setup({ repo: true });
	put(dir, "a.txt", "a\n");
	const first = await snaps.track(dir);
	rmSync(dir, { recursive: true, force: true });
	const err = await snaps.changed(dir, first!).then(() => "", (e: Error) => e.message);
	expect(err).toMatch(/no such directory|is gone/);
	expect(err).not.toContain("git is not installed");
});

test("a file that grows past the cap keeps its last version under it instead of being stored whole each turn", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-snapcap-")));
	scratch.push(root);
	const repo = join(root, "repo");
	await $`mkdir -p ${repo} && git -C ${repo} init -q && head -c 1000000 /dev/urandom > ${repo}/grows.db`.quiet();
	const lines: string[] = [];
	const snaps = new Snapshots({ dataDir: join(root, "data"), log: (l) => lines.push(l) });
	const first = await snaps.track(repo);
	for (let i = 0; i < 5; i++) {
		await $`head -c 8000000 /dev/urandom > ${repo}/grows.db`.quiet();
		expect(await snaps.track(repo)).toBe(first);
	}
	const mb = Number((await $`du -sm ${join(root, "data")}`.text()).split("\t")[0]);
	console.log(`five 8 MB rewrites of a file first seen at 1 MB: snapshot storage ${mb} MB; ${lines.at(-1)}`);
	expect(mb).toBeLessThan(5);
	expect(lines.some((l) => l.includes("leaving 1 file over 2 MB"))).toBe(true);
}, 60_000);
