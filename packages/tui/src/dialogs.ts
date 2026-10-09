import type { PermissionRequest, QuestionRequest } from "@cmx2/client";
import { type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "./theme.ts";

/** a titled frame around lines and an optional interactive child; the base of every dialog */
export class Panel implements Component, Focusable {
	private _focused = false;
	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		if (this.child && "focused" in this.child) (this.child as Component & Focusable).focused = v;
	}

	constructor(
		protected readonly theme: Theme,
		public title: string,
		public body: () => string[],
		public child?: Component,
		public footer = "",
	) {}

	invalidate() {
		this.child?.invalidate();
	}

	handleInput(data: string) {
		this.child?.handleInput?.(data);
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const b = t.fg.border;
		const title = ` ${t.fg.accent(t.bold(this.title))} `;
		const top = b("╭─") + title + b("─".repeat(Math.max(0, width - 3 - visibleWidth(title)))) + b("╮");
		const row = (l: string) => {
			const s = truncateToWidth(l, inner);
			return `${b("│")} ${s}${" ".repeat(Math.max(0, inner - visibleWidth(s)))} ${b("│")}`;
		};
		const lines = [top];
		for (const l of this.body()) for (const w of wrapTextWithAnsi(l, inner)) lines.push(row(w));
		if (this.child) {
			if (lines.length > 1) lines.push(row(""));
			for (const l of this.child.render(inner)) lines.push(row(l));
		}
		if (this.footer) lines.push(row(t.dim(this.footer)));
		lines.push(b(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines;
	}
}

/**
 * the efforts the effort picker offers: the model's own variants as the daemon lists them (it leaves out
 * what routing.jsonc forbids), so an empty list stays empty. the five rungs are only for a model the
 * catalog does not know yet.
 */
export function effortsFor(
	providers: { providers: Array<{ id: string; models: Record<string, { variants?: Record<string, unknown> }> }> } | undefined,
	model: string | undefined,
	all: readonly string[],
): string[] {
	if (!model) return [...all];
	const slash = model.indexOf("/");
	const m = providers?.providers.find((p) => p.id === model.slice(0, slash))?.models[model.slice(slash + 1)];
	return m ? Object.keys(m.variants ?? {}) : [...all];
}

/** items that contain the filter first, in their order, then fuzzy matches */
export function narrow(items: SelectItem[], filter: string): SelectItem[] {
	const q = filter.trim().toLowerCase();
	if (!q) return items;
	const text = (i: SelectItem) => `${i.label} ${i.description ?? ""}`.toLowerCase();
	const direct = items.filter((i) => text(i).includes(q));
	const fuzzy = fuzzyFilter(items, q, text).filter((i) => !direct.includes(i));
	return [...direct, ...fuzzy];
}

/** a list you can narrow by typing; enter picks, esc closes */
export class Picker extends Panel {
	list: SelectList;
	private filter = "";
	onPick?: (item: SelectItem) => void;
	onClose?: () => void;

	constructor(
		theme: Theme,
		title: string,
		private readonly items: SelectItem[],
		opts: { selected?: string; note?: () => string[] } = {},
	) {
		super(theme, title, () => [], undefined, "type to filter · enter picks · esc closes");
		this.body = () => [...(opts.note?.() ?? []), ...(this.filter ? [theme.dim(`filter: ${this.filter}`)] : [])];
		this.list = this.build(items);
		const at = items.findIndex((i) => i.value === opts.selected);
		if (at >= 0) this.list.setSelectedIndex(at);
	}

	private build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 12, this.theme.select, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 });
		list.onSelect = (item) => this.onPick?.(item);
		list.onCancel = () => this.onClose?.();
		this.child = items.length ? list : { render: () => [this.theme.fg.warn(`nothing matches ${this.filter}`)], invalidate() {} };
		return list;
	}

	private refilter() {
		this.list = this.build(narrow(this.items, this.filter));
	}

	override handleInput(data: string) {
		if (matchesKey(data, Key.backspace)) {
			this.filter = this.filter.slice(0, -1);
			this.refilter();
			return;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.filter += data;
			this.refilter();
			return;
		}
		if (matchesKey(data, Key.escape) || this.list.getSelectedItem() || !matchesKey(data, Key.enter)) this.list.handleInput(data);
	}
}

export type PermissionReply = "once" | "always" | "reject";

/** a tool call waiting on you: what it wants to touch, and once, always or no */
export class PermissionDialog extends Panel {
	onReply?: (reply: PermissionReply) => void;
	readonly list: SelectList;

	constructor(
		theme: Theme,
		readonly ask: PermissionRequest,
		label: string,
	) {
		const always = ask.always.length ? ask.always.join(", ") : ask.patterns.join(", ");
		const list = new SelectList(
			[
				{ value: "once", label: "allow once" },
				{ value: "always", label: "always allow", description: always },
				{ value: "reject", label: "no", description: "the model reads that you said no" },
			],
			3,
			theme.select,
		);
		super(
			theme,
			`${label} wants to ${ask.permission}`,
			() => [...ask.patterns.map((p) => theme.fg.text(p)), ...(typeof ask.metadata?.description === "string" ? [theme.dim(ask.metadata.description as string)] : [])],
			list,
			"enter answers · esc says no",
		);
		this.list = list;
		list.onSelect = (item) => this.onReply?.(item.value as PermissionReply);
		list.onCancel = () => this.onReply?.("reject");
	}
}

const OWN = "\u0000own";

/** the model's question tool: pick an option or type your own answer, one question after another */
export class QuestionDialog extends Panel {
	private index = 0;
	private answers: string[][] = [];
	private typing?: Input;
	private chosen = new Set<string>();
	private list!: SelectList;
	onAnswer?: (answers: string[][]) => void;
	onDismiss?: () => void;

	constructor(
		theme: Theme,
		readonly ask: QuestionRequest,
		label: string,
	) {
		super(theme, `${label} asks`, () => this.lines(), undefined, "");
		this.show();
	}

	private get q() {
		return this.ask.questions[this.index]!;
	}

	private lines(): string[] {
		const t = this.theme;
		const n = this.ask.questions.length;
		return [...(n > 1 ? [t.dim(`question ${this.index + 1} of ${n}`)] : []), ...(this.q.header ? [t.bold(this.q.header)] : []), t.fg.text(this.q.question), ...(this.chosen.size ? [t.dim(`picked: ${[...this.chosen].join(", ")}`)] : [])];
	}

	private show() {
		const items: SelectItem[] = this.q.options.map((o) => ({ value: o.label, label: o.label, ...(o.description ? { description: o.description } : {}) }));
		items.push({ value: OWN, label: "type my own answer" });
		this.list = new SelectList(items, 8, this.theme.select);
		this.list.onSelect = (item) => {
			if (item.value === OWN) {
				this.typing = new Input();
				this.typing.focused = this.focused;
				this.typing.onSubmit = (v) => {
					if (!v.trim()) return;
					this.next([...this.chosen, v.trim()]);
				};
				this.child = this.typing;
				this.footer = "enter sends · esc goes back";
				return;
			}
			if (this.q.multiple) {
				if (this.chosen.has(item.value)) this.chosen.delete(item.value);
				else this.chosen.add(item.value);
				return;
			}
			this.next([item.value]);
		};
		this.list.onCancel = () => this.onDismiss?.();
		this.child = this.list;
		this.footer = this.q.multiple ? "enter toggles · tab sends the picks · esc dismisses" : "enter picks · esc dismisses";
	}

	private next(answer: string[]) {
		this.answers.push(answer);
		this.chosen = new Set();
		this.typing = undefined;
		if (this.index + 1 >= this.ask.questions.length) return this.onAnswer?.(this.answers);
		this.index++;
		this.show();
	}

	override handleInput(data: string) {
		if (this.typing) {
			if (matchesKey(data, Key.escape)) {
				this.typing = undefined;
				this.show();
				return;
			}
			this.typing.handleInput(data);
			return;
		}
		if (this.q.multiple && matchesKey(data, Key.tab) && this.chosen.size) return this.next([...this.chosen]);
		this.list.handleInput(data);
	}
}

/** a read-only panel that redraws from a function (the agent tree); esc closes */
export class InfoPanel extends Panel {
	onClose?: () => void;
	override handleInput(data: string) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("t"))) this.onClose?.();
	}
}
