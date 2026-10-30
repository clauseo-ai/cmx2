import type { Config } from "@cmx2/engine/config";
import { type GeneratedTitle, generateTitle } from "@cmx2/engine/title";
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

	/**
	 * a new title for a session from what it is about now, asked for by a client: the same structured
	 * request, over the session's first user message and its latest text. it replaces any title, given or
	 * generated. undefined when the session is read-only history or every title model failed.
	 */
	async regenerate(id: string, signal?: AbortSignal): Promise<GeneratedTitle | undefined> {
		const row = this.deps.store.session(id);
		if (!row || row.source === "cmx") return undefined;
		const text = digest(this.deps.store, id);
		if (!text) return undefined;
		const t = await generateTitle(this.deps.configFor(row.directory), { text, sessionModel: row.model, ...(signal ? { signal } : {}) });
		if (!t || !this.deps.store.setSessionTitle(id, t.title)) return undefined;
		this.deps.store.addSessionCost(id, t.cost);
		this.deps.onTitle(id, t.title, t.model, t.cost);
		return t;
	}
}

/** what a session is about, for a title: its first user message, then its latest user and assistant text, newest kept, within `max` characters */
export function digest(store: Store, id: string, max = 4000): string {
	const textOf = (parts: Array<{ type: string; data: string }>) =>
		parts
			.filter((p) => p.type === "text")
			.map((p) => {
				try {
					const d = JSON.parse(p.data);
					return d.synthetic || typeof d.text !== "string" ? "" : d.text;
				} catch {
					return "";
				}
			})
			.join("\n")
			.trim();
	const recent = store.messages(id, { limit: 40 }).rows;
	const firstUser = store.firstMessage(id, "user");
	const head = firstUser ? `first message:\n${textOf(firstUser.parts).slice(0, 1500)}` : "";
	const tail: string[] = [];
	let room = max - head.length;
	for (let i = recent.length - 1; i >= 0 && room > 0; i--) {
		const m = recent[i]!;
		if (m.id === firstUser?.id) continue;
		const t = textOf(m.parts);
		if (!t) continue;
		const line = `${m.role}: ${t}`.slice(0, room);
		tail.unshift(line);
		room -= line.length + 1;
	}
	return [head, tail.length ? `latest:\n${tail.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
