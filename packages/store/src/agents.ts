import type { Database } from "bun:sqlite";

/**
 * the agent registry and mailboxes, as rows. the runtime keeps nothing about an agent that is not
 * here or in its transcript, so a daemon restart rehydrates identity (path, name, parent, seat) and
 * any mail that had not reached a transcript yet.
 */

export type AgentState = "queued" | "working" | "parked" | "interrupted" | "closed";

export interface AgentRow {
	id: string;
	root_id: string;
	parent_id: string | null;
	path: string;
	name: string;
	depth: number;
	seat: string | null;
	agent_type: string | null;
	model: string | null;
	effort: string | null;
	state: AgentState;
	cause: string | null;
	previous_state: string | null;
	brief: string | null;
	last_task: string | null;
	last_report: string | null;
	/** json array of paths the agent wrote or edited */
	files: string | null;
	/** json: spawn options kept for respawns, pools and contracts */
	options: string;
	/** 1 when the agent messaged its spawner during the current dispatch */
	delivered: number;
	/** transcript position of the item that started the current dispatch; extraction reads after it */
	trigger_seq: number;
	/** tokens spent since the current dispatch began (the per-dispatch budget) */
	turn_tokens: number;
	tokens: number;
	respawns: number;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
}

export type MailKind = "task" | "message" | "report" | "job" | "system";

export interface MailRow {
	id: string;
	to_id: string;
	root_id: string;
	seq: number;
	kind: MailKind;
	from_id: string | null;
	from_path: string | null;
	body: string;
	wake: number;
	/** system items (reports, lifecycle notes) bypass the mailbox cap */
	system: number;
	correlation_id: string | null;
	/** json: abort_reason, behavior_violation, pool, label */
	meta: string;
	created_at: number;
	delivered_at: number | null;
	delivered_seq: number | null;
}

export class AgentStore {
	constructor(private readonly db: Database) {}

	put(a: AgentRow) {
		const cols = Object.keys(a);
		this.db.query(`insert or replace into agent (${cols.join(",")}) values (${cols.map((c) => `$${c}`).join(",")})`).run(a as never);
	}

	update(id: string, patch: Partial<AgentRow>) {
		const cols = Object.keys(patch).filter((c) => c !== "id");
		if (!cols.length) return;
		this.db.query(`update agent set ${cols.map((c) => `${c} = $${c}`).join(", ")}, updated_at = $__now where id = $__id`).run({ ...patch, __now: Date.now(), __id: id } as never);
	}

	get(id: string): AgentRow | undefined {
		return (this.db.query("select * from agent where id = ?").get(id) as AgentRow | null) ?? undefined;
	}

	/** the live (not closed) agent at a path in a tree */
	byPath(rootId: string, path: string): AgentRow | undefined {
		return (this.db.query("select * from agent where root_id = ? and path = ? and state != 'closed'").get(rootId, path) as AgentRow | null) ?? undefined;
	}

	/** the most recent agent ever at a path, closed or not */
	lastAtPath(rootId: string, path: string): AgentRow | undefined {
		return (this.db.query("select * from agent where root_id = ? and path = ? order by created_at desc limit 1").get(rootId, path) as AgentRow | null) ?? undefined;
	}

	tree(rootId: string): AgentRow[] {
		return this.db.query("select * from agent where root_id = ? order by created_at, id").all(rootId) as AgentRow[];
	}

	children(parentId: string): AgentRow[] {
		return this.db.query("select * from agent where parent_id = ? order by created_at, id").all(parentId) as AgentRow[];
	}

	inState(...states: AgentState[]): AgentRow[] {
		return this.db.query(`select * from agent where state in (${states.map(() => "?").join(",")}) order by created_at`).all(...states) as AgentRow[];
	}

	// ---------- mailbox ----------

	nextMailSeq(toId: string): number {
		const r = this.db.query("select coalesce(max(seq), 0) as n from mailbox where to_id = ?").get(toId) as { n: number };
		return r.n + 1;
	}

	putMail(m: MailRow) {
		const cols = Object.keys(m);
		this.db.query(`insert into mailbox (${cols.join(",")}) values (${cols.map((c) => `$${c}`).join(",")})`).run(m as never);
	}

	mail(id: string): MailRow | undefined {
		return (this.db.query("select * from mailbox where id = ?").get(id) as MailRow | null) ?? undefined;
	}

	/** items not yet in the recipient's transcript, oldest first */
	pending(toId: string): MailRow[] {
		return this.db.query("select * from mailbox where to_id = ? and delivered_at is null order by seq").all(toId) as MailRow[];
	}

	/** pending items that count against the cap (system items do not) */
	pendingUser(toId: string): number {
		return (this.db.query("select count(*) as n from mailbox where to_id = ? and delivered_at is null and system = 0").get(toId) as { n: number }).n;
	}

	delivered(id: string, seq: number) {
		this.db.query("update mailbox set delivered_at = ?, delivered_seq = ? where id = ? and delivered_at is null").run(Date.now(), seq, id);
	}

	/** a correlated item that already reached the recipient's transcript */
	deliveredCorrelated(toId: string, correlationId: string): MailRow | undefined {
		return (this.db.query("select * from mailbox where to_id = ? and correlation_id = ? and delivered_at is not null order by seq desc limit 1").get(toId, correlationId) as MailRow | null) ?? undefined;
	}

	/** every item to a recipient after a mailbox position, delivered or not */
	since(toId: string, seq: number): MailRow[] {
		return this.db.query("select * from mailbox where to_id = ? and seq > ? order by seq").all(toId, seq) as MailRow[];
	}

	metric(m: { root_id: string; session_id: string; kind: string; child_id?: string | null; data?: Record<string, unknown> }) {
		this.db.query("insert into agent_metric (at, root_id, session_id, kind, child_id, data) values (?, ?, ?, ?, ?, ?)").run(Date.now(), m.root_id, m.session_id, m.kind, m.child_id ?? null, JSON.stringify(m.data ?? {}));
	}

	metrics(rootId: string): Array<{ at: number; session_id: string; kind: string; child_id: string | null; data: string }> {
		return this.db.query("select at, session_id, kind, child_id, data from agent_metric where root_id = ? order by at").all(rootId) as Array<{ at: number; session_id: string; kind: string; child_id: string | null; data: string }>;
	}

	/** recipients holding mail that should start a turn */
	wakeable(): Array<{ to_id: string }> {
		return this.db.query("select distinct to_id from mailbox where delivered_at is null and wake = 1").all() as Array<{ to_id: string }>;
	}
}
