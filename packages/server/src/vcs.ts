import { existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * git, read-only, for clients: the branch and a dirty flag on each session row (cached per directory,
 * dropped when a turn ends or a file is edited, loaded async so git never holds the event loop) and the
 * working tree's status with line counts.
 */

export interface Vcs {
	branch: string;
	dirty: boolean;
}

export interface FileStatus {
	/** relative to the directory asked about */
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	added: number;
	removed: number;
}

const FRESH_MS = 30_000;

function git(dir: string, args: string[]): string | undefined {
	const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
	return r.exitCode === 0 ? r.stdout.toString() : undefined;
}

const STATUS_ARGS = ["status", "--porcelain=v2", "--branch"];

/** porcelain v2 with --branch names the head even on an unborn branch; any other line is a change */
function parseStatus(out: string | undefined): Vcs | null {
	if (out === undefined) return null;
	const lines = out.split("\n").filter(Boolean);
	const head = lines.find((l) => l.startsWith("# branch.head "))?.slice("# branch.head ".length) ?? "HEAD";
	const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length);
	return { branch: head === "(detached)" ? `detached at ${oid?.slice(0, 7) ?? "?"}` : head, dirty: lines.some((l) => !l.startsWith("#")) };
}

/** what a git run said: its output, nothing (not a work tree, or git failed), or that it was stopped */
type GitAnswer = { out: string | undefined } | "timeout";

async function gitAsync(dir: string, args: string[], timeoutMs: number): Promise<GitAnswer> {
	try {
		const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		const done = Promise.all([new Response(p.stdout).text(), p.exited]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// raced, not awaited: a child git left behind can hold the pipe open after git itself is killed
		const won = await Promise.race([done, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)))]);
		clearTimeout(timer);
		if (won === "timeout") {
			p.kill("SIGKILL");
			done.catch(() => {});
			return "timeout";
		}
		const [out, code] = won;
		return { out: code === 0 ? out : undefined };
	} catch {
		return { out: undefined };
	}
}

/**
 * branch and dirty flag per directory. git runs off the event loop (`load`, one run per directory at a
 * time, shared by every caller); `of` answers from what is loaded and fresh. `of` on a directory nobody
 * loaded still runs git inline, so a caller that skipped `load` gets the same answer, only slower.
 */
export class VcsCache {
	/** `until`: when the entry stops being fresh */
	private cache = new Map<string, { until: number; vcs: Vcs | null }>();
	private freshMs: number;
	private timeoutMs: number;
	private unknownMs: number;
	/** git runs that were stopped for taking too long; their directory keeps its last status (or none) for a short while */
	timeouts = 0;
	/** the last status git gave for each directory, kept across forget, for when a later run times out */
	private known = new Map<string, Vcs | null>();

	/**
	 * freshMs: how long a status is kept (30 s). timeoutMs: a git run that takes longer is stopped and its
	 * answer is unknown, shown as no branch (what a directory outside git shows), kept for unknownMs
	 */
	constructor(opts: { freshMs?: number; timeoutMs?: number; unknownMs?: number } = {}) {
		this.freshMs = opts.freshMs ?? FRESH_MS;
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		this.unknownMs = opts.unknownMs ?? 5_000;
	}
	/** bumped by forget, so a git run that started before an edit is not kept as fresh */
	private gen = new Map<string, number>();
	private running = new Map<string, { gen: number; done: Promise<void> }>();
	/** git runs that blocked the loop (a caller did not load first); for tests and probes */
	inline = 0;

	/** true when `of(dir)` answers without running git */
	fresh(dir: string): boolean {
		const hit = this.cache.get(dir);
		return !!hit && Date.now() < hit.until;
	}

	/** the branch and dirty flag for a directory, or nothing when it is not in a git work tree */
	of(dir: string): Vcs | undefined {
		const hit = this.cache.get(dir);
		if (hit && Date.now() < hit.until) return hit.vcs ?? undefined;
		this.inline++;
		const vcs = existsSync(dir) ? parseStatus(git(dir, STATUS_ARGS)) : null;
		this.known.set(dir, vcs);
		this.cache.set(dir, { until: Date.now() + this.freshMs, vcs });
		return vcs ?? undefined;
	}

	/** makes `of(dir)` fresh without blocking: runs git async when it is not, joining a run already going */
	async load(dir: string): Promise<void> {
		for (let i = 0; i < 3 && !this.fresh(dir); i++) {
			const gen = this.gen.get(dir) ?? 0;
			let run = this.running.get(dir);
			if (!run || run.gen !== gen) {
				const done = (async () => {
					// the existence check counts against the same deadline: a hung mount stalls stat too
					const started = Date.now();
					const there = await within(exists(dir), this.timeoutMs);
					const said = there === "timeout" ? "timeout" : there ? await gitAsync(dir, STATUS_ARGS, Math.max(1, this.timeoutMs - (Date.now() - started))) : { out: undefined };
					if (said === "timeout") {
						// a hung or slow git (a stuck mount, a lock, a cold large repository): the last status known stands for a
						// short while (none when nothing is known), so nobody waiting hangs, the loop never runs it inline and a
						// slow but working git does not make the row flap
						this.timeouts++;
						const last = this.known.get(dir);
						console.error(`cmx2: git status in ${dir} took over ${this.timeoutMs / 1000} s and was stopped; ${last ? "the last status known stands" : "its branch reads as unknown"} for now`);
						this.cache.set(dir, { until: Date.now() + this.unknownMs, vcs: last ?? null });
						return;
					}
					const vcs = parseStatus(said.out);
					this.known.set(dir, vcs);
					// an edit landed while git ran: what it saw may be old, so it is not kept
					if ((this.gen.get(dir) ?? 0) === gen) this.cache.set(dir, { until: Date.now() + this.freshMs, vcs });
				})().finally(() => {
					if (this.running.get(dir)?.done === done) this.running.delete(dir);
				});
				run = { gen, done };
				this.running.set(dir, run);
			}
			await run.done;
		}
	}

	/** drops what is known about a directory (a turn ended, a file changed); the next read asks git again */
	forget(dir: string) {
		this.cache.delete(dir);
		this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
	}
}

/** a promise's answer, or "timeout" when it takes longer than ms */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const won = await Promise.race([p, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]);
	clearTimeout(timer);
	return won;
}

/** existsSync without blocking: true for anything stat can see */
function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function lineCount(abs: string): number {
	try {
		const st = statSync(abs);
		if (!st.isFile() || st.size > 4 * 1024 * 1024) return 0;
		const buf = readFileSync(abs);
		if (buf.subarray(0, 8000).includes(0)) return 0;
		let n = 0;
		for (const b of buf) if (b === 10) n++;
		return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
	} catch {
		return 0;
	}
}

/** the working tree's changes against HEAD, untracked files included, with added and removed lines; undefined outside git */
export function fileStatus(dir: string): FileStatus[] | undefined {
	const status = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
	if (status === undefined) return undefined;
	const counts = new Map<string, { added: number; removed: number }>();
	for (const line of (git(dir, ["diff", "--numstat", "--relative", "HEAD", "--", "."]) ?? git(dir, ["diff", "--numstat", "--relative", "--cached", "--", "."]) ?? "").split("\n")) {
		const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
		if (m) counts.set(m[3]!, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
	}
	const top = git(dir, ["rev-parse", "--show-prefix"])?.trim() ?? "";
	const out: FileStatus[] = [];
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.length < 4) continue;
		const code = e.slice(0, 2);
		// porcelain paths are relative to the repository root; the answer is relative to the directory asked about
		const path = e.slice(3).startsWith(top) ? e.slice(3 + top.length) : e.slice(3);
		if (code[0] === "R" || code[0] === "C") i++;
		const kind: FileStatus["status"] = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code[0] === "R" ? "renamed" : "modified";
		const c = counts.get(path) ?? (kind === "untracked" ? { added: lineCount(join(dir, path)), removed: 0 } : { added: 0, removed: 0 });
		out.push({ path, status: kind, ...c });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}