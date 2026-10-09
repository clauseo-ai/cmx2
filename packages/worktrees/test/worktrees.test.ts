import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type Policy, WorktreeError, Worktrees } from "../src/index.ts";

/**
 * the checkout service against real git repositories in scratch directories: both population paths,
 * the secrets allowlist, merge (squash, conflict, into a checked-out base and not), discard's rescue
 * ref, and the typed refusals. the daemon-level behaviour (run locks, events, routes) is in the server
 * package's worktree test.
 */

const ID = ["-c", "user.email=it@cmx2", "-c", "user.name=it"];

function sh(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...ID, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function put(root: string, files: Record<string, string>) {
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), body);
	}
}

/** a repository shaped like a web project: tracked code, then everything a dev server needs that git ignores */
function project(label: string) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), `cmx2-wt-${label}-`)));
	const repo = join(base, "app");
	put(repo, {
		".gitignore": ["node_modules/", ".env", ".env.*", ".npmrc", "*.pem", "cache/", "certificates/", "vault/", "scratch.log"].join("\n"),
		".worktreeinclude": "cache/\nvault/\n",
		"package.json": '{"name":"app"}\n',
		"src/server.ts": "export const port = 3000;\n",
		"packages/ui/index.ts": "export {};\n",
	});
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	put(repo, {
		"node_modules/left-pad/index.js": "module.exports = (s) => s;\n",
		"packages/ui/node_modules/tiny/index.js": "module.exports = 1;\n",
		".env": "PORT=3000\n",
		".env.local": "SECRET_TOKEN=local-dev\n",
		"packages/ui/.env.development": "UI=1\n",
		".npmrc": "//registry.npmjs.org/:_authToken=npm_live_token\n",
		"deploy.pem": "-----BEGIN PRIVATE KEY-----\nprod\n",
		"certificates/localhost.pem": "dev cert\n",
		"cache/fixtures.json": "[1,2,3]\n",
		"vault/prod.key": "prod key\n",
		"vault/readme.txt": "the vault\n",
		"scratch.log": "noise\n",
		"wip.txt": "uncommitted work in the main checkout\n",
	});
	return { base, repo, wt: new Worktrees(join(base, "data")) };
}

// these tests make checkouts whatever the laptop's disk holds; the floor has its own test below (minFreeGB: 1e9)
const POLICY: Policy = { ...DEFAULT_POLICY, minFreeGB: 0, minFreeRatio: 0 };
const gitPolicy: Policy = { ...POLICY, clone: false };

describe("create", () => {
	test.if(process.platform === "darwin")("macos clones the working tree copy-on-write and leaves non-allowlisted secrets behind", () => {
		const { repo, wt } = project("clone");
		const c = wt.create(repo, { name: "clone me" }, POLICY);
		console.log(`clone: mode ${c.mode} in ${c.ms} ms, ${c.directory}; carried ${c.carried.join(", ")}; left behind ${c.left.join(", ")}`);
		expect(c.mode).toBe("clone");
		expect(c.name).toBe("clone-me");
		expect(c.branch).toBe("cmx2/clone-me");
		expect(c.base).toBe("main");
		const d = c.directory;
		// ignored files come along by construction: the package store is a real copy, not a link
		expect(readFileSync(join(d, "node_modules/left-pad/index.js"), "utf8")).toContain("module.exports");
		expect(lstatSync(join(d, "node_modules")).isSymbolicLink()).toBe(false);
		expect(existsSync(join(d, "scratch.log"))).toBe(true);
		// env files and the local cert are on the allowlist
		expect(readFileSync(join(d, ".env"), "utf8")).toBe("PORT=3000\n");
		expect(readFileSync(join(d, ".env.local"), "utf8")).toContain("local-dev");
		expect(existsSync(join(d, "packages/ui/.env.development"))).toBe(true);
		expect(existsSync(join(d, "certificates/localhost.pem"))).toBe(true);
		// secret-shaped files the allowlist does not name stay in the source only
		expect(c.left).toEqual([".npmrc", "deploy.pem", "vault/prod.key"]);
		for (const f of c.left) {
			expect(existsSync(join(repo, f))).toBe(true);
			expect(existsSync(join(d, f))).toBe(false);
		}
		// the checkout starts at the commit: the main checkout's uncommitted work is not in it
		expect(existsSync(join(d, "wip.txt"))).toBe(false);
		expect(sh(d, "status", "--porcelain")).toBe("");
		expect(wt.list(repo).map((w) => w.name)).toEqual(["clone-me"]);
	});

	test("the git path carries env files, .worktreeinclude entries and links package stores", () => {
		const { repo, wt } = project("git");
		const c = wt.create(repo, {}, gitPolicy);
		console.log(`git: mode ${c.mode} in ${c.ms} ms; carried ${c.carried.join(", ")}; linked ${c.linked.join(", ")}; left behind ${c.left.join(", ")}`);
		expect(c.mode).toBe("git");
		expect(c.name).toMatch(/^[a-z]+-[a-z]+$/);
		const d = c.directory;
		expect(readFileSync(join(d, ".env"), "utf8")).toBe("PORT=3000\n");
		expect(existsSync(join(d, ".env.local"))).toBe(true);
		expect(existsSync(join(d, "packages/ui/.env.development"))).toBe(true);
		expect(existsSync(join(d, "certificates/localhost.pem"))).toBe(true);
		expect(readFileSync(join(d, "cache/fixtures.json"), "utf8")).toBe("[1,2,3]\n");
		expect(readFileSync(join(d, "vault/readme.txt"), "utf8")).toBe("the vault\n");
		expect(readlinkSync(join(d, "node_modules"))).toBe(join(repo, "node_modules"));
		expect(readlinkSync(join(d, "packages/ui/node_modules"))).toBe(join(repo, "packages/ui/node_modules"));
		expect(c.linked).toEqual(["node_modules", "packages/ui/node_modules"]);
		// .worktreeinclude brought vault/ whole, less the key the allowlist does not name
		expect(c.left).toEqual([".npmrc", "deploy.pem", "vault/prod.key"]);
		for (const f of c.left) expect(existsSync(join(d, f))).toBe(false);
		expect(existsSync(join(d, "scratch.log"))).toBe(false);
	});

	test("widening the allowlist carries what it names", () => {
		const { repo, wt } = project("allow");
		const c = wt.create(repo, {}, { ...gitPolicy, carry: [...POLICY.carry, ".npmrc"] });
		expect(existsSync(join(c.directory, ".npmrc"))).toBe(true);
		expect(c.left).toEqual(["deploy.pem", "vault/prod.key"]);
	});

	test("the cap refuses with a typed error", () => {
		const { repo, wt } = project("cap");
		wt.create(repo, { name: "one" }, { ...gitPolicy, cap: 1 });
		let err: unknown;
		try {
			wt.create(repo, { name: "two" }, { ...gitPolicy, cap: 1 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).name).toBe("WorktreeRefusedError");
		expect((err as WorktreeError).status).toBe(409);
		expect((err as WorktreeError).data).toMatchObject({ reason: "cap", count: 1, cap: 1 });
		console.log(`cap: ${(err as Error).message}`);
	});

	test("the disk floor refuses with a typed error", () => {
		const { repo, wt } = project("disk");
		const e = (() => {
			try {
				wt.create(repo, {}, { ...gitPolicy, minFreeGB: 1e9 });
			} catch (x) {
				return x as WorktreeError;
			}
		})();
		expect(e?.data.reason).toBe("disk");
		console.log(`disk: ${e?.message}`);
	});

	test("outside a repository is a typed 400", () => {
		const { base, wt } = project("notgit");
		const e = (() => {
			try {
				wt.create(base, {}, gitPolicy);
			} catch (x) {
				return x as WorktreeError;
			}
		})();
		expect(e?.name).toBe("WorktreeNotGitError");
		expect(e?.status).toBe(400);
	});
});

describe("merge and discard", () => {
	test("merge squashes onto the checked-out base, then the checkout and its branch are gone", () => {
		const { repo, wt } = project("merge");
		const c = wt.create(repo, { name: "feature" }, gitPolicy);
		put(c.directory, { "src/feature.ts": "export const on = true;\n" });
		sh(c.directory, "add", "-A");
		sh(c.directory, "commit", "-qm", "add the feature flag");
		put(c.directory, { "src/feature.ts": "export const on = true;\nexport const level = 2;\n" });
		sh(c.directory, "commit", "-qam", "give the flag a level");
		const diff = wt.diff(c.directory);
		expect(diff).toMatchObject({ branch: "cmx2/feature", base: "main", commits: 2, dirty: false, mergeable: true, additions: 2, deletions: 0 });
		expect(diff.files).toEqual([{ path: "src/feature.ts", status: "added", additions: 2, deletions: 0 }]);
		expect(diff.diff).toContain("+export const level = 2;");
		const m = wt.merge(c.directory);
		console.log(`merge: ${m.commit.slice(0, 10)} onto ${m.base} in ${m.into}; message: ${JSON.stringify(sh(repo, "log", "-1", "--format=%B"))}`);
		expect(m).toMatchObject({ merged: true, base: "main", branch: "cmx2/feature", commits: 2, into: repo });
		expect(sh(repo, "rev-parse", "HEAD")).toBe(m.commit);
		// a squash: one new commit on main, whose only parent is the old main
		expect(sh(repo, "rev-list", "--count", "HEAD")).toBe("2");
		expect(readFileSync(join(repo, "src/feature.ts"), "utf8")).toContain("level = 2");
		expect(existsSync(c.directory)).toBe(false);
		expect(sh(repo, "branch", "--list", "cmx2/feature")).toBe("");
		// the main checkout's own uncommitted work is untouched
		expect(existsSync(join(repo, "wip.txt"))).toBe(true);
	});

	test("merge moves a base that is not checked out without a working tree", () => {
		const { repo, wt } = project("detachedbase");
		sh(repo, "branch", "release");
		const c = wt.create(repo, { from: "release" }, gitPolicy);
		expect(c.base).toBe("release");
		put(c.directory, { "notes.md": "release notes\n" });
		sh(c.directory, "add", "-A");
		sh(c.directory, "commit", "-qm", "release notes");
		const m = wt.merge(c.directory);
		expect(m.into).toBeUndefined();
		expect(sh(repo, "rev-parse", "release")).toBe(m.commit);
		expect(sh(repo, "rev-parse", "main")).not.toBe(m.commit);
	});

	test("a conflict is a typed 409 naming the files, and nothing moves", () => {
		const { repo, wt } = project("conflict");
		const c = wt.create(repo, {}, gitPolicy);
		put(c.directory, { "src/server.ts": "export const port = 4000;\n" });
		sh(c.directory, "commit", "-qam", "port 4000");
		put(repo, { "src/server.ts": "export const port = 5000;\n" });
		sh(repo, "commit", "-qm", "port 5000", "--", "src/server.ts");
		const before = sh(repo, "rev-parse", "HEAD");
		expect(wt.diff(c.directory).mergeable).toBe(false);
		const e = (() => {
			try {
				wt.merge(c.directory);
			} catch (x) {
				return x as WorktreeError;
			}
		})();
		console.log(`conflict: ${e?.name} ${e?.message} ${JSON.stringify(e?.data)}`);
		expect(e?.name).toBe("WorktreeMergeConflictError");
		expect(e?.status).toBe(409);
		expect(e?.data.files).toEqual(["src/server.ts"]);
		expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
		expect(existsSync(c.directory)).toBe(true);
	});

	test("merge refuses a dirty checkout and a branch with nothing to merge", () => {
		const { repo, wt } = project("refuse");
		const c = wt.create(repo, {}, gitPolicy);
		const reason = () => {
			try {
				wt.merge(c.directory);
			} catch (x) {
				return (x as WorktreeError).data.reason;
			}
		};
		expect(reason()).toBe("nothing");
		put(c.directory, { "src/server.ts": "export const port = 1;\n" });
		expect(reason()).toBe("dirty");
	});

	test("discard keeps a rescue ref holding the uncommitted work, then removes the checkout", () => {
		const { repo, wt } = project("discard");
		const c = wt.create(repo, { name: "throwaway" }, gitPolicy);
		put(c.directory, { "src/idea.ts": "export const idea = 42;\n" });
		sh(c.directory, "add", "-A");
		sh(c.directory, "commit", "-qm", "an idea");
		put(c.directory, { "src/half.ts": "export const half = 21;\n" });
		const d = wt.discard(c.directory);
		console.log(`discard: snapshot ${d.snapshot?.slice(0, 10)} at ${d.ref}`);
		expect(d.discarded).toBe(true);
		expect(d.ref).toBe("refs/cmx2/rescue/throwaway");
		expect(existsSync(c.directory)).toBe(false);
		expect(sh(repo, "branch", "--list", "cmx2/throwaway")).toBe("");
		expect(sh(repo, "show", `${d.ref}:src/half.ts`)).toBe("export const half = 21;");
		expect(sh(repo, "show", `${d.ref}:src/idea.ts`)).toBe("export const idea = 42;");
	});

	test("the main checkout and unknown directories are refused", () => {
		const { repo, wt } = project("locate");
		expect(() => wt.merge(repo)).toThrow(/main checkout/);
		wt.create(repo, { name: "real" }, gitPolicy);
		expect(() => wt.discard(join(wt.rootOf(repo), "nope"))).toThrow();
	});
});
