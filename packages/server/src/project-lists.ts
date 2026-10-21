import type { WorktreeInfo } from "@cmx2/worktrees";

/** how long an unknown answer (git timed out) is kept, so a hung git is not asked again on every read */
const UNKNOWN_MS = 5_000;

/**
 * each project's checkouts, as /project lists them. read with git off the event loop the first time a
 * project is asked about, then kept until something that publishes project.updated (a checkout made,
 * merged or discarded, a project opened) drops or replaces it. one read per project at a time. a read
 * that returns undefined (git timed out) answers an empty list and is kept only briefly.
 */
export class ProjectLists {
	private lists = new Map<string, { list: WorktreeInfo[]; until?: number }>();
	private reading = new Map<string, { gen: number; done: Promise<WorktreeInfo[] | undefined> }>();
	private gen = new Map<string, number>();

	constructor(private read: (project: string) => Promise<WorktreeInfo[] | undefined>) {}

	/** what is kept for a project, without reading */
	peek(project: string): WorktreeInfo[] | undefined {
		const have = this.lists.get(project);
		if (!have) return undefined;
		if (have.until !== undefined && Date.now() > have.until) {
			this.lists.delete(project);
			return undefined;
		}
		return have.list;
	}

	async of(project: string): Promise<WorktreeInfo[]> {
		for (;;) {
			const have = this.peek(project);
			if (have) return have;
			const gen = this.gen.get(project) ?? 0;
			let r = this.reading.get(project);
			if (!r || r.gen !== gen) {
				const done = this.read(project);
				r = { gen, done };
				this.reading.set(project, r);
				void done
					.then((list) => {
						// a checkout changed while git read: what it saw may be old, so it is not kept
						if ((this.gen.get(project) ?? 0) === gen) this.lists.set(project, list ? { list } : { list: [], until: Date.now() + UNKNOWN_MS });
					})
					.finally(() => {
						if (this.reading.get(project)?.done === done) this.reading.delete(project);
					});
			}
			const list = await r.done;
			if ((this.gen.get(project) ?? 0) === gen) return list ?? [];
		}
	}

	/** a list read just now, synchronously, by whoever changed the checkouts */
	set(project: string, list: WorktreeInfo[]) {
		this.gen.set(project, (this.gen.get(project) ?? 0) + 1);
		this.lists.set(project, { list });
	}

	forget(project: string) {
		this.gen.set(project, (this.gen.get(project) ?? 0) + 1);
		this.lists.delete(project);
	}
}
