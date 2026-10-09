import { stat } from "node:fs/promises";

/**
 * `/find/file`: fuzzy paths inside a directory for the `@` picker. the file list comes from
 * ripgrep (so .gitignore holds) and is kept for a few seconds per directory, long enough for a
 * burst of keystrokes and short enough that a new file shows up on the next search.
 *
 * the walk is asynchronous, so a slow directory (a person's home, `/`) never holds the daemon, and
 * there is one walk per directory at a time: asks that arrive while it runs wait for the same one.
 * a walk that outlasts its deadline answers what it found so far, flagged truncated; so does one cut
 * at MAX_PATHS; so does one that failed. a cut listing is kept for the same few seconds (a burst of keystrokes must not start
 * a walk each) but it stays flagged, so every answer from it says so.
 */

const TTL_MS = 5_000;
/** a listing larger than this is cut; a picker never needs the millionth path */
const MAX_PATHS = 200_000;
/** how long one walk may run before it answers what it has; CMX2_FIND_DEADLINE_MS overrides it (read on each walk) */
const DEADLINE_MS = 5_000;
/** the paths (files and directories) the kept listings hold between them, at most */
const MAX_KEPT = 500_000;

export interface Listing {
	files: string[];
	dirs: string[];
	/** the walk was cut by its deadline or by MAX_PATHS: the lists are what was found, not everything */
	truncated: boolean;
}

/** `keep` is false for an answer that says nothing about the directory (it is gone, or ripgrep did not run): never cached */
type Walked = Listing & { keep: boolean };

/** a listing kept for the ttl; `memo` holds answers worked out from it (the empty query's top paths) */
type Kept = Listing & { id: number; at: number; memo: Map<string, string[]> };

let nextId = 0;
const cache = new Map<string, Kept>();
/** how many directories' listings are held now (for tests and measurement) */
export const keptListings = () => cache.size;
const walking = new Map<string, Promise<Kept>>();

function deadlineMs(): number {
	const n = Number(process.env.CMX2_FIND_DEADLINE_MS);
	return Number.isFinite(n) && n > 0 ? n : DEADLINE_MS;
}

/** a loop over a large listing hands the loop back this often, so other requests are answered between slices */
const YIELD_EVERY = 20_000;
const breathe = () => new Promise<void>((r) => setImmediate(r));

/** how long ripgrep gets to leave after SIGTERM before SIGKILL */
const KILL_GRACE_MS = 500;
const ended = new WeakSet<object>();

/** ends a ripgrep that is still running: SIGTERM now, SIGKILL if it is still there after a short grace */
function terminate(proc: { exitCode: number | null; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }) {
	if (proc.exitCode !== null || ended.has(proc)) return;
	ended.add(proc);
	proc.kill("SIGTERM");
	const hard = setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), KILL_GRACE_MS);
	hard.unref();
	proc.exited.then(() => clearTimeout(hard));
}

const spawnRg = (cwd: string) => Bun.spawn(["rg", "--files", "--hidden", "--no-messages", "-g", "!.git"], { cwd, env: process.env, stdout: "pipe", stderr: "ignore" });

/**
 * ripgrep's file list for a directory, read as it arrives. one timer bounds the whole walk (the read
 * and the wait for ripgrep to exit): when it fires, or at MAX_PATHS, ripgrep is ended and what was
 * read is the answer, truncated. whatever else ends the walk early (an error) ends ripgrep too.
 */
async function walk(cwd: string): Promise<Walked> {
	if (!(await stat(cwd).then((st) => st.isDirectory(), () => false))) return { files: [], dirs: [], truncated: false, keep: false };
	let proc: ReturnType<typeof spawnRg>;
	try {
		proc = spawnRg(cwd);
	} catch {
		// ripgrep is not installed or would not start: the listing failed, which is not "whole and empty"
		return { files: [], dirs: [], truncated: true, keep: false };
	}
	const files: string[] = [];
	let truncated = false;
	let stop = false;
	const reader = proc.stdout.getReader();
	const cut = () => {
		stop = true;
		truncated = true;
		terminate(proc);
		reader.cancel().catch(() => {});
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((res) => {
		timer = setTimeout(() => {
			cut();
			res();
		}, deadlineMs());
	});
	const read = (async () => {
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const next = await reader.read();
			if (stop) return;
			if (next.done) {
				buf += dec.decode();
				if (buf) files.push(buf);
				return;
			}
			buf += dec.decode(next.value, { stream: true });
			let i: number;
			let from = 0;
			while ((i = buf.indexOf("\n", from)) >= 0) {
				if (i > from) files.push(buf.slice(from, i));
				from = i + 1;
			}
			buf = buf.slice(from);
			if (files.length >= MAX_PATHS) {
				files.length = MAX_PATHS;
				cut();
				return;
			}
		}
	})();
	let code: number | undefined;
	let broke = false;
	try {
		await Promise.race([read, deadline]);
		if (!stop) code = await Promise.race([proc.exited, deadline.then(() => undefined)]);
	} catch {
		broke = true;
	} finally {
		clearTimeout(timer);
		// a walk that ends any way but ripgrep exiting by itself leaves no ripgrep behind
		if (code === undefined) terminate(proc);
	}
	if (broke && !files.length) return { files: [], dirs: [], truncated: true, keep: false };
	const dirs = new Set<string>();
	let n = 0;
	for (const f of files) {
		if (++n % YIELD_EVERY === 0) await breathe();
		let i = f.indexOf("/");
		while (i > 0) {
			dirs.add(`${f.slice(0, i)}/`);
			i = f.indexOf("/", i + 1);
		}
	}
	// ripgrep exits 2 on any error, even when only an unreadable corner was skipped and the rest listed; with nothing listed it failed
	const failed = !truncated && !broke && files.length === 0 && (code ?? 0) >= 2;
	return { files, dirs: [...dirs], truncated: truncated || broke || failed, keep: !failed && !broke };
}

function listing(cwd: string): Promise<Kept> {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);
	const running = walking.get(cwd);
	if (running) return running;
	const p = walk(cwd).then(({ keep, ...l }) => {
		const entry: Kept = { ...l, id: ++nextId, at: Date.now(), memo: new Map() };
		if (keep) {
			cache.set(cwd, entry);
			// at most 32 directories and at most MAX_KEPT paths between them, oldest out first: a few big listings are most of a daemon's heap
			let kept = 0;
			for (const e of cache.values()) kept += e.files.length + e.dirs.length;
			for (const [k, e] of cache) {
				if (cache.size <= 1 || (cache.size <= 32 && kept <= MAX_KEPT)) break;
				cache.delete(k);
				kept -= e.files.length + e.dirs.length;
			}
			// an expired listing is dropped at its ttl, not when 32 newer directories push it out: a large one is tens of megabytes
			// (the timer holds the number, not the listing, so an evicted listing is freed at once)
			const id = entry.id;
			setTimeout(() => cache.get(cwd)?.id === id && cache.delete(cwd), TTL_MS).unref();
		}
		return entry;
	});
	walking.set(cwd, p);
	const done = () => walking.delete(cwd);
	p.then(done, done);
	return p;
}

/** the order `localeCompare` gives, without building a collator for each comparison */
const collator = new Intl.Collator();

/** subsequence match: lower is better; consecutive runs, word starts and a match in the file name score well */
export function fuzzyScore(path: string, query: string): number | undefined {
	const p = path.toLowerCase();
	const q = query.toLowerCase();
	let score = 0;
	let at = -1;
	let run = 0;
	for (const ch of q) {
		const next = p.indexOf(ch, at + 1);
		if (next < 0) return undefined;
		const gap = next - at - 1;
		run = gap === 0 ? run + 1 : 0;
		score += gap - run * 2;
		const prev = p[next - 1];
		if (next === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ".") score -= 3;
		at = next;
	}
	const base = p.lastIndexOf("/", p.endsWith("/") ? p.length - 2 : p.length) + 1;
	if (p.indexOf(q, base) >= 0) score -= 20;
	return score + path.length * 0.01;
}

export async function findFiles(cwd: string, opts: FindOpts): Promise<{ paths: string[]; truncated: boolean }> {
	const l = await listing(cwd);
	return { paths: await pick(l, opts), truncated: l.truncated };
}

interface FindOpts {
	query: string;
	limit: number;
	type?: "file" | "directory";
	dirs?: boolean;
}

/** the best `k` items under `cmp`, kept in order as they arrive: a listing of 200,000 paths is never sorted whole */
class Best<T> {
	readonly items: T[] = [];
	constructor(
		private readonly k: number,
		private readonly cmp: (a: T, b: T) => number,
	) {}

	add(x: T) {
		const { items, k, cmp } = this;
		if (items.length === k && cmp(x, items[k - 1]!) >= 0) return;
		let lo = 0;
		let hi = items.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cmp(items[mid]!, x) <= 0) lo = mid + 1;
			else hi = mid;
		}
		items.splice(lo, 0, x);
		if (items.length > k) items.pop();
	}
}

const byRank = (a: [string, number], b: [string, number]) => a[1] - b[1] || collator.compare(a[0], b[0]);
const hiddenPath = (p: string) => p.startsWith(".") || p.includes("/.");

/**
 * the paths for a query. the work goes in slices that hand the loop back, and only the best `limit`
 * are kept as it goes, so an ask against a large listing neither holds the daemon nor sorts it whole.
 * the empty query's answer is kept on the listing for the rest of its ttl.
 */
async function pick(l: Kept, opts: FindOpts): Promise<string[]> {
	const pools = opts.type === "file" || opts.dirs === false ? [l.files] : opts.type === "directory" ? [l.dirs] : [l.files, l.dirs];
	const q = opts.query.trim();
	const best = new Best<[string, number]>(opts.limit, byRank);
	let n = 0;
	if (!q) {
		const key = `${opts.type ?? ""}|${opts.dirs === false}|${opts.limit}`;
		const memo = l.memo.get(key);
		if (memo) return memo;
		for (const pool of pools) {
			for (const p of pool) {
				if (++n % YIELD_EVERY === 0) await breathe();
				if (hiddenPath(p)) continue;
				let depth = 0;
				for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) depth++;
				best.add([p, depth]);
			}
		}
		const top = best.items.map(([p]) => p);
		l.memo.set(key, top);
		return top;
	}
	const hiddenOk = q.startsWith(".");
	for (const pool of pools) {
		for (const p of pool) {
			if (++n % YIELD_EVERY === 0) await breathe();
			const s = fuzzyScore(p, q);
			if (s === undefined) continue;
			best.add([p, hiddenPath(p) && !hiddenOk ? s + 1000 : s]);
		}
	}
	return best.items.map(([p]) => p);
}

export interface TextMatch {
	/** relative to the directory searched */
	path: string;
	line: number;
	text: string;
	/** utf-16 offsets of each match within text */
	submatches: Array<{ start: number; end: number; text: string }>;
}

/** a line longer than this is cut in the answer; the match offsets still point into what is sent */
const MATCH_LINE_CHARS = 500;

/**
 * `/find/text`: ripgrep over the directory (.gitignore holds), regex unless literal, case-insensitive
 * unless the pattern has a capital letter (ripgrep's smart case). async so a slow search never holds
 * the daemon.
 */
export async function findText(cwd: string, opts: { pattern: string; limit: number; literal?: boolean; glob?: string }): Promise<{ matches: TextMatch[]; truncated: boolean }> {
	const args = ["--json", "--no-messages", "--smart-case", "--hidden", "-g", "!.git", "--max-columns", "2000", "--sort", "path"];
	if (opts.literal) args.push("-F");
	if (opts.glob) args.push("-g", opts.glob);
	args.push("-e", opts.pattern, ".");
	const proc = Bun.spawn(["rg", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const matches: TextMatch[] = [];
	let truncated = false;
	const dec = new TextDecoder();
	let buf = "";
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	outer: for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!line.includes('"type":"match"')) continue;
			const ev = JSON.parse(line) as { data: { path: { text?: string }; lines: { text?: string }; line_number: number; submatches: Array<{ match: { text?: string }; start: number; end: number }> } };
			const raw = (ev.data.lines.text ?? "").replace(/\r?\n$/, "");
			// ripgrep's offsets are utf-8 bytes; clients index strings in utf-16
			const bytes = Buffer.from(raw);
			const at = (b: number) => bytes.subarray(0, b).toString().length;
			const text = raw.length > MATCH_LINE_CHARS ? `${raw.slice(0, MATCH_LINE_CHARS)}…` : raw;
			matches.push({
				path: (ev.data.path.text ?? "").replace(/^\.\//, ""),
				line: ev.data.line_number,
				text,
				submatches: ev.data.submatches.map((s) => ({ start: at(s.start), end: at(s.end), text: s.match.text ?? "" })).filter((s) => s.end <= text.length),
			});
			if (matches.length >= opts.limit) {
				truncated = true;
				break outer;
			}
		}
	}
	proc.kill();
	const code = await proc.exited;
	if (code === 2 && !matches.length) {
		const err = (await new Response(proc.stderr).text()).trim();
		if (err) throw new Error(err.split("\n")[0]);
	}
	return { matches, truncated };
}
