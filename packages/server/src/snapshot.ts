import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * file snapshots per turn. each directory gets its own bare git repository under the data dir, with the
 * directory as its work tree, so a turn's changes can be listed, diffed and put back without ever touching
 * the project's own .git. the snapshot index mirrors the work tree; a tree hash is one moment of it.
 */

export interface FileDiff {
	/** path relative to the directory, forward slashes */
	file: string;
	/** full text before and after; "" for an added or deleted file; binary files get "" and binary: true */
	before: string;
	after: string;
	additions: number;
	deletions: number;
	status: "added" | "deleted" | "modified";
	binary?: true;
}

/** more changed or untracked files than this in one pass and the directory is not snapshotted */
const MAX_FILES = 20_000;
/** a file bigger than this is left out of snapshots (build output, media, dumps, a database that grew); one already in keeps its last version under the cap */
const MAX_NEW_FILE = 2 * 1024 * 1024;
/** a side of a diff bigger than this comes back as "" with only the line counts */
const MAX_TEXT = 256 * 1024;
const TIMEOUT_MS = 60_000;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CONFIG: [string, string][] = [
	["core.autocrlf", "false"],
	["core.longpaths", "true"],
	["core.symlinks", "true"],
	["core.fsmonitor", "false"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
];

interface Run {
	code: number;
	out: Uint8Array;
	err: string;
}

interface Ctx {
	/** the directory as the caller named it, resolved */
	given: string;
	/** its realpath; the work tree */
	dir: string;
	gitDir: string;
}

const decoder = new TextDecoder();

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	// a daemon started from inside a git hook or a shell with these set would point every call somewhere else
	for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"]) delete env[k];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_PAGER = "cat";
	return env;
}

async function run(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string>; live?: Set<ReturnType<typeof Bun.spawn>> } = {}): Promise<Run> {
	let proc: ReturnType<typeof Bun.spawn>;
	// a work tree removed under a turn (a merged checkout) makes the spawn fail the same way a missing git does
	if (opts.cwd && !existsSync(opts.cwd)) return { code: -1, out: new Uint8Array(), err: `${opts.cwd} is gone` };
	try {
		proc = Bun.spawn(["git", "--no-pager", ...args], {
			cwd: opts.cwd,
			stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...baseEnv(), ...opts.env },
			timeout: TIMEOUT_MS,
		});
	} catch (e) {
		const missing = (e as { code?: string }).code === "ENOENT";
		return { code: -1, out: new Uint8Array(), err: missing ? "git is not installed or not on PATH" : String((e as Error).message ?? e) };
	}
	opts.live?.add(proc);
	const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).arrayBuffer(), new Response(proc.stderr as ReadableStream).text(), proc.exited]).finally(() => opts.live?.delete(proc));
	if (proc.signalCode) return { code: -1, out: new Uint8Array(), err: `git ${args.find((a) => !a.startsWith("-")) ?? ""} took longer than ${TIMEOUT_MS / 1000}s and was stopped` };
	return { code, out: new Uint8Array(out), err: err.trim() };
}

function split0(buf: Uint8Array): string[] {
	return decoder.decode(buf).split("\0").filter(Boolean);
}

function fail(what: string, r: Run): Error {
	return new Error(`${what}: ${r.err || `git exited with ${r.code}`}`);
}

/** a .gitignore pattern that matches at any depth, so it means the same thing from a subdirectory */
function floating(line: string): boolean {
	const p = line.trim().replace(/^!/, "").replace(/\/+$/, "");
	return p !== "" && !p.startsWith("#") && !p.includes("/");
}

export class Snapshots {
	private dataDir: string;
	private log: (line: string) => void;
	private queues = new Map<string, Promise<unknown>>();
	private ready = new Set<string>();
	private told = new Set<string>();
	/** git processes running now, so close can stop them */
	private live = new Set<ReturnType<typeof Bun.spawn>>();
	private closed = false;

	constructor(opts: { dataDir: string; log?: (line: string) => void }) {
		this.dataDir = resolve(opts.dataDir);
		this.log = opts.log ?? ((line) => console.warn(line));
	}

	/**
	 * records the work tree of `directory` as it is now and returns the tree hash. undefined when the
	 * directory cannot be snapshotted (the home dir or above it, missing, git missing, too many files);
	 * the reason is logged once per directory.
	 */
	async track(directory: string): Promise<string | undefined> {
		let ctx: Ctx;
		try {
			ctx = this.ctx(directory);
		} catch (e) {
			this.tell(directory, (e as Error).message);
			return undefined;
		}
		if (this.closed) return undefined;
		const refused = this.refuse(ctx.dir);
		if (refused) {
			this.tell(ctx.dir, `not snapshotting ${ctx.dir}: ${refused}`);
			return undefined;
		}
		return this.locked(ctx, () => this.write(ctx));
	}

	/** files (relative paths) that differ between tree `from` and tree `to` (the work tree now when `to` is omitted) */
	async changed(directory: string, from: string, to?: string): Promise<string[]> {
		const ctx = this.open(directory, from, to);
		return this.locked(ctx, async () => this.names(ctx, from, to ?? (await this.now(ctx))));
	}

	/**
	 * puts the given files (relative paths; all files that differ when omitted) back to how they were in tree
	 * `tree`: files present there are checked out, files absent there are deleted from the work tree, along
	 * with any directories that leaves empty. directories named in `files` are never deleted.
	 */
	async restore(directory: string, tree: string, files?: string[]): Promise<void> {
		const ctx = this.open(directory, tree);
		const wanted = files?.map((f) => this.inside(ctx, f));
		await this.locked(ctx, async () => {
			const list = wanted ?? (await this.names(ctx, tree, await this.now(ctx)));
			if (!list.length) return;
			const ls = await this.git(ctx, ["ls-tree", "-r", "-z", "--name-only", tree]);
			if (ls.code !== 0) throw fail(`could not read snapshot ${tree} of ${ctx.dir}`, ls);
			const present = new Set(split0(ls.out));
			const back = [...new Set(list.filter((f) => present.has(f)))];
			const gone = [...new Set(list.filter((f) => !present.has(f)))];
			if (back.length) {
				const r = await this.git(ctx, ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], back.join("\0"));
				if (r.code !== 0) throw fail(`could not restore ${back.length} file${back.length === 1 ? "" : "s"} in ${ctx.dir} from snapshot ${tree}`, r);
			}
			for (const f of gone) this.remove(ctx, f);
		});
	}

	/** per-file diff between tree `from` and tree `to` (the work tree now when omitted), sorted by file */
	async diff(directory: string, from: string, to?: string): Promise<FileDiff[]> {
		const ctx = this.open(directory, from, to);
		return this.locked(ctx, async () => {
			const b = to ?? (await this.now(ctx));
			const [raw, num] = await Promise.all([
				this.git(ctx, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", from, b]),
				this.git(ctx, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", from, b]),
			]);
			if (raw.code !== 0) throw fail(`could not diff snapshots ${from} and ${b} of ${ctx.dir}`, raw);
			if (num.code !== 0) throw fail(`could not count lines between snapshots ${from} and ${b} of ${ctx.dir}`, num);
			const counts = this.numstat(num.out);

			const rows: { file: string; status: FileDiff["status"]; before?: string; after?: string }[] = [];
			const tokens = split0(raw.out);
			for (let i = 0; i + 1 < tokens.length; i += 2) {
				const [, , , oldOid, newOid, code] = tokens[i]!.split(/[: ]/);
				const status = code?.startsWith("A") ? "added" : code?.startsWith("D") ? "deleted" : "modified";
				rows.push({ file: tokens[i + 1]!, status, before: status === "added" ? undefined : oldOid, after: status === "deleted" ? undefined : newOid });
			}
			const text = await this.blobs(
				ctx,
				rows.flatMap((r) => (counts.get(r.file)?.binary ? [] : [r.before, r.after].filter((o): o is string => !!o))),
			);
			const out: FileDiff[] = rows.map((r) => {
				const n = counts.get(r.file) ?? { additions: 0, deletions: 0, binary: false };
				const d: FileDiff = { file: r.file, before: "", after: "", additions: n.additions, deletions: n.deletions, status: r.status };
				if (n.binary) return { ...d, binary: true };
				const before = r.before ? text.get(r.before) : "";
				const after = r.after ? text.get(r.after) : "";
				// one side over the cap blanks both, so nobody builds a patch from half a file
				if (before === undefined || after === undefined) return d;
				return { ...d, before, after };
			});
			return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
		});
	}

	/** additions, deletions and file count between two trees (the work tree when `to` is omitted) */
	async stat(directory: string, from: string, to?: string): Promise<{ files: number; additions: number; deletions: number }> {
		const ctx = this.open(directory, from, to);
		return this.locked(ctx, async () => {
			const b = to ?? (await this.now(ctx));
			const r = await this.git(ctx, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", from, b]);
			if (r.code !== 0) throw fail(`could not count lines between snapshots ${from} and ${b} of ${ctx.dir}`, r);
			const total = { files: 0, additions: 0, deletions: 0 };
			for (const n of this.numstat(r.out).values()) {
				total.files++;
				total.additions += n.additions;
				total.deletions += n.deletions;
			}
			return total;
		});
	}

	// internals

	private ctx(directory: string): Ctx {
		const given = resolve(directory);
		let dir: string;
		try {
			dir = realpathSync(given);
		} catch {
			throw new Error(`no such directory: ${given}`);
		}
		if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${given}`);
		const key = createHash("sha256").update(dir).digest("hex").slice(0, 16);
		return { given, dir, gitDir: join(this.dataDir, "snapshot", key) };
	}

	/** a context for a read or restore; the hashes must look like hashes so none is taken for an option */
	private open(directory: string, ...hashes: (string | undefined)[]): Ctx {
		for (const h of hashes) if (h !== undefined && !HASH.test(h)) throw new Error(`not a snapshot hash: ${JSON.stringify(h)}`);
		const ctx = this.ctx(directory);
		const refused = this.refuse(ctx.dir);
		if (refused) throw new Error(`${ctx.dir} has no snapshots: ${refused}`);
		return ctx;
	}

	private refuse(dir: string): string | undefined {
		if (parse(dir).root === dir) return "it is the filesystem root; open a project folder instead";
		let home: string;
		try {
			home = realpathSync(homedir());
		} catch {
			home = resolve(homedir());
		}
		if (home === dir || home.startsWith(dir + sep)) return "it is the home directory or holds it; open a project folder instead";
		return undefined;
	}

	private tell(key: string, line: string) {
		const k = `${key}\0${line}`;
		if (this.told.has(k)) return;
		this.told.add(k);
		this.log(line);
	}

	/**
	 * the daemon is stopping: nothing new starts, work in flight gets `graceMs` to finish, then any git
	 * still running is killed, so no snapshot outlives the daemon that asked for it
	 */
	async close(graceMs = 3_000): Promise<void> {
		this.closed = true;
		const pending = [...this.queues.values()];
		if (pending.length) await Promise.race([Promise.all(pending), Bun.sleep(graceMs)]);
		for (const p of this.live) p.kill("SIGKILL");
		await Promise.all([...this.live].map((p) => p.exited.catch(() => {})));
	}

	private locked<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("snapshots are closed: the daemon is stopping"));
		const prev = this.queues.get(ctx.gitDir) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.then(
			() => {},
			() => {},
		);
		this.queues.set(ctx.gitDir, tail);
		void tail.then(() => {
			if (this.queues.get(ctx.gitDir) === tail) this.queues.delete(ctx.gitDir);
		});
		return next;
	}

	private git(ctx: Ctx, args: string[], stdin?: string): Promise<Run> {
		return run(["-c", "core.quotepath=false", "--git-dir", ctx.gitDir, "--work-tree", ctx.dir, ...args], { cwd: ctx.dir, stdin, env: { GIT_LITERAL_PATHSPECS: "1" }, live: this.live });
	}

	/** the project's own git, read-only: never takes its index lock */
	private project(ctx: Ctx, args: string[], stdin?: string): Promise<Run> {
		return run(["-c", "core.quotepath=false", ...args], { cwd: ctx.dir, stdin, env: { GIT_OPTIONAL_LOCKS: "0" }, live: this.live });
	}

	/** the work tree as a tree hash, for reads that compare against now */
	private async now(ctx: Ctx): Promise<string> {
		const hash = await this.write(ctx);
		if (!hash) throw new Error(`could not snapshot the work tree of ${ctx.dir} to compare against; the daemon log says why`);
		return hash;
	}

	private async write(ctx: Ctx): Promise<string | undefined> {
		if (!(await this.init(ctx))) return undefined;
		let staged: true | string = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			staged = await this.stage(ctx);
			if (staged === true) break;
			// a file written or removed between listing and adding, or another daemon holding the index: look again
			await Bun.sleep(150 * (attempt + 1));
		}
		if (staged !== true) {
			this.tell(ctx.dir, `could not snapshot ${ctx.dir}: ${staged}`);
			return undefined;
		}
		const r = await this.git(ctx, ["write-tree"]);
		if (r.code !== 0) {
			this.tell(ctx.dir, fail(`could not snapshot ${ctx.dir}`, r).message);
			return undefined;
		}
		return decoder.decode(r.out).trim();
	}

	private async init(ctx: Ctx): Promise<boolean> {
		if (this.ready.has(ctx.gitDir)) return true;
		if (!existsSync(join(ctx.gitDir, "HEAD"))) {
			mkdirSync(dirname(ctx.gitDir), { recursive: true });
			const r = await run(["-c", "init.defaultBranch=snapshot", "init", "--bare", "--quiet", ctx.gitDir], { live: this.live });
			if (r.code !== 0) {
				this.tell(ctx.dir, fail(`not snapshotting ${ctx.dir}`, r).message);
				return false;
			}
			for (const [k, v] of CONFIG) {
				const c = await run(["--git-dir", ctx.gitDir, "config", k, v], { live: this.live });
				if (c.code !== 0) {
					this.tell(ctx.dir, fail(`not snapshotting ${ctx.dir}: could not set ${k} in ${ctx.gitDir}`, c).message);
					return false;
				}
			}
			// for a human looking at the data dir: which directory this store belongs to
			writeFileSync(join(ctx.gitDir, "description"), `snapshots of ${ctx.dir}\n`);
		}
		this.ready.add(ctx.gitDir);
		return true;
	}

	/** brings the snapshot index in line with the work tree; true, or why it could not */
	private async stage(ctx: Ctx): Promise<true | string> {
		await this.excludes(ctx);
		const lock = join(ctx.gitDir, "index.lock");
		try {
			if (Date.now() - statSync(lock).mtimeMs > 2 * TIMEOUT_MS) {
				unlinkSync(lock);
				this.log(`snapshot: removed a stale index.lock in ${ctx.gitDir} left by a git that died`);
			}
		} catch {}

		const [mod, others] = await Promise.all([
			this.git(ctx, ["diff-files", "--name-only", "-z", "--", "."]),
			this.git(ctx, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
		]);
		if (mod.code !== 0) return fail("listing changed files failed", mod).message;
		if (others.code !== 0) return fail("listing new files failed", others).message;
		const modified = split0(mod.out);
		// a trailing slash is a nested repository; its files belong to it, not to this snapshot
		const untracked = split0(others.out).filter((f) => !f.endsWith("/"));
		if (modified.length + untracked.length > MAX_FILES) {
			return `more than ${MAX_FILES} files are new or changed at once; a .gitignore that covers dependencies and build output brings it under the cap`;
		}

		let all = [...new Set([...modified, ...untracked])];
		if (!all.length) return true;
		const ignored = await this.ignored(ctx, all);
		if (ignored.size) {
			// a file the project started ignoring leaves the snapshot instead of lingering in it
			const r = await this.git(ctx, ["rm", "--cached", "-q", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], [...ignored].join("\0"));
			if (r.code !== 0) return fail("dropping ignored files failed", r).message;
			all = all.filter((f) => !ignored.has(f));
		}

		const fresh = new Set(untracked);
		const big: string[] = [];
		// the cap holds for a file already in the snapshot too: one that grew past it (a database, a build output)
		// keeps its last version under the cap instead of being stored whole on every turn
		const add = all.filter((f) => {
			try {
				const st = lstatSync(join(ctx.dir, f));
				if (st.isFile() && st.size > MAX_NEW_FILE) {
					big.push(f);
					return false;
				}
				return true;
			} catch {
				// a deleted file: its removal is recorded; a new file that vanished again is not
				return !fresh.has(f);
			}
		});
		if (big.length) this.tell(`${ctx.dir}\0big`, `snapshot: leaving ${big.length} file${big.length === 1 ? "" : "s"} over ${MAX_NEW_FILE / 1024 / 1024} MB out of ${ctx.dir} (first: ${big[0]})`);
		if (!add.length) return true;
		const r = await this.git(ctx, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], add.join("\0"));
		if (r.code !== 0) return fail("adding files failed", r).message;
		return true;
	}

	/**
	 * the snapshot's info/exclude: the project's own info/exclude, the any-depth patterns of .gitignore files
	 * above the directory when it sits inside a repository, and the data dir when it sits inside the directory.
	 * anchored patterns from above are left to check-ignore, which asks the project's git directly.
	 */
	private async excludes(ctx: Ctx) {
		const lines: string[] = [];
		const r = await this.project(ctx, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "info/exclude"]);
		if (r.code === 0) {
			const [top, exclude] = decoder.decode(r.out).split("\n");
			let root = top ?? ctx.dir;
			try {
				root = realpathSync(root);
			} catch {}
			const sub = root !== ctx.dir;
			if (sub) {
				const above: string[] = [];
				for (let d = dirname(ctx.dir); d === root || d.startsWith(root + sep); d = dirname(d)) {
					above.unshift(d);
					if (d === root) break;
				}
				for (const d of above) lines.push(...this.readLines(join(d, ".gitignore")).filter(floating));
			}
			if (exclude) lines.push(...this.readLines(exclude).filter((l) => !sub || floating(l)));
		}
		const data = relative(ctx.dir, this.dataDir);
		if (data === "" || (!data.startsWith("..") && !isAbsolute(data))) lines.push(`/${data.split(sep).join("/")}/`);
		const text = lines.length ? `${lines.join("\n")}\n` : "";
		const target = join(ctx.gitDir, "info", "exclude");
		let current: string | undefined;
		try {
			current = readFileSync(target, "utf8");
		} catch {}
		if (current === text) return;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}

	private readLines(file: string): string[] {
		try {
			return readFileSync(file, "utf8")
				.split(/\r?\n/)
				.filter((l) => l.trim() && !l.startsWith("#"));
		} catch {
			return [];
		}
	}

	/** which of these paths the project's git ignores; empty outside a repository */
	private async ignored(ctx: Ctx, files: string[]): Promise<Set<string>> {
		const r = await this.project(ctx, ["check-ignore", "--no-index", "--stdin", "-z"], `${files.join("\0")}\0`);
		if (r.code !== 0 && r.code !== 1) return new Set();
		return new Set(split0(r.out));
	}

	private async names(ctx: Ctx, from: string, to: string): Promise<string[]> {
		const r = await this.git(ctx, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]);
		if (r.code !== 0) throw fail(`could not diff snapshots ${from} and ${to} of ${ctx.dir}`, r);
		return split0(r.out);
	}

	private numstat(buf: Uint8Array): Map<string, { additions: number; deletions: number; binary: boolean }> {
		const out = new Map<string, { additions: number; deletions: number; binary: boolean }>();
		for (const rec of split0(buf)) {
			const m = rec.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
			if (!m) continue;
			const binary = m[1] === "-" && m[2] === "-";
			out.set(m[3]!, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
		}
		return out;
	}

	/** blob text by oid for the blobs at or under the cap; bigger or missing ones are absent from the map */
	private async blobs(ctx: Ctx, oids: string[]): Promise<Map<string, string>> {
		const text = new Map<string, string>();
		const want = [...new Set(oids)].filter((o) => HASH.test(o) && !/^0+$/.test(o));
		if (!want.length) return text;
		const check = await this.git(ctx, ["cat-file", "--batch-check"], `${want.join("\n")}\n`);
		if (check.code !== 0) throw fail(`could not read file sizes from the snapshots of ${ctx.dir}`, check);
		const small: string[] = [];
		for (const line of decoder.decode(check.out).split("\n")) {
			const [oid, type, size] = line.split(" ");
			if (oid && type === "blob" && Number(size) <= MAX_TEXT) small.push(oid);
		}
		if (!small.length) return text;
		const r = await this.git(ctx, ["cat-file", "--batch"], `${small.join("\n")}\n`);
		if (r.code !== 0) throw fail(`could not read file contents from the snapshots of ${ctx.dir}`, r);
		let i = 0;
		while (i < r.out.length) {
			let end = i;
			while (end < r.out.length && r.out[end] !== 10) end++;
			const [oid, type, size] = decoder.decode(r.out.subarray(i, end)).split(" ");
			i = end + 1;
			if (type !== "blob" || !oid) continue;
			const n = Number(size);
			text.set(oid, decoder.decode(r.out.subarray(i, i + n)));
			i += n + 1;
		}
		return text;
	}

	/** a caller's path as a forward-slash path inside the directory */
	private inside(ctx: Ctx, file: string): string {
		const abs = isAbsolute(file) ? file : resolve(ctx.given, file);
		let rel = relative(ctx.given, abs);
		if (rel.startsWith("..") || isAbsolute(rel)) rel = relative(ctx.dir, abs);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`restore takes files inside ${ctx.given}; ${file} is not one`);
		return rel.split(sep).join("/");
	}

	/** deletes a file the snapshot did not have, then any directories that leaves empty up to the directory itself */
	private remove(ctx: Ctx, file: string) {
		const abs = join(ctx.dir, file);
		try {
			if (lstatSync(abs).isDirectory()) return;
			unlinkSync(abs);
		} catch {
			return;
		}
		for (let d = dirname(abs); d !== ctx.dir && d.startsWith(ctx.dir + sep); d = dirname(d)) {
			try {
				if (readdirSync(d).length) break;
				rmdirSync(d);
			} catch {
				break;
			}
		}
	}
}
