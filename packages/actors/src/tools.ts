import { defineTool, type Tool, type ToolResult, text } from "@cmx2/tools";
import { Type } from "typebox";
import { ActorError, type Actors, type AgentInfo } from "./actors.ts";

/**
 * the agent verbs as the model sees them: spawn, message, wait and agents (run is the fifth; its
 * agents.* helpers call these). descriptions say what each does and never change with config, so they
 * stay byte-identical in every prefix; the models and the guide arrive in the appended routing table.
 */

const EFFORT = Type.Union(["low", "medium", "high", "xhigh", "max"].map((e) => Type.Literal(e)));

const SPAWN = `start a helper agent on a task and get its id back at once. it runs in its own session with its own context and starts with none of yours. when it ends its turn, its final text reaches you as a report and wakes you if your turn has ended. it stays addressable afterwards: message(id) gives it a follow-up and it carries on with everything it already knows.

model names one of the models in the table in your context, and effort moves that model's default up or down within what it allows. after names an earlier helper whose attempt this one takes over; its brief and last report ride along. brief is the whole task: goal, constraints, definition of done, the files it owns, and the shape of report you want. pool starts n helpers on the same brief (or one brief each) and sends one combined report when its collect rule is met.`;

const MESSAGE = `send a note to another agent in your tree. to is an id, a path such as /root/worker_a, a child's name, or parent. a running agent reads it at its next step; with wake (the default) an agent whose turn has ended starts a turn for it, and a parked agent comes back with its full history. correlation_id pairs a reply with a request so wait can wait for exactly that reply. each mailbox holds 32 unread notes; a full one answers mailbox_full, so retry once it has caught up.`;

const WAIT = `wait until a note or a report arrives in your mailbox, or until the timeout passes. it tells you what arrived and from whom; the notes themselves land in your context right after it returns. with correlation_id it waits for that reply only, and answers at once if the reply already reached you. when only children or jobs remain, ending your turn is cheaper than waiting, because their reports wake you.`;

const AGENTS = `the agents in your tree: path, model, effort, state (queued waits for a free slot, working, parked is idle and free, interrupted, closed), context size and cost per step, files they touched and their last report. close ends an agent and everything under it for good (their transcripts stay on disk). interrupt stops its current turn and keeps it resumable: a message continues it. return_to sends a parked agent a follow-up, the same as message with wake.`;

function ok(t: string, details: unknown): ToolResult {
	return { content: [text(t)], details, structuredContent: details };
}

function fail(actors: Actors, sessionID: string, tool: string, e: unknown): ToolResult {
	if (e instanceof ActorError) {
		actors.toolError(sessionID, tool, e.name);
		return { content: [text(`${e.name}: ${e.message}`)], details: { error: e.name, ...e.data }, isError: true };
	}
	throw e;
}

/** a verb's answer, or an error as soon as the turn is stopped: the verb goes on, the stopped turn does not wait for it */
function orStop<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	const stopped = () => new Error("the turn was stopped before the call finished; it goes on without you");
	if (signal.aborted) {
		work.catch(() => {});
		return Promise.reject(stopped());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(stopped());
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

function line(a: AgentInfo): string {
	return `${a.path} (id ${a.id}): ${a.seat ?? "agent"} on ${a.model?.split("/").pop() ?? "?"} at ${a.effort ?? "?"}, ${a.state}`;
}

/** dollars: to the cent, or finer when the amount is small */
function dollars(n: number): string {
	return n >= 0.1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
}

/** one agent in the list: who, what it runs on, how big its context is and what it costs, then what it did */
/**
 * a roster entry as the agent at `self` sees it. `why` is a spawner's reasoning about a helper's model and effort, so
 * it shows only on agents below `self`, never on itself, its spawners or its siblings: a helper is not told why it
 * runs on what it runs on (DECISIONS D27)
 */
export function rosterFor(self: string, a: AgentInfo): AgentInfo {
	if (a.why === undefined || a.path.startsWith(`${self}/`)) return a;
	const { why: _why, ...rest } = a;
	return rest;
}

function rosterLine(a: AgentInfo): string {
	const size = a.contextTokens !== undefined ? ` · ctx ${Math.round(a.contextTokens / 1000)}k` : "";
	const step = a.lastStepCost !== undefined ? ` · $${dollars(a.lastStepCost)}/step` : "";
	const total = a.cost !== undefined ? ` · $${dollars(a.cost)} total` : "";
	return `- ${a.path} · ${a.seat ?? "agent"} · ${a.model?.split("/").pop() ?? "?"} · ${a.effort ?? "?"} · ${a.state}${a.cause ? ` (${a.cause})` : ""}${size}${step}${total}${a.files.length ? ` · files: ${a.files.slice(0, 5).join(", ")}` : ""}${a.why ? ` · why: ${a.why.split("\n")[0]!.slice(0, 120)}` : ""}${a.lastReport ? ` · last: ${a.lastReport.split("\n")[0]!.slice(0, 120)}` : ""} · id ${a.id}`;
}

export function agentTools(actors: Actors, sessionID: string): Tool[] {
	const spawn = defineTool({
		name: "spawn",
		label: "spawn",
		description: SPAWN,
		parameters: Type.Object({
			brief: Type.String({ description: "the task: goal, constraints, definition of done, files it owns, report shape" }),
			model: Type.Optional(Type.String({ description: "a model name from the models table in your context; a custom agent type may bring its own" })),
			name: Type.Optional(Type.String({ description: "lowercase name for its path; made from the brief when omitted" })),
			effort: Type.Optional(EFFORT),
			after: Type.Optional(Type.String({ description: "id, path or name of an earlier helper whose attempt this one takes over; its brief and last report ride along, and it keeps running unless you close it" })),
			agent_type: Type.Optional(Type.String({ description: "general (default), explore (reads and searches), review (reads and runs commands), or a type from .cmx2/agent. explore and review cannot write files: their final reply is their deliverable, and the daemon saves it to a file the report names" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "files whose contents ride along with the brief. a helper's report names a file holding its whole text, and that path can be passed on here" })),
			fork_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "copy your last n exchanges into its brief as context" })),
			on_failure: Type.Optional(Type.Union([Type.Literal("escalate"), Type.Literal("respawn"), Type.Literal("ignore")], { description: "when its turn fails: report it (default), start it again in a fresh session up to 3 times, or say nothing" })),
			pool: Type.Optional(
				Type.Object({
					n: Type.Integer({ minimum: 1, maximum: 16 }),
					collect: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("first"), Type.Literal("any_n")], { description: "report when all have reported (default), after the first success (the rest are closed), or after any_n successes" })),
					any_n: Type.Optional(Type.Integer({ minimum: 1 })),
					strategy: Type.Optional(Type.Union([Type.Literal("one_for_one"), Type.Literal("one_for_all"), Type.Literal("rest_for_one")], { description: "when a member fails: only it (default), close all the others, or close the ones started after it" })),
					briefs: Type.Optional(Type.Array(Type.String(), { description: "one brief per member instead of the shared one" })),
				}),
			),
			cache_ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")], { description: "1h for an agent you expect to come back to after a long while" })),
			why: Type.Optional(Type.String({ description: "why this model and effort, in one line; it goes to the agent tree and the metrics, never to the helper" })),
			directory: Type.Optional(Type.String({ description: "where it works instead of your directory, such as a checkout from worktree_create" })),
		}),
		async execute(_id, params) {
			try {
				const { agents: out, notes } = await actors.spawnWithNotes(sessionID, params, { model: true });
				const first = out[0]!;
				const head = out.length === 1 ? `spawned ${line(first)}.` : `spawned a pool of ${out.length}:\n${out.map((a) => `- ${line(a)}`).join("\n")}`;
				const tail = out.length === 1 ? `its report arrives as a message when it ends its turn. to continue it later: message("${first.id}").` : "one combined report arrives when the pool's collect rule is met.";
				return ok([head, tail, ...notes].join("\n"), { agents: out, child_session_id: first.id, id: first.id, path: first.path, ...(notes.length ? { notes } : {}) });
			} catch (e) {
				return fail(actors, sessionID, "spawn", e);
			}
		},
	});

	const message = defineTool({
		name: "message",
		label: "message",
		description: MESSAGE,
		parameters: Type.Object({
			to: Type.String({ description: "id, path, name, or parent" }),
			body: Type.String(),
			wake: Type.Optional(Type.Boolean({ description: "start its turn if it has ended; default true" })),
			correlation_id: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String(), { description: "files whose contents ride along with the note, cut like spawn's. a helper's report names a file holding its whole text, and that path can be passed on here" })),
		}),
		async execute(_id, params) {
			try {
				const r = await actors.message(sessionID, params);
				return ok(`delivered to ${r.to} (${r.state}${r.woke ? ", woken" : ""}); ${r.pending} unread in its mailbox.`, r);
			} catch (e) {
				return fail(actors, sessionID, "message", e);
			}
		},
	});

	const wait = defineTool({
		name: "wait",
		label: "wait",
		description: WAIT,
		parameters: Type.Object({
			timeout_ms: Type.Optional(Type.Integer({ minimum: 0, description: "1000 to 600000; 30000 when omitted" })),
			correlation_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal) {
			try {
				const r = await actors.wait(sessionID, params, signal);
				const warn = r.warning === "missing_timeout" ? " (no timeout given; waited up to 30 s)" : r.warning === "timeout_clamped" ? " (timeout clamped to 600 s)" : "";
				if (!r.arrived) return ok(`timed out after ${Math.round(r.waited_ms / 1000)} s with nothing new${warn}.`, r);
				const what = r.items.map((i) => `${i.kind} from ${i.from ?? "the runtime"}${i.correlation_id ? ` (correlation ${i.correlation_id})` : ""}${i.body ? `:\n${i.body}` : ""}`).join("\n");
				return ok(`${r.already_delivered ? "already delivered earlier" : "arrived"}${warn}: ${what}`, r);
			} catch (e) {
				return fail(actors, sessionID, "wait", e);
			}
		},
	});

	const agents = defineTool({
		name: "agents",
		label: "agents",
		description: AGENTS,
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("close"), Type.Literal("interrupt"), Type.Literal("return_to")], { description: "list when omitted" })),
			target: Type.Optional(Type.String({ description: "id, path or name, for close, interrupt and return_to" })),
			body: Type.Optional(Type.String({ description: "the follow-up, for return_to" })),
			path_prefix: Type.Optional(Type.String({ description: "list only this part of the tree" })),
		}),
		async execute(_id, params, signal) {
			try {
				const action = params.action ?? "list";
				if (action === "list") {
					const r = actors.roster(sessionID, params.path_prefix);
					const seen = { ...r, agents: r.agents.map((a) => rosterFor(r.self, a)) };
					const rows = seen.agents.map(rosterLine);
					return ok(`you are ${r.self}.\n${rows.join("\n")}`, seen);
				}
				if (!params.target) return { content: [text(`${action} needs a target`)], details: { error: "BadRequestError" }, isError: true };
				if (action === "close") {
					const r = await orStop(actors.close(sessionID, params.target), signal);
					return ok(r.already_terminated ? `${r.path} was already closed.` : `closed ${r.closed.join(", ")} (was ${r.previous_state}). transcripts stay on disk.`, { ...r, ...(r.already_terminated ? { error: "already_terminated" } : {}) });
				}
				if (action === "interrupt") {
					const r = await orStop(actors.interrupt(sessionID, params.target), signal);
					return ok(r.interrupted ? `interrupted ${r.path}; it keeps its history and a message continues it.` : `${r.path} was not running (${r.previous_state}).`, r);
				}
				if (!params.body) return { content: [text("return_to needs a body: the follow-up")], details: { error: "BadRequestError" }, isError: true };
				const r = await actors.message(sessionID, { to: params.target, body: params.body, wake: true });
				return ok(`sent to ${r.to} (${r.state}${r.woke ? ", woken" : ""}).`, r);
			} catch (e) {
				if (e instanceof ActorError && e.name === "AgentNotFoundError" && params.action === "close") {
					actors.toolError(sessionID, "agents", "path_invalid");
					return { content: [text(`path_invalid: ${e.message}`)], details: { error: "path_invalid" }, isError: true };
				}
				return fail(actors, sessionID, "agents", e);
			}
		},
	});

	return [spawn, message, wait, agents];
}
