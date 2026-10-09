import type { Event, MessageInfo, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@cmx2/client";

/**
 * everything the screen shows, built from the daemon's reads and events. `apply` is pure bookkeeping
 * (no io, no rendering) so it is tested on recorded event sequences.
 */

export interface Message {
	info: MessageInfo;
	/** parts in arrival order */
	parts: Part[];
}

export type AgentState = "queued" | "working" | "parked" | "interrupted" | "closed";

export interface Agent {
	id: string;
	parentID: string | null;
	path: string;
	name: string;
	depth: number;
	seat: string | null;
	model: string | null;
	effort: string | null;
	state: AgentState;
	lastTask?: string;
	lastReport?: string;
	tokens: number;
	files: string[];
}

export interface State {
	sessionID?: string;
	title?: string;
	/** provider/model-id for the next turn */
	model?: string;
	effort?: string;
	/** a failure escalation is in force: `effort` is the turn's, not the session read's */
	escalated?: boolean;
	agent?: string;
	status: SessionStatus;
	messages: Message[];
	/** open asks, oldest first; only this session's tree */
	permissions: PermissionRequest[];
	questions: QuestionRequest[];
	/** the tree this session roots, by agent session id */
	agents: Map<string, Agent>;
	/** tokens the last finished step sent (input + cache), the context in use */
	context?: number;
	cost: number;
	/** the last error a turn hit, cleared by the next turn */
	error?: string;
	/** notes for the person: a steer landed, a retry, a refusal */
	notices: string[];
	/** the event stream's cursor, for a resume */
	cursor?: string;
	/** client ids of steers this tui sent, so their provisional messages read as steers, not queued */
	steers: Set<string>;
}

export function initialState(): State {
	return { status: { type: "idle" }, messages: [], permissions: [], questions: [], agents: new Map(), cost: 0, notices: [], steers: new Set() };
}

function findMessage(s: State, id: string): Message | undefined {
	for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i]!.info.id === id) return s.messages[i];
	return undefined;
}

function upsertMessage(s: State, info: MessageInfo): Message {
	const m = findMessage(s, info.id);
	if (m) {
		m.info = { ...m.info, ...info };
		return m;
	}
	const fresh: Message = { info, parts: [] };
	s.messages.push(fresh);
	return fresh;
}

function upsertPart(s: State, part: Part) {
	const m = findMessage(s, part.messageID) ?? upsertMessage(s, { id: part.messageID, sessionID: part.sessionID, role: "assistant", time: { created: Date.now() } });
	const i = m.parts.findIndex((p) => p.id === part.id);
	if (i >= 0) m.parts[i] = part;
	else m.parts.push(part);
}

/** whether an event belongs to what this screen shows: the session, or an agent under it */
export function mine(s: State, sessionID: string | undefined): boolean {
	if (!sessionID || !s.sessionID) return false;
	return sessionID === s.sessionID || s.agents.has(sessionID);
}

function agentOf(a: Record<string, any>): Agent {
	return {
		id: a.id,
		parentID: a.parentID ?? null,
		path: a.path,
		name: a.name,
		depth: a.depth ?? 0,
		seat: a.seat ?? null,
		model: a.model ?? null,
		effort: a.effort ?? null,
		state: a.state,
		...(a.lastTask ? { lastTask: a.lastTask } : {}),
		...(a.lastReport ? { lastReport: a.lastReport } : {}),
		tokens: a.tokens ?? 0,
		files: a.files ?? [],
	};
}

/** a read of the roster replaces what the events built */
export function setRoster(s: State, agents: Record<string, any>[]) {
	s.agents = new Map(agents.filter((a) => a.id !== s.sessionID).map((a) => [a.id, agentOf(a)]));
}

/** a read of the transcript replaces the messages */
export function setMessages(s: State, list: Array<{ info: MessageInfo; parts: Part[] }>) {
	s.messages = list.map((m) => ({ info: m.info, parts: [...m.parts] }));
	for (let i = s.messages.length - 1; i >= 0; i--) {
		const info = s.messages[i]!.info as Record<string, any>;
		if (info.role !== "assistant") continue;
		const t = info.tokens as { input?: number; cache?: { read?: number; write?: number } } | undefined;
		if (t && (t.input || t.cache?.read)) {
			s.context = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
			break;
		}
	}
}

/** applies one event; returns true when the screen should redraw */
export function apply(s: State, e: Event): boolean {
	const p = e.properties as Record<string, any>;
	switch (e.type) {
		case "message.updated": {
			if (p.sessionID !== s.sessionID) return false;
			const info = p.info as MessageInfo & Record<string, any>;
			upsertMessage(s, info);
			if (info.role === "assistant" && info.time?.completed) {
				const t = info.tokens as { input?: number; cache?: { read?: number; write?: number } } | undefined;
				if (t && (t.input || t.cache?.read)) s.context = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
				if (info.error?.data?.message) s.error = String(info.error.data.message);
			}
			return true;
		}
		case "message.part.updated": {
			if (p.sessionID !== s.sessionID) return false;
			upsertPart(s, p.part as Part);
			return true;
		}
		case "message.part.delta": {
			if (p.sessionID !== s.sessionID) return false;
			// a delta goes to a part the daemon announced (a message.part.updated that said text or reasoning); one this screen never saw
			// announced (the stream opened mid-part) has no type here, and guessing text would show thinking as the reply: the part
			// arrives typed with the next read or its final update
			const part = findMessage(s, p.messageID)?.parts.find((x) => x.id === p.partID) as (Part & { text?: string }) | undefined;
			if (!part) return false;
			const field = p.field === "reasoning" ? "text" : (p.field as string) || "text";
			const current = String((part as Record<string, unknown>)[field] ?? "");
			// deltas carry the text's length before them; a gap or a repeat means a missed or doubled frame
			if (typeof p.offset === "number" && p.offset !== current.length) {
				if (p.offset < current.length) (part as Record<string, unknown>)[field] = current.slice(0, p.offset) + p.delta;
				else return false;
			} else (part as Record<string, unknown>)[field] = current + p.delta;
			return true;
		}
		case "message.removed": {
			if (p.sessionID !== s.sessionID) return false;
			s.messages = s.messages.filter((m) => m.info.id !== p.messageID);
			return true;
		}
		case "session.status": {
			if (p.sessionID !== s.sessionID) {
				return false;
			}
			const was = s.status.type;
			s.status = p.status as SessionStatus;
			if (s.status.type === "busy" && was !== "busy") {
				s.error = undefined;
				s.notices = [];
			}
			return true;
		}
		case "session.updated":
		case "session.created": {
			const info = p.info as Record<string, any>;
			if (info?.id !== s.sessionID) return false;
			if (typeof info.title === "string") s.title = info.title;
			if (typeof info.cost === "number") s.cost = info.cost;
			if (info.model?.id) s.model = `${info.model.providerID}/${info.model.id}`;
			// the session read carries where the session stands; while a helper runs escalated, the effort in force is what shows
			if (typeof info.effort === "string" && !s.escalated) s.effort = info.effort;
			return true;
		}
		case "session.model": {
			if (p.sessionID !== s.sessionID) return false;
			s.model = p.model;
			return true;
		}
		case "session.effort": {
			if (p.sessionID !== s.sessionID) return false;
			s.effort = p.effort;
			s.escalated = false;
			return true;
		}
		case "session.error": {
			if (p.sessionID !== s.sessionID) return false;
			s.error = p.error?.data?.message ?? p.error?.name ?? "the turn failed";
			return true;
		}
		case "session.escalated": {
			if (p.sessionID !== s.sessionID) return false;
			s.effort = p.to;
			s.escalated = true;
			s.notices.push(`effort raised from ${p.from} to ${p.to}: ${p.reason}`);
			return true;
		}
		case "session.deescalated": {
			if (p.sessionID !== s.sessionID) return false;
			s.effort = p.to;
			s.escalated = false;
			s.notices.push(`effort back from ${p.from} to ${p.to}: ${p.reason}`);
			return true;
		}
		case "session.warning": {
			if (p.sessionID !== s.sessionID) return false;
			s.notices.push(String(p.message));
			return true;
		}
		case "permission.asked": {
			if (!mine(s, p.sessionID) || s.permissions.some((x) => x.id === p.id)) return false;
			s.permissions.push(p as PermissionRequest);
			return true;
		}
		case "permission.replied": {
			const before = s.permissions.length;
			s.permissions = s.permissions.filter((x) => x.id !== p.requestID);
			return before !== s.permissions.length;
		}
		case "question.asked": {
			if (!mine(s, p.sessionID) || s.questions.some((x) => x.id === p.id)) return false;
			s.questions.push(p as QuestionRequest);
			return true;
		}
		case "question.replied":
		case "question.rejected": {
			const before = s.questions.length;
			s.questions = s.questions.filter((x) => x.id !== p.requestID);
			return before !== s.questions.length;
		}
		case "agent.spawned":
		case "agent.updated":
		case "agent.closed": {
			if (p.sessionID !== s.sessionID && !s.agents.has(p.sessionID)) return false;
			const a = agentOf(p.agent);
			if (a.id === s.sessionID) return false;
			s.agents.set(a.id, a);
			return true;
		}
		default:
			return false;
	}
}

export function oneLine(text: string, max: number): string {
	const t = String(text ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
