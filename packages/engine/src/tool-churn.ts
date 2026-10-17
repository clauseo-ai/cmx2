import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * anthropic refuses a request whose transcript holds more than 512 tool additions in all. a session that
 * loads many tools from a server that drops and comes back several times can get there (53 tools per
 * reconnect), and from then on every request fails. past this many additions the request is sent with
 * the churn taken out instead.
 */
export const CHURN_LIMIT = 384;

type ToolRef = { name: string };
type ToolChange = { role: "system"; toolsAdded?: ToolRef[]; toolsRemoved?: ToolRef[] };

const isChange = (m: unknown): m is ToolChange => {
	const s = m as ToolChange;
	return s?.role === "system" && (!!s.toolsAdded?.length || !!s.toolsRemoved?.length);
};

/** tool additions across these messages, the leading system message's included */
export function countAdditions(messages: readonly AgentMessage[]): number {
	let n = 0;
	for (const m of messages) if (isChange(m)) n += m.toolsAdded?.length ?? 0;
	return n;
}

/**
 * the messages with every removal that a later addition of the same tool undoes taken out, together
 * with that addition, when nothing called the tool in between. the tool reads as available through that
 * gap, which changes nothing the model did: it made no call to it there. under `limit` additions the
 * messages come back as they are, so a normal session's requests (and their cache) are untouched. the
 * stored messages are never changed; changed system messages are copies.
 */
export function collapseToolChurn(messages: AgentMessage[], limit = CHURN_LIMIT): AgentMessage[] {
	if (countAdditions(messages) <= limit) return messages;
	// per tool: where its last removal sits, while no addition or call of it has come since
	const pending = new Map<string, { at: number; ref: ToolRef }>();
	const drop = new Map<number, Set<ToolRef>>();
	const mark = (at: number, ref: ToolRef) => {
		let s = drop.get(at);
		if (!s) drop.set(at, (s = new Set()));
		s.add(ref);
	};
	messages.forEach((m, i) => {
		const a = m as { role?: string; content?: unknown };
		if (a.role === "assistant" && Array.isArray(a.content)) {
			for (const b of a.content as Array<{ type?: string; name?: string }>) if (b.type === "toolCall" && b.name) pending.delete(b.name);
			return;
		}
		if (!isChange(m)) return;
		// pi writes a message's removals before its additions
		for (const ref of m.toolsRemoved ?? []) pending.set(ref.name, { at: i, ref });
		for (const ref of m.toolsAdded ?? []) {
			const p = pending.get(ref.name);
			if (!p) continue;
			pending.delete(ref.name);
			mark(p.at, p.ref);
			mark(i, ref);
		}
	});
	if (!drop.size) return messages;
	return messages.map((m, i) => {
		const gone = drop.get(i);
		if (!gone) return m;
		const s = m as unknown as ToolChange & Record<string, unknown>;
		const { toolsAdded, toolsRemoved, ...rest } = s;
		const added = (toolsAdded ?? []).filter((r) => !gone.has(r));
		const removed = (toolsRemoved ?? []).filter((r) => !gone.has(r));
		return { ...rest, ...(added.length ? { toolsAdded: added } : {}), ...(removed.length ? { toolsRemoved: removed } : {}) } as unknown as AgentMessage;
	});
}
