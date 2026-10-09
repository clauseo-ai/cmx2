import { randomBytes } from "node:crypto";
import type { PermissionAsk, QuestionAsk } from "@cmx2/engine/session";
import type { PermissionReply } from "@cmx2/engine/permission";
import { messageId, type PendingPermission, type PendingQuestion, type Store } from "@cmx2/store";

/**
 * pending permission and question asks. the store holds what is pending and what was settled (so
 * `GET /permission` and `GET /question` answer after a client reconnects, and a late reply learns who
 * answered first); this registry holds the waiting tool calls. asks are a contract: an
 * unknown id is `unknown`, a settled one is `settled` with the answer, when and by whom; reject
 * settles one ask unless the caller asks for the cascade; always saves the ask's patterns for the
 * project and settles any other pending ask they now cover; an abort rejects what its turn left open.
 */

type Publish = (directory: string, type: string, properties: Record<string, unknown>) => void;

interface Waiter<T> {
	sessionID: string;
	directory: string;
	resolve: (v: T) => void;
	reject: (e: Error) => void;
}

/** how a reply went: it acted, or the ask was never there, or someone got there first */
export type ReplyOutcome =
	| { ok: true }
	| { ok: false; kind: "unknown" }
	| { ok: false; kind: "settled"; reply?: string; answers?: string[][] | null; state?: string; settledAt: number | null; by: string | null };

/** who settled an ask, and the client id of the request that did, both echoed on the event */
export interface Settler {
	by?: string;
	clientID?: string;
}

export function askId(prefix: "per" | "que"): string {
	return `${prefix}_${Date.now().toString(16)}${randomBytes(7).toString("hex")}`;
}

export class Asks {
	private permissions = new Map<string, Waiter<{ reply: PermissionReply; message?: string }> & { req: PendingPermission }>();
	private questions = new Map<string, Waiter<string[][]>>();

	constructor(
		private readonly store: Store,
		private readonly publish: Publish,
		/** true when saved and configured rules now allow every pattern of this ask */
		private readonly covered: (req: PendingPermission) => boolean,
	) {}

	permission(sessionID: string, directory: string, ask: PermissionAsk, signal?: AbortSignal): Promise<{ reply: PermissionReply; message?: string }> {
		const req: PendingPermission = {
			id: askId("per"),
			session_id: sessionID,
			directory,
			permission: ask.permission,
			patterns: ask.patterns,
			metadata: ask.metadata,
			always: ask.always,
			tool: { messageID: messageId(sessionID, ask.messageSeq), callID: ask.callID },
			created_at: Date.now(),
		};
		this.store.putPermission(req);
		this.publish(directory, "permission.asked", permissionJson(req));
		return new Promise((resolve, reject) => {
			this.permissions.set(req.id, { sessionID, directory, resolve, reject, req });
			signal?.addEventListener("abort", () => this.settlePermission(req.id, "reject", undefined, { by: "abort" }), { once: true });
		});
	}

	private settlePermission(id: string, reply: PermissionReply, message: string | undefined, who: Settler): boolean {
		const w = this.permissions.get(id);
		const row = this.store.permissionAsk(id);
		if (!this.store.replyPermission(id, reply, message, who.by)) return false;
		this.permissions.delete(id);
		const sessionID = w?.sessionID ?? row?.session_id;
		const directory = w?.directory ?? row?.directory;
		if (sessionID && directory) this.publish(directory, "permission.replied", { sessionID, requestID: id, reply, ...(who.by ? { by: who.by } : {}), ...(who.clientID ? { clientID: who.clientID } : {}) });
		w?.resolve({ reply, ...(message ? { message } : {}) });
		return true;
	}

	private settledPermission(id: string): ReplyOutcome {
		const row = this.store.permissionAsk(id);
		if (!row) return { ok: false, kind: "unknown" };
		return { ok: false, kind: "settled", reply: row.reply ?? undefined, settledAt: row.replied_at, by: row.settled_by };
	}

	replyPermission(id: string, reply: PermissionReply, opts: Settler & { message?: string; cascade?: boolean; saveRule?: (req: PendingPermission) => void } = {}): ReplyOutcome {
		const w = this.permissions.get(id);
		if (reply === "always" && w) opts.saveRule?.(w.req);
		if (!this.settlePermission(id, reply, opts.message, opts)) return this.settledPermission(id);
		if (!w) return { ok: true };
		if (reply === "reject" && opts.cascade) {
			for (const [other, o] of this.permissions) if (o.sessionID === w.sessionID) this.settlePermission(other, "reject", undefined, { by: "cascade" });
		}
		if (reply === "always") {
			for (const [other, o] of this.permissions) if (o.sessionID === w.sessionID && this.covered(o.req)) this.settlePermission(other, "always", undefined, { by: "always rule" });
		}
		return { ok: true };
	}

	question(sessionID: string, directory: string, ask: QuestionAsk, signal?: AbortSignal): Promise<string[][]> {
		const req: PendingQuestion = {
			id: askId("que"),
			session_id: sessionID,
			directory,
			questions: ask.questions.map((q) => ({ ...q, custom: true })),
			tool: { messageID: messageId(sessionID, ask.messageSeq), callID: ask.callID },
			created_at: Date.now(),
		};
		this.store.putQuestion(req);
		this.publish(directory, "question.asked", questionJson(req));
		return new Promise((resolve, reject) => {
			this.questions.set(req.id, { sessionID, directory, resolve, reject });
			signal?.addEventListener("abort", () => this.rejectQuestion(req.id, { by: "abort" }), { once: true });
		});
	}

	private settledQuestion(id: string): ReplyOutcome {
		const row = this.store.questionAsk(id);
		if (!row) return { ok: false, kind: "unknown" };
		return { ok: false, kind: "settled", state: row.state ?? undefined, answers: row.answers, settledAt: row.replied_at, by: row.settled_by };
	}

	replyQuestion(id: string, answers: string[][], who: Settler = {}): ReplyOutcome {
		const w = this.questions.get(id);
		const row = this.store.questionAsk(id);
		if (!this.store.settleQuestion(id, { answers }, who.by)) return this.settledQuestion(id);
		this.questions.delete(id);
		const sessionID = w?.sessionID ?? row!.session_id;
		this.publish(w?.directory ?? row!.directory, "question.replied", { sessionID, requestID: id, answers, ...(who.by ? { by: who.by } : {}), ...(who.clientID ? { clientID: who.clientID } : {}) });
		w?.resolve(answers);
		return { ok: true };
	}

	rejectQuestion(id: string, who: Settler = {}): ReplyOutcome {
		const w = this.questions.get(id);
		const row = this.store.questionAsk(id);
		if (!this.store.settleQuestion(id, { rejected: true }, who.by)) return this.settledQuestion(id);
		this.questions.delete(id);
		const sessionID = w?.sessionID ?? row!.session_id;
		this.publish(w?.directory ?? row!.directory, "question.rejected", { sessionID, requestID: id, ...(who.by ? { by: who.by } : {}), ...(who.clientID ? { clientID: who.clientID } : {}) });
		w?.reject(new Error("the user dismissed this question"));
		return { ok: true };
	}

	/** asks a stopped turn or an ended session left open are rejected, each with its event */
	dropSession(sessionID: string, by: string) {
		for (const [id, w] of this.permissions) if (w.sessionID === sessionID) this.settlePermission(id, "reject", undefined, { by });
		for (const [id, w] of this.questions) if (w.sessionID === sessionID) this.rejectQuestion(id, { by });
	}
}

export function permissionJson(p: PendingPermission) {
	return { id: p.id, sessionID: p.session_id, permission: p.permission, patterns: p.patterns, metadata: p.metadata, always: p.always, ...(p.tool ? { tool: p.tool } : {}) };
}

export function questionJson(q: PendingQuestion) {
	return { id: q.id, sessionID: q.session_id, questions: q.questions, ...(q.tool ? { tool: q.tool } : {}) };
}
