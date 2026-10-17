import { type Static, type TSchema, Type } from "typebox";

/**
 * the server contract, one source: every event the daemon publishes and every route it serves, as
 * json schema. `generate.ts` turns this into the client package (`@cmx2/client`: typed events with a
 * discriminated union and decoder, a typed http client) and `openapi.json`. the daemon validates
 * request bodies against the route schemas, and in test runs every published event against its
 * event schema, so the contract cannot drift from the wire.
 *
 * event names and shapes follow cmx where the meaning is unchanged, so boxbox's cutover is a
 * regeneration, not a rewrite. `version` bumps when an event's shape changes incompatibly.
 */

export const CONTRACT_VERSION = 7;

// ---------- shared shapes ----------

const ToolRef = Type.Object({ messageID: Type.String(), callID: Type.String() }, { description: "the tool call that raised the ask" });

export const SessionStatusIdle = Type.Object(
	{
		type: Type.Literal("idle"),
			since: Type.Optional(Type.Number({ description: "when this state began (ms); on a parked session, when it parked" })),
			queued: Type.Optional(Type.Integer({ description: "prompts an abort left waiting (GET /session/:id/queue lists them; loop runs them)" })),
			parked: Type.Optional(
				Type.Object(
					{ agents: Type.Integer({ description: "agents under it still working or queued" }), jobs: Type.Integer({ description: "background jobs that will notify it" }) },
					{ description: "the turn has ended and the session waits on these; a report or a job notice wakes it" },
				),
			),
	},
	{ description: "no turn running; with parked, waiting on agents or jobs that will wake it" },
);
export const SessionStatusBusy = Type.Object(
	{
		type: Type.Literal("busy"),
		queued: Type.Optional(Type.Integer({ description: "steers and queued prompts admitted but not yet sent to the model" })),
		since: Type.Optional(Type.Number({ description: "when the turn began (ms)" })),
		waiting: Type.Optional(Type.String({ description: "why the turn has not started yet, short and lowercase, shown as is: the session's directory has not answered (a macos privacy prompt, a hung mount)" })),
	},
	{ description: "a turn is running" },
);
export const SessionStatusRetry = Type.Object(
	{ type: Type.Literal("retry"), attempt: Type.Integer(), message: Type.String({ description: "short and lowercase, shown as is" }), next: Type.Number({ description: "when the next attempt goes (ms)" }), since: Type.Optional(Type.Number()) },
	{ description: "a turn is waiting out a transient provider failure" },
);
export const SessionStatus = Type.Union([SessionStatusIdle, SessionStatusBusy, SessionStatusRetry], { description: "discriminated on type. idle sessions are absent from the status map unless parked=true is asked for" });

export const SessionInfo = Type.Object(
	{
		id: Type.String(),
		slug: Type.String(),
		projectID: Type.String({ description: "the project root (git top level, or the directory)" }),
		directory: Type.String(),
		parentID: Type.Optional(Type.String()),
		title: Type.String(),
		version: Type.String({ description: "daemon version that created the session" }),
		time: Type.Object({ created: Type.Number(), updated: Type.Number(), archived: Type.Optional(Type.Number({ description: "when the session was archived (deleted from view); its history stays" })) }),
		model: Type.Optional(Type.Object({ id: Type.String(), providerID: Type.String() })),
		summary: Type.Optional(Type.Object({ additions: Type.Number(), deletions: Type.Number(), files: Type.Number() })),
		source: Type.Union([Type.Literal("cmx2"), Type.Literal("cmx")], { description: "cmx sessions are imported history: browse only" }),
		effort: Type.Optional(Type.String()),
		cost: Type.Number(),
		tokens: Type.Object({ input: Type.Number(), output: Type.Number(), cache: Type.Object({ read: Type.Number(), write: Type.Number() }) }),
		status: Type.Optional(SessionStatus),
		vcs: Type.Optional(Type.Object({ branch: Type.String(), dirty: Type.Boolean({ description: "the work tree has uncommitted changes, untracked files included" }) }, { description: "the git branch of the session's directory, when it is in a work tree" })),
		context: Type.Optional(
			Type.Object(
				{
					used: Type.Number({ description: "tokens in the context now: the last step's usage plus an estimate of what came after it" }),
					limit: Type.Number({ description: "the model's context window" }),
					compactAt: Type.Optional(Type.Number({ description: "where automatic compaction runs" })),
				},
				{ description: "context fill" },
			),
		),
		revert: Type.Optional(
			Type.Object(
				{
					messageID: Type.String({ description: "messages from this one on are parked; the next send makes it permanent, unrevert brings them back" }),
					partID: Type.Optional(Type.String()),
					snapshot: Type.Optional(Type.String()),
					diff: Type.Optional(Type.Object({ files: Type.Number(), additions: Type.Number(), deletions: Type.Number() })),
				},
				{ description: "an armed revert: the files are back as they were before messageID" },
			),
		),
	},
	{ description: "opencode-compatible session info plus cmx2's fields" },
);

export const FileDiff = Type.Object(
	{
		file: Type.String({ description: "relative to the session's directory" }),
		before: Type.String(),
		after: Type.String(),
		additions: Type.Number(),
		deletions: Type.Number(),
		status: Type.Union([Type.Literal("added"), Type.Literal("deleted"), Type.Literal("modified")]),
		binary: Type.Optional(Type.Boolean({ description: "or over 256 kb: before and after are left empty, the counts stand" })),
	},
	{ description: "one file's change: full text before and after" },
);

export const MessageInfo = Type.Object(
	{
		id: Type.String(),
		sessionID: Type.String(),
		role: Type.String({ description: "user or assistant" }),
		time: Type.Object({ created: Type.Number(), completed: Type.Optional(Type.Number()) }),
		clientID: Type.Optional(Type.String({ description: "on a user message: the client id of the request that sent it" })),
		queued: Type.Optional(Type.Boolean({ description: "a provisional message waiting behind the running turn; it reissues under its transcript id when it lands" })),
		steer: Type.Optional(Type.Boolean({ description: "on a user message sent as a steer (read at the next tool boundary of the running turn), provisional or landed; absent on a prompt that waited for the turn to end" })),
		agent: Type.Optional(Type.String({ description: "on a user message: the agent it was sent for" })),
		model: Type.Optional(Type.Object({ providerID: Type.String(), modelID: Type.String() }, { description: "on a queued or steered user message: the model it asked for, applied when it runs" })),
		variant: Type.Optional(Type.String({ description: "on a queued or steered user message: the effort it asked for, applied when it runs (a steer's from the next turn)" })),
	},
	{ additionalProperties: true, description: "opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort)" },
);

const partBase = { id: Type.String(), sessionID: Type.String(), messageID: Type.String() };
const ToolTime = Type.Object({ start: Type.Optional(Type.Union([Type.Number(), Type.Null()])), end: Type.Optional(Type.Number()) }, { additionalProperties: true });
const ToolInput = Type.Record(Type.String(), Type.Unknown());
export const ToolStateRunning = Type.Object(
	{ status: Type.Literal("running"), input: ToolInput, time: Type.Optional(ToolTime), metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "while a shell runs, output holds the last 2 kb, updated at most once a second" })) },
	{ additionalProperties: true },
);
export const ToolStatePending = Type.Object({ status: Type.Literal("pending"), input: ToolInput }, { additionalProperties: true });
export const ToolStateCompleted = Type.Object(
	{ status: Type.Literal("completed"), input: ToolInput, output: Type.String(), title: Type.String(), metadata: Type.Record(Type.String(), Type.Unknown(), { description: "what the tool reported. a completed edit or write carries filediff {file, patch, additions, deletions} (the shape imported history has; the patch is a unified patch cut at 64 KB, 8 KB for a file the call created, the counts cover the whole change) and truncated (the patch was cut). a change too big to diff (a changed region over 32 MB, or a file over 64 MB) carries no filediff: counts made up for it would look exact" }), time: ToolTime, attachments: Type.Optional(Type.Array(Type.Object({ type: Type.Literal("file"), mime: Type.String(), filename: Type.String(), url: Type.String({ description: "a data url" }) }, { additionalProperties: true }), { description: "the images the tool returned (a read of an image, a screenshot), for clients to preview; present only when the result carried at least one. in result order, at most 8 and at most 4 MB of data urls per part; the filename is the label the tool gave the image (the file name for a read), else image" })), attachmentsDropped: Type.Optional(Type.Number({ description: "how many of the result's images were left off attachments by the 8 image or 4 MB cap; absent when none were" })) },
	{ additionalProperties: true },
);
export const ToolStateError = Type.Object({ status: Type.Literal("error"), input: ToolInput, error: Type.String(), time: ToolTime }, { additionalProperties: true });
export const ToolState = Type.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError], { description: "discriminated on status" });
/** when a streamed part started and ended (ms); the end is absent while it streams */
const PartTime = Type.Object({ start: Type.Number(), end: Type.Optional(Type.Number()) }, { description: "start is when the part was announced (its first delta follows at once), end when its block ended; end is absent on a part that is still streaming" });
const PartStreaming = Type.Boolean({
	description: "the part is still being written: it was announced with empty text when it started, message.part.delta extends it, and its final message.part.updated (the whole text, no streaming, time with end) ends it, published when the part's block ends, not when the step does; in a read, the text so far, with the deltas after the read's seq continuing it; a part whose block has ended reads final, not streaming",
});
export const TextPart = Type.Object(
	{
		...partBase,
		type: Type.Literal("text"),
		text: Type.String(),
		synthetic: Type.Optional(Type.Boolean({ description: "context the user did not type (a mentioned file, the turn context)" })),
		streaming: Type.Optional(PartStreaming),
		time: Type.Optional(PartTime),
	},
	{ additionalProperties: true, description: "text; on user messages mail and notice mark agent and runtime words" },
);
export const ReasoningPart = Type.Object(
	{ ...partBase, type: Type.Literal("reasoning"), text: Type.String(), streaming: Type.Optional(PartStreaming), time: Type.Optional(PartTime) },
	{ additionalProperties: true, description: "the model's visible thinking; it streams like text, in content order with the text parts of its message" },
);
export const ToolPart = Type.Object({ ...partBase, type: Type.Literal("tool"), callID: Type.String(), tool: Type.String(), state: ToolState }, { additionalProperties: true, description: "one tool call and its state" });
export const CompactionPart = Type.Object(
	{ ...partBase, type: Type.Literal("compaction"), auto: Type.Boolean(), overflow: Type.Optional(Type.Boolean()), tail_start_id: Type.Optional(Type.String({ description: "the first message kept verbatim after the summary" })) },
	{ additionalProperties: true, description: "a compaction: the summary follows as an assistant message marked summary" },
);
export const FilePart = Type.Object({ ...partBase, type: Type.Literal("file"), mime: Type.String(), filename: Type.String(), url: Type.String({ description: "a data url" }) }, { additionalProperties: true, description: "an attached photo or document" });
/** a step boundary: the part imported history opens each model step with (native turns publish steps on /steps instead) */
export const StepStartPart = Type.Object(
	{ ...partBase, type: Type.Literal("step-start"), snapshot: Type.Optional(Type.String({ description: "the work-tree snapshot hash the step started from, when the source took one" })) },
	{ additionalProperties: true, description: "imported history only: a model step began" },
);
const StepTokens = Type.Object(
	{ total: Type.Optional(Type.Number()), input: Type.Number(), output: Type.Number(), reasoning: Type.Number(), cache: Type.Object({ read: Type.Number(), write: Type.Number() }, { additionalProperties: true }) },
	{ additionalProperties: true },
);
export const StepFinishPart = Type.Object(
	{
		...partBase,
		type: Type.Literal("step-finish"),
		reason: Type.String({ description: "why the step ended (stop, tool-calls, length, ...)" }),
		snapshot: Type.Optional(Type.String({ description: "the work-tree snapshot hash at the step's end, when the source took one" })),
		cost: Type.Number({ description: "usd the step cost" }),
		tokens: StepTokens,
	},
	{ additionalProperties: true, description: "imported history only: a model step ended, with its cost and tokens" },
);
export const PatchPart = Type.Object(
	{ ...partBase, type: Type.Literal("patch"), hash: Type.String({ description: "the snapshot hash the files changed against" }), files: Type.Array(Type.String(), { description: "absolute paths the step changed" }) },
	{ additionalProperties: true, description: "imported history only: the files a step changed" },
);
export const SubtaskPart = Type.Object(
	{
		...partBase,
		type: Type.Literal("subtask"),
		agent: Type.String(),
		description: Type.String(),
		prompt: Type.String(),
		command: Type.Optional(Type.String()),
		model: Type.Optional(Type.Object({ providerID: Type.String(), modelID: Type.String() }, { additionalProperties: true })),
	},
	{ additionalProperties: true, description: "imported history only: a subtask or command the user started" },
);
export const Part = Type.Union([TextPart, ReasoningPart, ToolPart, FilePart, CompactionPart, StepStartPart, StepFinishPart, PatchPart, SubtaskPart], {
	description: "opencode-shaped part, discriminated on type. step-start, step-finish, patch and subtask appear in imported (source cmx) history only",
});

export const PermissionRequest = Type.Object({
	id: Type.String(),
	sessionID: Type.String(),
	permission: Type.String({ description: "shell, edit, read, grep, glob, webfetch, external_directory, ..." }),
	patterns: Type.Array(Type.String(), { description: "what the call touches: the command, the path" }),
	metadata: Type.Record(Type.String(), Type.Unknown()),
	always: Type.Array(Type.String(), { description: "patterns an always answer saves for the project" }),
	tool: Type.Optional(ToolRef),
});

export const QuestionOption = Type.Object({ label: Type.String(), description: Type.String() });
export const QuestionInfo = Type.Object({
	question: Type.String(),
	header: Type.String(),
	options: Type.Array(QuestionOption),
	multiple: Type.Optional(Type.Boolean()),
	custom: Type.Optional(Type.Boolean({ description: "a typed answer is accepted; always true in cmx2" })),
});
export const QuestionRequest = Type.Object({
	id: Type.String(),
	sessionID: Type.String(),
	questions: Type.Array(QuestionInfo),
	tool: Type.Optional(ToolRef),
});

export const ErrorBody = Type.Object(
	{ name: Type.String({ description: "BadRequestError, UnauthorizedError, NotFoundError, BusyError, ConflictError, UnknownError" }), data: Type.Object({ message: Type.String() }, { additionalProperties: true }) },
	{ description: "every error the daemon returns" },
);

export const StepRow = Type.Object(
	{
		session_id: Type.String(),
		seq: Type.Integer(),
		at: Type.Number(),
		model: Type.String(),
		effort: Type.Union([Type.String(), Type.Null()]),
		input: Type.Integer(),
		cache_read: Type.Integer(),
		cache_write: Type.Integer(),
		output: Type.Integer(),
		cache_read_pct: Type.Number(),
		ttft_ms: Type.Union([Type.Integer(), Type.Null()]),
		duration_ms: Type.Integer(),
		tool_calls: Type.Integer(),
		nested_calls: Type.Integer(),
		calls: Type.Integer(),
		tool_names: Type.String(),
		tool_ms: Type.Integer(),
		cost: Type.Number(),
		stop_reason: Type.String(),
		refusal: Type.Union([Type.String(), Type.Null()]),
		prefix_hash: Type.String(),
		prefix_same: Type.Integer(),
		steered: Type.Integer(),
		dropped_blocks: Type.Integer(),
		poll_only: Type.Integer({ description: "1 when every call in the step only waited: a sleep, a retry loop, a read of process output" }),
		escalation: Type.Union([Type.String(), Type.Null()], { description: "on the first step at a raised effort: from→to and the failure signals that raised it" }),
		warm: Type.Integer({ description: "1 when refreshes kept the session's cache warm while it sat parked before this step" }),
		continued: Type.Integer({ description: "1 when the reply hit the output limit and the turn went on with a continuation request" }),
	},
	{ description: "one telemetry row per assistant step" },
);

export const PtyInfo = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		command: Type.String({ description: "empty for a login shell" }),
		args: Type.Array(Type.String()),
		cwd: Type.String(),
		status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
		pid: Type.Integer(),
		origin: Type.Union([Type.Literal("tui"), Type.Literal("model")], { description: "tui: a person opened it; model: a session's pty" }),
	},
	{ description: "a terminal, in cmx's shape" },
);

export const ProcessInfo = Type.Object(
	{
		id: Type.String(),
		sessionID: Type.Union([Type.String(), Type.Null()], { description: "the owning session; null for a terminal a person opened" }),
		pid: Type.Integer(),
		command: Type.String(),
		cwd: Type.String(),
		title: Type.String(),
		kind: Type.Union([Type.Literal("pty"), Type.Literal("job")]),
		status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		ports: Type.Array(Type.Integer(), { description: "tcp ports the process group listens on, as last looked up" }),
		origin: Type.Union([Type.Literal("model"), Type.Literal("user")]),
		startedAt: Type.Number(),
		endedAt: Type.Optional(Type.Number()),
		keep: Type.Optional(Type.String({ description: "survives session end under this name" })),
		detached: Type.Optional(Type.Boolean({ description: "survives daemon restart" })),
		adopted: Type.Optional(Type.Boolean({ description: "taken over from a previous daemon; earlier output is gone" })),
	},
	{ description: "a process a session owns (a background job or a pty), or a terminal a person opened" },
);

export const AgentInfo = Type.Object(
	{
		id: Type.String({ description: "the agent's session id" }),
		rootID: Type.String(),
		parentID: Type.Union([Type.String(), Type.Null()]),
		path: Type.String({ description: "canonical path: /root, /root/<name>, /root/<name>/<child>" }),
		name: Type.String(),
		depth: Type.Integer(),
		seat: Type.Union([Type.String(), Type.Null()], { description: "the model label a helper runs on (haiku, sonnet, a provider/model-id's bare id); driver for the root" }),
		agentType: Type.Union([Type.String(), Type.Null()]),
		model: Type.Union([Type.String(), Type.Null()]),
		effort: Type.Union([Type.String(), Type.Null()]),
		state: Type.Union([Type.Literal("queued"), Type.Literal("working"), Type.Literal("parked"), Type.Literal("interrupted"), Type.Literal("closed")], {
			description: "queued waits for a running-turn slot; parked is idle, addressable and free; closed is a tombstone",
		}),
		cause: Type.Optional(Type.String({ description: "why it is interrupted or closed: interrupted, budget, daemon_restart, closed, respawned, pool_collected, pool_failed, session_ended; or asking while a working helper waits on its question to its spawner" })),
		previousState: Type.Optional(Type.String()),
		files: Type.Array(Type.String(), { description: "paths it wrote or edited" }),
		lastTask: Type.Optional(Type.String()),
		lastReport: Type.Optional(Type.String()),
		pending: Type.Integer({ description: "mailbox items not yet in its transcript" }),
		tokens: Type.Number({ description: "input, output and cache-write tokens it has spent" }),
		contextTokens: Type.Optional(Type.Number({ description: "input, cache read and cache write of its last step: how big its context is now" })),
		lastStepCost: Type.Optional(Type.Number({ description: "what its last step cost, in dollars" })),
		cost: Type.Optional(Type.Number({ description: "what its session has cost so far, in dollars" })),
		pool: Type.Optional(Type.Object({ id: Type.String(), name: Type.String(), index: Type.Integer(), n: Type.Integer() })),
		createdAt: Type.Number(),
		updatedAt: Type.Number(),
		closedAt: Type.Optional(Type.Number()),
	},
	{ description: "one agent in a session's tree" },
);

export const McpStatus = Type.Object(
	{
		name: Type.String(),
		transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
		status: Type.Union([Type.Literal("connecting"), Type.Literal("connected"), Type.Literal("failed"), Type.Literal("disabled"), Type.Literal("needs_auth")]),
		tools: Type.Array(Type.String(), { description: "the server's tool names; sessions see them as <server>_<tool> through tool_search" }),
		error: Type.Optional(Type.String()),
		server: Type.Optional(Type.Object({ name: Type.String(), version: Type.String() })),
	},
	{ description: "one mcp server from the profile" },
);

const Ok = Type.Literal(true);
const sid = { sessionID: Type.String() };

/** what a step up and a retry record about the attempt they took over */
const attemptShape = {
	childID: Type.Optional(Type.String()),
	from_id: Type.String({ description: "the earlier helper" }),
	from_model: Type.Union([Type.String(), Type.Null()]),
	from_effort: Type.Union([Type.String(), Type.Null()]),
	to_model: Type.String(),
	to_effort: Type.String(),
	from_label: Type.Union([Type.String(), Type.Null()], { description: "the model label the earlier helper ran under" }),
	to_label: Type.String(),
};

export const WorktreeInfo = Type.Object(
	{
		name: Type.String(),
		directory: Type.String({ description: "absolute; sessions homed here fold under project" }),
		branch: Type.Optional(Type.String({ description: "cmx2/<name>" })),
		base: Type.Optional(Type.String({ description: "the branch it was made from and merges back into" })),
		project: Type.String({ description: "the repository's main checkout" }),
	},
	{ description: "a checkout made for an agent: a branch in a directory of its own" },
);
const WorktreeSetupRun = Type.Object({
	command: Type.String(),
	ok: Type.Boolean(),
	exitCode: Type.Union([Type.Integer(), Type.Null()]),
	ms: Type.Integer(),
	log: Type.String({ description: "the tail of stdout and stderr, 4000 characters at most" }),
	timedOut: Type.Optional(Type.Boolean()),
});
export const WorktreeCreated = Type.Object(
	{
		...WorktreeInfo.properties,
		mode: Type.Union([Type.Literal("clone"), Type.Literal("git")], { description: "clone: an apfs copy-on-write clone of the working tree (macos); git: git worktree add plus carried files" }),
		fallback: Type.Optional(Type.String({ description: "why the clone was not used when the profile wanted it" })),
		ms: Type.Integer({ description: "how long making the checkout took, setup excluded" }),
		source: Type.String({ description: "the directory it was made from" }),
		from: Type.String({ description: "the commit it starts at" }),
		carried: Type.Array(Type.String(), { description: "untracked paths brought along (directories end in /)" }),
		left: Type.Array(Type.String(), { description: "secret-shaped files left behind because worktree.carry does not name them" }),
		linked: Type.Array(Type.String(), { description: "package stores linked to the source's (the git path)" }),
		setup: Type.Optional(Type.Array(WorktreeSetupRun, { description: "the setup commands, when the caller waited for them" })),
	},
	{ description: "a new checkout and how it was made" },
);
const WorktreeDiff = Type.Object({
	branch: Type.Optional(Type.String()),
	base: Type.String(),
	baseRef: Type.String(),
	commits: Type.Integer({ description: "on the branch beyond its base" }),
	dirty: Type.Boolean({ description: "uncommitted changes in the checkout (merge refuses until they are committed)" }),
	mergeable: Type.Optional(Type.Boolean({ description: "false when the branch conflicts with its base" })),
	additions: Type.Integer(),
	deletions: Type.Integer(),
	files: Type.Array(Type.Object({ path: Type.String(), status: Type.Union([Type.Literal("added"), Type.Literal("deleted"), Type.Literal("modified"), Type.Literal("renamed")]), additions: Type.Integer(), deletions: Type.Integer() })),
	diff: Type.String({ description: "the unified patch of the commits, 2 MB at most" }),
	truncated: Type.Boolean(),
});
const ProjectRow = Type.Object({
	id: Type.String({ description: "the project's path" }),
	worktree: Type.String({ description: "the project's main checkout" }),
	time: Type.Object({ created: Type.Number(), updated: Type.Number() }),
	sandboxes: Type.Array(Type.String(), { description: "directories of the checkouts made for agents" }),
	worktrees: Type.Optional(Type.Array(WorktreeInfo, { description: "with worktrees=true: the checkouts, from git's own list" })),
});

// ---------- events ----------

export interface EventDef {
	version: number;
	description: string;
	properties: TSchema;
}

function event(description: string, properties: Record<string, TSchema>, version = 1): EventDef {
	return { version, description, properties: Type.Object(properties) };
}

export const EVENTS = {
	"server.connected": event("first frame of every event stream", { version: Type.Optional(Type.String()) }),
	"server.heartbeat": event("every 10 s on every stream; a silent stream for 25 s is dead", {}),
	"global.disposed": event("the daemon is exiting (restart or shutdown); every stream ends after it", {}),
	"stream.reset": event("first frame when a resume cursor cannot be replayed: expired (older than the window), epoch (another store) or invalid (malformed, or ahead of the log). the stream continues live from seq; reconcile from reads, whose x-cmx2-seq is a cursor", {
		reason: Type.Union([Type.Literal("expired"), Type.Literal("epoch"), Type.Literal("invalid")]),
		seq: Type.Integer({ description: "the head of the log when the stream started" }),
		epoch: Type.String(),
	}),
	"config.updated": event("config was reloaded from disk", { directory: Type.String(), changed: Type.Array(Type.String()) }),
	"mcp.status": event("an mcp server connected, failed, needs a sign-in, or changed its tools", McpStatus.properties),

	"session.created": event("a session was created", { ...sid, info: SessionInfo }),
	"session.updated": event("a session's info changed (title, totals, effort)", { ...sid, info: SessionInfo }),
	"session.deleted": event("a session was archived (deleted from view); its history stays on disk", { ...sid, info: Type.Optional(SessionInfo) }),
	"session.model": event("the session's model changed (the picker); applies from the next turn", { ...sid, model: Type.String({ description: "provider/model-id" }) }),
	"session.resumed": event("a stored session was reopened from its transcript into memory", sid),
	"session.status": event("a session's run state changed; queued counts steers and prompts not yet sent", { ...sid, status: SessionStatus }),
	"session.idle": event("a session's turn settled (deprecated in cmx, kept for boxbox)", sid),
	"session.error": event("a turn hit an error. name is RefusalError (data.refusal names the classifier, content filters included), ContextOverflowError, AuthError, RateLimitError, ProviderUnavailableError (after retries), ProviderError (unknown) or EngineError; data.message is short and lowercase, data.kind the class", {
		sessionID: Type.Optional(Type.String()),
		error: Type.Object({ name: Type.String(), data: Type.Object({ message: Type.String() }, { additionalProperties: true }) }),
	}),
	"session.steered": event("a steer was admitted into the running turn", { ...sid, text: Type.String(), messageID: Type.Optional(Type.String({ description: "the steer's provisional id, as message.updated announced it" })), clientID: Type.Optional(Type.String()) }),
	"session.queued": event("a prompt was queued behind the running turn", { ...sid, text: Type.String(), messageID: Type.Optional(Type.String({ description: "the prompt's provisional id, as message.updated announced it" })), clientID: Type.Optional(Type.String()) }),
	"session.effort": event("the session's effort dial changed", { ...sid, effort: Type.String() }),
	"session.tools": event("deferred tools were loaded into the session", { ...sid, loaded: Type.Array(Type.String()) }),
	"session.warning": event("something odd that did not stop the session", { ...sid, message: Type.String() }),
	"session.compacted": event("the context was compacted: a summary and the recent messages replaced it (the transcript keeps everything)", {
		...sid,
		trigger: Type.Union([Type.Literal("auto"), Type.Literal("manual"), Type.Literal("overflow")]),
		tokensBefore: Type.Number(),
		tokensAfter: Type.Number({ description: "an estimate" }),
		durationMs: Type.Number({ description: "how long the session waited on the compaction" }),
		waitedMs: Type.Number({ description: "of that, waiting on a background summary still being written" }),
		summaryMs: Type.Number({ description: "the summary request's own wall time" }),
		summaryChars: Type.Number(),
		prefire: Type.Boolean({ description: "the summary was made in the background before the threshold" }),
		cold: Type.Boolean({ description: "compacted under the threshold because the prompt cache had gone cold (past its ttl, or a model switch) and a background summary was ready" }),
		tailFrom: Type.Number(),
		tailStartID: Type.Optional(Type.String()),
		cleared: Type.Number({ description: "tool outputs the kept tail carries cleared (recall reads them)" }),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		input: Type.Number(),
		output: Type.Number(),
		cost: Type.Number(),
		cacheReadPct: Type.Number({ description: "of the summary request" }),
	}),
	"compaction.prefire": event("the background summary started, is ready, failed, or no longer fits the context", {
		...sid,
		state: Type.Union([Type.Literal("started"), Type.Literal("ready"), Type.Literal("failed"), Type.Literal("stale")]),
		tokens: Type.Number(),
		ms: Type.Optional(Type.Number()),
		chars: Type.Optional(Type.Number()),
		message: Type.Optional(Type.String()),
		cacheReadPct: Type.Optional(Type.Number()),
		refresh: Type.Optional(Type.Boolean({ description: "a newer summary over the grown context, made while the ready one stays in use; stale here means a compaction or a revert came first and it was dropped" })),
	}),
	"compaction.failed": event("a compaction did not happen; sticky ones are not tried again on this model until a manual compact or a model switch", {
		...sid,
		trigger: Type.String(),
		reason: Type.Union([Type.Literal("degenerate"), Type.Literal("too_large"), Type.Literal("transient")]),
		message: Type.String(),
		sticky: Type.Boolean(),
		tokens: Type.Number(),
	}),
	"session.images_dropped": event("images left the context: past the image budget, over the provider's limits for a request, or unreadable to it; the transcript keeps them, the model reads a marker where each was", {
		...sid,
		reason: Type.Union([Type.Literal("budget"), Type.Literal("turn"), Type.Literal("compaction"), Type.Literal("limit"), Type.Literal("rejected"), Type.Literal("unreadable")], {
			description: "budget: past images.budget; turn: near it at a turn's first request; compaction: past the keep line right after a compaction; limit: the request would pass the provider's byte or image count limit; rejected: the provider refused a request for its size, its image count or an image's size; unreadable: the provider could not read an image, so the images since its last reply went (all of them when there were none)",
		}),
		dropped: Type.Integer(),
		imagesBefore: Type.Integer(),
		imagesAfter: Type.Integer(),
		bytesBefore: Type.Integer({ description: "base64 bytes of images in the context" }),
		bytesAfter: Type.Integer(),
		budget: Type.Union([Type.Number(), Type.Null()]),
		requestLimit: Type.Number({ description: "the request byte limit the session holds to" }),
	}),
	"session.prefix_changed": event("a request's prefix bytes differ from the session's recorded prefix (a cache miss risk)", {
		...sid,
		request: Type.Integer(),
		at: Type.Integer({ description: "byte offset of the first difference" }),
		hash: Type.String(),
	}),

	"message.updated": event("a message was created or finished", { ...sid, info: MessageInfo }),
	"message.part.updated": event("a part was created or changed (a tool call running, then completed). every text and reasoning part of a streaming message is announced when it starts, before its first delta: this event with empty text and streaming true, logged like any other, in content order; its final update carries the whole text, no streaming, and time {start, end}, and is published when that part's block ends (a reasoning part when the reply begins), not when the step does; the step's end publishes it again, the same text and time.end", { ...sid, part: Part }),
	"message.part.delta": event("streamed text for a text or reasoning part that was announced (a message.part.updated with streaming true); never sent to a part that was not", {
		...sid,
		messageID: Type.String(),
		partID: Type.String(),
		field: Type.String({ description: "text" }),
		delta: Type.String(),
		offset: Type.Integer({ description: "utf-16 units of the part's text before this delta; deltas are not logged, so a consumer checks contiguity with this" }),
	}),

	"file.edited": event("a session's write or edit changed a file (after the formatter ran)", {
		...sid,
		file: Type.String({ description: "absolute path" }),
		additions: Type.Optional(Type.Number({ description: "lines this edit or write added, counted against the file as it was before and as it is after the formatter; the same numbers as the tool part's metadata.filediff. absent from a revert's event, and from a change too big to diff (the part has no filediff either)" })),
		deletions: Type.Optional(Type.Number({ description: "lines this edit or write removed" })),
	}),
	"message.removed": event("a queued prompt was taken back before the model saw it", { ...sid, messageID: Type.String() }),
	"command.executed": event("a / command ran as a prompt", { ...sid, name: Type.String(), arguments: Type.String(), clientID: Type.Optional(Type.String()) }),

	"pty.created": event("a terminal opened", { info: PtyInfo }),
	"pty.updated": event("a terminal was renamed or resized", { info: PtyInfo }),
	"pty.exited": event("a terminal's process exited", { id: Type.String(), exitCode: Type.Integer() }),
	"pty.deleted": event("a terminal was closed and forgotten", { id: Type.String() }),
	"process.started": event("a job or pty started", { process: ProcessInfo }),
	"process.updated": event("a process changed (title, size, keep)", { process: ProcessInfo }),
	"process.exited": event("a process exited", { process: ProcessInfo }),
	"process.deleted": event("a process was forgotten", { process: ProcessInfo }),
	"process.notify": event("a background job reported (exit, a matching line, a port opening); the owning session gets it as a turn message", {
		process: ProcessInfo,
		reason: Type.Union([Type.Literal("exit"), Type.Literal("pattern"), Type.Literal("port")]),
		detail: Type.String(),
	}),

	"step.recorded": event("one assistant step's telemetry", { ...sid, step: StepRow }),
	"session.escalated": event("failure signals raised a helper's effort for its next turn; the stored effort does not change", { ...sid, from: Type.String(), to: Type.String(), reason: Type.String() }),
	"session.deescalated": event("a turn without failure signals put an escalated effort back to where the session stands; the stored effort does not change", { ...sid, from: Type.String(), to: Type.String(), reason: Type.String() }),
	"session.warmed": event("a parked session's prompt cache was refreshed with a one-token request", {
		...sid,
		cache_read: Type.Integer(),
		cache_write: Type.Integer(),
		input: Type.Integer(),
		output: Type.Integer(),
		cost: Type.Number(),
		ms: Type.Integer(),
	}),
	"project.updated": event("a project's checkouts changed: one was made, merged or discarded. sandboxes is the full list after the change", ProjectRow.properties),
	"worktree.ready": event("a checkout is ready: made, files carried, setup commands done. framed with the checkout's directory", { name: Type.String(), branch: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal("clone"), Type.Literal("git")])) }),
	"worktree.failed": event("a checkout's setup failed; the checkout stays so the failure can be looked at. framed with the checkout's directory", { name: Type.Optional(Type.String()), message: Type.String(), log: Type.Optional(Type.String({ description: "the tail of the failing command's output" })) }),
	"worktree.review.requested": event("the agent in a checkout says its work is ready to look at (request_review). the only thing that raises a review card. framed with the checkout's directory", { name: Type.String(), branch: Type.Optional(Type.String()), note: Type.Optional(Type.String()), sessionID: Type.Optional(Type.String()) }),
	"worktree.merged": event("a checkout's branch was squash-merged into its base and the checkout removed. framed with the checkout's directory", { name: Type.String(), branch: Type.String(), base: Type.String(), commit: Type.String(), commits: Type.Integer() }),
	"worktree.discarded": event("a checkout was removed without merging; snapshot and ref hold its last state when it had work. framed with the checkout's directory", { name: Type.String(), branch: Type.Optional(Type.String()), snapshot: Type.Optional(Type.String()), ref: Type.Optional(Type.String()) }),

	"agent.spawned": event("an agent was spawned; its session follows as session.created with parentID", { ...sid, agent: AgentInfo }),
	"agent.updated": event("an agent changed state (queued, working, parked, interrupted, closed) or its roster entry changed; sessionID is the tree's root", { ...sid, agent: AgentInfo }),
	"agent.closed": event("an agent was closed and kept as a tombstone", { ...sid, agent: AgentInfo, cause: Type.String() }),
	"agent.report": event("a child's turn ended and its report went to its spawner (or its pool)", {
		...sid,
		from: Type.String(),
		childID: Type.String(),
		label: Type.String({ description: "parked, failed, partial" }),
		body_length: Type.Integer(),
		abort_reason: Type.Optional(Type.Object({ reason: Type.String(), details: Type.String() })),
		behavior_violation: Type.Optional(Type.Unknown()),
	}),
	"agent.message": event("one agent sent another a note", { ...sid, from: Type.String(), to: Type.String(), toID: Type.String(), wake: Type.Boolean(), length: Type.Integer(), correlation_id: Type.Optional(Type.String()) }),
	"agent.wait": event("an agent started waiting on its mailbox", { ...sid, path: Type.String(), timeout_ms: Type.Integer(), correlation_id: Type.Optional(Type.String()) }),
	"agent.metric.deliverable_arrived": event("a child's report arrived; source says how (explicit_send, extracted, safety_net)", {
		...sid,
		childID: Type.Optional(Type.String()),
		source: Type.String(),
		body_length: Type.Integer(),
		child_path: Type.String(),
	}),
	"agent.metric.safety_net_fired": event("a report carried the no-deliverable warning", { ...sid, childID: Type.Optional(Type.String()), child_path: Type.String() }),
	"agent.metric.sibling_deadlock": event("a wait timed out with nothing new", { ...sid, timeout_ms: Type.Integer(), tool: Type.String(), correlation_id: Type.Optional(Type.String()) }),
	"agent.metric.step_up": event("a helper took over an earlier attempt at a task on another model or at another effort", { ...sid, ...attemptShape }),
	"agent.metric.retry": event("a helper took over an earlier attempt at a task on the same model at the same effort", { ...sid, ...attemptShape }),
	"agent.metric.subagent_tool_error": event("an agent verb failed in a way the model can recover from", { ...sid, tool: Type.String(), error_kind: Type.String() }),

	"permission.asked": event("a tool call waits for the user's permission", PermissionRequest.properties),
	"permission.replied": event("a permission ask was answered; by is who (a client's name, abort, cascade, always rule, session_ended)", {
		...sid,
		requestID: Type.String(),
		reply: Type.Union([Type.Literal("once"), Type.Literal("always"), Type.Literal("reject")]),
		by: Type.Optional(Type.String()),
		clientID: Type.Optional(Type.String()),
	}),
	"question.asked": event("the model asked the user a question and waits", QuestionRequest.properties),
	"question.replied": event("a question was answered", { ...sid, requestID: Type.String(), answers: Type.Array(Type.Array(Type.String())), by: Type.Optional(Type.String()), clientID: Type.Optional(Type.String()) }),
	"question.rejected": event("a question was dismissed, or its turn was stopped (by: abort)", { ...sid, requestID: Type.String(), by: Type.Optional(Type.String()), clientID: Type.Optional(Type.String()) }),
} satisfies Record<string, EventDef>;

export type EventType = keyof typeof EVENTS;
export type EventProperties<T extends EventType> = Static<(typeof EVENTS)[T]["properties"]>;

// ---------- routes ----------

export interface RouteDef {
	method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
	path: string;
	/** name of the generated client method */
	operationId: string;
	summary: string;
	query?: TSchema;
	body?: TSchema;
	/** response for 2xx; `sse` for event streams, `websocket` for an upgrade */
	response: TSchema | "sse" | "websocket";
	status?: number;
	/** the route reads x-cmx2-directory / x-opencode-directory / ?directory= */
	scoped?: boolean;
	headers?: Record<string, string>;
	/** error statuses beyond 400, 401 and 404 the route can answer (409: busy, conflict, already settled) */
	errors?: number[];
	/** the 2xx body is a file's bytes, not json: the generated client returns them with the content type and etag, and openapi says octet-stream */
	bytes?: boolean;
	/** another 2xx the route can answer, with its body */
	also?: { status: number; response: TSchema; description: string };
}

const Effort = Type.Union(["low", "medium", "high", "xhigh", "max"].map((e) => Type.Literal(e)));
const ListQuery = {
	directory: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Literal("project", { description: "list the directory's whole project, not just the directory" })),
	roots: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
	search: Type.Optional(Type.String({ description: "title contains" })),
	start: Type.Optional(Type.String({ description: "only sessions updated at or after this time (ms)" })),
	limit: Type.Optional(Type.String()),
};
const PartInput = Type.Object(
	{
		type: Type.String({ description: "text, or file: a data url (photos, pdfs) or a file url (an @ mention)" }),
		text: Type.Optional(Type.String()),
		mime: Type.Optional(Type.String()),
		filename: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const ModelRef = Type.Object({ providerID: Type.String(), modelID: Type.String() });
const ClientID = Type.Optional(Type.String({ description: "a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it" }));
const PromptBody = Type.Object({
	clientID: ClientID,
	text: Type.Optional(Type.String()),
	parts: Type.Optional(Type.Array(PartInput)),
	model: Type.Optional(ModelRef),
	variant: Type.Optional(Type.String({ description: "cmx's name for the effort; one of the model's variants" })),
	agent: Type.Optional(Type.String()),
	effort: Type.Optional(Effort),
	tool_choice: Type.Optional(Type.Union([Type.Literal("required"), Type.Object({ name: Type.String() })])),
	format: Type.Optional(Type.Object({ schema: Type.Record(Type.String(), Type.Unknown()), name: Type.Optional(Type.String()) })),
});
const TextBody = Type.Object({
	clientID: ClientID,
	text: Type.Optional(Type.String()),
	parts: Type.Optional(Type.Array(PartInput)),
	model: Type.Optional(ModelRef),
	variant: Type.Optional(Type.String({ description: "cmx's name for the effort; one of the model's variants" })),
	agent: Type.Optional(Type.String()),
	effort: Type.Optional(Effort),
});
/** what a queued or steered prompt kept of its choice, echoed so the 202 says what will apply */
const KeptChoice = { model: Type.Optional(Type.String({ description: "provider/model-id the prompt will run on" })), effort: Type.Optional(Type.String()), agent: Type.Optional(Type.String()) };
const MessageWithParts = Type.Object({ info: MessageInfo, parts: Type.Array(Part) });
const Seq = { "x-cmx2-seq": "the cursor (<epoch>:<seq>) of the last event this state includes; apply only events after it" };
const Queued = Type.Object({ queued: Ok, messageID: Type.String({ description: "the provisional id; unsend takes it back" }) });
const Busy = [409];
const Settle = Type.Object({ by: Type.Optional(Type.String({ description: "who is answering, shown to the next client that tries (default: the x-cmx2-client header, else the user agent)" })), clientID: ClientID });

export const ROUTES: RouteDef[] = [
	{ method: "GET", path: "/global/health", operationId: "health", summary: "liveness and version", response: Type.Object({ healthy: Ok, version: Type.String(), name: Type.Literal("cmx2"), contract: Type.Integer(), pid: Type.Integer() }) },
	{ method: "GET", path: "/global/event", operationId: "globalEvents", summary: "every event on the host, wrapped in {directory, project, payload}", response: "sse" },
	{ method: "GET", path: "/event", operationId: "events", summary: "events for one directory, bare payloads", response: "sse", scoped: true },
	{
		method: "GET",
		path: "/global/fs",
		operationId: "browse",
		summary: "list the directories inside a directory (default home)",
		query: Type.Object({ path: Type.Optional(Type.String({ description: "absolute, ~ or ~/..." })), hidden: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])) }),
		response: Type.Object({
			path: Type.String(),
			parent: Type.Union([Type.String(), Type.Null()]),
			home: Type.String(),
			entries: Type.Array(Type.Object({ name: Type.String(), absolute: Type.String(), hidden: Type.Boolean(), git: Type.Boolean() })),
		}),
	},
	{
		method: "POST",
		path: "/global/reload",
		operationId: "reload",
		summary: "re-read config from disk, flush skills, agents, commands, the model list and language servers, and reconnect mcp servers (the answer waits up to 15 s for them); sessions are untouched",
		response: Type.Object({ instances: Type.Integer(), changed: Type.Array(Type.String()), flushed: Type.Array(Type.String()), mcp: Type.Array(McpStatus) }),
	},
	{ method: "GET", path: "/mcp", operationId: "mcp", summary: "the profile's mcp servers and how each is doing", response: Type.Array(McpStatus) },
	{ method: "POST", path: "/global/restart", operationId: "restart", summary: "abort turns, close streams and exit cleanly so the supervisor starts a fresh daemon", response: Ok },
	{
		method: "GET",
		path: "/global/memory",
		operationId: "memory",
		summary: "resident memory and live sessions, for the budget check",
		query: Type.Object({ gc: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")], { description: "run a full garbage collection before measuring" })) }),
		response: Type.Object({ rss: Type.Number(), heapUsed: Type.Number(), heapTotal: Type.Number(), external: Type.Number(), live_sessions: Type.Integer(), uptime_s: Type.Integer(), contract_violations: Type.Integer({ description: "published events that failed their manifest schema (counted when the daemon runs with event checks on)" }) }),
	},
	{
		method: "GET",
		path: "/global/system",
		operationId: "system",
		summary: "the machine the daemon runs on: os, model, cpu and live load, memory, the data volume's disk space and uptimes. static fields are read once; live ones on each request without spawning a process",
		response: Type.Object({
			os: Type.Object({
				platform: Type.String({ description: "process.platform: darwin, linux, win32, ..." }),
				name: Type.String({ description: "macOS, Ubuntu, Debian, ..." }),
				version: Type.String({ description: "the os version (26.1, 24.04); empty when unknown" }),
				kernel: Type.String(),
				arch: Type.String({ description: "arm64, x64, ..." }),
			}),
			machine: Type.Object({
				model: Type.Union([Type.String(), Type.Null()], { description: "a mac's family (Mac mini, MacBook Pro), else the dmi product name (Google Compute Engine)" }),
				identifier: Type.Union([Type.String(), Type.Null()], { description: "a mac's model identifier (Mac16,11); null elsewhere" }),
				virtual: Type.Boolean({ description: "a vm or cloud instance" }),
			}),
			cpu: Type.Object({ model: Type.String(), cores: Type.Integer({ description: "logical cores" }), load: Type.Array(Type.Number(), { description: "load average over 1, 5 and 15 minutes" }) }),
			memory: Type.Object({
				total: Type.Number({ description: "bytes" }),
				available: Type.Number({ description: "bytes usable without swapping: MemAvailable on linux; on macos physical memory less app, wired and compressed memory, as activity monitor counts it" }),
			}),
			disk: Type.Union([Type.Object({ path: Type.String({ description: "mount point of the volume holding the daemon's data" }), total: Type.Number(), available: Type.Number({ description: "bytes free to an unprivileged user" }) }), Type.Null()]),
			uptime: Type.Integer({ description: "host uptime in seconds" }),
			daemon: Type.Object({ rss: Type.Number({ description: "bytes" }), uptime: Type.Integer({ description: "seconds" }) }),
			at: Type.Number({ description: "epoch ms the live fields were read" }),
		}),
	},
	{
		method: "GET",
		path: "/project",
		operationId: "projects",
		summary: "projects that have sessions or checkouts, newest activity first; worktrees=true adds each project's checkouts",
		query: Type.Object({ worktrees: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])) }),
		response: Type.Array(ProjectRow),
		headers: Seq,
	},
	{
		method: "POST",
		path: "/experimental/worktree",
		operationId: "createWorktree",
		summary: "a checkout of the directory's repository on a new branch (cmx2/<name>), from what the directory has checked out unless from says otherwise. answers once the files are in place; setup commands run after, then worktree.ready (or worktree.failed). wait=true answers after setup instead. refusals are 409 WorktreeRefusedError with data.reason cap or disk; outside a repository 400 WorktreeNotGitError",
		body: Type.Object({
			name: Type.Optional(Type.String({ description: "lowercase words; made up when omitted" })),
			from: Type.Optional(Type.String({ description: "a branch or commit; what the directory has checked out when omitted" })),
			startCommand: Type.Optional(Type.String({ description: "one more setup command after the project's worktree.setup" })),
			wait: Type.Optional(Type.Boolean({ description: "answer after the setup commands, with their results" })),
		}),
		response: WorktreeCreated,
		scoped: true,
		errors: [409],
	},
	{ method: "GET", path: "/experimental/worktree", operationId: "worktrees", summary: "the checkouts of the directory's repository", response: Type.Array(WorktreeInfo), scoped: true },
	{
		method: "GET",
		path: "/experimental/worktree/diff",
		operationId: "worktreeDiff",
		summary: "what a checkout's branch holds beyond its base: commits, files with line counts, the patch, and whether it merges clean",
		query: Type.Object({ directory: Type.String({ description: "the checkout" }) }),
		response: WorktreeDiff,
	},
	{
		method: "POST",
		path: "/experimental/worktree/merge",
		operationId: "mergeWorktree",
		summary: "squash-merge a checkout's branch into its base on this machine, then remove the checkout and the branch; never pushes. 409 BusyError while a session in the checkout runs a turn (the run lock), WorktreeMergeConflictError with data.files when the branches conflict, WorktreeRefusedError with data.reason dirty, nothing, detached or target_dirty",
		body: Type.Object({ directory: Type.String({ description: "the checkout" }), message: Type.Optional(Type.String({ description: "the squash commit's message; made from the branch's commits when omitted" })) }),
		response: Type.Object({ merged: Ok, commit: Type.String(), base: Type.String(), branch: Type.String(), commits: Type.Integer(), into: Type.Optional(Type.String({ description: "where the base is checked out; the merge ran there" })), stopped: Type.Array(Type.String(), { description: "processes stopped because they ran in the checkout" }) }),
		errors: [409],
	},
	{
		method: "POST",
		path: "/experimental/worktree/discard",
		operationId: "discardWorktree",
		summary: "remove a checkout and its branch without merging. when it held work, its last state (uncommitted files included) is kept first as a commit under refs/cmx2/rescue/<name>. 409 BusyError while a session in the checkout runs a turn",
		body: Type.Object({ directory: Type.String({ description: "the checkout" }) }),
		response: Type.Object({ discarded: Ok, snapshot: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), stopped: Type.Array(Type.String()) }),
		errors: [409],
	},
	{
		method: "GET",
		path: "/session",
		operationId: "listSessions",
		summary: "sessions, newest updated first (ties by id, descending); the next page's `before` comes back in x-next-cursor",
		query: Type.Object({ ...ListQuery, before: Type.Optional(Type.String({ description: "x-next-cursor from the previous page: `<updated_at>:<id>` continues exactly after that row, so sessions sharing one updated time are not dropped at a page edge; a bare `<updated_at>` (what version 5 answered) pages strictly older than it" })) }),
		response: Type.Array(SessionInfo),
		scoped: true,
		headers: { "x-next-cursor": "`<updated_at>:<id>` of the last item when more may follow (version 5 answered the updated time alone)", ...Seq },
	},
	{
		method: "GET",
		path: "/api/session",
		operationId: "pageSessions",
		summary: "sessions by creation time, cursor-paginated; an empty page is the end",
		query: Type.Object({
			...ListQuery,
			order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
			cursor: Type.Optional(Type.String({ description: "a cursor from a previous page; no other filter may be sent with it" })),
		}),
		response: Type.Object({ items: Type.Array(SessionInfo), cursor: Type.Object({ previous: Type.Optional(Type.String()), next: Type.Optional(Type.String()) }) }),
		scoped: true,
		headers: Seq,
	},
	{
		method: "GET",
		path: "/session/status",
		operationId: "sessionStatus",
		summary: "run state of every non-idle session; with parked=true, parked sessions too (off by default: boxbox v1 reads any entry as busy)",
		query: Type.Object({ parked: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])) }),
		response: Type.Record(Type.String(), SessionStatus),
		scoped: true,
		headers: Seq,
	},
	{
		method: "POST",
		path: "/session",
		operationId: "createSession",
		summary: "create a session in a directory",
		body: Type.Object({
			directory: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "provider/model-id" })),
			effort: Type.Optional(Effort),
			nudge: Type.Optional(Type.Boolean()),
			turn_messages: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("system"), Type.Literal("user-part")])),
			cache_ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")])),
		}),
		response: SessionInfo,
		status: 201,
		scoped: true,
	},
	{ method: "GET", path: "/session/:sessionID", operationId: "getSession", summary: "one session", response: SessionInfo, headers: Seq },
	{
		method: "PATCH",
		path: "/session/:sessionID",
		operationId: "updateSession",
		summary: "rename a session, or archive it with time.archived",
		body: Type.Object({ title: Type.Optional(Type.String({ minLength: 1 })), time: Type.Optional(Type.Object({ archived: Type.Optional(Type.Number()) })) }),
		response: SessionInfo,
		errors: [409],
	},
	{ method: "DELETE", path: "/session/:sessionID", operationId: "deleteSession", summary: "end a session: abort its turn, stop its processes (keep'd ones stay) and archive it. nothing is deleted; listings leave it out", response: Ok },
	{ method: "GET", path: "/session/:sessionID/children", operationId: "children", summary: "sessions this one started (its subagents), newest first", response: Type.Array(SessionInfo), headers: Seq },
	{
		method: "GET",
		path: "/session/:sessionID/agents",
		operationId: "roster",
		summary: "the agent tree this session belongs to: live agents, then the newest closed ones",
		query: Type.Object({ path_prefix: Type.Optional(Type.String()) }),
		response: Type.Object({ root: Type.String(), self: Type.String({ description: "this session's path" }), agents: Type.Array(AgentInfo) }),
		headers: Seq,
	},
	{
		method: "POST",
		path: "/session/:sessionID/agents",
		operationId: "spawnAgent",
		summary: "spawn an agent as this session (the same verb the model calls); returns at once",
		body: Type.Object({
			brief: Type.String(),
			seat: Type.Optional(Type.String({ description: "gone: seats were replaced by models in routing.jsonc version 2; a request that sends it is refused with SeatsRemovedError" })),
			name: Type.Optional(Type.String()),
			effort: Type.Optional(Effort),
			agent_type: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "a model name from routing.jsonc, or provider/model-id; required unless the agent type names one" })),
			after: Type.Optional(Type.String({ description: "id, path or name of an earlier helper whose attempt this one takes over; its brief and last report ride along, and it keeps running unless closed" })),
			files: Type.Optional(Type.Array(Type.String())),
			fork_turns: Type.Optional(Type.Integer({ minimum: 1 })),
			on_failure: Type.Optional(Type.Union([Type.Literal("escalate"), Type.Literal("respawn"), Type.Literal("ignore")])),
			pool: Type.Optional(
				Type.Object({
					n: Type.Integer({ minimum: 1, maximum: 16 }),
					collect: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("first"), Type.Literal("any_n")])),
					any_n: Type.Optional(Type.Integer({ minimum: 1 })),
					strategy: Type.Optional(Type.Union([Type.Literal("one_for_one"), Type.Literal("one_for_all"), Type.Literal("rest_for_one")])),
					briefs: Type.Optional(Type.Array(Type.String())),
				}),
			),
			cache_ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")])),
			warm: Type.Optional(Type.Boolean({ description: "keep its cache warm while it is parked (default on for subagents)" })),
			mailbox_capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
			behavior_version: Type.Optional(Type.Union([Type.Literal("subagent_v1"), Type.Literal("subagent_v2")])),
			budget_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "tokens one dispatch may spend before it stops with a partial report" })),
			directory: Type.Optional(Type.String({ description: "where the agent works instead of the spawner's directory, such as a checkout" })),
		}),
		response: Type.Object({ agents: Type.Array(AgentInfo) }),
		status: 201,
		errors: [409],
	},
	{
		method: "POST",
		path: "/session/:sessionID/agents/message",
		operationId: "messageAgent",
		summary: "send a note as this session to an agent in its tree",
		body: Type.Object({ to: Type.String({ description: "id, path, name or parent" }), body: Type.String(), wake: Type.Optional(Type.Boolean()), correlation_id: Type.Optional(Type.String()) }),
		response: Type.Object({ to: Type.String(), id: Type.String(), state: Type.String(), woke: Type.Boolean(), pending: Type.Integer() }),
		status: 202,
		errors: [409],
	},
	{
		method: "POST",
		path: "/session/:sessionID/agents/wait",
		operationId: "waitAgents",
		summary: "wait on this session's mailbox (the model's wait verb)",
		body: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })), correlation_id: Type.Optional(Type.String()) }),
		response: Type.Object(
			{ arrived: Type.Boolean(), timed_out: Type.Boolean(), waited_ms: Type.Integer(), items: Type.Array(Type.Record(Type.String(), Type.Unknown())), already_delivered: Type.Optional(Type.Boolean()), warning: Type.Optional(Type.String()) },
			{ additionalProperties: true },
		),
	},
	{
		method: "POST",
		path: "/session/:sessionID/agents/interrupt",
		operationId: "interruptAgent",
		summary: "stop an agent's current turn; it stays resumable",
		body: Type.Object({ target: Type.String() }),
		response: Type.Object({ path: Type.String(), previous_state: Type.String(), interrupted: Type.Boolean() }),
	},
	{
		method: "POST",
		path: "/session/:sessionID/agents/close",
		operationId: "closeAgent",
		summary: "close an agent and everything under it; transcripts stay",
		body: Type.Object({ target: Type.String() }),
		response: Type.Object({ path: Type.String(), previous_state: Type.String(), already_terminated: Type.Boolean(), closed: Type.Array(Type.String()) }),
	},
	{ method: "GET", path: "/session/:sessionID/agents/metrics", operationId: "agentMetrics", summary: "delivery, safety-net, wait-timeout and tool-error rates for the tree", response: Type.Record(Type.String(), Type.Unknown()) },
	{ method: "GET", path: "/session/:sessionID/mailbox", operationId: "mailbox", summary: "mailbox items not yet in this session's transcript", response: Type.Array(Type.Record(Type.String(), Type.Unknown())) },
	{
		method: "GET",
		path: "/session/:sessionID/message",
		operationId: "messages",
		summary: "messages oldest first; with limit, the newest page, and x-next-cursor for the page before it. the newest page ends with the message being streamed, if any, with every text and reasoning part it has started, in content order, typed, its text so far, marked streaming with time.start (a part whose block has ended reads final: the whole text, time with end, no streaming)",
		query: Type.Object({ limit: Type.Optional(Type.String()), before: Type.Optional(Type.String()) }),
		response: Type.Array(MessageWithParts),
		headers: { "x-next-cursor": "pass as before for the older page", ...Seq },
	},
	{ method: "GET", path: "/session/:sessionID/message/:messageID", operationId: "getMessage", summary: "one message with its parts; the message being streamed reads with every text and reasoning part it has started (typed, in content order, text so far, marked streaming; a part whose block has ended reads final)", response: MessageWithParts, headers: Seq },
	{
		method: "POST",
		path: "/session/:sessionID/prompt",
		operationId: "prompt",
		summary: "start a turn, or queue it behind the running one; messageID is the prompt's id either way",
		body: PromptBody,
		response: Type.Object({ accepted: Ok, effort: Type.String(), messageID: Type.String(), queued: Type.Optional(Type.String({ description: "present when the prompt waits behind a running turn: its provisional id" })) }),
		status: 202,
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/message",
		operationId: "sendMessage",
		summary: "cmx's blocking send: runs a turn and answers with the assistant message once it settles (headers at once, the body when it settles); a busy session queues the prompt and answers 202 with its id",
		body: PromptBody,
		response: Type.Union([MessageWithParts, Type.Null()]),
		also: { status: 202, response: Queued, description: "queued behind the running turn" },
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/prompt_async",
		operationId: "promptAsync",
		summary: "start or queue a turn and answer at once with the prompt's id; a queued prompt is announced as a provisional message",
		body: PromptBody,
		response: Type.Object({ messageID: Type.String(), queued: Type.Boolean() }),
		status: 202,
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/shell",
		operationId: "shell",
		summary: "run a `!` line in the session's directory; the model reads it on its next request. answers with the shell message",
		body: Type.Object({ clientID: ClientID, command: Type.String({ minLength: 1 }), agent: Type.Optional(Type.String()), model: Type.Optional(ModelRef) }),
		response: Type.Union([MessageWithParts, Type.Null()]),
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/command",
		operationId: "runCommand",
		summary: "run a / command (a command file or a skill) as a prompt; blocks like /message",
		body: Type.Object({
			clientID: ClientID,
			command: Type.String(),
			arguments: Type.Optional(Type.String()),
			agent: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "provider/model-id" })),
			variant: Type.Optional(Type.String()),
			messageID: Type.Optional(Type.String()),
			parts: Type.Optional(Type.Array(PartInput)),
		}),
		response: Type.Union([MessageWithParts, Type.Null()]),
		also: { status: 202, response: Queued, description: "queued behind the running turn" },
		errors: Busy,
	},
	{ method: "DELETE", path: "/session/:sessionID/message/:messageID", operationId: "unsend", summary: "take back a queued prompt the model has not seen; 409 once it went out", response: Ok, errors: Busy },
	{ method: "POST", path: "/session/:sessionID/loop", operationId: "loop", summary: "run what abort left queued, now: ran is how many waiting messages it started (0 when nothing waited); 409 while a turn is running", response: Type.Object({ ran: Type.Integer({ description: "waiting messages the turn it started took" }) }), errors: Busy },
	{
		method: "GET",
		path: "/session/:sessionID/queue",
		operationId: "queuedMessages",
		summary: "the prompts and steers waiting behind the running turn, or left by an abort, oldest first, as the provisional messages the stream announced (queued: true, steer: true on a steer, clientID, the model, variant and agent each asked for). x-cmx2-seq is the cursor the list reflects; message.updated and message.removed after it keep it current; DELETE /session/:id/message/:messageID takes one back",
		response: Type.Array(MessageWithParts),
		headers: Seq,
	},
	{ method: "POST", path: "/session/:sessionID/share", operationId: "share", summary: "not supported: sessions stay on this machine (501 NotSupportedError)", response: ErrorBody },
	{ method: "DELETE", path: "/session/:sessionID/share", operationId: "unshare", summary: "not supported (501 NotSupportedError)", response: ErrorBody },
	{
		method: "POST",
		path: "/session/:sessionID/summarize",
		operationId: "summarize",
		summary: "compact the session now, on its own cached prefix; answers once the summary is in (the model given is taken for the next turn, as the picker would)",
		body: Type.Object({ providerID: Type.Optional(Type.String()), modelID: Type.Optional(Type.String()), auto: Type.Optional(Type.Boolean()) }),
		response: Ok,
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/revert",
		operationId: "revert",
		summary: "put the files back as they were before a message and park it and everything after it; the next send makes it permanent (the messages stay on disk, out of lists), unrevert undoes it",
		body: Type.Object({ messageID: Type.String(), partID: Type.Optional(Type.String()) }),
		response: SessionInfo,
		errors: Busy,
	},
	{ method: "POST", path: "/session/:sessionID/unrevert", operationId: "unrevert", summary: "undo an armed revert: the files and the parked messages come back", response: SessionInfo, errors: Busy },
	{
		method: "POST",
		path: "/session/:sessionID/fork",
		operationId: "fork",
		summary: "a new session with this one's history up to (not including) a message, or all of it; titled (fork #n)",
		body: Type.Object({ messageID: Type.Optional(Type.String()) }),
		response: SessionInfo,
	},
	{
		method: "GET",
		path: "/session/:sessionID/diff",
		operationId: "sessionDiff",
		summary: "what the session changed in its files, one entry per file (with messageID, what that turn changed)",
		query: Type.Object({ messageID: Type.Optional(Type.String()) }),
		response: Type.Array(FileDiff),
	},
	{
		method: "POST",
		path: "/session/:sessionID/procs",
		operationId: "startProc",
		summary: "start a job (or a pty with tty) the session owns; notify reports back to the session as a turn message",
		body: Type.Object({
			command: Type.String({ minLength: 1 }),
			tty: Type.Optional(Type.Boolean()),
			title: Type.Optional(Type.String()),
			keep: Type.Optional(Type.String({ description: "survives session end under this name" })),
			detach: Type.Optional(Type.Boolean({ description: "survives daemon restart" })),
			notify: Type.Optional(Type.Object({ on_exit: Type.Optional(Type.Boolean()), on_pattern: Type.Optional(Type.String()), on_port: Type.Optional(Type.Integer()) })),
		}),
		response: ProcessInfo,
		status: 201,
		errors: [409],
	},
	{ method: "GET", path: "/session/:sessionID/procs", operationId: "sessionProcs", summary: "the session's jobs and ptys, ports refreshed", response: Type.Array(ProcessInfo), headers: Seq },
	{
		method: "POST",
		path: "/session/:sessionID/steer",
		operationId: "steer",
		summary: "land a message at the next tool boundary of the running turn (announced as a provisional message marked steer: true), or start a turn. an effort or agent rides the steer (the effort applies from the next turn, the agent when it lands); a model other than the running turn's answers 400, since a steer joins the turn that is running (queue it instead). an effort the model does not allow answers 400",
		body: TextBody,
		response: Type.Object({ result: Type.Union([Type.Literal("steered"), Type.Literal("started")]), messageID: Type.String(), ...KeptChoice }),
		status: 202,
		errors: Busy,
	},
	{
		method: "POST",
		path: "/session/:sessionID/queue",
		operationId: "queue",
		summary: "run a message after the running turn (announced as a provisional message), or start a turn. the model, effort and agent stay on the waiting message and apply when it runs: one that asks for another model or effort than the session has runs as its own turn after the running one. an effort the model does not allow, or a model that cannot be set, answers 400 now",
		body: TextBody,
		response: Type.Object({ result: Type.Union([Type.Literal("queued"), Type.Literal("started")]), messageID: Type.String(), ...KeptChoice }),
		status: 202,
		errors: Busy,
	},
	{ method: "POST", path: "/session/:sessionID/effort", operationId: "setEffort", summary: "move the effort dial; applies from the next turn", body: Type.Object({ effort: Effort }), response: Type.Object({ result: Type.Union([Type.Literal("applied"), Type.Literal("pending")]), effort: Type.String() }), errors: [409] },
	{ method: "POST", path: "/session/:sessionID/abort", operationId: "abort", summary: "stop the running turn", response: Ok },
	{ method: "GET", path: "/session/:sessionID/steps", operationId: "steps", summary: "per-step telemetry", response: Type.Array(StepRow) },
	{ method: "GET", path: "/session/:sessionID/prefix", operationId: "prefix", summary: "the recorded prefix bytes and hash", response: Type.Object({ hash: Type.String(), bytes: Type.String() }) },
	{ method: "GET", path: "/session/:sessionID/requests", operationId: "requests", summary: "summaries of the last 200 model requests (prefix hash, markers, gates)", response: Type.Array(Type.Record(Type.String(), Type.Unknown())) },
	{ method: "GET", path: "/session/:sessionID/messages", operationId: "transcript", summary: "the engine transcript as the model sees it (pi's message shapes), for evals and debugging", response: Type.Array(Type.Record(Type.String(), Type.Unknown())) },
	{
		method: "GET",
		path: "/command",
		operationId: "commands",
		summary: "/ commands: command files from the profile and the project, then skills",
		response: Type.Array(
			Type.Object({
				name: Type.String(),
				description: Type.Optional(Type.String()),
				agent: Type.Optional(Type.String()),
				model: Type.Optional(Type.String()),
				source: Type.Union([Type.Literal("command"), Type.Literal("skill")]),
				template: Type.String(),
				hints: Type.Array(Type.String()),
			}),
		),
		scoped: true,
	},
	{
		method: "GET",
		path: "/find/file",
		operationId: "findFile",
		summary: "fuzzy paths relative to the directory, for the @ picker; directories end in /",
		query: Type.Object({
			query: Type.Optional(Type.String()),
			limit: Type.Optional(Type.String({ description: "1 to 200, default 10" })),
			dirs: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
			type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory")])),
		}),
		response: Type.Array(Type.String()),
		scoped: true,
		headers: { "x-truncated": "true when the directory's walk was cut (its deadline, 200,000 paths) or failed: the paths are what was found, not everything. a client treats it as transient" },
	},
	{
		method: "GET",
		path: "/find/text",
		operationId: "findText",
		summary: "ripgrep over the directory (.gitignore holds): regex unless literal, smart case; x-truncated when limit cut it",
		query: Type.Object({
			pattern: Type.String(),
			literal: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
			glob: Type.Optional(Type.String({ description: "only files matching this glob, e.g. *.ts" })),
			limit: Type.Optional(Type.String({ description: "1 to 1000, default 100" })),
		}),
		response: Type.Array(
			Type.Object({
				path: Type.String({ description: "relative to the directory" }),
				line: Type.Integer(),
				text: Type.String({ description: "the line, cut at 500 characters" }),
				submatches: Type.Array(Type.Object({ start: Type.Integer({ description: "utf-16 offset in text" }), end: Type.Integer(), text: Type.String() })),
			}),
		),
		scoped: true,
		headers: { "x-truncated": "true when more matches exist than limit" },
	},
	{
		method: "GET",
		path: "/file/content",
		operationId: "fileContent",
		summary: "one file's raw bytes, for a favicon or a preview: content-type from the magic bytes first (png, jpeg, gif, webp, avif, ico, svg) and the extension second, an etag (if-none-match answers 304) and content-length. a missing path or a directory is 404 FileNotFoundError; a path that leaves the directory, by .. or a symlink, is 403; a file over max is 413 FileTooLargeError, refused from its size without reading it. a file that kept changing while it was read is 409 ConflictError. HEAD answers the same headers without the body. a read never creates an instance for a directory",
		query: Type.Object({
			path: Type.String({ description: "relative to the directory" }),
			max: Type.Optional(Type.String({ description: "bytes, 1 to 1048576 (the default and the ceiling)" })),
		}),
		response: Type.String({ format: "binary", description: "the file's bytes" }),
		bytes: true,
		scoped: true,
		errors: [403, 409, 413],
		headers: { "content-type": "sniffed from the bytes, then the extension, then text/plain or application/octet-stream", etag: "a quoted hash of the bytes; send it back as if-none-match for a 304", "content-length": "the file's size" },
	},
	{
		method: "GET",
		path: "/file/status",
		operationId: "fileStatus",
		summary: "the directory's git work tree against HEAD: changed, added, deleted and untracked files with line counts, so a client can show what a session changed",
		response: Type.Array(
			Type.Object({
				path: Type.String({ description: "relative to the directory" }),
				status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed"), Type.Literal("untracked")]),
				added: Type.Integer(),
				removed: Type.Integer(),
			}),
		),
		scoped: true,
	},
	{
		method: "GET",
		path: "/agent",
		operationId: "agents",
		summary: "agent types: build, then agent files from the profile and the project",
		response: Type.Array(
			Type.Object(
				{ name: Type.String(), description: Type.Optional(Type.String()), mode: Type.Union([Type.Literal("primary"), Type.Literal("subagent"), Type.Literal("all")]), native: Type.Boolean(), hidden: Type.Optional(Type.Boolean()), model: Type.Optional(ModelRef) },
				{ additionalProperties: true },
			),
		),
		scoped: true,
	},
	{
		method: "GET",
		path: "/config/providers",
		operationId: "providers",
		summary: "the models this daemon can run, by provider, without the profile's blacklist; variants are the efforts each accepts, then the profile's named variants for it. a model's cost is {input, output, cache: {read, write}} per million tokens, plus tiers (inputTokensAbove, input, output, cache) when it has a long-context rate that applies to every token of a request once its input passes the threshold (haiku 5.5 from 100k)",
		response: Type.Object({ providers: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), models: Type.Record(Type.String(), Type.Object({ id: Type.String(), providerID: Type.String(), name: Type.String() }, { additionalProperties: true })) }, { additionalProperties: true })), default: Type.Record(Type.String(), Type.String()) }),
		scoped: true,
	},
	{
		method: "GET",
		path: "/config",
		operationId: "getConfig",
		summary: "the merged profile (defaults, cmx2.jsonc, the machine overlay, the project layer): literal keys, header and env values masked as [redacted]; $ENV references stay",
		response: Type.Record(Type.String(), Type.Unknown()),
		headers: Seq,
		scoped: true,
	},
	{
		method: "PATCH",
		path: "/config",
		operationId: "patchConfig",
		summary: "change the profile's cmx2.jsonc with a json merge patch (null removes a key); comments are kept, a patch that would not load is refused and the file left as it was, the daemon reloads",
		body: Type.Record(Type.String(), Type.Unknown()),
		response: Type.Object({ path: Type.String(), changed: Type.Array(Type.String()), config: Type.Record(Type.String(), Type.Unknown()) }),
	},
	{
		method: "POST",
		path: "/pair",
		operationId: "pair",
		summary: "trade the one-time token cmx2 pair printed for a bearer credential (send it as authorization: Bearer). needs no other auth; a spent, expired or unknown token is 401",
		body: Type.Object({ token: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ description: "what the client calls itself; cmx2 pair --list shows it" })) }),
		response: Type.Object({ id: Type.String(), name: Type.String(), credential: Type.String(), scheme: Type.Literal("Bearer"), version: Type.String(), contract: Type.Integer() }),
	},
	{ method: "GET", path: "/pty", operationId: "ptys", summary: "open terminals (exited ones a person opened drop off)", response: Type.Array(PtyInfo) },
	{ method: "GET", path: "/pty/shells", operationId: "ptyShells", summary: "login shells on this host", response: Type.Array(Type.Object({ path: Type.String(), name: Type.String(), acceptable: Type.Boolean() })) },
	{
		method: "POST",
		path: "/pty",
		operationId: "createPty",
		summary: "open a terminal (a login shell unless command is given)",
		body: Type.Object({ command: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String())), cwd: Type.Optional(Type.String()), title: Type.Optional(Type.String()), env: Type.Optional(Type.Record(Type.String(), Type.String())), origin: Type.Optional(Type.Union([Type.Literal("tui"), Type.Literal("model")])) }),
		response: PtyInfo,
		scoped: true,
	},
	{ method: "GET", path: "/pty/:ptyID", operationId: "getPty", summary: "one terminal", response: PtyInfo },
	{ method: "PUT", path: "/pty/:ptyID", operationId: "updatePty", summary: "rename or resize a terminal", body: Type.Object({ title: Type.Optional(Type.String()), size: Type.Optional(Type.Object({ rows: Type.Integer({ minimum: 1 }), cols: Type.Integer({ minimum: 1 }) })) }), response: PtyInfo },
	{ method: "DELETE", path: "/pty/:ptyID", operationId: "deletePty", summary: "kill and forget a terminal", response: Ok },
	{
		method: "GET",
		path: "/pty/:ptyID/connect",
		operationId: "connectPty",
		summary: "terminal bytes. ?cursor= resumes (utf-16 units; -1 is from now; absent replays what is retained). output arrives as text frames, then one binary frame: byte 0 and json {cursor}. text frames sent are typed into the terminal; resize with PUT",
		query: Type.Object({ cursor: Type.Optional(Type.String()) }),
		response: "websocket",
	},
	{ method: "GET", path: "/proc", operationId: "procs", summary: "every process on the daemon (the kill list)", response: Type.Array(ProcessInfo) },
	{ method: "GET", path: "/proc/sweep", operationId: "sweep", summary: "what the orphan sweep at daemon start found", response: Type.Record(Type.String(), Type.Unknown()) },
	{ method: "POST", path: "/proc/:procID/kill", operationId: "killProc", summary: "stop a process and its group (sigterm, then sigkill)", response: ProcessInfo },
	{ method: "GET", path: "/permission", operationId: "permissions", summary: "pending permission asks", response: Type.Array(PermissionRequest), scoped: true, headers: Seq },
	{
		method: "POST",
		path: "/permission/:requestID/reply",
		operationId: "replyPermission",
		summary: "answer a permission ask. reject settles this ask only (cascade: true rejects the session's other pending asks too); always saves the patterns for the project. an unknown id is 404; an ask already settled is 409 ConflictError with {reply, settledAt, by}",
		body: Type.Object({
			reply: Type.Union([Type.Literal("once"), Type.Literal("always"), Type.Literal("reject")]),
			message: Type.Optional(Type.String({ description: "with reject: feedback the model reads and continues from" })),
			cascade: Type.Optional(Type.Boolean({ description: "with reject: reject the session's other pending asks too" })),
			...Settle.properties,
		}),
		response: Ok,
		errors: [409],
	},
	{ method: "GET", path: "/question", operationId: "questions", summary: "pending questions", response: Type.Array(QuestionRequest), scoped: true, headers: Seq },
	{
		method: "POST",
		path: "/question/:requestID/reply",
		operationId: "replyQuestion",
		summary: "answer a question: one list of chosen labels (or typed text) per question. unknown is 404; already settled is 409 ConflictError with {answers | state, settledAt, by}",
		body: Type.Object({ answers: Type.Array(Type.Array(Type.String())), ...Settle.properties }),
		response: Ok,
		errors: [409],
	},
	{ method: "POST", path: "/question/:requestID/reject", operationId: "rejectQuestion", summary: "dismiss a question. unknown is 404; already settled is 409", body: Settle, response: Ok, errors: [409] },
];
