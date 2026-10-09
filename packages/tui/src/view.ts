import type { Part, ToolPart } from "@cmx2/client";
import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { partWords, statusLine, toolLine } from "./format.ts";
import type { Message, State } from "./state.ts";
import type { Theme } from "./theme.ts";

/** the conversation: your messages, the model's markdown, tool calls one line each, reasoning folded */
export class TranscriptView implements Component {
	/** reasoning shows in full when true (the /thinking command flips it) */
	showReasoning = false;
	private md = new Map<string, { text: string; view: Markdown }>();

	constructor(
		private readonly state: State,
		private readonly theme: Theme,
		private readonly header: () => string[],
	) {}

	invalidate() {
		for (const m of this.md.values()) m.view.invalidate();
	}

	private markdown(id: string, text: string): Markdown {
		let entry = this.md.get(id);
		if (!entry) {
			entry = { text, view: new Markdown(text, 0, 0, this.theme.markdown, { color: this.theme.fg.text }) };
			this.md.set(id, entry);
		} else if (entry.text !== text) {
			entry.text = text;
			entry.view.setText(text);
		}
		return entry.view;
	}

	private userLines(m: Message, width: number): string[] {
		const t = this.theme;
		const text = m.parts
			.filter((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic)
			.map((p) => (p as { text: string }).text)
			.join("\n")
			.trim();
		const files = m.parts.filter((p) => p.type === "file").map((p) => `[${(p as { filename?: string }).filename ?? "file"}]`);
		const label = m.info.queued ? t.fg.warn(m.info.clientID && this.state.steers.has(m.info.clientID) ? "steering " : "queued ") : "";
		const body = [text, files.join(" ")].filter(Boolean).join(" ");
		if (!body) return [];
		const marker = t.fg.user("› ");
		return wrapTextWithAnsi(`${label}${t.fg.user(body)}`, Math.max(8, width - 2)).map((l, i) => truncateToWidth(`${i === 0 ? marker : "  "}${l}`, width));
	}

	private partLines(p: Part, width: number): string[] {
		const t = this.theme;
		if (p.type === "text") {
			const text = (p as { text: string }).text;
			if (!text.trim() || (p as { synthetic?: boolean }).synthetic) return [];
			return this.markdown(p.id, text).render(width);
		}
		if (p.type === "reasoning") {
			const words = partWords(p);
			if (!words) return [];
			if (!this.showReasoning) return [truncateToWidth(t.dim(t.italic(`thinking, ${words} words (/thinking shows it)`)), width)];
			return wrapTextWithAnsi(t.dim(t.italic((p as { text: string }).text.trim())), width);
		}
		if (p.type === "tool") return toolLine(p as ToolPart, t, width);
		if (p.type === "file") return [truncateToWidth(t.dim(`[${(p as { filename?: string }).filename ?? "file"}]`), width)];
		return [];
	}

	render(width: number): string[] {
		const out: string[] = this.header().flatMap((l) => wrapTextWithAnsi(l, width));
		// prompts still waiting behind the turn read below it, where they will run
		const ordered = [...this.state.messages.filter((m) => !m.info.queued), ...this.state.messages.filter((m) => m.info.queued)];
		for (const m of ordered) {
			const lines = m.info.role === "user" ? this.userLines(m, width) : m.parts.flatMap((p) => this.partLines(p, width));
			if (!lines.length) continue;
			out.push("", ...lines);
			const err = (m.info as { error?: { data?: { message?: string } } }).error?.data?.message;
			if (m.info.role === "assistant" && err) out.push(truncateToWidth(this.theme.fg.error(`the turn failed: ${err}`), width));
		}
		const t = this.theme;
		for (const n of this.state.notices.slice(-3)) out.push(truncateToWidth(t.fg.warn(n), width));
		if (this.state.error && !this.state.messages.some((m) => (m.info as { error?: { data?: { message?: string } } }).error?.data?.message === this.state.error)) out.push(truncateToWidth(t.fg.error(this.state.error), width));
		out.push("");
		return out;
	}
}

/** one line: model, effort, agent, state, context, cost; plus a transient hint when there is one */
export class StatusBar implements Component {
	hint = "";
	constructor(
		private readonly state: State,
		private readonly theme: Theme,
	) {}
	invalidate() {}
	render(width: number): string[] {
		const lines = [statusLine(this.state, this.theme, width)];
		if (this.hint) lines.push(...wrapTextWithAnsi(this.theme.fg.warn(this.hint), width).slice(0, 3));
		return lines;
	}
}
