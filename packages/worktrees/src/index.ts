import { dlopen, FFIType, read } from "bun:ffi";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * checkouts: a branch of a repository in a directory of its own, so an agent can work, run the dev
 * server and commit without touching the main working tree until someone merges it.
 *
 * on macos a checkout is an apfs clone of the source working tree: `clonefile(2)` copies every
 * top-level entry copy-on-write in one call each (node_modules, build caches and env files come along
 * by construction, costing metadata only), then git resets the tracked files to the ref and removes
 * untracked ones that are not ignored. elsewhere, or when the clone is refused (another volume, not
 * apfs), it is a plain `git worktree add` plus what the dev server needs: allowlisted env files,
 * `.worktreeinclude` entries, node_modules and virtualenvs linked from the source, local dev certs.
 *
 * either way an untracked file shaped like a secret is carried only when `carry` allows it; the rest
 * are left behind and listed. merge is a local squash onto the branch the checkout was made from,
 * refusing on conflicts; discard saves the last state under `refs/cmx2/rescue/` first. nothing here
 * pushes. the daemon adds the run lock, the events and the typed http errors.
 */

export interface Policy {
	/** untracked secret-shaped files carried into a checkout (basename globs); everything else secret-shaped stays behind */
	carry: string[];
	/** checkouts per project on this machine */
	cap: number;
	/** create refuses under max(minFreeGB, minFreeRatio of the volume) free */
	minFreeGB: number;
	minFreeRatio: number;
	/** use the copy-on-write clone where the volume allows it */
	clone: boolean;
	/** commands run in a new checkout before it is ready (bash -lc, in order) */
	setup: string[];
}

export const DEFAULT_POLICY: Policy = {
	carry: [".env", ".env.*", ".envrc", ".dev.vars", "localhost*.pem"],
	cap: 15,
	minFreeGB: 5,
	minFreeRatio: 0.03,
	clone: true,
	setup: [],
};

/** untracked files that count as secrets: carried only when `carry` matches them */
export const SECRET_SHAPES = [
	".env",
	".env.*",
	".envrc",
	".dev.vars",
	".npmrc",
	".pypirc",
	".netrc",
	".pgpass",
	".git-credentials",
	".htpasswd",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.jks",
	"*.keystore",
	"*.kdbx",
	"*.gpg",
	"*.tfstate",
	"*.tfstate.*",
	"*.tfvars",
	"id_rsa*",
	"id_dsa*",
	"id_ecdsa*",
	"id_ed25519*",
	"credentials",
	"credentials.*",
	"secret",
	"secrets",
	"secret.*",
	"secrets.*",
	".secret*",
	"*.secret",
	"service-account*.json",
];

/** directories never walked for secrets or carried files: package stores and build output */
const HEAVY = new Set(["node_modules", ".git", "target", ".next", ".venv", "venv", "dist", "build", ".turbo", ".cache", "__pycache__", ".gradle", "Pods"]);
/** what the git path links from the source instead of copying (a clone brings its own copy) */
const LINKED = ["node_modules", ".venv", "venv"];
const INCLUDE_FILE = ".worktreeinclude";
const SETUP_TIMEOUT_MS = 10 * 60_000;
const DIFF_MAX_BYTES = 2_000_000;
const LOG_TAIL = 4000;

export type RefusalReason = "cap" | "disk" | "dirty" | "nothing" | "target_dirty" | "primary" | "not_ours" | "detached";

/** a refusal or failure with a name clients can switch on and a status for the http layer */
export class WorktreeError extends Error {
	constructor(
		readonly name: "WorktreeNotGitError" | "WorktreeNotFoundError" | "WorktreeRefusedError" | "WorktreeMergeConflictError" | "WorktreeFailedError",
		readonly status: number,
		message: string,
		readonly data: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export interface WorktreeInfo {
	name: string;
	directory: string;
	branch?: string;
	/** the branch it was made from and merges back into */
	base?: string;
	/** the primary checkout of its repository */
	project: string;
}

export interface Carried {
	/** relative paths brought into the checkout on top of the tracked files */
	carried: string[];
	/** untracked secret-shaped files that stayed behind, relative to the source */
	left: string[];
	/** paths linked to the source's copy (the git path only) */
	linked: string[];
}

export interface Created extends WorktreeInfo, Carried {
	/** clone: the apfs copy-on-write path ran; git: git worktree add plus carried files */
	mode: "clone" | "git";
	/** why the clone was not used, when it was wanted */
	fallback?: string;
	ms: number;
	/** the directory it was made from and the commit it starts at */
	source: string;
	from: string;
}

export interface SetupRun {
	command: string;
	ok: boolean;
	exitCode: number | null;
	ms: number;
	/** the tail of stdout and stderr */
	log: string;
	timedOut?: boolean;
}

export interface Diff {
	branch?: string;
	base: string;
	baseRef: string;
	commits: number;
	dirty: boolean;
	mergeable?: boolean;
	additions: number;
	deletions: number;
	files: Array<{ path: string; status: "added" | "deleted" | "modified" | "renamed"; additions: number; deletions: number }>;
	diff: string;
	truncated: boolean;
}

export interface Merged {
	merged: true;
	commit: string;
	base: string;
	branch: string;
	commits: number;
	/** where the base branch is checked out, when it is; the merge ran there */
	into?: string;
}

export interface Discarded {
	discarded: true;
	/** the rescue commit, when there was work to keep */
	snapshot?: string;
	ref?: string;
}

// ---------- git ----------

interface GitResult {
	code: number;
	out: string;
	err: string;
}

function git(cwd: string, args: string[], env?: Record<string, string>): GitResult {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
	return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function must(cwd: string, args: string[], what: string, env?: Record<string, string>): string {
	const r = git(cwd, args, env);
	if (r.code !== 0) throw new WorktreeError("WorktreeFailedError", 500, `${what}: ${(r.err || r.out).trim() || `git ${args[0]} exited ${r.code}`}`);
	return r.out;
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** the repository a directory belongs to: its work tree's top level and the primary checkout */
export function repoOf(dir: string): { top: string; primary: string } {
	const r = git(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
	if (r.code !== 0) throw new WorktreeError("WorktreeNotGitError", 400, `${dir} is not inside a git repository; checkouts need one`);
	const [top, common] = r.out.trim().split("\n");
	const commonAbs = resolve(dir, common!);
	// the common dir of a normal repository is <primary>/.git; a bare repository has no primary work tree
	const primary = basename(commonAbs) === ".git" ? dirname(commonAbs) : real(top!);
	return { top: real(top!), primary: real(primary) };
}

function currentBranch(dir: string): string | undefined {
	const r = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
	return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

function branchExists(dir: string, branch: string): boolean {
	return git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** the repository's default branch: origin's head when it has a local branch, else main or master, else the primary's branch */
export function defaultBranch(primary: string): string | undefined {
	const origin = git(primary, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).out.trim();
	const name = origin.replace(/^origin\//, "");
	if (name && branchExists(primary, name)) return name;
	for (const b of ["main", "master"]) if (branchExists(primary, b)) return b;
	return currentBranch(primary);
}

interface ListedTree {
	path: string;
	branch?: string;
	head?: string;
}

function worktreeList(primary: string): ListedTree[] {
	const out = must(primary, ["worktree", "list", "--porcelain"], "listing the checkouts");
	const items: ListedTree[] = [];
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) items.push({ path: real(line.slice(9).trim()) });
		else if (line.startsWith("branch ") && items.length) items.at(-1)!.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
		else if (line.startsWith("HEAD ") && items.length) items.at(-1)!.head = line.slice(5).trim();
	}
	return items;
}

// ---------- files ----------

const CLONE_NOFOLLOW = 0x0001;
const libc = (() => {
	if (process.platform !== "darwin") return undefined;
	try {
		return dlopen("/usr/lib/libSystem.B.dylib", {
			clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
			__error: { args: [], returns: FFIType.ptr },
		});
	} catch {
		return undefined;
	}
})();
const ERRNO: Record<number, string> = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 28: "ENOSPC", 30: "EROFS", 45: "ENOTSUP", 63: "ENAMETOOLONG" };

/** one clonefile(2) call: a whole directory tree copied on write, or the errno name when the volume refuses */
function clone(src: string, dst: string): string | undefined {
	if (!libc) return "no clonefile on this platform";
	const r = libc.symbols.clonefile(Buffer.from(`${src}\0`), Buffer.from(`${dst}\0`), CLONE_NOFOLLOW);
	if (r === 0) return undefined;
	const p = libc.symbols.__error();
	const errno = p ? read.i32(p, 0) : 0;
	return ERRNO[errno] ?? `errno ${errno}`;
}

/** a file or directory copied into the checkout: cloned where the volume allows, copied otherwise */
function copyInto(src: string, dst: string) {
	mkdirSync(dirname(dst), { recursive: true });
	if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
	if (!clone(src, dst)) return;
	const st = lstatSync(src);
	if (st.isDirectory()) cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
	else if (st.isSymbolicLink()) cpSync(src, dst, { verbatimSymlinks: true });
	else copyFileSync(src, dst);
}

function globRe(glob: string): RegExp {
	return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function matcher(globs: string[]): (name: string) => boolean {
	const res = globs.map(globRe);
	return (name) => res.some((r) => r.test(name));
}

const isSecret = matcher(SECRET_SHAPES);

/** files under a directory (relative to it), skipping package stores and build output, a few levels deep */
function walk(root: string, rel: string, depth: number, out: string[]) {
	if (depth > 6) return;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const r = rel ? join(rel, e.name) : e.name;
		if (e.isDirectory()) {
			if (!HEAVY.has(e.name)) walk(root, r, depth + 1, out);
		} else if (e.isFile()) out.push(r);
	}
}

/** untracked paths git ignores, ignored directories collapsed to one entry each (a trailing slash) */
function ignored(dir: string, extra: string[] = []): string[] {
	const r = git(dir, ["ls-files", "--others", "--ignored", "--directory", "-z", ...(extra.length ? extra : ["--exclude-standard"])]);
	if (r.code !== 0) return [];
	return r.out.split("\0").filter((e) => e && e !== ".git/" && !e.startsWith(".git/"));
}

/** every untracked file under the entries, directories expanded */
function expand(root: string, entries: string[]): string[] {
	const files: string[] = [];
	for (const e of entries) {
		if (e.endsWith("/")) {
			const d = e.replace(/\/+$/, "");
			if (HEAVY.has(basename(d))) continue;
			walk(root, d, 1, files);
		} else files.push(e);
	}
	return files;
}

/**
 * a link is not a directory to git, so `node_modules/` does not ignore a linked node_modules and the
 * checkout would read as dirty. the repository's shared exclude file gets each linked path, anchored;
 * the source has real ignored directories there, so it reads the same as before.
 */
function excludeLinks(directory: string, paths: string[]) {
	const common = git(directory, ["rev-parse", "--git-common-dir"]).out.trim();
	if (!common) return;
	const file = join(resolve(directory, common), "info", "exclude");
	const have = existsSync(file) ? readFileSync(file, "utf8") : "";
	const lines = have.split("\n");
	const add = paths.map((p) => `/${p}`).filter((l) => !lines.includes(l));
	if (!add.length) return;
	mkdirSync(dirname(file), { recursive: true });
	const head = lines.includes(EXCLUDE_MARK) ? "" : `${EXCLUDE_MARK}\n`;
	writeFileSync(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${head}${add.join("\n")}\n`);
}

const EXCLUDE_MARK = "# cmx2: package stores linked into checkouts";

// ---------- names ----------

const ADJECTIVES = ["amber", "brisk", "calm", "clever", "coral", "dusty", "eager", "fleet", "gentle", "hazel", "ivory", "jolly", "keen", "lucid", "mellow", "nimble", "olive", "plucky", "quiet", "rapid", "shiny", "steady", "tidy", "urban", "vivid", "wiry", "young", "zesty"];
const NOUNS = ["badger", "comet", "delta", "ember", "falcon", "gecko", "heron", "island", "jaguar", "kestrel", "lantern", "meadow", "narwhal", "otter", "pebble", "quartz", "raven", "sparrow", "tiger", "umber", "valley", "walrus", "yak", "zephyr"];

function slug(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function randomName(): string {
	const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
	return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

// ---------- the service ----------

export class Worktrees {
	readonly home: string;

	constructor(dataDir: string) {
		this.home = join(dataDir, "worktree");
	}

	/** where a project's checkouts live: <data>/worktree/<repo name>-<hash of its path> */
	rootOf(primary: string): string {
		const hash = createHash("sha1").update(primary).digest("hex").slice(0, 8);
		return join(this.home, `${slug(basename(primary)) || "repo"}-${hash}`);
	}

	/** the projects that have a checkout root here, by their primary path */
	projects(): string[] {
		if (!existsSync(this.home)) return [];
		const out: string[] = [];
		for (const d of readdirSync(this.home)) {
			const f = join(this.home, d, ".project");
			if (existsSync(f)) out.push(readFileSync(f, "utf8").trim());
		}
		return out.filter((p) => existsSync(p));
	}

	/** the checkouts cmx2 made for a project, from git's own list */
	list(dir: string): WorktreeInfo[] {
		const { primary } = repoOf(dir);
		const root = real(this.rootOf(primary));
		if (!existsSync(root)) return [];
		return worktreeList(primary)
			.filter((t) => inside(t.path, root) && t.path !== root)
			.map((t) => this.info(primary, t));
	}

	private info(primary: string, t: ListedTree): WorktreeInfo {
		const base = t.branch ? git(primary, ["config", "--get", `branch.${t.branch}.cmx2base`]).out.trim() : "";
		return { name: basename(t.path), directory: t.path, ...(t.branch ? { branch: t.branch } : {}), ...(base ? { base } : {}), project: primary };
	}

	/** the checkout a directory is in, when it is one cmx2 made; anything else is refused */
	locate(dir: string): WorktreeInfo {
		const d = real(dir);
		const { primary } = repoOf(d);
		if (d === primary) throw new WorktreeError("WorktreeRefusedError", 400, `${d} is the repository's main checkout, not one made for an agent`, { reason: "primary" satisfies RefusalReason });
		const root = real(this.rootOf(primary));
		const t = worktreeList(primary).find((x) => x.path === d);
		if (!t) throw new WorktreeError("WorktreeNotFoundError", 404, `no checkout at ${d}; it was merged, discarded or never made`);
		if (!inside(d, root)) throw new WorktreeError("WorktreeRefusedError", 400, `${d} is a git worktree cmx2 did not make; merge or remove it with git`, { reason: "not_ours" satisfies RefusalReason });
		return this.info(primary, t);
	}

	/**
	 * a new checkout of the repository `dir` is in, on a new branch from `from` (default: what `dir` has
	 * checked out). ready to work in when this returns; setup commands are a separate step (setup()).
	 */
	create(dir: string, input: { name?: string; from?: string }, policy: Policy): Created {
		const started = performance.now();
		const { top: source, primary } = repoOf(dir);
		const root = this.rootOf(primary);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, ".project"), `${primary}\n`);
		const realRoot = real(root);

		const existing = readdirSync(realRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
		if (existing >= policy.cap) {
			throw new WorktreeError("WorktreeRefusedError", 409, `${basename(primary)} already has ${existing} checkout${existing === 1 ? "" : "s"} on this machine (the cap is ${policy.cap}); merge or discard one first`, { reason: "cap" satisfies RefusalReason, count: existing, cap: policy.cap });
		}
		const fs = statfsSync(realRoot);
		const free = Number(fs.bavail) * Number(fs.bsize);
		const total = Number(fs.blocks) * Number(fs.bsize);
		const floor = Math.max(policy.minFreeGB * 1024 ** 3, total * policy.minFreeRatio);
		if (free < floor) {
			throw new WorktreeError("WorktreeRefusedError", 409, `the disk has ${(free / 1024 ** 3).toFixed(1)} GB free, under the ${(floor / 1024 ** 3).toFixed(1)} GB floor; not making another checkout`, { reason: "disk" satisfies RefusalReason, freeBytes: free, floorBytes: floor });
		}

		const fromRef = input.from?.trim() || "HEAD";
		const sha = git(source, ["rev-parse", "--verify", "-q", `${fromRef}^{commit}`]).out.trim();
		if (!sha) throw new WorktreeError("WorktreeFailedError", 400, `${fromRef} is not a commit in ${source}`);
		const base = input.from && branchExists(source, input.from) ? input.from : currentBranch(source);

		let name = "";
		let directory = "";
		let branch = "";
		const wanted = input.name ? slug(input.name) : "";
		for (let i = 0; i < 30; i++) {
			name = wanted ? (i === 0 ? wanted : `${wanted}-${i + 1}`) : randomName();
			directory = join(realRoot, name);
			branch = `cmx2/${name}`;
			if (!existsSync(directory) && !branchExists(primary, branch)) break;
			name = "";
		}
		if (!name) throw new WorktreeError("WorktreeFailedError", 500, "could not find a free checkout name after 30 tries");

		must(source, ["worktree", "add", "--no-checkout", "-b", branch, directory, sha], "git worktree add");
		if (base) git(primary, ["config", `branch.${branch}.cmx2base`, base]);

		const allow = matcher(policy.carry);
		let mode: "clone" | "git" = "git";
		let fallback: string | undefined;
		let carried: Carried = { carried: [], left: [], linked: [] };
		try {
			if (policy.clone && process.platform === "darwin") {
				fallback = this.cloneTree(source, directory);
				if (!fallback) mode = "clone";
			} else if (policy.clone) fallback = `copy-on-write clones are macos only here (${process.platform})`;
			must(directory, ["reset", "-q", "--hard", sha], "filling the checkout");
			if (mode === "clone") {
				// the clone brought the source's uncommitted work too; the checkout starts at the ref
				must(directory, ["clean", "-q", "-fd"], "clearing untracked files the clone brought");
				carried = this.pruneSecrets(source, directory, allow);
			} else carried = this.carry(source, directory, allow);
		} catch (e) {
			this.remove(primary, directory, branch);
			throw e;
		}
		return { name, directory, branch, ...(base ? { base } : {}), project: primary, mode, ...(fallback ? { fallback } : {}), ms: Math.round(performance.now() - started), source, from: sha, ...carried };
	}

	/** clonefile every top-level entry but .git; the error when the volume refuses, with what was cloned undone */
	private cloneTree(source: string, directory: string): string | undefined {
		const done: string[] = [];
		for (const e of readdirSync(source)) {
			if (e === ".git") continue;
			const err = clone(join(source, e), join(directory, e));
			if (err) {
				for (const d of done) rmSync(join(directory, d), { recursive: true, force: true });
				return `clonefile refused ${e}: ${err}`;
			}
			done.push(e);
		}
		return undefined;
	}

	/** after a clone: the ignored files came along; secret-shaped ones outside the allowlist are removed */
	private pruneSecrets(source: string, directory: string, allow: (n: string) => boolean): Carried {
		const files = expand(directory, ignored(directory));
		const left: string[] = [];
		const carried: string[] = [];
		for (const f of files) {
			const n = basename(f);
			if (!isSecret(n)) continue;
			if (allow(n)) carried.push(f);
			else {
				rmSync(join(directory, f), { force: true });
				left.push(f);
			}
		}
		const top = ignored(directory).filter((e) => !isSecret(basename(e.replace(/\/+$/, ""))));
		return { carried: [...carried, ...top].sort(), left: left.sort(), linked: [] };
	}

	/** the git path: allowlisted env files, .worktreeinclude entries, linked package stores */
	private carry(source: string, directory: string, allow: (n: string) => boolean): Carried {
		const carried = new Set<string>();
		const left = new Set<string>();
		const take = (rel: string) => {
			const n = basename(rel);
			if (isSecret(n) && !allow(n)) {
				left.add(rel);
				return;
			}
			copyInto(join(source, rel), join(directory, rel));
			carried.add(rel);
		};
		// env files and local certs: the allowlist names them wherever git ignores them
		for (const f of expand(source, ignored(source))) if (isSecret(basename(f))) take(f);
		// .worktreeinclude: gitignore syntax, the repository's own list of what a working checkout needs
		if (existsSync(join(source, INCLUDE_FILE))) {
			for (const e of ignored(source, [`--exclude-from=${INCLUDE_FILE}`])) {
				const rel = e.replace(/\/+$/, "");
				if (!rel || carried.has(rel)) continue;
				if (e.endsWith("/")) {
					// a directory comes whole, less the secrets in it that the allowlist does not name
					const files: string[] = [];
					walk(source, rel, 1, files);
					const secrets = files.filter((f) => isSecret(basename(f)) && !allow(basename(f)));
					copyInto(join(source, rel), join(directory, rel));
					for (const s of secrets) {
						rmSync(join(directory, s), { force: true });
						left.add(s);
					}
					carried.add(`${rel}/`);
				} else take(rel);
			}
		}
		// package stores are linked, not copied: an install inside the checkout writes to the source's store
		const linked: string[] = [];
		const link = (rel: string) => {
			const src = join(source, rel);
			const dst = join(directory, rel);
			if (!existsSync(src) || existsSync(dst) || !existsSync(dirname(dst))) return;
			symlinkSync(src, dst);
			linked.push(rel);
		};
		for (const l of LINKED) link(l);
		// workspace packages one or two levels down keep their own node_modules
		for (const e of ignored(source)) {
			const rel = e.replace(/\/+$/, "");
			if (basename(rel) === "node_modules" && rel !== "node_modules" && rel.split("/").length <= 3) link(rel);
		}
		if (linked.length) excludeLinks(directory, linked);
		return { carried: [...carried].sort(), left: [...left].sort(), linked: linked.sort() };
	}

	/** runs setup commands in a checkout, in order, stopping at the first failure */
	async setup(directory: string, commands: string[], env: Record<string, string> = {}): Promise<SetupRun[]> {
		const runs: SetupRun[] = [];
		for (const command of commands.map((c) => c.trim()).filter(Boolean)) {
			const started = performance.now();
			const p = Bun.spawn(["bash", "-lc", command], { cwd: directory, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...env } });
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				p.kill("SIGKILL");
			}, SETUP_TIMEOUT_MS);
			const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			const exitCode = await p.exited;
			clearTimeout(timer);
			const both = `${out}${err ? `${out ? "\n" : ""}${err}` : ""}`.trim();
			const run: SetupRun = { command, ok: exitCode === 0 && !timedOut, exitCode: timedOut ? null : exitCode, ms: Math.round(performance.now() - started), log: both.length > LOG_TAIL ? both.slice(-LOG_TAIL) : both, ...(timedOut ? { timedOut } : {}) };
			runs.push(run);
			if (!run.ok) break;
		}
		return runs;
	}

	private baseOf(w: WorktreeInfo): string {
		const b = w.base && branchExists(w.project, w.base) ? w.base : defaultBranch(w.project);
		if (!b) throw new WorktreeError("WorktreeFailedError", 500, `${basename(w.project)} has no branch to compare the checkout with`);
		return b;
	}

	/** what the checkout's branch holds beyond its base: commits, files with line counts, the patch */
	diff(dir: string): Diff {
		const w = this.locate(dir);
		const base = this.baseOf(w);
		const range = `${base}...HEAD`;
		const dirty = git(w.directory, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]).out.trim().length > 0;
		const commits = Number(git(w.directory, ["rev-list", "--count", `${base}..HEAD`]).out.trim()) || 0;
		const status = new Map<string, Diff["files"][number]["status"]>();
		for (const line of git(w.directory, ["diff", "--name-status", "-M", "-z", range]).out.split("\0").reduce<string[][]>((acc, part, i, all) => {
			if (/^[AMDRTCU]\d*$/.test(part)) acc.push([part, all[i + 1] ?? "", ...(part.startsWith("R") || part.startsWith("C") ? [all[i + 2] ?? ""] : [])]);
			return acc;
		}, [])) {
			const [code, a, b] = line as [string, string, string?];
			status.set(b ?? a, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified");
		}
		const files: Diff["files"] = [];
		for (const row of git(w.directory, ["diff", "--numstat", "-M", range]).out.split("\n").filter(Boolean)) {
			const [add, del, ...rest] = row.split("\t");
			const path = rest.join("\t").replace(/^(.*)\{(.*) => (.*)\}(.*)$/, "$1$3$4").replace(/^.* => /, "");
			files.push({ path, status: status.get(path) ?? "modified", additions: Number(add) || 0, deletions: Number(del) || 0 });
		}
		const patch = git(w.directory, ["diff", "-M", range]).out;
		const head = git(w.directory, ["rev-parse", "HEAD"]).out.trim();
		const probe = head ? git(w.project, ["merge-tree", "--write-tree", "--no-messages", base, head]) : undefined;
		const mergeable = probe === undefined ? undefined : probe.code === 0 ? true : probe.code === 1 ? false : undefined;
		return {
			...(w.branch ? { branch: w.branch } : {}),
			base,
			baseRef: base,
			commits,
			dirty,
			...(mergeable === undefined ? {} : { mergeable }),
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
			files,
			diff: patch.length > DIFF_MAX_BYTES ? patch.slice(0, DIFF_MAX_BYTES) : patch,
			truncated: patch.length > DIFF_MAX_BYTES,
		};
	}

	/**
	 * squash-merges the checkout's branch into its base on this machine, then removes the checkout and
	 * the branch. where the base is checked out the merge runs in that working tree (git refuses when it
	 * would overwrite local changes there); otherwise the base ref moves to a new commit directly.
	 */
	merge(dir: string, opts: { message?: string } = {}): Merged {
		const w = this.locate(dir);
		if (!w.branch) throw new WorktreeError("WorktreeRefusedError", 409, `the checkout at ${w.directory} has no branch (detached head); commit onto a branch first`, { reason: "detached" satisfies RefusalReason });
		if (git(w.directory, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]).out.trim()) {
			throw new WorktreeError("WorktreeRefusedError", 409, `the checkout has uncommitted changes; commit them (or discard the checkout) before merging`, { reason: "dirty" satisfies RefusalReason });
		}
		const base = this.baseOf(w);
		const subjects = git(w.project, ["log", "--reverse", "--format=%s", `${base}..${w.branch}`]).out.split("\n").filter(Boolean);
		if (!subjects.length) throw new WorktreeError("WorktreeRefusedError", 409, `${w.branch} has no commits beyond ${base}; nothing to merge`, { reason: "nothing" satisfies RefusalReason });

		const probe = git(w.project, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, w.branch]);
		if (probe.code === 1) {
			const files = probe.out.split("\n").slice(1).filter(Boolean);
			throw new WorktreeError("WorktreeMergeConflictError", 409, `${base} moved since ${w.branch} was made and they conflict in ${files.length} file(s); rebase the branch onto ${base} inside the checkout, then merge again`, { files, base, branch: w.branch });
		}
		if (probe.code !== 0) throw new WorktreeError("WorktreeFailedError", 500, `git merge-tree failed: ${(probe.err || probe.out).trim()}`);
		const tree = probe.out.split("\n")[0]!.trim();

		const message = opts.message?.trim() || (subjects.length === 1 ? subjects[0]! : `${w.branch.replace(/^cmx2\//, "")}: ${subjects.length} commits\n\n${subjects.map((s) => `- ${s}`).join("\n")}`);
		const into = worktreeList(w.project).find((t) => t.branch === base)?.path;
		let commit: string;
		if (into) {
			const squashed = git(into, ["merge", "--squash", w.branch]);
			if (squashed.code !== 0) {
				git(into, ["reset", "-q", "--merge"]);
				throw new WorktreeError("WorktreeRefusedError", 409, `${base} is checked out at ${into} and git would not merge there: ${(squashed.err || squashed.out).trim().split("\n")[0]}`, { reason: "target_dirty" satisfies RefusalReason, into });
			}
			const committed = git(into, ["commit", "-q", "-m", message]);
			if (committed.code !== 0) {
				git(into, ["reset", "-q", "--merge"]);
				throw new WorktreeError("WorktreeFailedError", 500, `the squash commit on ${base} failed: ${(committed.err || committed.out).trim()}`);
			}
			commit = must(into, ["rev-parse", "HEAD"], "reading the merge commit").trim();
		} else {
			const parent = must(w.project, ["rev-parse", `refs/heads/${base}`], "reading the base").trim();
			commit = must(w.project, ["commit-tree", tree, "-p", parent, "-m", message], "writing the squash commit").trim();
			must(w.project, ["update-ref", `refs/heads/${base}`, commit, parent], "moving the base branch");
		}
		this.remove(w.project, w.directory, w.branch);
		return { merged: true, commit, base, branch: w.branch, commits: subjects.length, ...(into ? { into } : {}) };
	}

	/** removes the checkout and its branch; its last state is kept under refs/cmx2/rescue/<name> first when there was any work */
	discard(dir: string): Discarded {
		const w = this.locate(dir);
		const dirty = git(w.directory, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]).out.trim().length > 0;
		const base = w.base && branchExists(w.project, w.base) ? w.base : defaultBranch(w.project);
		const ahead = base ? Number(git(w.directory, ["rev-list", "--count", `${base}..HEAD`]).out.trim()) || 0 : 0;
		let snapshot: string | undefined;
		let ref: string | undefined;
		if (dirty || ahead > 0) {
			snapshot = this.snapshot(w.directory);
			if (snapshot) {
				ref = `refs/cmx2/rescue/${w.name}`;
				git(w.project, ["update-ref", ref, snapshot]);
			}
		}
		this.remove(w.project, w.directory, w.branch);
		return { discarded: true, ...(snapshot ? { snapshot } : {}), ...(ref ? { ref } : {}) };
	}

	/** a commit of the checkout as it stands, untracked files included, written through a scratch index so the checkout is untouched */
	private snapshot(directory: string): string | undefined {
		const head = git(directory, ["rev-parse", "HEAD"]).out.trim();
		if (!head) return undefined;
		const index = join(directory, "..", `.${basename(directory)}.rescue-index`);
		try {
			const env = { GIT_INDEX_FILE: index };
			if (git(directory, ["read-tree", head], env).code !== 0) return undefined;
			if (git(directory, ["add", "-A", "."], env).code !== 0) return undefined;
			const tree = git(directory, ["write-tree"], env).out.trim();
			if (!tree) return undefined;
			return git(directory, ["commit-tree", tree, "-p", head, "-m", `rescue: ${basename(directory)} as it was when discarded (${new Date().toISOString()})`]).out.trim() || undefined;
		} finally {
			rmSync(index, { force: true });
		}
	}

	/** the checkout's directory, its git bookkeeping and its branch, gone */
	private remove(primary: string, directory: string, branch?: string) {
		git(primary, ["worktree", "remove", "--force", "--force", directory]);
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
		git(primary, ["worktree", "prune"]);
		if (branch) git(primary, ["branch", "-D", branch]);
	}
}
