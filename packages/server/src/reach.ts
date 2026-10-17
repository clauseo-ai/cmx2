/**
 * the first touch of a session's directory, off the main thread. macOS holds the first access to a
 * protected folder (Desktop, Documents, Downloads, network and removable volumes) until someone answers
 * its privacy prompt, and a hung network mount holds it for good; a sync call there would stop every
 * session and route. so the first access is async (bun runs it on its threadpool), the session that needs
 * the directory waits for it, and once it settles, allowed or denied, sync access is fine again: a prompt
 * only blocks while it is pending. nothing times out; the work goes on when access arrives.
 */

export const SLOW_MS = 2000;

/** what a waiting session shows, plain and lowercase */
export function waitingText(dir: string, platform: string = process.platform): string {
	return platform === "darwin" ? `waiting for access to ${dir}. macos may be asking on the mac` : `waiting for access to ${dir}. the file system is not answering`;
}

export interface ReachOptions {
	/** the first access: async reads of whatever the sync paths read next. its errors are swallowed (a denied read settles too) */
	probe: (dir: string) => Promise<void>;
	/** how long a probe runs before it counts as slow */
	slowMs?: number;
	/** a probe has run past `slowMs` */
	onSlow?: (dir: string) => void;
	/** a probe settled; `slow` when it had passed `slowMs` */
	onSettled?: (dir: string, ms: number, slow: boolean) => void;
}

export class Reach {
	private readonly settled = new Set<string>();
	private readonly pending = new Map<string, { since: number; slow: boolean; done: Promise<void> }>();

	constructor(private readonly opts: ReachOptions) {}

	/** the first access settled: sync reads of this directory no longer wait on a prompt */
	ready(dir: string): boolean {
		return this.settled.has(dir);
	}

	/** a probe has run past the slow mark and is still waiting */
	slow(dir: string): boolean {
		return this.pending.get(dir)?.slow ?? false;
	}

	/** when the probe still waiting for this directory started */
	since(dir: string): number | undefined {
		return this.pending.get(dir)?.since;
	}

	/** resolves once the directory's first access settled; one probe per directory, shared by every caller */
	wait(dir: string): Promise<void> {
		if (this.settled.has(dir)) return Promise.resolve();
		const running = this.pending.get(dir);
		if (running) return running.done;
		const since = Date.now();
		const entry = { since, slow: false, done: Promise.resolve() };
		const timer = setTimeout(() => {
			entry.slow = true;
			this.opts.onSlow?.(dir);
		}, this.opts.slowMs ?? SLOW_MS);
		entry.done = Promise.resolve()
			.then(() => this.opts.probe(dir))
			.catch(() => {})
			.finally(() => {
				clearTimeout(timer);
				this.settled.add(dir);
				this.pending.delete(dir);
				this.opts.onSettled?.(dir, Date.now() - since, entry.slow);
			});
		this.pending.set(dir, entry);
		return entry.done;
	}
}
