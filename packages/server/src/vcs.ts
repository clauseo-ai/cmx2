import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * git, read-only, for clients: the branch and a dirty flag on each session row (cached per directory,
 * dropped when a turn ends or a file is edited) and the working tree's status with line counts.
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

export class VcsCache {
	private cache = new Map<string, { at: number; vcs: Vcs | null }>();

	/** the branch and dirty flag for a directory, or nothing when it is not in a git work tree */
	of(dir: string): Vcs | undefined {
		const hit = this.cache.get(dir);
		if (hit && Date.now() - hit.at < FRESH_MS) return hit.vcs ?? undefined;
		let vcs: Vcs | null = null;
		if (existsSync(dir)) {
			// porcelain v2 with --branch names the head even on an unborn branch; any other line is a change
			const out = git(dir, ["status", "--porcelain=v2", "--branch"]);
			if (out !== undefined) {
				const lines = out.split("\n").filter(Boolean);
				const head = lines.find((l) => l.startsWith("# branch.head "))?.slice("# branch.head ".length) ?? "HEAD";
				const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length);
				vcs = { branch: head === "(detached)" ? `detached at ${oid?.slice(0, 7) ?? "?"}` : head, dirty: lines.some((l) => !l.startsWith("#")) };
			}
		}
		this.cache.set(dir, { at: Date.now(), vcs });
		return vcs ?? undefined;
	}

	/** drops what is known about a directory (a turn ended, a file changed); the next read asks git again */
	forget(dir: string) {
		this.cache.delete(dir);
	}
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
