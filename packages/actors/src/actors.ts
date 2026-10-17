import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { MailRecord, TurnEvent } from "@cmx2/engine/session";
import { type Effort, modelId, type Routing, RoutingError } from "@cmx2/routing";
import type { AgentRow, AgentState, MailKind, MailRow, Store } from "@cmx2/store";
import type { AgentAnswer, QuestionPrompt } from "@cmx2/tools";
import { computeViolations, resolveContract } from "./contracts.ts";
import { childPath, isAncestor, nameFrom, ROOT_PATH, validName } from "./paths.ts";
import { attemptAttachment, helperFragment, taskEnvelope } from "./prompt.ts";
import { capBody, extractDeliverable, failedTurnBody, filesTouched, looksLikeMissingDeliverable, parseAbort, reportBody } from "./report.ts";

/**
 * the agent runtime: a port of cmx's `AgentControl` onto cmx2's sessions. an agent is a session with
 * a row here (path, parent, seat, state) and a mailbox; its transcript is the truth, a loaded engine
 * session is only a hot cache, so an agent that finished is parked (idle, addressable, free) and a
 * daemon restart loses nothing. engine-agnostic: the daemon supplies a Host.
 */

export const MAILBOX_CAPACITY = 32;
export const MIN_WAIT_MS = 1_000;
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 600_000;
export const MAX_RESPAWNS = 3;
/** closed agents the roster keeps per tree, newest first */
export const TOMBSTONES = 32;
/** tools the built-in agent types do not get: explore reads and searches, review also runs commands */
export const EXCLUDE_EXPLORE = ["write", "edit", "shell", "run", "worktree_create", "worktree_merge", "worktree_discard"];
export const EXCLUDE_REVIEW = ["write", "edit", "worktree_create", "worktree_merge", "worktree_discard"];
/** the core tools a helper does not get, from its stored options: one list for a fresh session, a reopened one and a respawn; rows written before `exclude_tools` carry `read_only` */
export function excludeFor(options: { exclude_tools?: string[]; read_only?: boolean }): string[] {
	return options.exclude_tools ?? (options.read_only ? EXCLUDE_EXPLORE : []);
}

/** an attached file larger than this is cut in the brief */
const ATTACH_MAX = 20_000;

export class ActorError extends Error {
	constructor(
		override readonly name: string,
		readonly status: number,
		message: string,
		readonly data: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export interface ChildSpec {
	id: string;
	parentID: string;
	rootID: string;
	directory: string;
	title: string;
	model: string;
	effort: Effort;
	systemExtra: string;
	excludeTools: string[];
	cacheTtl?: "5m" | "1h";
}

/** what the daemon does for the runtime; the runtime never touches an engine session itself */
export interface Host {
	createSession(spec: ChildSpec): Promise<void>;
	state(id: string): "busy" | "idle" | "unloaded";
	/** lands mail in a running turn; false when the session is not running */
	deliver(id: string, items: MailRecord[]): boolean;
	/** opens the session (reviving it from its transcript) and starts a turn for its waiting mail */
	wake(id: string): Promise<boolean>;
	interrupt(id: string): Promise<void>;
	/** transcript entries at positions (from, to] */
	messages(id: string, from: number, to?: number): Promise<any[]>;
	directory(id: string): string | undefined;
	exists(id: string): boolean;
	/** running background jobs that will notify this session */
	liveJobs(id: string): number;
	/** the session is done for good: stop its processes (keep'd ones stay) */
	end(id: string): Promise<void>;
	publish(sessionID: string, type: string, properties: Record<string, unknown>): void;
	/** the run state changed in a way a client shows (parked counts) */
	statusChanged(sessionID: string): void;
	failNextTurn(id: string, message: string): void;
}

export interface AgentType {
	body: string;
	/** a model alias from routing.jsonc, or a provider/model-id */
	model?: string;
	/** explore: reads and searches, changes nothing and runs nothing */
	readOnly?: boolean;
	/** review: reads, searches and runs commands, changes no files */
	review?: boolean;
}

/** the built-in agent types; others come from .cmx2/agent/*.md */
const BUILTIN: Record<string, AgentType> = { explore: { body: "", readOnly: true }, review: { body: "", review: true } };

export interface ActorsOptions {
	store: Store;
	host: Host;
	routing: Routing;
	/** an agent type from `.cmx2/agent/*.md` or the profile, by directory and name */
	agentType?: (directory: string, name: string) => AgentType | undefined;
	/** agent names whose first turn fails before its first request (`CMX2_FAULT=first_turn:<name>,...`) */
	faults?: string[];
	/** how long a parked child's cache is kept warm */
	warmHorizonMs?: number;
	/** whether the profile blacklists a model for work in a directory (providers.<id>.blacklist) */
	blacklisted?: (directory: string, model: string) => boolean;
}

export interface PoolSpec {
	n: number;
	collect?: "all" | "first" | "any_n";
	any_n?: number;
	strategy?: "one_for_one" | "one_for_all" | "rest_for_one";
	briefs?: string[];
}

export interface SpawnInput {
	brief: string;
	name?: string;
	effort?: Effort;
	agent_type?: string;
	/** a model alias from routing.jsonc; over rest a provider/model-id is accepted too. required unless the agent type names one */
	model?: string;
	/** id of an earlier helper whose attempt this one takes over; its brief and last report ride along */
	after?: string;
	files?: string[];
	fork_turns?: number;
	on_failure?: "escalate" | "respawn" | "ignore";
	pool?: PoolSpec;
	cache_ttl?: "5m" | "1h";
	warm?: boolean;
	mailbox_capacity?: number;
	behavior_version?: "subagent_v1" | "subagent_v2";
	budget_tokens?: number;
	/** where it works instead of the spawner's directory: a checkout from worktree_create, or any directory */
	directory?: string;
}

interface AgentOptions {
	/** its working directory when it is not the spawner's; a respawn keeps it */
	directory?: string;
	on_failure?: "escalate" | "respawn" | "ignore";
	pool?: { id: string; name: string; index: number; n: number; collect: "all" | "first" | "any_n"; any_n: number; strategy: "one_for_one" | "one_for_all" | "rest_for_one" };
	cache_ttl?: "5m" | "1h";
	warm?: boolean;
	mailbox_capacity?: number;
	behavior_version?: "subagent_v1" | "subagent_v2";
	budget_tokens?: number;
	/** old rows: an explore child; read as the explore exclusion */
	read_only?: boolean;
	/** core tools this helper does not get, for the fresh and the reopened session alike */
	exclude_tools?: string[];
	/** the earlier helper whose attempt this one took over */
	after?: string;
	system_extra_hash?: string;
}

export interface AgentInfo {
	id: string;
	rootID: string;
	parentID: string | null;
	path: string;
	name: string;
	depth: number;
	seat: string | null;
	agentType: string | null;
	model: string | null;
	effort: string | null;
	state: AgentState;
	cause?: string;
	previousState?: string;
	files: string[];
	lastTask?: string;
	lastReport?: string;
	pending: number;
	tokens: number;
	/** input, cache read and cache write of its last step: how big its context is now */
	contextTokens?: number;
	/** what its last step cost, in dollars */
	lastStepCost?: number;
	/** what the session has cost so far, in dollars */
	cost?: number;
	pool?: { id: string; name: string; index: number; n: number };
	createdAt: number;
	updatedAt: number;
	closedAt?: number;
}

interface Waiter {
	correlation?: string;
	resolve: (m: MailRow | undefined) => void;
}

/** a helper's question out to its spawner: the helper's tool call waits on it */
interface PendingAsk {
	id: string;
	childID: string;
	parentID: string;
	/** the mail that carries the question to the spawner */
	mailID: string;
	resolve: (a: AgentAnswer) => void;
	reject: (e: Error) => void;
}

interface PoolState {
	id: string;
	name: string;
	parentID: string;
	members: string[];
	collect: "all" | "first" | "any_n";
	anyN: number;
	strategy: "one_for_one" | "one_for_all" | "rest_for_one";
	reports: Map<string, { path: string; label: string; body: string; failed: boolean }>;
	done: boolean;
}

function json<T>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

function firstLine(s: string | null | undefined, max = 120): string {
	const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** the mail a helper's question becomes: the questions with their options, then how to answer */
export function askBody(from: { path: string }, questions: QuestionPrompt[], id: string): string {
	const lines = [`${from.path} asks you, and waits for your answer:`, ""];
	questions.forEach((q, i) => {
		lines.push(`${questions.length > 1 ? `${i + 1}. ` : ""}${q.header ? `${q.header}: ` : ""}${q.question}`);
		for (const o of q.options ?? []) lines.push(`   - ${o.label}${o.description ? `: ${o.description}` : ""}`);
		if (q.multiple) lines.push("   (more than one may be chosen)");
	});
	lines.push(
		"",
		`answer with message(to: "${from.path}", body: <your answer>, correlation_id: "${id}"). answer from what you know when you can; when you cannot, ask with your own question tool and pass the answer on. it reads nothing else until you answer, and if you end your turn without answering it goes on without one.`,
	);
	return lines.join("\n");
}

export class Actors {
	private readonly store: Store;
	private readonly host: Host;
	readonly routing: Routing;
	private readonly waiters = new Map<string, Set<Waiter>>();
	private readonly pools = new Map<string, PoolState>();
	/** per tree: children holding a running-turn slot */
	private readonly running = new Map<string, Set<string>>();
	/** per tree: children waiting for a slot, and lenders reclaiming theirs (first) */
	private readonly queue = new Map<string, Array<{ id: string; resolve?: () => void }>>();
	/** agents in `wait` or `question` who lent their slot out */
	private readonly lent = new Set<string>();
	/** helpers' questions out to their spawners, by correlation id */
	private readonly asking = new Map<string, PendingAsk>();
	/** who stopped a turn and why, so the watcher knows whether to report */
	private readonly interrupting = new Map<string, { by: string; cause: "interrupted" | "closed" | "budget" | "pool" }>();
	private readonly lastParked = new Map<string, string>();
	/** task envelopes of agents created but not started yet */
	private readonly envelopes = new Map<string, string>();
	/** custom agent types that share a built-in's name, already warned about */
	private readonly shadowed = new Set<string>();

	constructor(private readonly opts: ActorsOptions) {
		this.store = opts.store;
		this.host = opts.host;
		this.routing = opts.routing;
	}

	private get rows() {
		return this.store.agents;
	}

	// ---------- registry ----------

	/** a top-level session is the root of its own tree; its row is made on first need */
	ensureRoot(id: string): AgentRow {
		const existing = this.rows.get(id);
		if (existing) return existing;
		const now = Date.now();
		const row: AgentRow = {
			id,
			root_id: id,
			parent_id: null,
			path: ROOT_PATH,
			name: "root",
			depth: 0,
			seat: "driver",
			agent_type: null,
			model: null,
			effort: null,
			state: this.host.state(id) === "busy" ? "working" : "parked",
			cause: null,
			previous_state: null,
			brief: null,
			last_task: null,
			last_report: null,
			files: "[]",
			options: "{}",
			delivered: 0,
			trigger_seq: 0,
			turn_tokens: 0,
			tokens: 0,
			respawns: 0,
			created_at: now,
			updated_at: now,
			closed_at: null,
		};
		this.rows.put(row);
		return row;
	}

	/** the row for any live cmx2 session: its agent row, or a fresh root row */
	rowOf(id: string): AgentRow {
		const r = this.rows.get(id);
		if (r) return r;
		if (!this.host.exists(id)) throw new ActorError("AgentNotFoundError", 404, `no session ${id}`);
		return this.ensureRoot(id);
	}

	/** true for a session some agent spawned */
	isChild(id: string): boolean {
		const r = this.rows.get(id);
		return !!r && r.depth > 0;
	}

	info(a: AgentRow): AgentInfo {
		const opts = json<AgentOptions>(a.options, {});
		const last = this.store.lastStep(a.id);
		const stored = this.store.session(a.id);
		const cost = stored?.cost;
		return {
			id: a.id,
			rootID: a.root_id,
			parentID: a.parent_id,
			path: a.path,
			name: a.name,
			depth: a.depth,
			seat: a.seat,
			agentType: a.agent_type,
			// a root's row holds no model or effort (the user picks them): its session's own model and standing effort stand in
			model: a.model ?? stored?.model ?? null,
			effort: a.effort ?? stored?.effort ?? null,
			state: a.state,
			...(a.cause ? { cause: a.cause } : {}),
			...(a.previous_state ? { previousState: a.previous_state } : {}),
			files: json<string[]>(a.files, []),
			...(a.last_task ? { lastTask: a.last_task.slice(0, 2000) } : {}),
			...(a.last_report ? { lastReport: a.last_report.slice(0, 2000) } : {}),
			pending: this.rows.pending(a.id).length,
			tokens: a.tokens,
			...(last ? { contextTokens: last.input + last.cache_read + last.cache_write, lastStepCost: last.cost } : {}),
			...(cost !== undefined ? { cost } : {}),
			...(opts.pool ? { pool: { id: opts.pool.id, name: opts.pool.name, index: opts.pool.index, n: opts.pool.n } } : {}),
			createdAt: a.created_at,
			updatedAt: a.updated_at,
			...(a.closed_at ? { closedAt: a.closed_at } : {}),
		};
	}

	/** the whole tree the session belongs to: live agents, then the newest closed ones */
	roster(sessionID: string, pathPrefix?: string): { root: string; self: string; agents: AgentInfo[] } {
		const me = this.rowOf(sessionID);
		// "/root/" means the same part of the tree as "/root"; "/" alone means all of it
		const prefix = pathPrefix?.replace(/\/+$/, "") || undefined;
		const all = this.rows.tree(me.root_id).filter((a) => !prefix || a.path === prefix || a.path.startsWith(`${prefix}/`));
		const live = all.filter((a) => a.state !== "closed");
		const closed = all
			.filter((a) => a.state === "closed")
			.sort((x, y) => (y.closed_at ?? 0) - (x.closed_at ?? 0))
			.slice(0, TOMBSTONES);
		if (!live.some((a) => a.depth === 0) && !prefix) live.unshift(this.ensureRoot(me.root_id));
		return { root: me.root_id, self: me.path, agents: [...live, ...closed].map((a) => this.info(a)) };
	}

	private setState(id: string, state: AgentState, patch: Partial<AgentRow> = {}) {
		const a = this.rows.get(id);
		if (!a) return;
		if (a.state === state && !Object.keys(patch).length) return;
		this.rows.update(id, { state, ...(a.state !== state ? { previous_state: a.state } : {}), ...patch });
		const next = this.rows.get(id)!;
		this.host.publish(next.root_id, "agent.updated", { sessionID: next.root_id, agent: this.info(next) });
	}

	/**
	 * a target by id, canonical path, name or `parent`, inside the sender's tree only; another tree's
	 * agent answers the same as one that does not exist
	 */
	resolve(sender: AgentRow, to: string, opts: { closed?: boolean } = {}): AgentRow {
		const t = to.trim();
		let found: AgentRow | undefined;
		if (t === "parent" || t === "spawner") {
			found = sender.parent_id ? this.rows.get(sender.parent_id) : undefined;
			if (!found) throw new ActorError("AgentNotFoundError", 404, "you have no parent; you are the root of this tree");
		} else if (t.startsWith("ses_")) {
			const r = this.rows.get(t) ?? (t === sender.root_id ? this.ensureRoot(t) : undefined);
			if (r && r.root_id === sender.root_id) found = r;
		} else if (t.startsWith("/")) {
			found = t === ROOT_PATH ? this.ensureRoot(sender.root_id) : (this.rows.byPath(sender.root_id, t) ?? (opts.closed ? this.rows.lastAtPath(sender.root_id, t) : undefined));
			if (!found && this.rows.lastAtPath(sender.root_id, t)) {
				throw new ActorError("AgentClosedError", 409, `${t} was closed; spawn a new agent for more work, or read its transcript`, { path: t, already_terminated: true });
			}
		} else {
			const tree = this.rows.tree(sender.root_id).filter((a) => a.state !== "closed" && a.name === t);
			const mine = tree.filter((a) => a.parent_id === sender.id);
			const pick = mine.length === 1 ? mine : tree;
			if (pick.length > 1) throw new ActorError("AgentReferenceInvalidError", 400, `${t} names ${pick.length} agents (${pick.map((a) => a.path).join(", ")}); use the path or id`);
			found = pick[0];
		}
		if (!found) throw new ActorError("AgentNotFoundError", 404, `no agent ${t} in this tree; agents() lists them`, { reference: t });
		if (found.state === "closed" && !opts.closed) {
			throw new ActorError("AgentClosedError", 409, `${found.path} was closed; spawn a new agent for more work, or read its transcript (session ${found.id})`, { path: found.path, already_terminated: true });
		}
		return found;
	}

	// ---------- mailboxes ----------

	private capacityOf(a: AgentRow): number {
		return json<AgentOptions>(a.options, {}).mailbox_capacity ?? MAILBOX_CAPACITY;
	}

	private record(m: MailRow): MailRecord {
		return {
			role: "mail",
			mailID: m.id,
			kind: m.kind,
			from: m.from_path ?? "runtime",
			...(m.from_id ? { fromID: m.from_id } : {}),
			...(m.correlation_id ? { correlation_id: m.correlation_id } : {}),
			text: m.body,
			timestamp: m.created_at,
		};
	}

	/**
	 * puts an item in a mailbox and moves it on: into a running turn at its next boundary, or a turn
	 * for an idle recipient when it wakes. system items (reports, lifecycle notes) bypass the cap.
	 */
	post(to: AgentRow, m: { kind: MailKind; from?: AgentRow | null; body: string; wake: boolean; system: boolean; correlation_id?: string; meta?: Record<string, unknown> }): MailRow {
		if (to.state === "closed" && !m.system) throw new ActorError("AgentClosedError", 409, `${to.path} was closed; spawn a new agent for more work`, { path: to.path });
		if (!m.system) {
			const cap = this.capacityOf(to);
			if (this.rows.pendingUser(to.id) >= cap) {
				throw new ActorError("MailboxFullError", 429, `${to.path}'s mailbox is full (${cap} notes it has not read yet); retry after it catches up, or wait for its report`, { capacity: cap, retry: "after its next turn boundary" });
			}
		}
		const row: MailRow = {
			id: `mail_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			to_id: to.id,
			root_id: to.root_id,
			seq: this.rows.nextMailSeq(to.id),
			kind: m.kind,
			from_id: m.from?.id ?? null,
			from_path: m.from?.path ?? null,
			body: m.body,
			wake: m.wake ? 1 : 0,
			system: m.system ? 1 : 0,
			correlation_id: m.correlation_id ?? null,
			meta: JSON.stringify(m.meta ?? {}),
			created_at: Date.now(),
			delivered_at: null,
			delivered_seq: null,
		};
		this.rows.putMail(row);
		this.notifyWaiters(to.id, row);
		if (to.state !== "closed") this.dispatch(to, row);
		return row;
	}

	private dispatch(to: AgentRow, m: MailRow) {
		if (this.host.state(to.id) === "busy") {
			if (this.host.deliver(to.id, [this.record(m)])) return;
		}
		if (m.wake) this.requestTurn(to);
	}

	/** the engine's inbox: what waits for this session, oldest first */
	inbox(sessionID: string): MailRecord[] {
		const a = this.rows.get(sessionID);
		if (!a || a.state === "closed") return [];
		return this.rows.pending(sessionID).map((m) => this.record(m));
	}

	onMailDelivered(sessionID: string, mailID: string, seq: number) {
		const m = this.rows.mail(mailID);
		this.rows.delivered(mailID, seq);
		if (m && (m.kind === "task" || m.kind === "message") && this.rows.get(sessionID)?.parent_id === m.from_id) this.rows.update(sessionID, { trigger_seq: seq });
	}

	pendingMail(sessionID: string): MailRow[] {
		return this.rows.pending(sessionID);
	}

	private notifyWaiters(id: string, m: MailRow) {
		const set = this.waiters.get(id);
		if (!set) return;
		for (const w of [...set]) {
			if (w.correlation && w.correlation !== m.correlation_id) continue;
			set.delete(w);
			w.resolve(m);
		}
	}

	// ---------- the running-turn cap ----------

	/** child slots per tree: the cap counts the root, which always has its own */
	private childSlots(): number {
		return Math.max(1, this.routing.current().caps.running_turns - 1);
	}

	private runningOf(root: string): Set<string> {
		let s = this.running.get(root);
		if (!s) this.running.set(root, (s = new Set()));
		return s;
	}

	private queueOf(root: string) {
		let q = this.queue.get(root);
		if (!q) this.queue.set(root, (q = []));
		return q;
	}

	/** running turns in a tree right now (children only), for the cap invariant */
	runningCount(root: string): number {
		return this.runningOf(root).size;
	}

	private requestTurn(a: AgentRow) {
		if (a.state === "closed") return;
		if (a.depth === 0) {
			void this.host.wake(a.id).catch((e) => console.error(`cmx2: could not wake ${a.id}: ${e instanceof Error ? e.message : String(e)}`));
			return;
		}
		const run = this.runningOf(a.root_id);
		const q = this.queueOf(a.root_id);
		if (run.has(a.id) || q.some((w) => w.id === a.id && !w.resolve)) return;
		if (run.size < this.childSlots()) {
			run.add(a.id);
			this.startChild(a);
			return;
		}
		q.push({ id: a.id });
		if (a.state !== "working") this.setState(a.id, "queued");
		this.refreshParked(a.id);
	}

	private startChild(a: AgentRow) {
		const release = () => {
			this.runningOf(a.root_id).delete(a.id);
			const now = this.rows.get(a.id);
			if (now?.state === "queued") this.setState(a.id, "parked");
			this.grantNext(a.root_id);
		};
		this.host
			.wake(a.id)
			.then((started) => {
				if (!started && this.host.state(a.id) !== "busy") release();
			})
			.catch((e) => {
				release();
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`cmx2: agent ${a.path} (${a.id}) could not start a turn: ${msg}`);
				const parent = a.parent_id ? this.rows.get(a.parent_id) : undefined;
				if (parent) this.post(parent, { kind: "system", from: a, body: `agent ${a.path} could not start its turn: ${msg}`, wake: true, system: true, meta: { label: "failed" } });
			});
	}

	private grantNext(root: string) {
		const run = this.runningOf(root);
		const q = this.queueOf(root);
		while (run.size < this.childSlots() && q.length) {
			const next = q.shift()!;
			if (next.resolve) {
				run.add(next.id);
				next.resolve();
				continue;
			}
			const a = this.rows.get(next.id);
			if (!a || a.state === "closed") continue;
			if (!this.rows.pending(a.id).some((m) => m.wake) && this.host.state(a.id) !== "busy") {
				if (a.state === "queued") this.setState(a.id, "parked");
				continue;
			}
			run.add(a.id);
			this.startChild(a);
		}
	}

	/** an agent in `wait` does no work; its slot goes to whoever is queued until the wait ends */
	private lend(a: AgentRow) {
		if (a.depth === 0) return;
		if (this.runningOf(a.root_id).delete(a.id)) {
			this.lent.add(a.id);
			this.grantNext(a.root_id);
		}
	}

	private async reclaim(a: AgentRow) {
		if (!this.lent.delete(a.id)) return;
		const run = this.runningOf(a.root_id);
		if (run.size < this.childSlots()) {
			run.add(a.id);
			return;
		}
		await new Promise<void>((resolve) => this.queueOf(a.root_id).unshift({ id: a.id, resolve }));
	}

	// ---------- the five verbs ----------

	async spawn(senderID: string, input: SpawnInput): Promise<AgentInfo[]> {
		return (await this.spawnWithNotes(senderID, input)).agents;
	}

	/** spawn, plus lines for whoever started it that do not belong on an agent row (a step up that has failed before) */
	async spawnWithNotes(senderID: string, input: SpawnInput, from: { model?: boolean } = {}): Promise<{ agents: AgentInfo[]; notes: string[] }> {
		const sender = this.rowOf(senderID);
		if (sender.state === "closed") throw new ActorError("AgentClosedError", 409, `${sender.path} is closed`);
		const r = this.routing.current();
		// the rest body's seat from version 1 of routing: refused, with what to say instead
		if ((input as { seat?: unknown }).seat !== undefined) {
			throw new ActorError("SeatsRemovedError", 400, `seats are gone; name a model from routing.jsonc (${Object.keys(r.models).join(", ")})`);
		}
		const depth = sender.depth + 1;
		if (depth > r.caps.depth) {
			throw new ActorError("AgentDepthExceededError", 400, `spawning from ${sender.path} would make depth ${depth}; the limit is ${r.caps.depth}. do the work yourself or hand it back to your spawner`, { depth, max: r.caps.depth });
		}
		this.checkBudget(sender.root_id);
		if (!input.brief?.trim()) throw new ActorError("BadRequestError", 400, "a spawn needs a brief: goal, constraints, definition of done, files owned, report shape");
		const home = this.host.directory(sender.id) ?? process.cwd();
		const directory = input.directory?.trim() ? resolve(home, input.directory.trim()) : home;
		if (directory !== home && !(existsSync(directory) && statSync(directory).isDirectory())) {
			throw new ActorError("BadRequestError", 400, `${directory} is not a directory; give spawn a checkout from worktree_create, or leave directory out to share yours`);
		}
		const agentType = input.agent_type ?? "general";
		const typeDef = agentType === "general" ? undefined : (BUILTIN[agentType] ?? this.opts.agentType?.(directory, agentType));
		if (BUILTIN[agentType] && this.opts.agentType?.(directory, agentType) && !this.shadowed.has(`${directory}:${agentType}`)) {
			this.shadowed.add(`${directory}:${agentType}`);
			console.error(`cmx2: an agent type named ${agentType} exists in ${directory}'s .cmx2/agent or your profile, and the built-in ${agentType} wins; rename the file to use it`);
		}
		if (agentType !== "general" && !typeDef) throw new ActorError("BadRequestError", 400, `no agent type ${agentType}; the built-in ones are general, explore and review, others come from .cmx2/agent/*.md`);
		// the spawn's own model wins; an agent type may bring one; otherwise a spawn is a cost decision the caller has to make
		// the model-facing verb names an alias from the table; a provider/model-id is for rest and an agent type's frontmatter
		if (from.model && input.model?.includes("/")) {
			throw new ActorError("UnknownModelError", 400, `no model named ${input.model.trim()} in routing.jsonc; the models are ${Object.keys(r.models).join(", ")}`, { code: "unknown_model" });
		}
		const named = input.model?.trim() || typeDef?.model;
		if (!named) throw new ActorError("BadRequestError", 400, `a spawn needs a model: one of ${Object.keys(r.models).join(", ")}`);
		const { model, effort, label } = this.pick(named, input.effort);
		if (this.opts.blacklisted?.(directory, model)) {
			throw new ActorError("BadRequestError", 400, `${model} is on the blacklist in your profile (providers.<id>.blacklist); pick another model`);
		}
		const name = input.name ?? nameFrom(input.brief);
		if (!validName(name)) throw new ActorError("BadRequestError", 400, `agent names are lowercase letters, digits and _ (up to 40), starting with a letter; got ${JSON.stringify(name)}`);
		const prior = input.after ? this.priorAttempt(sender, input.after) : undefined;
		const base: AgentOptions = {
			...(directory !== home ? { directory } : {}),
			...(input.on_failure ? { on_failure: input.on_failure } : {}),
			...(input.cache_ttl ? { cache_ttl: input.cache_ttl } : {}),
			...(input.warm !== undefined ? { warm: input.warm } : {}),
			...(input.mailbox_capacity ? { mailbox_capacity: input.mailbox_capacity } : {}),
			...(input.behavior_version ? { behavior_version: input.behavior_version } : {}),
			...(input.budget_tokens ? { budget_tokens: input.budget_tokens } : {}),
			...(typeDef?.readOnly ? { exclude_tools: EXCLUDE_EXPLORE } : typeDef?.review ? { exclude_tools: EXCLUDE_REVIEW } : {}),
			...(prior ? { after: prior.id } : {}),
		};
		const attachments = [
			...(prior
				? [
						attemptAttachment({
							path: prior.path,
							model: prior.model ?? "?",
							effort: prior.effort ?? "?",
							brief: prior.brief ?? prior.last_task ?? "",
							...(prior.last_task && prior.last_task !== prior.brief ? { lastInstruction: prior.last_task } : {}),
							report: prior.last_report ?? undefined,
						}),
					]
				: []),
			...this.attach(directory, input.files ?? []),
			...(input.fork_turns ? await this.forkTurns(sender.id, input.fork_turns) : []),
		];
		// two attempts on one model already: the third hears which attempt it is
		const tries = prior ? this.attemptsOn(prior, model) + 1 : 0;
		const notes = tries >= 3 ? [`this is attempt ${tries} on ${label}; if it falls short, step up or do it yourself.`] : [];
		const common = { sender, label, model, effort, agentType, typeDef, attachments };
		const stepUp = (a: AgentRow) => {
			if (!prior) return;
			// a step up changes the model or the effort; the same model at the same effort is a retry
			const kind = prior.model !== model || prior.effort !== effort ? "step_up" : "retry";
			this.metric(sender, kind, a, { from_id: prior.id, from_model: prior.model, from_effort: prior.effort, to_model: model, to_effort: effort, from_label: prior.seat, to_label: label });
		};
		if (!input.pool) {
			const a = await this.create({ ...common, name, brief: input.brief, options: base });
			stepUp(a);
			this.start(a);
			return { agents: [this.info(this.rows.get(a.id)!)], notes };
		}

		const n = Math.floor(input.pool.n);
		if (!(n >= 1 && n <= 16)) throw new ActorError("BadRequestError", 400, "a pool has 1 to 16 members");
		const collect = input.pool.collect ?? "all";
		const pool = { id: `pool_${randomUUID().replace(/-/g, "").slice(0, 12)}`, name, n, collect, any_n: Math.min(n, Math.max(1, input.pool.any_n ?? 1)), strategy: input.pool.strategy ?? "one_for_one" };
		// every member exists before any starts, so a member that fails at once still sees the whole pool
		const created: AgentRow[] = [];
		for (let i = 1; i <= n; i++) {
			const brief = input.pool.briefs?.[i - 1] ?? input.brief;
			created.push(await this.create({ ...common, name: `${name}_${i}`, brief, options: { ...base, pool: { ...pool, index: i } } }));
		}
		this.pools.set(pool.id, { id: pool.id, name, parentID: sender.id, members: created.map((a) => a.id), collect, anyN: pool.any_n, strategy: pool.strategy, reports: new Map(), done: false });
		for (const a of created) stepUp(a);
		for (const a of created) this.start(a);
		return { agents: created.map((a) => this.info(this.rows.get(a.id)!)), notes };
	}

	/**
	 * a model name to the model, effort and label a helper runs on. an alias goes through routing.jsonc;
	 * a provider/model-id (rest, or an agent type's frontmatter) is taken as written, with the effort of
	 * the alias that names the same model when there is one.
	 */
	private pick(named: string, effort?: Effort): { model: string; effort: Effort; label: string } {
		if (named.includes("/")) {
			const alias = this.routing.aliasOf(named);
			const e = effort ?? (alias ? this.routing.current().models[alias]!.effort : "medium");
			if (!this.routing.allowed(named, e)) {
				throw new ActorError("EffortNotAllowedError", 400, `${modelId(named)} never runs at ${e}; it runs at ${this.routing.allowedEfforts(named).join(", ")}`, { model: named, effort: e });
			}
			return { model: named, effort: e, label: alias ?? modelId(named) };
		}
		try {
			const r = this.routing.resolve(named, effort ? { effort } : {});
			return { model: r.model, effort: r.effort, label: r.alias };
		} catch (e) {
			if (e instanceof RoutingError) throw new ActorError(e.code === "unknown_model" ? "UnknownModelError" : "EffortNotAllowedError", 400, e.message, { code: e.code });
			throw e;
		}
	}

	/** an earlier helper of the sender's, by id, path or name like message, closed ones included (by id or path); it keeps running unless closed */
	private priorAttempt(sender: AgentRow, ref: string): AgentRow {
		const t = ref.trim();
		let row: AgentRow | undefined;
		try {
			row = this.resolve(sender, t, { closed: true });
		} catch (e) {
			if (!(e instanceof ActorError)) throw e;
		}
		if (!row || row.id === sender.id || row.root_id !== sender.root_id || !isAncestor(sender.path, row.path)) {
			throw new ActorError("BadRequestError", 400, `after names ${t}, which is not one of your agents`);
		}
		return row;
	}

	/** attempts on this model along a chain of after links, starting at `from` */
	private attemptsOn(from: AgentRow, model: string): number {
		let n = 0;
		const seen = new Set<string>();
		for (let a: AgentRow | undefined = from; a && !seen.has(a.id); ) {
			seen.add(a.id);
			if (a.model === model) n++;
			const next: string | undefined = json<AgentOptions>(a.options, {}).after;
			a = next ? this.rows.get(next) : undefined;
		}
		return n;
	}

	private attach(directory: string, files: string[]): string[] {
		return files.map((f) => {
			const path = isAbsolute(f) ? f : join(directory, f);
			if (!existsSync(path) || !statSync(path).isFile()) return `<file path="${f}">(not found)</file>`;
			const text = readFileSync(path, "utf8");
			return `<file path="${f}">\n${text.length > ATTACH_MAX ? `${text.slice(0, ATTACH_MAX)}\n(${text.length - ATTACH_MAX} more characters; read the file for the rest)` : text}\n</file>`;
		});
	}

	/** the spawner's last few exchanges, as context the child reads once in its brief */
	private async forkTurns(senderID: string, n: number): Promise<string[]> {
		const all = await this.host.messages(senderID, 0);
		const users = all.map((m, i) => ({ m, i })).filter((x) => x.m?.role === "user");
		const start = users.length > n ? users[users.length - n]!.i : 0;
		const lines = all
			.slice(start)
			.filter((m) => m?.role === "user" || m?.role === "assistant")
			.map((m) => {
				const t = typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
				return t.trim() ? `${m.role}: ${t.trim().slice(0, 4000)}` : "";
			})
			.filter(Boolean);
		return lines.length ? [`<spawner-context turns="${n}">\n${lines.join("\n\n")}\n</spawner-context>`] : [];
	}

	private async create(spec: { sender: AgentRow; name: string; label: string; model: string; effort: Effort; agentType: string; typeDef?: AgentType; brief: string; attachments: string[]; options: AgentOptions; respawns?: number }): Promise<AgentRow> {
		const { sender } = spec;
		const path = childPath(sender.path, spec.name);
		const live = this.rows.byPath(sender.root_id, path);
		if (live) throw new ActorError("PathTakenError", 409, `${path} is already live (${live.state}); message("${live.id}") gives it more work, or pick another name`, { path, id: live.id });
		const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		const systemExtra = helperFragment({ ...(spec.typeDef?.body ? { typeBody: spec.typeDef.body } : {}), ...(spec.typeDef?.readOnly ? { readOnly: true } : {}), ...(spec.typeDef?.review ? { review: true } : {}) });
		await this.host.createSession({
			id,
			parentID: sender.id,
			rootID: sender.root_id,
			directory: spec.options.directory ?? this.host.directory(sender.id) ?? process.cwd(),
			title: `${spec.name} (${spec.label})`,
			model: spec.model,
			effort: spec.effort,
			systemExtra,
			excludeTools: excludeFor(spec.options),
			...(spec.options.cache_ttl ? { cacheTtl: spec.options.cache_ttl } : {}),
		});
		const now = Date.now();
		const row: AgentRow = {
			id,
			root_id: sender.root_id,
			parent_id: sender.id,
			path,
			name: spec.name,
			depth: sender.depth + 1,
			seat: spec.label,
			agent_type: spec.agentType,
			model: spec.model,
			effort: spec.effort,
			state: "queued",
			cause: null,
			previous_state: null,
			brief: spec.brief,
			last_task: spec.brief,
			last_report: null,
			files: "[]",
			options: JSON.stringify(spec.options),
			delivered: 0,
			trigger_seq: 0,
			turn_tokens: 0,
			tokens: 0,
			respawns: spec.respawns ?? 0,
			created_at: now,
			updated_at: now,
			closed_at: null,
		};
		this.rows.put(row);
		this.host.publish(sender.id, "agent.spawned", { sessionID: sender.id, agent: this.info(row) });
		if ((this.opts.faults ?? []).includes(spec.name) && !spec.respawns) this.host.failNextTurn(id, "injected fault (CMX2_FAULT)");
		const envelope = taskEnvelope({ path, id, model: spec.model, effort: spec.effort, spawnerPath: sender.path, spawnerID: sender.id, brief: spec.brief, attachments: spec.attachments });
		this.envelopes.set(id, envelope);
		return this.rows.get(id)!;
	}

	/** posts a created agent's task, which starts its first turn when a slot is free */
	private start(a: AgentRow) {
		const envelope = this.envelopes.get(a.id);
		if (envelope === undefined) return;
		this.envelopes.delete(a.id);
		const spawner = this.rows.get(a.parent_id!)!;
		this.post(this.rows.get(a.id)!, { kind: "task", from: spawner, body: envelope, wake: true, system: true });
	}

	async message(senderID: string, input: { to: string; body: string; wake?: boolean; correlation_id?: string; kind?: MailKind }): Promise<{ to: string; id: string; state: AgentState; woke: boolean; pending: number }> {
		const sender = this.rowOf(senderID);
		if (!input.body?.trim()) throw new ActorError("BadRequestError", 400, "a message needs a body");
		const t = this.resolve(sender, input.to);
		if (t.id === sender.id) throw new ActorError("BadRequestError", 400, "that is you; message another agent");
		// a helper blocked on its question reads nothing else until it is answered, so any note from the agent it asked is the answer
		const ask = this.askFor(t.id, sender.id, input.correlation_id);
		if (ask) {
			this.asking.delete(ask.id);
			ask.resolve({ by: sender.path, text: input.body });
			this.host.publish(sender.root_id, "agent.message", { sessionID: sender.id, from: sender.path, to: t.path, toID: t.id, wake: false, length: input.body.length, correlation_id: ask.id });
			return { to: t.path, id: t.id, state: this.rows.get(t.id)!.state, woke: false, pending: this.rows.pending(t.id).length };
		}
		const wake = input.wake ?? true;
		if (wake && t.depth > 0) this.checkBudget(t.root_id);
		const fromParent = t.parent_id === sender.id;
		if (fromParent && wake) this.rows.update(t.id, { last_task: input.body, delivered: 0, turn_tokens: 0 });
		if (t.id === sender.parent_id) this.rows.update(sender.id, { delivered: 1 });
		const wasRunning = this.host.state(t.id) === "busy";
		this.post(t, { kind: input.kind ?? (fromParent ? "task" : "message"), from: sender, body: input.body, wake, system: false, ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}) });
		this.host.publish(sender.root_id, "agent.message", { sessionID: sender.id, from: sender.path, to: t.path, toID: t.id, wake, length: input.body.length, ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}) });
		const now = this.rows.get(t.id)!;
		return { to: t.path, id: t.id, state: now.state, woke: wake && !wasRunning, pending: this.rows.pending(t.id).length };
	}

	/**
	 * waits for mail in the caller's own mailbox. with a correlation id, only the matching reply ends
	 * the wait (and one already delivered answers at once). the slot is lent out while it waits.
	 */
	async wait(senderID: string, input: { timeout_ms?: number; correlation_id?: string }, signal?: AbortSignal): Promise<{ arrived: boolean; timed_out: boolean; waited_ms: number; items: Array<{ from: string | null; kind: string; correlation_id?: string; body?: string }>; already_delivered?: boolean; warning?: "missing_timeout" | "timeout_clamped" }> {
		const sender = this.rowOf(senderID);
		let timeout = input.timeout_ms;
		let warning: "missing_timeout" | "timeout_clamped" | undefined;
		if (timeout === undefined) {
			timeout = DEFAULT_WAIT_MS;
			warning = "missing_timeout";
		} else if (timeout > MAX_WAIT_MS) {
			timeout = MAX_WAIT_MS;
			warning = "timeout_clamped";
		} else if (timeout < MIN_WAIT_MS) timeout = MIN_WAIT_MS;
		const cid = input.correlation_id;
		const item = (m: MailRow) => ({ from: m.from_path, kind: m.kind, ...(m.correlation_id ? { correlation_id: m.correlation_id } : {}), ...(cid ? { body: m.body } : {}) });
		const t0 = Date.now();
		const extra = warning ? { warning } : {};
		if (cid) {
			const done = this.rows.deliveredCorrelated(sender.id, cid);
			if (done) return { arrived: true, timed_out: false, waited_ms: 0, items: [item(done)], already_delivered: true, ...extra };
			const pending = this.rows.pending(sender.id).find((m) => m.correlation_id === cid);
			if (pending) return { arrived: true, timed_out: false, waited_ms: 0, items: [item(pending)], ...extra };
		} else {
			const pending = this.rows.pending(sender.id);
			if (pending.length) return { arrived: true, timed_out: false, waited_ms: 0, items: pending.map(item), ...extra };
		}
		this.host.publish(sender.root_id, "agent.wait", { sessionID: sender.id, path: sender.path, timeout_ms: timeout, ...(cid ? { correlation_id: cid } : {}) });
		this.lend(sender);
		let set = this.waiters.get(sender.id);
		if (!set) this.waiters.set(sender.id, (set = new Set()));
		const got = await new Promise<MailRow | undefined>((resolve) => {
			const w: Waiter = { ...(cid ? { correlation: cid } : {}), resolve: (m) => finish(m) };
			const timer = setTimeout(() => finish(undefined), timeout);
			const onAbort = () => finish(undefined);
			signal?.addEventListener("abort", onAbort);
			const finish = (m: MailRow | undefined) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				set!.delete(w);
				resolve(m);
			};
			set!.add(w);
		});
		await this.reclaim(sender);
		const waited = Date.now() - t0;
		if (!got) {
			this.metric(sender, "sibling_deadlock", undefined, { timeout_ms: timeout, tool: "wait", ...(cid ? { correlation_id: cid } : {}) });
			return { arrived: false, timed_out: true, waited_ms: waited, items: [], ...extra };
		}
		return { arrived: true, timed_out: false, waited_ms: waited, items: [item(got)], ...extra };
	}

	/** the open question a note from `fromID` to `toID` answers: the one its correlation id names, else the oldest */
	private askFor(toID: string, fromID: string, correlation?: string): PendingAsk | undefined {
		const open = [...this.asking.values()].filter((q) => q.childID === toID && q.parentID === fromID);
		return open.find((q) => q.id === correlation) ?? open[0];
	}

	/** whether a helper has a question out to its spawner */
	isAsking(sessionID: string): boolean {
		for (const q of this.asking.values()) if (q.childID === sessionID) return true;
		return false;
	}

	/**
	 * a helper's question tool. the question goes to its spawner as mail (waking it when it is parked) and the call
	 * waits until the spawner answers with a message. the spawner answers from what it knows or asks further up with
	 * its own question tool, so at the root it reaches the user. the helper's slot is lent out while it waits. the
	 * call fails when the helper's turn stops, or when the spawner ends a turn that read the question without answering.
	 */
	async ask(sessionID: string, questions: QuestionPrompt[], signal?: AbortSignal): Promise<AgentAnswer> {
		const a = this.rowOf(sessionID);
		const parent = a.parent_id ? this.rows.get(a.parent_id) : undefined;
		if (!parent || parent.state === "closed") throw new ActorError("AgentNotFoundError", 404, "the agent that started you is gone, so nobody can answer; decide with what you have and say what you assumed");
		if (signal?.aborted) throw new Error("the turn was stopped before the question went out");
		const id = `ask_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		const mail = this.post(parent, { kind: "message", from: a, body: askBody(a, questions, id), wake: true, system: true, correlation_id: id, meta: { label: "question", questions: questions.length } });
		this.host.publish(a.root_id, "agent.message", { sessionID: a.id, from: a.path, to: parent.path, toID: parent.id, wake: true, length: mail.body.length, correlation_id: id });
		this.setState(a.id, "working", { cause: "asking" });
		this.lend(a);
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<AgentAnswer>((resolve, reject) => {
				this.asking.set(id, { id, childID: a.id, parentID: parent.id, mailID: mail.id, resolve, reject });
				onAbort = () => {
					if (this.asking.delete(id)) reject(new Error("the turn was stopped while the question waited for an answer"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			this.asking.delete(id);
			await this.reclaim(a);
			const now = this.rows.get(a.id);
			if (now?.state === "working" && now.cause === "asking" && !this.isAsking(a.id)) this.setState(a.id, "working", { cause: null });
		}
	}

	/** questions a spawner read in the turn that just ended and did not answer: the helpers go on without an answer */
	private settleUnanswered(parent: AgentRow) {
		for (const q of [...this.asking.values()]) {
			if (q.parentID !== parent.id || !this.rows.mail(q.mailID)?.delivered_at) continue;
			this.asking.delete(q.id);
			q.reject(new Error(`${parent.path} ended its turn without answering. decide with what you have and say what you assumed, or end your turn with ABORT(user_question): <the question>`));
		}
	}

	/** ends an agent for good, leaves first: its turn stops, its processes are reaped, it leaves the roster as a tombstone */
	async close(senderID: string, target: string, opts: { cause?: string; silent?: boolean } = {}): Promise<{ path: string; previous_state: AgentState; already_terminated: boolean; closed: string[] }> {
		const sender = this.rowOf(senderID);
		let t: AgentRow;
		try {
			t = this.resolve(sender, target, { closed: true });
		} catch (e) {
			if (e instanceof ActorError && e.name === "AgentClosedError") {
				const last = target.startsWith("/") ? this.rows.lastAtPath(sender.root_id, target) : this.rows.get(target);
				if (last) return { path: last.path, previous_state: "closed", already_terminated: true, closed: [] };
			}
			throw e;
		}
		if (t.depth === 0) throw new ActorError("BadRequestError", 400, "the root is the session itself; archive the session to end it");
		if (t.state === "closed") return { path: t.path, previous_state: "closed", already_terminated: true, closed: [] };
		const previous = t.state;
		const victims = this.rows
			.tree(t.root_id)
			.filter((a) => a.state !== "closed" && (a.id === t.id || isAncestor(t.path, a.path)))
			.sort((a, b) => b.depth - a.depth);
		const cause = opts.cause ?? "closed";
		for (const v of victims) await this.shut(v, sender.id, cause);
		const parent = t.parent_id ? this.rows.get(t.parent_id) : undefined;
		// the closer knows; a parent learns only when someone else (a sibling, the agent itself) closed its child
		if (parent && !opts.silent && sender.id !== parent.id && !isAncestor(sender.path, t.path)) {
			const body = reportBody({ header: `agent ${t.path} reached status: closed (closed by ${sender.path})`, body: "", warn: false, childID: t.id });
			this.post(parent, { kind: "report", from: this.rows.get(t.id)!, body, wake: false, system: true, meta: { label: "closed", child: t.id, closed_by: sender.path } });
		}
		this.refreshParked(t.root_id);
		return { path: t.path, previous_state: previous, already_terminated: false, closed: victims.map((v) => v.path) };
	}

	private async shut(v: AgentRow, by: string, cause: string) {
		const prev = v.state;
		if (this.host.state(v.id) === "busy") {
			this.interrupting.set(v.id, { by, cause: "closed" });
			await this.host.interrupt(v.id).catch(() => {});
		}
		this.runningOf(v.root_id).delete(v.id);
		const q = this.queueOf(v.root_id);
		for (let i = q.length - 1; i >= 0; i--) if (q[i]!.id === v.id && !q[i]!.resolve) q.splice(i, 1);
		this.setState(v.id, "closed", { cause, previous_state: prev, closed_at: Date.now() });
		await this.host.end(v.id).catch(() => {});
		this.host.publish(v.root_id, "agent.closed", { sessionID: v.root_id, agent: this.info(this.rows.get(v.id)!), cause });
		this.grantNext(v.root_id);
	}

	/** a person stopped a subagent's turn from a client; its spawner gets a partial report */
	userInterrupt(id: string) {
		if (this.rows.get(id)) this.interrupting.set(id, { by: "user", cause: "interrupted" });
	}

	/** stops an agent's current turn; it stays parked-resumable with its transcript, and a message continues it */
	async interrupt(senderID: string, target: string): Promise<{ path: string; previous_state: AgentState; interrupted: boolean }> {
		const sender = this.rowOf(senderID);
		const t = this.resolve(sender, target);
		if (t.depth === 0 && t.id !== sender.id) throw new ActorError("BadRequestError", 400, "the root's turn is the user's to stop");
		const previous = t.state;
		if (this.host.state(t.id) !== "busy") {
			if (t.state === "queued") {
				const q = this.queueOf(t.root_id);
				for (let i = q.length - 1; i >= 0; i--) if (q[i]!.id === t.id && !q[i]!.resolve) q.splice(i, 1);
				this.setState(t.id, "interrupted", { cause: "interrupted" });
				return { path: t.path, previous_state: previous, interrupted: true };
			}
			return { path: t.path, previous_state: previous, interrupted: false };
		}
		this.interrupting.set(t.id, { by: sender.id, cause: "interrupted" });
		await this.host.interrupt(t.id);
		return { path: t.path, previous_state: previous, interrupted: true };
	}

	// ---------- the watcher ----------

	/** the engine's turn boundaries for every session: state, the cap, reports, supervision */
	onTurn(sessionID: string, e: TurnEvent) {
		const a = this.rows.get(sessionID);
		if (!a) {
			// a root that has no agents yet only matters for the parked state of nothing
			return;
		}
		if (e.type === "start") {
			if (a.depth > 0) {
				this.runningOf(a.root_id).add(a.id);
				const q = this.queueOf(a.root_id);
				for (let i = q.length - 1; i >= 0; i--) if (q[i]!.id === a.id && !q[i]!.resolve) q.splice(i, 1);
			}
			if (a.state !== "closed") this.setState(a.id, "working", { cause: null });
			this.refreshParked(a.id);
			return;
		}
		void this.turnEnded(a, e).catch((err) => console.error(`cmx2: agent ${a.path} turn end: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
	}

	private async turnEnded(a: AgentRow, e: Extract<TurnEvent, { type: "end" }>) {
		if (a.depth > 0) this.runningOf(a.root_id).delete(a.id);
		this.settleUnanswered(a);
		const intr = this.interrupting.get(a.id);
		this.interrupting.delete(a.id);
		const now = this.rows.get(a.id)!;
		if (now.state === "closed") {
			this.grantNext(a.root_id);
			this.refreshParked(a.id);
			return;
		}
		const aborted = e.outcome === "aborted";
		this.setState(a.id, aborted ? "interrupted" : "parked", aborted ? { cause: intr?.cause === "budget" ? "budget" : "interrupted" } : {});
		if (a.depth > 0) await this.report(this.rows.get(a.id)!, e, intr);
		// mail that came in after the loop's last look starts the next turn (not after an interrupt: that would undo it)
		const after = this.rows.get(a.id)!;
		if (!aborted && after.state !== "closed" && this.rows.pending(a.id).some((m) => m.wake)) this.requestTurn(after);
		this.grantNext(a.root_id);
		this.refreshParked(a.id);
	}

	private async report(a: AgentRow, e: Extract<TurnEvent, { type: "end" }>, intr?: { by: string; cause: string }) {
		const parent = a.parent_id ? this.rows.get(a.parent_id) : undefined;
		if (!parent) return;
		const byAncestor = intr && intr.by !== "budget" && (intr.by === parent.id || isAncestor(this.rows.get(intr.by)?.path ?? "\0", a.path));
		if (e.outcome === "aborted" && intr?.cause !== "budget" && (byAncestor || !intr)) return;
		const opts = json<AgentOptions>(a.options, {});
		const turn = await this.host.messages(a.id, e.from, e.to);
		const raw = extractDeliverable(turn);
		const files = [...new Set([...json<string[]>(a.files, []), ...filesTouched(turn), ...(e.files ?? [])])];
		const substantive = !looksLikeMissingDeliverable(raw);
		const explicit = a.delivered === 1;
		const warn = !explicit && !substantive;
		const failed = e.outcome === "errored";
		let overrideAbort: { reason: string; details: string } | undefined;
		if (failed && !opts.pool) {
			if (opts.on_failure === "ignore") {
				this.rows.update(a.id, { last_report: `failed: ${e.error ?? "unknown error"}`, files: JSON.stringify(files) });
				return;
			}
			if (opts.on_failure === "respawn") {
				if (a.respawns < MAX_RESPAWNS) {
					await this.respawn(a, parent, e.error ?? "unknown error");
					return;
				}
				overrideAbort = { reason: "transient_tool_error", details: `respawn cap reached after ${MAX_RESPAWNS} attempts` };
			}
		}
		const label = failed ? "failed" : e.outcome === "aborted" ? "partial" : "parked";
		const lines = [`agent ${a.path} reached status: ${label}`];
		if (failed) lines.push(`error: ${(e.refusal ? `refused by ${e.refusal}: ` : "") + (e.error ?? "unknown").slice(0, 600)}`);
		if (intr?.cause === "budget") lines.push(`it stopped at its token budget (${opts.budget_tokens ?? this.routing.current().caps.budget_tokens} tokens); what it had so far is below. message it to continue`);
		else if (intr && !byAncestor) lines.push(`${intr.by === "user" ? "the user" : (this.rows.get(intr.by)?.path ?? intr.by)} stopped its turn; what it had so far is below. message it to continue`);
		const abort = overrideAbort ?? parseAbort(raw);
		const contract = resolveContract(a.agent_type ?? undefined, opts.behavior_version);
		const violations = computeViolations(contract, { delivered: explicit || substantive, ...(abort ? { abort } : {}) });
		const shown = failed ? failedTurnBody(turn, raw) : raw;
		const body = capBody(shown, a.id);
		const content = reportBody({ header: lines.join("\n"), body, warn, childID: a.id });
		const meta: Record<string, unknown> = {
			label,
			child: a.id,
			...(abort ? { abort_reason: abort } : {}),
			...(contract && violations.length ? { behavior_violation: { contract_version: contract.version, violations } } : {}),
		};
		this.rows.update(a.id, { last_report: (failed ? `${lines.join("\n")}${shown ? `\n\n${shown}` : ""}` : raw || lines.join("\n")).slice(0, 4000), files: JSON.stringify(files), delivered: 0 });
		const source = explicit ? "explicit_send" : warn ? "safety_net" : "extracted";
		this.metric(parent, "deliverable_arrived", a, { source, body_length: raw.length, child_path: a.path });
		if (warn) this.metric(parent, "safety_net_fired", a, { child_path: a.path });
		this.host.publish(a.root_id, "agent.report", { sessionID: parent.id, from: a.path, childID: a.id, label, body_length: raw.length, ...(abort ? { abort_reason: abort } : {}), ...(meta.behavior_violation ? { behavior_violation: meta.behavior_violation } : {}) });
		if (opts.pool) {
			this.poolReport(a, parent, opts.pool, { label, body: capBody(shown, a.id, 4000), failed });
			return;
		}
		this.post(parent, { kind: "report", from: a, body: content, wake: true, system: true, meta });
	}

	private async respawn(a: AgentRow, parent: AgentRow, error: string) {
		const attempt = a.respawns + 1;
		await this.shut(a, parent.id, "respawned");
		this.post(parent, {
			kind: "system",
			from: a,
			body: `agent ${a.path} reached status: failed (${error.slice(0, 300)}); it was respawned in a fresh session, attempt ${attempt}/${MAX_RESPAWNS}`,
			wake: false,
			system: true,
			meta: { label: "failed", child: a.id, abort_reason: { reason: "transient_tool_error", details: `respawned after a failure; attempt ${attempt}/${MAX_RESPAWNS}` } },
		});
		const opts = json<AgentOptions>(a.options, {});
		const directory = this.host.directory(parent.id) ?? process.cwd();
		const typeDef = a.agent_type && a.agent_type !== "general" ? (BUILTIN[a.agent_type] ?? this.opts.agentType?.(directory, a.agent_type)) : undefined;
		// the row's own model and effort: a respawn is the same helper in a fresh session, whatever the table says now
		const model = a.model ?? Object.values(this.routing.current().models)[0]!.ref;
		const fresh = await this.create({ sender: parent, name: a.name, label: a.seat ?? this.routing.aliasOf(model) ?? modelId(model), model, effort: (a.effort as Effort) ?? "medium", agentType: a.agent_type ?? "general", ...(typeDef ? { typeDef } : {}), brief: a.last_task ?? a.brief ?? "", attachments: [], options: opts, respawns: attempt });
		this.start(fresh);
	}

	private poolOf(id: string, parent: AgentRow): PoolState {
		let p = this.pools.get(id);
		if (p) return p;
		// rebuilt after a restart from the members' rows; reports that arrived before it are gone
		const members = this.rows.children(parent.id).filter((m) => json<AgentOptions>(m.options, {}).pool?.id === id);
		const spec = json<AgentOptions>(members[0]?.options, {}).pool!;
		p = { id, name: spec.name, parentID: parent.id, members: members.sort((x, y) => json<AgentOptions>(x.options, {}).pool!.index - json<AgentOptions>(y.options, {}).pool!.index).map((m) => m.id), collect: spec.collect, anyN: spec.any_n, strategy: spec.strategy, reports: new Map(), done: false };
		this.pools.set(id, p);
		return p;
	}

	/** pool members report to the collector; the spawner gets one combined report when the collect rule is met */
	private poolReport(a: AgentRow, parent: AgentRow, spec: NonNullable<AgentOptions["pool"]>, rep: { label: string; body: string; failed: boolean }) {
		const p = this.poolOf(spec.id, parent);
		if (p.done) return;
		p.reports.set(a.id, { path: a.path, ...rep });
		if (rep.failed && p.strategy !== "one_for_one") {
			const victims = p.members.filter((m, i) => m !== a.id && (p.strategy === "one_for_all" || i + 1 > spec.index) && !p.reports.has(m));
			void (async () => {
				for (const v of victims) {
					const row = this.rows.get(v);
					if (row && row.state !== "closed") await this.shut(row, parent.id, "pool_failed");
				}
				this.finishPool(p, parent, `${a.path} failed; ${p.strategy} closed ${victims.length ? victims.map((v) => this.rows.get(v)?.path).join(", ") : "nothing else"}`);
			})();
			return;
		}
		const ok = [...p.reports.values()].filter((r) => !r.failed).length;
		const live = p.members.filter((m) => this.rows.get(m)?.state !== "closed" || p.reports.has(m)).length;
		const met = p.collect === "all" ? p.reports.size >= live : p.collect === "first" ? ok >= 1 : ok >= p.anyN;
		if (!met) return;
		const rest = p.members.filter((m) => !p.reports.has(m));
		void (async () => {
			for (const v of rest) {
				const row = this.rows.get(v);
				if (row && row.state !== "closed") await this.shut(row, parent.id, "pool_collected");
			}
			this.finishPool(p, parent, rest.length ? `closed the rest: ${rest.map((v) => this.rows.get(v)?.path).join(", ")}` : undefined);
		})();
	}

	private finishPool(p: PoolState, parent: AgentRow, note?: string) {
		if (p.done) return;
		p.done = true;
		const reports = p.members.filter((m) => p.reports.has(m)).map((m) => p.reports.get(m)!);
		const header = `pool ${p.name} (${p.members.length} agents, collect ${p.collect}, ${p.strategy}): ${reports.length} reported${note ? `; ${note}` : ""}`;
		const body = reports.map((r) => `agent ${r.path} reached status: ${r.label}\n${r.body || "<no text emitted>"}`).join("\n\n");
		this.post(parent, { kind: "report", from: null, body: `${header}\n\n${body}`, wake: true, system: true, meta: { label: "pool", pool: { id: p.id, name: p.name, reported: reports.length, members: p.members.length } } });
	}

	// ---------- budget ----------

	/** tokens a tree has spent: input, output and cache writes (cache reads are the cheap re-read of a prefix) */
	treeTokens(root: string): number {
		return this.rows.tree(root).reduce((n, a) => n + a.tokens, 0);
	}

	private checkBudget(root: string) {
		const budget = this.routing.current().caps.budget_tokens;
		if (budget === null || budget === undefined) return;
		const used = this.treeTokens(root);
		if (used >= budget) throw new ActorError("BudgetExceededError", 409, `this session's agents have spent ${used} of the ${budget} token budget; raise caps.budget_tokens in routing.jsonc to go on`, { used, budget });
	}

	onStep(sessionID: string, step: { input: number; output: number; cache_write: number }) {
		const a = this.rows.get(sessionID) ?? (this.host.exists(sessionID) ? this.ensureRoot(sessionID) : undefined);
		if (!a) return;
		const t = (step.input ?? 0) + (step.output ?? 0) + (step.cache_write ?? 0);
		this.rows.update(a.id, { tokens: a.tokens + t, turn_tokens: a.turn_tokens + t });
		const opts = json<AgentOptions>(a.options, {});
		if (a.depth > 0 && opts.budget_tokens && a.turn_tokens + t >= opts.budget_tokens && this.host.state(a.id) === "busy" && !this.interrupting.has(a.id)) {
			this.interrupting.set(a.id, { by: "budget", cause: "budget" });
			void this.host.interrupt(a.id);
		}
		const budget = this.routing.current().caps.budget_tokens;
		if (budget && this.treeTokens(a.root_id) >= budget) {
			for (const c of this.rows.tree(a.root_id)) {
				if (c.depth > 0 && this.host.state(c.id) === "busy" && !this.interrupting.has(c.id)) {
					this.interrupting.set(c.id, { by: "budget", cause: "budget" });
					void this.host.interrupt(c.id);
				}
			}
		}
	}

	// ---------- metrics ----------

	private metric(at: AgentRow, kind: string, child: AgentRow | undefined, data: Record<string, unknown>) {
		this.rows.metric({ root_id: at.root_id, session_id: at.id, kind, child_id: child?.id ?? null, data });
		this.host.publish(at.root_id, `agent.metric.${kind}`, { sessionID: at.id, ...(child ? { childID: child.id } : {}), ...data });
	}

	/** a verb call that failed in a way the model can recover from (full mailbox, unknown target, a cap) */
	toolError(sessionID: string, tool: string, kind: string) {
		const a = this.rows.get(sessionID);
		if (a) this.metric(a, "subagent_tool_error", undefined, { tool, error_kind: kind });
	}

	/** the rates the stats digest asks for, over one tree */
	metrics(sessionID: string) {
		const me = this.rowOf(sessionID);
		const rows = this.rows.metrics(me.root_id);
		const arrived = rows.filter((r) => r.kind === "deliverable_arrived").map((r) => json<{ source: string }>(r.data, { source: "" }));
		const waits = rows.filter((r) => r.kind === "sibling_deadlock").length;
		const steps = this.rows.tree(me.root_id).length;
		return {
			root: me.root_id,
			reports: arrived.length,
			deliverable_arrival_rate: arrived.length ? arrived.filter((a) => a.source !== "safety_net").length / arrived.length : 0,
			safety_net_firing_rate: arrived.length ? arrived.filter((a) => a.source === "safety_net").length / arrived.length : 0,
			wait_timeouts: waits,
			tool_errors: rows.filter((r) => r.kind === "subagent_tool_error").length,
			agents: steps,
			events: rows.map((r) => ({ at: r.at, kind: r.kind, session: r.session_id, child: r.child_id, ...json<Record<string, unknown>>(r.data, {}) })),
		};
	}

	// ---------- parked ----------

	/** when each session last became parked, so a status can say since when */
	private readonly parkedSince = new Map<string, number>();

	/** ms since a session has been parked on its current wait, or undefined when it is not parked */
	parkedAt(sessionID: string): number | undefined {
		return this.parkedOf(sessionID) ? this.parkedSince.get(sessionID) : undefined;
	}

	/** every session in any tree that is parked right now */
	parkedSessions(): string[] {
		const out: string[] = [];
		for (const a of this.rows.inState("parked", "interrupted")) if (this.parkedOf(a.id)) out.push(a.id);
		return out;
	}

	/** what a parked session waits on: working or queued agents under it, and jobs that will notify it */
	parkedOf(sessionID: string): { agents: number; jobs: number } | undefined {
		if (this.host.state(sessionID) === "busy") return undefined;
		const a = this.rows.get(sessionID);
		const agents = a ? this.rows.tree(a.root_id).filter((c) => (c.state === "working" || c.state === "queued") && isAncestor(a.path, c.path)).length : 0;
		const jobs = this.host.liveJobs(sessionID);
		return agents || jobs ? { agents, jobs } : undefined;
	}

	/** republishes the parked state of a session and its ancestors when it moved */
	refreshParked(sessionID: string) {
		let a = this.rows.get(sessionID);
		const seen = new Set<string>();
		while (a && !seen.has(a.id)) {
			seen.add(a.id);
			const parked = this.parkedOf(a.id);
			const now = JSON.stringify(parked ?? null);
			if (parked && !this.parkedSince.has(a.id)) this.parkedSince.set(a.id, Date.now());
			if (!parked) this.parkedSince.delete(a.id);
			if (this.lastParked.get(a.id) !== now) {
				this.lastParked.set(a.id, now);
				this.host.statusChanged(a.id);
			}
			a = a.parent_id ? this.rows.get(a.parent_id) : undefined;
		}
	}

	// ---------- text for the model ----------

	/** the agents under a session that are not closed */
	private liveUnder(sessionID: string): { me: AgentRow; live: AgentRow[] } | undefined {
		const me = this.rows.get(sessionID);
		if (!me) return undefined;
		return { me, live: this.rows.tree(me.root_id).filter((a) => isAncestor(me.path, a.path) && a.state !== "closed") };
	}

	/**
	 * the one line the turn context carries about a session's helpers, sent when its counts change: the roster itself is read
	 * with the agents tool (a list in every turn grew the root's transcript by about 312k tokens in one build)
	 */
	helpersText(sessionID: string): string | undefined {
		const u = this.liveUnder(sessionID);
		if (!u?.live.length) return undefined;
		const working = u.live.filter((a) => a.state === "working" || a.state === "queued").length;
		const stopped = u.live.filter((a) => a.state === "interrupted").length;
		return `helpers: ${working} working, ${u.live.length - working - stopped} parked${stopped ? `, ${stopped} stopped` : ""}; agents lists them.`;
	}

	/**
	 * the compact roster a compaction carries over (the post-compaction state block only; turns carry `helpersText`): live agents,
	 * one line each, enough to message or close one
	 */
	rosterText(sessionID: string): string | undefined {
		const u = this.liveUnder(sessionID);
		if (!u?.live.length) return undefined;
		const lines = u.live.map((a) => `- ${a.path.slice(u.me.path.length + 1)} · ${a.seat ?? "agent"} · ${a.effort ?? "?"} · ${a.state} · id ${a.id}`);
		return [`agents under you (message(id) continues one; the agents tool lists more):`, ...lines].join("\n");
	}

	/** the model table, guide and rules for sessions that may spawn */
	routingText(sessionID: string): string | undefined {
		const a = this.rows.get(sessionID);
		const depth = a?.depth ?? 0;
		// a helper's header does not say anything about "your own model": the user's choice is the root's business
		const text = this.routing.render({ canSpawn: depth < this.routing.current().caps.depth, helper: depth > 0 });
		return text || undefined;
	}

	/** core tools a helper does not get, read from its row so a fresh session and a reopened one agree */
	excludedTools(sessionID: string): string[] {
		const a = this.rows.get(sessionID);
		if (!a || a.depth === 0) return [];
		return excludeFor(json<AgentOptions>(a.options, {}));
	}

	/** whether a parked child's cache is kept warm, and for how long */
	warmFor(sessionID: string): { enabled: boolean; horizonMs: number } {
		const a = this.rows.get(sessionID);
		if (!a || a.depth === 0 || a.state === "closed") return { enabled: false, horizonMs: 0 };
		const opts = json<AgentOptions>(a.options, {});
		return { enabled: opts.warm ?? true, horizonMs: this.opts.warmHorizonMs ?? 20 * 60_000 };
	}

	// ---------- session lifecycle ----------

	/** the user stopped the root's turn: children keep running, and the root hears who is still out */
	onUserAbort(sessionID: string) {
		const a = this.rows.get(sessionID);
		if (!a) return;
		const out = this.rows.tree(a.root_id).filter((c) => isAncestor(a.path, c.path) && (c.state === "working" || c.state === "queued"));
		if (!out.length) return;
		this.post(a, { kind: "system", from: null, body: `you stopped the turn. these agents are still running and will report when they end:\n${out.map((c) => `- ${c.path} (${c.state})`).join("\n")}`, wake: false, system: true, meta: { label: "survivors" } });
	}

	/** the session ended (archived): every agent under it is closed and kept as a tombstone */
	async onSessionEnded(sessionID: string) {
		const a = this.rows.get(sessionID);
		if (!a) return;
		const victims = this.rows
			.tree(a.root_id)
			.filter((c) => c.state !== "closed" && isAncestor(a.path, c.path))
			.sort((x, y) => y.depth - x.depth);
		for (const v of victims) await this.shut(v, a.id, "session_ended");
	}

	/**
	 * after a daemon start: identity is in the rows, mail in the mailbox. agents that were mid-turn are
	 * interrupted (their spawner hears it and can message them to continue); queued ones and any mail
	 * that should wake someone get their turn.
	 */
	reconcile(): { interrupted: string[]; woken: string[] } {
		const interrupted: string[] = [];
		for (const a of this.rows.inState("working")) {
			this.rows.update(a.id, { state: a.depth === 0 ? "parked" : "interrupted", previous_state: "working", cause: a.depth === 0 ? null : "daemon_restart" });
			if (a.depth === 0) continue;
			interrupted.push(a.path);
			const parent = a.parent_id ? this.rows.get(a.parent_id) : undefined;
			if (parent && parent.state !== "closed") {
				this.post(parent, {
					kind: "system",
					from: a,
					body: `agent ${a.path} reached status: interrupted (the daemon restarted during its turn). its transcript is intact; message("${a.id}") continues it`,
					wake: true,
					system: true,
					meta: { label: "interrupted", child: a.id },
				});
			}
		}
		const woken: string[] = [];
		for (const { to_id } of this.rows.wakeable()) {
			const a = this.rows.get(to_id);
			if (!a || a.state === "closed") continue;
			if (a.state === "queued") this.rows.update(a.id, { state: "parked" });
			woken.push(a.path);
			this.requestTurn(this.rows.get(a.id)!);
		}
		return { interrupted, woken };
	}
}
