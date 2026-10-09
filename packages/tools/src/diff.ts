import { existsSync, readFileSync, statSync } from "node:fs";

/** what an edit or a write did to a file, in the shape imported history carries (`metadata.filediff`) */
export interface FileDiff {
	file: string;
	/** a unified patch (jsdiff's `Index:` header form, three lines of context), cut at PATCH_CAP bytes; empty when nothing changed */
	patch: string;
	additions: number;
	deletions: number;
}

export interface FileDiffResult {
	filediff: FileDiff;
	/** the patch was cut to stay bounded; additions and deletions still count the whole change */
	truncated: boolean;
}

/** what a file held before a write: its bytes, or null when it did not exist */
export type Before = Buffer | null;

/** bytes of patch kept on a part: a phone reads it and every client hears it in an event */
export const PATCH_CAP = 64 * 1024;
/** the patch of a file the call created: the part's `input.content` already holds every line of it */
export const CREATED_PATCH_CAP = 8 * 1024;
/** a file over this is never held to diff: a call that changes one carries no diff */
export const DIFF_MAX_BYTES = 64 * 1024 * 1024;
/** the changed region (what is left after the shared head and tail go) over this is not diffed: a call that changes that much carries no diff */
export const MIDDLE_MAX_BYTES = 32 * 1024 * 1024;
/** how far Myers searches a range before the range is split on its unique lines (or, with none, replaced whole) */
const MAX_EDIT_DISTANCE = 1000;
/** and the work it may spend there: (lines in the range) x (edit distance) */
const MYERS_WORK = 40_000_000;
/** how deep a range is split on unique lines before it is replaced whole */
const MAX_SPLIT_DEPTH = 64;
const CONTEXT = 3;
const NO_EOL = "\u0000no-eol";
const HUNK_HEADER_BYTES = 48;
const EMPTY = Buffer.alloc(0);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
const headerOf = (file: string) => `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n`;

/** the lines of a text; a last line with no newline is marked, as it is a different line from the same words with one */
function linesOf(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	else lines[lines.length - 1] += NO_EOL;
	return lines;
}

/**
 * the edit script as runs, not lines: t 0 is lines both sides share, 1 lines only the new side has, 2 lines only the old
 * side has; a and b are where each side's lines start (for an insertion, a is the line it goes before, for a deletion b is)
 */
class Runs {
	t: number[] = [];
	a: number[] = [];
	b: number[] = [];
	n: number[] = [];
	push(t: number, a: number, b: number, n: number) {
		if (n <= 0) return;
		const k = this.t.length - 1;
		if (k >= 0 && this.t[k] === t && this.a[k]! + (t !== 1 ? this.n[k]! : 0) === a && this.b[k]! + (t !== 2 ? this.n[k]! : 0) === b) {
			this.n[k]! += n;
			return;
		}
		this.t.push(t);
		this.a.push(a);
		this.b.push(b);
		this.n.push(n);
	}
}

/** Myers over A[alo..alo+n) and B[blo..blo+m): the minimal script, written to `out`, or false when it is further apart than maxD */
function myers(A: string[], B: string[], alo: number, n: number, blo: number, m: number, maxD: number, out: Runs): boolean {
	const max = Math.min(n + m, maxD);
	const off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && A[alo + x] === B[blo + y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) {
				backtrack(trace, d, off, alo, n, blo, m, out);
				return true;
			}
		}
	}
	return false;
}

function backtrack(trace: Int32Array[], d: number, off: number, alo: number, n: number, blo: number, m: number, out: Runs) {
	const rev: number[] = [];
	let x = n;
	let y = m;
	for (let step = d; step > 0; step--) {
		const v = trace[step]!;
		const k = x - y;
		const prevK = k === -step || (k !== step && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
		const prevX = v[off + prevK]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			rev.push(0, alo + x - 1, blo + y - 1);
			x--;
			y--;
		}
		if (x === prevX) rev.push(1, alo + x, blo + y - 1);
		else rev.push(2, alo + x - 1, blo + y);
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		rev.push(0, alo + x - 1, blo + y - 1);
		x--;
		y--;
	}
	for (let i = rev.length - 3; i >= 0; i -= 3) out.push(rev[i]!, rev[i + 1]!, rev[i + 2]!, 1);
}

/** lines that occur once on each side of a range, in the longest run that keeps their order (patience anchors): [a, b] pairs */
function anchorsOf(A: string[], B: string[], alo: number, ahi: number, blo: number, bhi: number): Array<[number, number]> {
	const inA = new Map<string, number>();
	for (let i = alo; i < ahi; i++) inA.set(A[i]!, inA.has(A[i]!) ? -1 : i);
	const inB = new Map<string, number>();
	for (let j = blo; j < bhi; j++) {
		const line = B[j]!;
		if ((inA.get(line) ?? -1) < 0) continue;
		inB.set(line, inB.has(line) ? -1 : j);
	}
	const pa: number[] = [];
	const pb: number[] = [];
	for (let i = alo; i < ahi; i++) {
		const j = inB.get(A[i]!);
		if (j !== undefined && j >= 0 && inA.get(A[i]!) === i) {
			pa.push(i);
			pb.push(j);
		}
	}
	// the longest increasing run of pb, with predecessors
	const tails: number[] = [];
	const prev = new Int32Array(pb.length);
	for (let p = 0; p < pb.length; p++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pb[tails[mid]!]! < pb[p]!) lo = mid + 1;
			else hi = mid;
		}
		prev[p] = lo > 0 ? tails[lo - 1]! : -1;
		tails[lo] = p;
	}
	const out: Array<[number, number]> = [];
	for (let p = tails.length ? tails[tails.length - 1]! : -1; p >= 0; p = prev[p]!) out.push([pa[p]!, pb[p]!]);
	return out.reverse();
}

/** the script for A[alo..ahi) against B[blo..bhi): the shared head and tail first, then Myers, then (further apart) the range split on its anchors */
function diffRange(A: string[], B: string[], alo: number, ahi: number, blo: number, bhi: number, out: Runs, depth = 0) {
	let head = 0;
	while (alo + head < ahi && blo + head < bhi && A[alo + head] === B[blo + head]) head++;
	out.push(0, alo, blo, head);
	alo += head;
	blo += head;
	let tail = 0;
	while (ahi - tail > alo && bhi - tail > blo && A[ahi - 1 - tail] === B[bhi - 1 - tail]) tail++;
	ahi -= tail;
	bhi -= tail;
	const n = ahi - alo;
	const m = bhi - blo;
	if (n === 0 || m === 0) {
		out.push(2, alo, blo, n);
		out.push(1, ahi, blo, m);
	} else {
		const maxD = Math.min(MAX_EDIT_DISTANCE, Math.floor(MYERS_WORK / (n + m)));
		if (maxD < 1 || !myers(A, B, alo, n, blo, m, maxD, out)) {
			const anchors = depth < MAX_SPLIT_DEPTH ? anchorsOf(A, B, alo, ahi, blo, bhi) : [];
			if (anchors.length === 0) {
				// nothing to split on: the range is replaced whole (a true script, not a minimal one)
				out.push(2, alo, blo, n);
				out.push(1, ahi, blo, m);
			} else {
				let pa = alo;
				let pb = blo;
				for (const [ia, ib] of anchors) {
					diffRange(A, B, pa, ia, pb, ib, out, depth + 1);
					out.push(0, ia, ib, 1);
					pa = ia + 1;
					pb = ib + 1;
				}
				diffRange(A, B, pa, ahi, pb, bhi, out, depth + 1);
			}
		}
	}
	out.push(0, ahi, bhi, tail);
}

/** the changed runs between two shared runs written as the deletions then the additions, as git prints them (Myers interleaves them) */
function grouped(runs: Runs): Runs {
	const out = new Runs();
	const R = runs.t.length;
	for (let i = 0; i < R; ) {
		if (runs.t[i] === 0) {
			out.push(0, runs.a[i]!, runs.b[i]!, runs.n[i]!);
			i++;
			continue;
		}
		const a0 = runs.a[i]!;
		const b0 = runs.b[i]!;
		let del = 0;
		let add = 0;
		for (; i < R && runs.t[i] !== 0; i++) {
			if (runs.t[i] === 2) del += runs.n[i]!;
			else add += runs.n[i]!;
		}
		out.push(2, a0, b0, del);
		out.push(1, a0 + del, b0, add);
	}
	return out;
}

/** a line as the lines of a patch: the marker for a missing final newline follows the line it belongs to */
function unit(sign: string, line: string): string[] {
	return line.endsWith(NO_EOL) ? [sign + line.slice(0, -NO_EOL.length), "\\ No newline at end of file"] : [sign + line];
}

/**
 * the diff of one file from what it held to what it holds now.
 *  - binary on either side is a note with no counts.
 *  - the shared head and tail go first, by bytes and at line boundaries, so a local change costs what the change costs and
 *    nothing for the file around it; a changed region over MIDDLE_MAX_BYTES (both sides together) is not diffed, and the
 *    answer is undefined: counts made up for a change that big would look exact, so there are none.
 *  - a changed region is diffed minimally (Myers) when it is near, split on the lines unique to both sides when it is not,
 *    and a gap that still does not fit is replaced whole (a true patch, its counts match it).
 *  - the patch is cut at PATCH_CAP bytes (CREATED_PATCH_CAP for a file the call created) at a hunk boundary, or inside the
 *    first hunk when that alone is over the cap (its header counting what is kept); no marker in the patch, `truncated`
 *    says so, and the counts keep counting.
 *  - a file that is not valid utf-8 is compared as latin1, so a changed byte is never a no change.
 */
export function fileDiff(file: string, before: Before, afterBytes: Buffer): FileDiffResult | undefined {
	const header = headerOf(file);
	const old = before ?? EMPTY;
	if ((before && isBinary(old)) || isBinary(afterBytes)) return { filediff: { file, patch: `${header}Binary files differ\n`, additions: 0, deletions: 0 }, truncated: false };
	if (old.equals(afterBytes)) return { filediff: { file, patch: "", additions: 0, deletions: 0 }, truncated: false };

	// the shared head, ending after a newline
	const limit = Math.min(old.length, afterBytes.length);
	let p = 0;
	while (p < limit && old[p] === afterBytes[p]) p++;
	p = p === 0 ? 0 : old.lastIndexOf(10, p - 1) + 1;
	// and the shared tail, starting after one
	let s = 0;
	while (s < limit - p && old[old.length - 1 - s] === afterBytes[afterBytes.length - 1 - s]) s++;
	const firstNl = s === 0 ? -1 : old.indexOf(10, old.length - s);
	s = firstNl === -1 ? 0 : old.length - (firstNl + 1);
	const midA = old.subarray(p, old.length - s);
	const midB = afterBytes.subarray(p, afterBytes.length - s);
	if (midA.length + midB.length > MIDDLE_MAX_BYTES) return undefined;

	// the lines of the change and three lines either side of it
	let cs = p;
	for (let i = 0; i < CONTEXT && cs > 0; i++) cs = cs <= 1 ? 0 : old.lastIndexOf(10, cs - 2) + 1;
	const sufStart = old.length - s;
	let ce = sufStart;
	for (let i = 0; i < CONTEXT && ce < old.length; i++) {
		const nl = old.indexOf(10, ce);
		ce = nl === -1 ? old.length : nl + 1;
	}
	const slices = [midA, midB, old.subarray(cs, p), old.subarray(sufStart, ce)];
	let texts: string[];
	try {
		texts = slices.map((b) => STRICT_UTF8.decode(b));
	} catch {
		texts = slices.map((b) => b.toString("latin1"));
	}
	const pre = linesOf(texts[2]!);
	const suf = linesOf(texts[3]!);
	const A = [...pre, ...linesOf(texts[0]!), ...suf];
	const B = [...pre, ...linesOf(texts[1]!), ...suf];
	// lines before the first one of A and B
	let base = 0;
	for (let i = old.indexOf(10); i !== -1 && i < cs; i = old.indexOf(10, i + 1)) base++;

	const raw = new Runs();
	diffRange(A, B, 0, A.length, 0, B.length, raw);
	const runs = grouped(raw);
	let additions = 0;
	let deletions = 0;
	for (let i = 0; i < runs.t.length; i++) {
		if (runs.t[i] === 1) additions += runs.n[i]!;
		else if (runs.t[i] === 2) deletions += runs.n[i]!;
	}
	if (additions === 0 && deletions === 0) return { filediff: { file, patch: "", additions, deletions }, truncated: false };

	// hunks: each change with CONTEXT lines either side, hunks that touch merged; stops adding lines when the cap is reached
	const cap = before === null ? CREATED_PATCH_CAP : PATCH_CAP;
	const out: string[] = [];
	let used = header.length;
	let truncated = false;
	const flush = (ia: number, ib: number, units: string[][]) => {
		let ac = 0;
		let bc = 0;
		let changed = false;
		const body: string[] = [];
		for (const u of units) {
			const sign = u[0]![0];
			if (sign !== "+") ac++;
			if (sign !== "-") bc++;
			if (sign !== " ") changed = true;
			body.push(...u);
		}
		if (!changed) return;
		out.push(`@@ -${ac === 0 ? base + ia : base + ia + 1},${ac} +${bc === 0 ? base + ib : base + ib + 1},${bc} @@`, ...body);
	};
	const R = runs.t.length;
	let i = 0;
	while (i < R && !truncated) {
		if (runs.t[i] === 0) {
			i++;
			continue;
		}
		const lead = i > 0 && runs.t[i - 1] === 0 ? Math.min(CONTEXT, runs.n[i - 1]!) : 0;
		const ia = runs.a[i]! - lead;
		const ib = runs.b[i]! - lead;
		const units: string[][] = [];
		used += HUNK_HEADER_BYTES;
		const add = (sign: string, line: string): boolean => {
			const u = unit(sign, line);
			const bytes = u.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
			if (used + bytes > cap) {
				truncated = true;
				// the patch ends at a hunk boundary; only a first hunk bigger than the whole cap is cut inside (the header then counts what is kept)
				if (out.length > 0) units.length = 0;
				return false;
			}
			used += bytes;
			units.push(u);
			return true;
		};
		for (let l = lead; l > 0 && !truncated; l--) add(" ", A[runs.a[i]! - l]!);
		let j = i;
		while (j < R && !truncated) {
			const t = runs.t[j]!;
			const last = j === R - 1;
			if (t === 0) {
				const apart = last || runs.n[j]! > 2 * CONTEXT;
				const take = apart ? Math.min(CONTEXT, runs.n[j]!) : runs.n[j]!;
				for (let k = 0; k < take && add(" ", A[runs.a[j]! + k]!); k++);
				j++;
				if (apart) break;
			} else {
				for (let k = 0; k < runs.n[j]! && add(t === 1 ? "+" : "-", (t === 1 ? B : A)[(t === 1 ? runs.b[j]! : runs.a[j]!) + k]!); k++);
				j++;
			}
		}
		flush(ia, ib, units);
		i = j;
	}
	return { filediff: { file, patch: out.length ? `${header}${out.join("\n")}\n` : "", additions, deletions }, truncated };
}

/** what a file holds now, before a write replaces it: see Before; undefined when it cannot be read, or is too big to hold (no diff is taken) */
export function snapshot(abs: string): Before | undefined {
	try {
		if (!existsSync(abs)) return null;
		const st = statSync(abs);
		if (!st.isFile()) return null;
		return st.size > DIFF_MAX_BYTES ? undefined : readFileSync(abs);
	} catch {
		return undefined;
	}
}

/** the diff of a file as it is on disk now against `before`; undefined for a file too big to read whole (see fileDiff for a change too big to diff) */
export function diffOnDisk(abs: string, before: Before): FileDiffResult | undefined {
	if (statSync(abs).size > DIFF_MAX_BYTES) return undefined;
	return fileDiff(abs, before, readFileSync(abs));
}
