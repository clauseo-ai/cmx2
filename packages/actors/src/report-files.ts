import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * every helper report, saved in full as a file the parent's report names, so the deliverable has a handle an
 * agent can read and pass on (spawn or message with files) instead of retyping it. the transcript stays the
 * truth; these are copies, so they are pruned: oldest first, once the files together pass a byte cap or a
 * count cap. the daemon's Actors owns them, under `<data dir>/reports/<root session id>/<child id>-<turn end>.md`.
 */

/** the bytes all report files may take together before the oldest go */
export const REPORT_FILES_MAX_BYTES = 64 * 1024 * 1024;
/** the files kept at most, whatever their size */
export const REPORT_FILES_MAX_COUNT = 5_000;

interface Entry {
	path: string;
	size: number;
	mtime: number;
}

export class ReportFiles {
	/** oldest first; read from disk on first use */
	private entries: Entry[] | undefined;
	private bytes = 0;

	constructor(
		readonly dir: string,
		private readonly maxBytes = REPORT_FILES_MAX_BYTES,
		private readonly maxCount = REPORT_FILES_MAX_COUNT,
	) {}

	/** the directory one tree's reports go in; agents in that tree may read it */
	treeDir(rootID: string): string {
		return join(this.dir, safe(rootID));
	}

	/** saves one report and returns its path; the oldest files go when the caps are passed, never the one just written */
	write(rootID: string, childID: string, seq: number, text: string): string {
		const dir = this.treeDir(rootID);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${safe(childID)}-${seq}.md`);
		const entries = this.load();
		const old = entries.findIndex((e) => e.path === path);
		if (old !== -1) {
			this.bytes -= entries[old]!.size;
			entries.splice(old, 1);
		}
		writeFileSync(path, text);
		const size = Buffer.byteLength(text);
		entries.push({ path, size, mtime: Date.now() });
		this.bytes += size;
		this.evict(path);
		return path;
	}

	/** what the files take now, for tests and the memory page */
	usage(): { files: number; bytes: number } {
		const entries = this.load();
		return { files: entries.length, bytes: this.bytes };
	}

	private evict(keep: string) {
		const entries = this.load();
		while ((this.bytes > this.maxBytes || entries.length > this.maxCount) && entries.length > 1) {
			const i = entries[0]!.path === keep ? 1 : 0;
			const [gone] = entries.splice(i, 1);
			this.bytes -= gone!.size;
			try {
				unlinkSync(gone!.path);
			} catch {}
			try {
				// an emptied tree directory goes too; one that still holds files refuses
				rmdirSync(join(gone!.path, ".."));
			} catch {}
		}
	}

	private load(): Entry[] {
		if (this.entries) return this.entries;
		const out: Entry[] = [];
		let trees: string[] = [];
		try {
			trees = readdirSync(this.dir);
		} catch {}
		for (const t of trees) {
			let names: string[] = [];
			try {
				names = readdirSync(join(this.dir, t));
			} catch {
				continue;
			}
			for (const n of names) {
				const path = join(this.dir, t, n);
				try {
					const s = statSync(path);
					if (s.isFile()) out.push({ path, size: s.size, mtime: s.mtimeMs });
				} catch {}
			}
		}
		out.sort((a, b) => a.mtime - b.mtime);
		this.entries = out;
		this.bytes = out.reduce((n, e) => n + e.size, 0);
		return out;
	}
}

/** ids are ses_<hex>; anything else is made safe for a file name */
function safe(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
