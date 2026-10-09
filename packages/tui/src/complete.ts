import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

export interface CommandEntry {
	name: string;
	description?: string;
}

/**
 * `/` at the start completes commands (the tui's own, then the daemon's command files and skills);
 * `@` anywhere completes a path in the session's directory through the daemon's file finder.
 */
export class Completer implements AutocompleteProvider {
	triggerCharacters = ["@"];

	constructor(
		private readonly commands: () => CommandEntry[],
		private readonly findFiles: (query: string, signal: AbortSignal) => Promise<string[]>,
	) {}

	async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (cursorLine === 0 && /^\/\S*$/.test(before)) {
			const q = before.slice(1).toLowerCase();
			const items: AutocompleteItem[] = this.commands()
				.filter((c) => c.name.toLowerCase().startsWith(q) || (q.length > 1 && c.name.toLowerCase().includes(q)))
				.slice(0, 40)
				.map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, ...(c.description ? { description: c.description } : {}) }));
			return items.length ? { items, prefix: before } : null;
		}
		const at = before.match(/(?:^|\s)@([^\s@]*)$/);
		if (at) {
			const q = at[1] ?? "";
			const paths = await this.findFiles(q, options.signal).catch(() => [] as string[]);
			if (options.signal.aborted || !paths.length) return null;
			return { items: paths.map((p) => ({ value: `@${p}`, label: p })), prefix: `@${q}` };
		}
		return null;
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		const line = lines[cursorLine] ?? "";
		const start = cursorCol - prefix.length;
		const insert = item.value.endsWith("/") ? item.value : `${item.value} `;
		const next = [...lines];
		next[cursorLine] = line.slice(0, start) + insert + line.slice(cursorCol);
		return { lines: next, cursorLine, cursorCol: start + insert.length };
	}
}
