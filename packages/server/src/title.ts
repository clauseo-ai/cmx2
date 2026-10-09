import type { Config } from "@cmx2/engine/config";
import { generateTitle } from "@cmx2/engine/title";
import type { Store } from "@cmx2/store";

/** the title a session gets at create when nobody named it; only these are ever replaced */
export function defaultTitle(createdAt: number): string {
	return `new session ${new Date(createdAt).toISOString()}`;
}

export function isDefaultTitle(title: string): boolean {
	return /^new session \d{4}-\d{2}-\d{2}T/.test(title) || title === "untitled";
}

/**
 * generated titles: after the first user message of a top-level session, one small request names it.
 * a title given at create or by a rename is never replaced; the compare-and-set in the store makes a
 * rename that lands while the title request runs win.
 */
export class Titles {
	private readonly running = new Set<string>();

	constructor(
		private readonly deps: {
			store: Store;
			configFor: (directory: string) => Config;
			/** the new title is on the session row; tell clients and the live session */
			onTitle: (id: string, title: string, model: string, cost: number) => void;
		},
	) {}

	maybe(id: string, text: string): Promise<void> | undefined {
		const row = this.deps.store.session(id);
		if (!row || row.parent_id || row.source === "cmx" || row.archived_at || !isDefaultTitle(row.title) || this.running.has(id) || !text.trim()) return undefined;
		this.running.add(id);
		const expected = row.title;
		return generateTitle(this.deps.configFor(row.directory), { text, sessionModel: row.model })
			.then((t) => {
				if (!t) {
					console.error(`cmx2: no title for ${id}: every title model failed`);
					return;
				}
				if (!this.deps.store.setGeneratedTitle(id, t.title, expected)) return;
				this.deps.store.addSessionCost(id, t.cost);
				this.deps.onTitle(id, t.title, t.model, t.cost);
			})
			.catch((e) => console.error(`cmx2: title for ${id} failed: ${e instanceof Error ? e.message : String(e)}`))
			.finally(() => this.running.delete(id));
	}
}
