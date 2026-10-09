import type { Part, ToolPart } from "@cmx2/client";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Agent, oneLine, type State } from "./state.ts";
import type { Theme } from "./theme.ts";

/** 1234 → 1.2k, 1234567 → 1.2m */
export function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

export function seconds(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** the argument worth showing for a tool call: the command, the path, the pattern */
export function toolSubject(part: ToolPart): string {
	const input = (part.state.input ?? {}) as Record<string, unknown>;
	const qs = input.questions;
	if (Array.isArray(qs) && typeof qs[0]?.question === "string") return oneLine(qs[0].question, 200);
	for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "brief", "name", "code"]) {
		const v = input[key];
		if (typeof v === "string" && v.trim()) return oneLine(v, 200);
	}
	const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
	return first ? oneLine(first, 200) : "";
}

/** one compact line per tool call: a status mark, the tool, what it touched, and how it ended */
export function toolLine(part: ToolPart, theme: Theme, width: number): string[] {
	const st = part.state;
	const mark = st.status === "completed" ? theme.fg.ok("✓") : st.status === "error" ? theme.fg.error("✗") : theme.fg.warn("…");
	const t = st.time as { start?: number | null; end?: number } | undefined;
	const took = t?.start && t.end ? theme.dim(` ${seconds(t.end - t.start)}`) : "";
	const head = `${mark} ${theme.fg.tool(part.tool)} ${theme.dim(toolSubject(part))}`;
	const lines = [truncateToWidth(`${head}${took}`, width)];
	if (st.status === "error") lines.push(truncateToWidth(`  ${theme.fg.error(oneLine(String(st.error), 300))}`, width));
	else if (st.status === "running") {
		const out = (st.metadata as { output?: unknown } | undefined)?.output;
		if (typeof out === "string" && out.trim()) {
			const last = out.trimEnd().split("\n").pop() ?? "";
			lines.push(truncateToWidth(`  ${theme.dim(oneLine(last, 300))}`, width));
		}
	}
	return lines;
}

export function partWords(part: Part): number {
	const text = (part as { text?: string }).text ?? "";
	return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function statusWord(s: State): string {
	const st = s.status;
	if (st.type === "busy") return st.queued ? `working, ${st.queued} waiting` : "working";
	if (st.type === "retry") return `retry ${st.attempt}: ${st.message}`;
	if (st.parked) return `parked on ${[st.parked.agents ? `${st.parked.agents} agent${st.parked.agents === 1 ? "" : "s"}` : "", st.parked.jobs ? `${st.parked.jobs} job${st.parked.jobs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}`;
	return "idle";
}

/**
 * the line under the composer: model, effort, agent and state, then context and cost when there is
 * room. it drops items from the right before it truncates, so a 64 column terminal keeps the state.
 */
export function statusLine(s: State, theme: Theme, width: number): string {
	const model = s.model ? s.model.slice(s.model.indexOf("/") + 1) : "default model";
	const stateColor = s.status.type === "busy" ? theme.fg.accent : s.status.type === "retry" ? theme.fg.warn : theme.dim;
	const items = [theme.fg.text(model), theme.fg.tool(s.effort ?? "effort default"), theme.fg.user(s.agent ?? "build"), stateColor(statusWord(s))];
	const extra: string[] = [];
	if (s.context) extra.push(theme.dim(`context ${compact(s.context)}`));
	if (s.cost) extra.push(theme.dim(`$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}`));
	const working = s.agents.size ? [...s.agents.values()].filter((a) => a.state === "working" || a.state === "queued").length : 0;
	if (s.agents.size) extra.push(theme.dim(`agents ${working}/${s.agents.size}`));
	const sep = theme.dim(" · ");
	let line = [...items, ...extra].join(sep);
	while (visibleWidth(line) > width && extra.length) {
		extra.pop();
		line = [...items, ...extra].join(sep);
	}
	return truncateToWidth(line, width);
}

const STATE_MARK: Record<Agent["state"], string> = { queued: "○", working: "●", parked: "◐", interrupted: "◌", closed: "·" };

/** the agent tree, indented by depth under the session, children after their parent */
export function agentTree(s: State, theme: Theme, width: number): string[] {
	if (!s.agents.size) return [theme.dim("no agents yet. ask for a subagent and it shows up here.")];
	const all = [...s.agents.values()];
	const byParent = new Map<string | null, Agent[]>();
	for (const a of all) {
		const parent = a.parentID && s.agents.has(a.parentID) ? a.parentID : null;
		byParent.set(parent, [...(byParent.get(parent) ?? []), a]);
	}
	const out: string[] = [];
	const color = (a: Agent) => (a.state === "working" ? theme.fg.accent : a.state === "queued" ? theme.fg.warn : a.state === "interrupted" ? theme.fg.error : a.state === "parked" ? theme.fg.ok : theme.dim);
	const walk = (parent: string | null, depth: number) => {
		for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.path.localeCompare(y.path))) {
			const pad = "  ".repeat(depth);
			const seat = [a.seat !== a.name ? a.seat : null, a.model?.slice(a.model.indexOf("/") + 1), a.effort].filter(Boolean).join(" ");
			out.push(truncateToWidth(`${pad}${color(a)(STATE_MARK[a.state])} ${theme.bold(a.name)} ${color(a)(a.state)}${seat ? theme.dim(` ${seat}`) : ""}${a.tokens ? theme.dim(` ${compact(a.tokens)} tok`) : ""}`, width));
			const note = a.state === "working" ? a.lastTask : (a.lastReport ?? a.lastTask);
			if (note) out.push(truncateToWidth(`${pad}  ${theme.dim(oneLine(note, 400))}`, width));
			walk(a.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" };

/** the image type a path's extension names, for files typed or dropped into the prompt; the daemon converts heic to jpeg */
export function imageMimeOfPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? undefined : IMAGE_EXT[path.slice(dot).toLowerCase()];
}
