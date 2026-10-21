import { existsSync, readFileSync, statSync } from "node:fs";
import { shrinkDetails, toolTitle } from "@cmx2/tools/record";
import type { MessageRow, PartRow, RecallDoc, Store } from "./index.ts";

/**
 * the message projection: engine transcript messages (pi's shapes) turned into opencode-shaped
 * message infos and parts, so clients that speak the cmx contract render cmx2 sessions unchanged.
 * the transcript stays the truth; the projection is a derived, rebuildable index. ids come from the
 * transcript position, so projecting the same line twice is an idempotent upsert.
 */

/** tool output kept in the projection; the transcript and the spill file keep all of it */
const TOOL_OUTPUT_CAP = 16_384;
/** text kept per recall row; recall searches it whole, well past what a part carries */
const RECALL_CAP = 1024 * 1024;

function doc(ctx: ProjectContext, messageID: string, key: string, role: string, kind: string, at: number, text: string, extra: { tool?: string; call_id?: string } = {}): RecallDoc {
	return { id: `${messageID}:${key}`, session_id: ctx.sessionId, message_id: messageID, seq: ctx.seq, role, kind, at, text: text.length > RECALL_CAP ? text.slice(0, RECALL_CAP) : text, ...extra };
}

const bare = (sessionId: string) => sessionId.replace(/^ses_/, "");
export const messageId = (sessionId: string, seq: number) => `msg_${bare(sessionId)}_${String(seq).padStart(5, "0")}`;
export const partId = (sessionId: string, seq: number, i: number) => `prt_${bare(sessionId)}_${String(seq).padStart(5, "0")}_${i}`;

/** a document the user attached, as clients show it: a file part, with its bytes as a data url when small enough to carry */
export function documentPart(id: string, sessionID: string, messageID: string, d: { data: string; mimeType: string; filename: string }) {
	const bytes = Math.floor((d.data.length * 3) / 4);
	return { id, sessionID, messageID, type: "file", mime: d.mimeType, filename: d.filename, url: bytes <= DOCUMENT_URL_MAX ? `data:${d.mimeType};base64,${d.data}` : "", size: bytes };
}

/** documents over this many bytes are listed without their bytes in parts and events; the transcript keeps them */
const DOCUMENT_URL_MAX = 1024 * 1024;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text))
		.join("\n");
}

/** a completed tool part carries at most this many of its result's images, and at most this many characters of their data urls */
export const TOOL_ATTACHMENTS_MAX = 8;
export const TOOL_ATTACHMENTS_BUDGET = 4 * 1024 * 1024;

/**
 * the images a tool result returned, as file attachments clients can preview. taken in order; an image that would pass
 * TOOL_ATTACHMENTS_MAX images or TOOL_ATTACHMENTS_BUDGET characters of data urls is left off and counted in dropped.
 * the filename is the label from the caption the tools put before an image ("image <label> (WxH, ...)"), else "image"
 */
export function toolAttachments(content: unknown): { attachments: Array<{ type: "file"; mime: string; filename: string; url: string }>; dropped: number } {
	const attachments: Array<{ type: "file"; mime: string; filename: string; url: string }> = [];
	let dropped = 0;
	let used = 0;
	if (!Array.isArray(content)) return { attachments, dropped };
	content.forEach((b: any, i: number) => {
		if (b?.type !== "image" || typeof b.data !== "string" || !b.data) return;
		const mime = typeof b.mimeType === "string" && b.mimeType ? b.mimeType : "image/png";
		const url = `data:${mime};base64,${b.data}`;
		if (attachments.length >= TOOL_ATTACHMENTS_MAX || used + url.length > TOOL_ATTACHMENTS_BUDGET) {
			dropped++;
			return;
		}
		used += url.length;
		const prev = content[i - 1] as any;
		const label = prev?.type === "text" ? String(prev.text ?? "").match(/^image (.+?) \((?:\d+x\d+|unknown size), /)?.[1] : undefined;
		attachments.push({ type: "file", mime, filename: label ? (label.split(/[\\/]/).pop() || label) : "image", url });
	});
	return { attachments, dropped };
}

function cap(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n…[${s.length - max} more characters in the transcript]`;
}

export interface ProjectContext {
	sessionId: string;
	cwd: string;
	/** position of the message in the transcript, 1-based, the leading system message being 1 */
	seq: number;
	/** when the message finished, for live projection; transcript backfill uses the message's own time */
	completedAt?: number;
}

/**
 * applies one transcript message to the projection. user and assistant messages become rows; a
 * tool result lands on its call's part; a turn-scoped system message becomes a synthetic part on
 * the user message it follows; the leading system message (the recorded prefix) is not a message.
 */
export function projectMessage(store: Store, ctx: ProjectContext, m: any): Touched {
	const { sessionId, seq } = ctx;
	const created = typeof m?.timestamp === "number" ? m.timestamp : Date.now();
	if (!m || typeof m !== "object") return { parts: [] };

	if (m.role === "user") {
		const id = messageId(sessionId, seq);
		const parts: PartRow[] = [];
		const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
		blocks.forEach((b: any, i: number) => {
			const pid = partId(sessionId, seq, i);
			const text = b?.type === "text" ? String(b.text) : "";
			const synthetic = b?.synthetic === true || text.startsWith("<system-reminder>");
			const data =
				b?.type === "image"
					? { id: pid, sessionID: sessionId, messageID: id, type: "file", mime: b.mimeType ?? "image/png", filename: b.filename ?? "image", url: `data:${b.mimeType ?? "image/png"};base64,${b.data}` }
					: b?.document
						? documentPart(pid, sessionId, id, b.document)
						: { id: pid, sessionID: sessionId, messageID: id, type: "text", text, ...(synthetic ? { synthetic: true } : {}) };
			parts.push({ id: pid, message_id: id, session_id: sessionId, seq: i, type: String(data.type), data: JSON.stringify(data) });
		});
		// a steer says it is one, and a queued or steered prompt keeps the model and effort it asked for (a20, a18)
		const info = {
			id,
			sessionID: sessionId,
			role: "user",
			time: { created },
			...(m.agent ? { agent: m.agent } : {}),
			...(m.clientID ? { clientID: m.clientID } : {}),
			...(m.steer === true ? { steer: true } : {}),
			...(m.model?.providerID && m.model?.modelID ? { model: { providerID: String(m.model.providerID), modelID: String(m.model.modelID) } } : {}),
			...(typeof m.variant === "string" ? { variant: m.variant } : {}),
		};
		store.putMessage(row(sessionId, seq, "user", created, null, info, { id }), parts);
		store.putRecall(id, blocks.flatMap((b: any, i: number) => (b?.type === "text" && b.text ? [doc(ctx, id, String(i), "user", "text", created, String(b.text))] : [])));
		return { message: id, parts: parts.map((p) => p.id) };
	}

	if (m.role === "shell") {
		// cmx's shape for a `!` line: a user message saying so, then an assistant message holding one completed shell tool part
		const uid = messageId(sessionId, seq);
		const aid = `${uid}_r`;
		const upart = partId(sessionId, seq, 0);
		const tpart = `${partId(sessionId, seq, 0)}_r`;
		const started = typeof m.startedAt === "number" ? m.startedAt : created;
		const status = m.timedOut ? "killed at the timeout" : m.exitCode === null ? "aborted" : `exit ${m.exitCode}`;
		const output = cap(`${String(m.output ?? "").replace(/\n+$/, "")}\n(${status})`, TOOL_OUTPUT_CAP);
		store.putMessage(row(sessionId, seq, "user", started, null, { id: uid, sessionID: sessionId, role: "user", time: { created: started }, ...(m.clientID ? { clientID: m.clientID } : {}) }, { id: uid }), [
			{ id: upart, message_id: uid, session_id: sessionId, seq: 0, type: "text", data: JSON.stringify({ id: upart, sessionID: sessionId, messageID: uid, type: "text", text: "the user ran a shell command", synthetic: true }) },
		]);
		const tool = {
			id: tpart,
			sessionID: sessionId,
			messageID: aid,
			type: "tool",
			callID: `shell_${seq}`,
			tool: "shell",
			state: { status: "completed", input: { command: m.command }, output, title: m.command, metadata: { output, exit: m.exitCode, description: "" }, time: { start: started, end: created } },
		};
		const info = { id: aid, sessionID: sessionId, role: "assistant", time: { created: started, completed: created }, parentID: uid, modelID: "shell", providerID: "cmx2", mode: "shell", agent: "shell", path: { cwd: m.cwd ?? ctx.cwd, root: ctx.cwd }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" };
		store.putMessage(row(sessionId, seq + 0.5, "assistant", started, created, info, { id: aid }), [{ id: tpart, message_id: aid, session_id: sessionId, seq: 0, type: "tool", data: JSON.stringify(tool) }]);
		store.putRecall(uid, [doc(ctx, uid, "shell", "user", "tool output", created, `$ ${m.command}\n${String(m.output ?? "")}`, { tool: "shell" })]);
		return { message: uid, parts: [upart], also: { message: aid, parts: [tpart] } };
	}

	if (m.role === "notice") {
		const id = messageId(sessionId, seq);
		const pid = partId(sessionId, seq, 0);
		const text = `${String(m.source ?? "runtime")}: ${String(m.text ?? "")}`;
		const info = { id, sessionID: sessionId, role: "user", time: { created }, notice: { source: m.source } };
		store.putMessage(row(sessionId, seq, "user", created, null, info, { id }), [
			{ id: pid, message_id: id, session_id: sessionId, seq: 0, type: "text", data: JSON.stringify({ id: pid, sessionID: sessionId, messageID: id, type: "text", text, notice: true }) },
		]);
		store.putRecall(id, [doc(ctx, id, "0", "user", "notice", created, text)]);
		return { message: id, parts: [pid] };
	}

	if (m.role === "mail") {
		// another agent's words (a task, a message, a child's report): a user message marked with who sent it
		const id = messageId(sessionId, seq);
		const pid = partId(sessionId, seq, 0);
		const from = String(m.from ?? "runtime");
		const mail = { kind: m.kind, from, ...(m.fromID ? { fromID: m.fromID } : {}), ...(m.correlation_id ? { correlation_id: m.correlation_id } : {}), ...(m.mailID ? { mailID: m.mailID } : {}) };
		const info = { id, sessionID: sessionId, role: "user", time: { created }, mail };
		store.putMessage(row(sessionId, seq, "user", created, null, info, { id }), [
			{ id: pid, message_id: id, session_id: sessionId, seq: 0, type: "text", data: JSON.stringify({ id: pid, sessionID: sessionId, messageID: id, type: "text", text: cap(String(m.text ?? ""), TOOL_OUTPUT_CAP), mail }) },
		]);
		store.putRecall(id, [doc(ctx, id, "0", "user", "mail", created, String(m.text ?? ""))]);
		return { message: id, parts: [pid] };
	}

	if (m.role === "compaction") {
		// cmx's shape for a compaction, which boxbox draws as a pit stop: a user message holding a compaction
		// part (where the kept tail starts), then the summary turn, an assistant message marked summary
		const uid = messageId(sessionId, seq);
		const aid = `${uid}_r`;
		const cpart = partId(sessionId, seq, 0);
		const spart = `${cpart}_r`;
		const u = m.usage ?? {};
		const started = created - (typeof m.summaryMs === "number" ? m.summaryMs : 0);
		const trigger = String(m.trigger ?? "auto");
		const part = { id: cpart, sessionID: sessionId, messageID: uid, type: "compaction", auto: trigger !== "manual", ...(trigger === "overflow" ? { overflow: true } : {}), ...(typeof m.tailFrom === "number" && m.tailFrom < seq ? { tail_start_id: messageId(sessionId, m.tailFrom) } : {}), prefire: m.prefire === true };
		store.putMessage(row(sessionId, seq, "user", started, null, { id: uid, sessionID: sessionId, role: "user", time: { created: started } }, { id: uid }), [
			{ id: cpart, message_id: uid, session_id: sessionId, seq: 0, type: "compaction", data: JSON.stringify(part) },
		]);
		const slash = String(m.model ?? "").indexOf("/");
		const info = {
			id: aid,
			sessionID: sessionId,
			role: "assistant",
			time: { created: started, completed: created },
			parentID: uid,
			modelID: slash > 0 ? String(m.model).slice(slash + 1) : String(m.model ?? ""),
			providerID: slash > 0 ? String(m.model).slice(0, slash) : "",
			mode: "compaction",
			agent: "compaction",
			summary: true,
			path: { cwd: ctx.cwd, root: ctx.cwd },
			cost: u.cost ?? 0,
			tokens: { input: u.input ?? 0, output: u.output ?? 0, reasoning: 0, cache: { read: u.cacheRead ?? 0, write: u.cacheWrite ?? 0 } },
			finish: "stop",
		};
		const text = { id: spart, sessionID: sessionId, messageID: aid, type: "text", text: String(m.summary ?? "") };
		store.putMessage(
			row(sessionId, seq + 0.5, "assistant", started, created, info, {
				id: aid,
				model: m.model ?? null,
				tokens_input: u.input ?? 0,
				tokens_output: u.output ?? 0,
				tokens_cache_read: u.cacheRead ?? 0,
				tokens_cache_write: u.cacheWrite ?? 0,
				cost: u.cost ?? 0,
				stop_reason: "stop",
			}),
			[{ id: spart, message_id: aid, session_id: sessionId, seq: 0, type: "text", data: JSON.stringify(text) }],
		);
		store.putRecall(uid, [doc(ctx, uid, "summary", "assistant", "summary", created, String(m.summary ?? ""))]);
		return { message: uid, parts: [cpart], also: { message: aid, parts: [spart] } };
	}

	if (m.role === "revert") {
		// a revert made permanent: the messages it took back stay, marked, out of lists
		if (typeof m.from === "number") store.markReverted(sessionId, m.from, seq);
		return { parts: [] };
	}

	if (m.role === "system") {
		if (seq === 1) return { parts: [] };
		const target = lastUserMessage(store, sessionId, seq);
		if (!target) return { parts: [] };
		const pid = partId(sessionId, seq, 0);
		const data = { id: pid, sessionID: sessionId, messageID: target, type: "text", text: textOf(m.content), synthetic: true };
		store.putPart({ id: pid, message_id: target, session_id: sessionId, seq: 1000 + seq, type: "text", data: JSON.stringify(data) });
		return { parts: [pid] };
	}

	if (m.role === "assistant") {
		const id = messageId(sessionId, seq);
		const u = m.usage ?? {};
		// a replay of the transcript (a restart, a heal) keeps the time the row was closed at: its event already said so (a13)
		const ended = ctx.completedAt ?? store.message(id)?.completed_at ?? created;
		// a step that called tools is still working until their results land (cmx keeps it open the same way)
		const calls = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type === "toolCall").length;
		const completed = calls > 0 && m.stopReason === "toolUse" ? null : ended;
		const parts: PartRow[] = [];
		(Array.isArray(m.content) ? m.content : []).forEach((b: any, i: number) => {
			const pid = partId(sessionId, seq, i);
			let data: Record<string, unknown> | undefined;
			// a streamed part's times were stamped on the message when it ended (a17); a transcript that predates them has none
			const t = m.partTimes?.[i];
			const time = typeof t?.start === "number" ? { time: { start: t.start, ...(typeof t.end === "number" ? { end: t.end } : {}) } } : {};
			if (b?.type === "text") data = { type: "text", text: String(b.text), ...time };
			else if (b?.type === "thinking") data = { type: "reasoning", text: String(b.thinking ?? ""), ...time };
			else if (b?.type === "toolCall") {
				data = { type: "tool", callID: b.id, tool: b.name, state: { status: "running", input: b.arguments ?? {}, time: { start: completed } } };
			}
			if (!data) return;
			const full = { id: pid, sessionID: sessionId, messageID: id, ...data };
			parts.push({ id: pid, message_id: id, session_id: sessionId, seq: i, type: String(data.type), data: JSON.stringify(full) });
		});
		// the engine stamps a decline (a refusal stop, a content filter) on the message; it projects as a refusal, not a provider error
		const r = m.refusal as { classifier: string; explanation?: string } | undefined;
		const error =
			m.stopReason === "aborted"
				? { name: "MessageAbortedError", data: { message: m.errorMessage ?? m.stopReason } }
				: m.stopReason === "error" && r
					? { name: "RefusalError", data: { message: `the model declined this request (classifier: ${r.classifier})${r.explanation ? `: ${r.explanation}` : ""}. rephrase it, or send it to another model`, refusal: r } }
					: m.stopReason === "error" && m.errorType
						? { name: m.errorType.name, data: { message: m.errorType.message, kind: m.errorType.kind, detail: m.errorMessage ?? "" } }
						: m.stopReason === "error"
							? { name: "ProviderError", data: { message: m.errorMessage ?? m.stopReason } }
							: undefined;
		const info = {
			id,
			sessionID: sessionId,
			role: "assistant",
			time: { created, ...(completed !== null ? { completed } : {}) },
			parentID: lastUserMessage(store, sessionId, seq),
			modelID: m.model,
			providerID: m.provider,
			// the agent the user picked for the prompt it answers (stamped by the engine); "build" when none was
			mode: typeof m.agent === "string" && m.agent ? m.agent : "build",
			agent: typeof m.agent === "string" && m.agent ? m.agent : "build",
			path: { cwd: ctx.cwd, root: ctx.cwd },
			cost: u.cost?.total ?? 0,
			tokens: { input: u.input ?? 0, output: u.output ?? 0, reasoning: u.reasoning ?? 0, cache: { read: u.cacheRead ?? 0, write: u.cacheWrite ?? 0 } },
			finish: m.stopReason === "toolUse" ? "tool-calls" : m.stopReason,
			...(m.providerThinkingLevel || m.thinkingLevel ? { variant: m.providerThinkingLevel ?? m.thinkingLevel } : {}),
			...(error ? { error } : {}),
		};
		store.putMessage(
			row(sessionId, seq, "assistant", created, completed, info, {
				model: `${m.provider}/${m.model}`,
				effort: m.providerThinkingLevel ?? m.thinkingLevel ?? null,
				tokens_input: u.input ?? 0,
				tokens_output: u.output ?? 0,
				tokens_cache_read: u.cacheRead ?? 0,
				tokens_cache_write: u.cacheWrite ?? 0,
				cost: u.cost?.total ?? 0,
				stop_reason: m.stopReason ?? null,
			}),
			parts,
		);
		store.putRecall(
			id,
			(Array.isArray(m.content) ? m.content : []).flatMap((b: any, i: number) => {
				if (b?.type === "text" && b.text) return [doc(ctx, id, String(i), "assistant", "text", created, String(b.text))];
				if (b?.type === "thinking" && b.thinking) return [doc(ctx, id, String(i), "assistant", "reasoning", created, String(b.thinking))];
				if (b?.type === "toolCall") return [doc(ctx, id, String(i), "assistant", "tool input", created, JSON.stringify(b.arguments ?? {}), { tool: b.name, call_id: b.id })];
				return [];
			}),
		);
		return { message: id, parts: parts.map((p) => p.id) };
	}

	if (m.role === "toolResult") {
		const part = store.toolPart(sessionId, m.toolCallId);
		if (!part) return { parts: [] };
		const data = JSON.parse(part.data);
		const output = cap(textOf(m.content), TOOL_OUTPUT_CAP);
		const time = { ...(data.state?.time ?? {}), end: ctx.completedAt ?? data.state?.time?.end ?? created };
		const images = m.isError ? undefined : toolAttachments(m.content);
		data.state = m.isError
			? { status: "error", input: data.state?.input ?? {}, error: output, time }
			: {
					status: "completed",
					input: data.state?.input ?? {},
					output,
					title: toolTitle(m.toolName, data.state?.input, m.details),
					metadata: summariseDetails(m.details, m.toolName),
					time,
					...(images?.attachments.length ? { attachments: images.attachments } : {}),
					...(images?.dropped ? { attachmentsDropped: images.dropped } : {}),
				};
		store.putPart({ ...part, data: JSON.stringify(data) });
		store.putRecallDoc(doc(ctx, part.message_id, `out:${m.toolCallId}`, "tool", "tool output", created, textOf(m.content), { tool: m.toolName, call_id: m.toolCallId }));
		const closed = closeIfDone(store, part.message_id, time.end);
		return { ...(closed ? { message: part.message_id } : {}), parts: [part.id] };
	}
	return { parts: [] };
}

/** marks an open assistant message completed once none of its tool parts is still running; true when it did */
export function closeIfDone(store: Store, messageId: string, at: number): boolean {
	const m = store.message(messageId);
	if (!m || m.role !== "assistant" || m.completed_at !== null) return false;
	const running = store.db
		.query("select count(*) as n from part where message_id = ? and type = 'tool' and json_extract(data, '$.state.status') in ('running', 'pending')")
		.get(messageId) as { n: number };
	if (running.n > 0) return false;
	const info = JSON.parse(m.info);
	info.time = { ...info.time, completed: at };
	store.noteTranscriptWrite(messageId);
	store.db.query("update message set completed_at = ?, info = ? where id = ?").run(at, JSON.stringify(info), messageId);
	return true;
}

/** a settled turn leaves nothing open: steps whose tools never answered (an abort) are closed; returns their ids */
export function closeOpenSteps(store: Store, sessionId: string, at: number): string[] {
	const open = store.db.query("select id from message where session_id = ? and role = 'assistant' and completed_at is null").all(sessionId) as Array<{ id: string }>;
	for (const { id } of open) {
		const m = store.message(id)!;
		const info = JSON.parse(m.info);
		info.time = { ...info.time, completed: at };
		store.noteTranscriptWrite(id);
		store.db.query("update message set completed_at = ?, info = ? where id = ?").run(at, JSON.stringify(info), id);
	}
	return open.map((o) => o.id);
}

/** what one projected message wrote, so the server can publish exactly those rows */
export interface Touched {
	message?: string;
	parts: string[];
	/** a second message the same line produced (a `!` shell line projects as a user and an assistant message) */
	also?: { message: string; parts: string[] };
}

const DETAILS_CAP = 4096;

/** typed tool metadata worth carrying (grep and glob hits, run counts); bulky fields stay in the transcript */
export function summariseDetails(details: unknown, tool?: string): Record<string, unknown> {
	if (!details || typeof details !== "object") return {};
	// an edit's or a write's diff is bounded where it is made (PATCH_CAP in tools) and is what a client reads the row for (a16): it rides outside the cap, and only theirs does
	const d = details as Record<string, unknown>;
	const diff = (tool === "edit" || tool === "write") && boundedFileDiff(d.filediff) ? d.filediff : undefined;
	const rest = diff ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "filediff")) : d;
	const kept = JSON.stringify(rest).length <= DETAILS_CAP ? rest : (fitNested(rest) ?? { truncated: true });
	return diff ? { ...kept, filediff: diff } : kept;
}

/** the patch cap in tools (64 KB) and a little room for its headers; anything bigger is not a diff this daemon made */
const FILEDIFF_MAX_CHARS = 64 * 1024 + 4096;

function boundedFileDiff(v: unknown): boolean {
	const f = v as { file?: unknown; patch?: unknown; additions?: unknown; deletions?: unknown } | null;
	return !!f && typeof f === "object" && typeof f.file === "string" && typeof f.patch === "string" && f.patch.length <= FILEDIFF_MAX_CHARS && typeof f.additions === "number" && typeof f.deletions === "number";
}

/**
 * a run part over the cap: its helper calls each carry the tool's answer, so a script that started
 * agents would lose their ids with the rest. measured once per entry (never re-serialised per pass), and
 * tried in tiers until one fits: every entry, the biggest answers shrunk first; every entry, only the
 * spawns keeping their answers; the spawn entries alone (the part's `calls` and `truncated` say the rest
 * were left out); the spawn entries with their scalars only (child_session_id, id, path); the part's own
 * fields and nothing else
 */
function fitNested(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const nested = details.nested;
	if (!Array.isArray(nested)) return undefined;
	const len = (v: unknown) => JSON.stringify(v).length;
	type Row = { bare: Record<string, unknown>; d?: unknown; bareLen: number; dLen: number; tool: unknown };
	const rows: Row[] = nested.map((n) => {
		const { details: d, ...bare } = (n ?? {}) as Record<string, unknown>;
		return { bare, ...(d === undefined ? {} : { d }), bareLen: len(bare) + 1, dLen: d === undefined ? 0 : len(d) + 11, tool: bare.tool };
	});
	const { nested: _, ...head } = details;
	const fit = (use: Row[], extra: Record<string, unknown>): Record<string, unknown> | undefined => {
		const frame = len({ ...head, ...extra, nested: [] });
		// with every answer removed the part must already fit, else shrinking answers cannot help
		if (use.reduce((t, r) => t + r.bareLen, frame) > DETAILS_CAP) return undefined;
		let total = use.reduce((t, r) => t + r.bareLen + r.dLen, frame);
		const out = use.map((r) => ({ ...r }));
		for (const r of [...out].sort((x, y) => y.dLen - x.dLen)) {
			if (total <= DETAILS_CAP || r.dLen === 0) break;
			const shrunk = shrinkDetails(r.d, DETAILS_CAP);
			const now = len(shrunk) + 11;
			// an answer that is already small stays as it is (the marker alone would make it longer)
			if (now >= r.dLen) continue;
			total += now - r.dLen;
			r.d = shrunk;
			r.dLen = now;
		}
		if (total > DETAILS_CAP) return undefined;
		return { ...head, ...extra, nested: out.map((r) => ({ ...r.bare, ...(r.d === undefined ? {} : { details: r.d }) })) };
	};
	const spawns = rows.filter((r) => r.tool === "spawn");
	const named = rows.map((r) => (r.tool === "spawn" || r.d === undefined ? r : { ...r, d: undefined, dLen: 0 }));
	const flat = spawns.map((r) => {
		if (r.d === undefined) return r;
		const d = shrinkDetails(r.d, DETAILS_CAP, { flat: true });
		return { ...r, d, dLen: len(d) + 11 };
	});
	return fit(rows, {}) ?? fit(named, { truncated: true }) ?? fit(spawns, { truncated: true }) ?? fit(flat, { truncated: true }) ?? shrinkDetails(head, DETAILS_CAP, { flat: true });
}

function lastUserMessage(store: Store, sessionId: string, beforeSeq: number): string | undefined {
	const r = store.db.query("select id from message where session_id = ? and role = 'user' and seq < ? order by seq desc limit 1").get(sessionId, beforeSeq) as { id: string } | null;
	return r?.id;
}

function row(sessionId: string, seq: number, role: string, created: number, completed: number | null, info: Record<string, unknown>, extra: Partial<MessageRow>): MessageRow {
	return {
		id: messageId(sessionId, Math.floor(seq)),
		session_id: sessionId,
		seq,
		role,
		created_at: created,
		completed_at: completed,
		model: null,
		effort: null,
		tokens_input: 0,
		tokens_output: 0,
		tokens_cache_read: 0,
		tokens_cache_write: 0,
		cost: 0,
		stop_reason: null,
		...extra,
		info: JSON.stringify(info),
	};
}

/**
 * rebuilds the projection of one session from its transcript file, from the first line the
 * projection does not have yet. used for sessions recorded before the projection existed and to
 * heal a projection after a crash between the transcript append and the row write.
 */
export function projectTranscript(store: Store, sessionId: string, path: string, cwd: string, opts: { all?: boolean } = {}): number {
	if (!existsSync(path)) return 0;
	// one transaction: the rows a replay changes and the transcript revision they move commit together (protocol 14a); a
	// replay that only rewrites what is stored leaves the revision where it was, so a read never moves it
	return store.db.transaction(() => {
		const { result, changed } = store.trackTranscript(() => replayTranscript(store, sessionId, path, cwd, opts));
		if (changed) store.bumpTranscriptRev(sessionId);
		return result;
	})();
}

function replayTranscript(store: Store, sessionId: string, path: string, cwd: string, opts: { all?: boolean }): number {
	const have = store.lastMessageSeq(sessionId);
	// what this process saw of the file last time (kept in memory, so the first read after a restart pays once):
	// the same size, mtime and last row means the replay below would rewrite rows with what they hold
	const memos = projected.get(store) ?? projected.set(store, new Map()).get(store)!;
	const key = `${sessionId}\0${path}`;
	const memo = opts.all ? undefined : memos.get(key);
	const st = statSync(path);
	if (memo && memo.have === have && st.size === memo.size && st.mtimeMs === memo.mtime) return 0;
	const buf = readFileSync(path);
	// a transcript only grows: lines before the last row's line were applied already, so reading starts there
	const resume = memo && memo.have === have && buf.length > memo.size;
	let seq = resume ? memo.seq : 0;
	let applied = 0;
	/** byte offset of each message line, by its position, from where reading started */
	const starts: number[] = [];
	let at = resume ? memo.offset : 0;
	/** the end of the last whole line, and the message lines up to it */
	let complete = at;
	let seqComplete = seq;
	while (at < buf.length) {
		const nl = buf.indexOf(10, at);
		const end = nl < 0 ? buf.length : nl;
		const from = at;
		at = end + 1;
		const r = end === from ? undefined : parseLine(buf.toString("utf8", from, end));
		if (r?.type === "message") {
			seq++;
			starts[seq] = from;
			// tool results and turn messages do not create rows, so replay from the last row onwards to catch them
			if (seq >= have || opts.all) {
				projectMessage(store, { sessionId, cwd, seq }, r.message);
				applied++;
			}
		}
		if (nl >= 0) {
			complete = at;
			seqComplete = seq;
		}
	}
	// the next replay starts at the line of the last row (or after the last whole line, when the file has no such line yet)
	const last = store.lastMessageSeq(sessionId);
	const first = Math.max(1, Math.ceil(last));
	const offset = starts[first];
	// the mtime read before the file was: a write after it shows as a change next time
	memos.set(key, { size: buf.length, mtime: st.mtimeMs, have: last, offset: offset ?? complete, seq: offset !== undefined ? first - 1 : seqComplete });
	return applied;
}

function parseLine(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** per store and transcript: the size projectTranscript last read, the last row it left, and where that row's line starts */
const projected = new WeakMap<Store, Map<string, { size: number; mtime: number; have: number; offset: number; seq: number }>>();
