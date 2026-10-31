// generated from packages/contract/src/manifest.ts by packages/contract/src/generate.ts. edit the manifest, then run `bun run contract`.

export const CONTRACT_VERSION = 7;

/** no turn running; with parked, waiting on agents or jobs that will wake it */
export type SessionStatusIdle = {
	type: "idle";
	/** when this state began (ms); on a parked session, when it parked */
	since?: number;
	/** prompts an abort left waiting (GET /session/:id/queue lists them; loop runs them) */
	queued?: number;
	/** the turn has ended and the session waits on these; a report or a job notice wakes it */
	parked?: {
		/** agents under it still working or queued */
		agents: number;
		/** background jobs that will notify it; serve jobs never count */
		jobs: number;
	};
};

/** a turn is running */
export type SessionStatusBusy = {
	type: "busy";
	/** steers and queued prompts admitted but not yet sent to the model */
	queued?: number;
	/** when the turn began (ms) */
	since?: number;
	/** why the turn has not started yet, short and lowercase, shown as is: the session's directory has not answered (a macos privacy prompt, a hung mount) */
	waiting?: string;
};

/** a turn is waiting out a transient provider failure */
export type SessionStatusRetry = {
	type: "retry";
	attempt: number;
	/** short and lowercase, shown as is */
	message: string;
	/** when the next attempt goes (ms) */
	next: number;
	since?: number;
};

/** discriminated on type. idle sessions are absent from the status map unless parked=true is asked for */
export type SessionStatus = SessionStatusIdle | SessionStatusBusy | SessionStatusRetry;

export type ToolStatePending = {
	status: "pending";
	input: Record<string, unknown>;
	[key: string]: unknown;
};

export type ToolStateRunning = {
	status: "running";
	input: Record<string, unknown>;
	time?: {
		start?: number | null;
		end?: number;
		[key: string]: unknown;
	};
	/** while a shell runs, output holds the last 2 kb, updated at most once a second, and progress counts those updates from 1 (a tail with a lower progress than one already applied is older and can be dropped: progress frames carry no seq) */
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
};

export type ToolStateCompleted = {
	status: "completed";
	input: Record<string, unknown>;
	output: string;
	title: string;
	/** what the tool reported. a completed edit or write carries filediff {file, patch, additions, deletions} (the shape imported history has; the patch is a unified patch cut at 64 KB, 8 KB for a file the call created, the counts cover the whole change) and truncated (the patch was cut). a change too big to diff (a changed region over 32 MB, or a file over 64 MB) carries no filediff: counts made up for it would look exact */
	metadata: Record<string, unknown>;
	time: {
		start?: number | null;
		end?: number;
		[key: string]: unknown;
	};
	/** the images the tool returned (a read of an image, a screenshot), for clients to preview; present only when the result carried at least one. in result order, at most 8 and at most 4 MB of data urls per part; the filename is the label the tool gave the image (the file name for a read), else image */
	attachments?: Array<{
		type: "file";
		mime: string;
		filename: string;
		/** a data url */
		url: string;
		[key: string]: unknown;
	}>;
	/** how many of the result's images were left off attachments by the 8 image or 4 MB cap; absent when none were */
	attachmentsDropped?: number;
	[key: string]: unknown;
};

export type ToolStateError = {
	status: "error";
	input: Record<string, unknown>;
	error: string;
	time: {
		start?: number | null;
		end?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** discriminated on status */
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

/** text; on user messages mail and notice mark agent and runtime words */
export type TextPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "text";
	text: string;
	/** context the user did not type (a mentioned file, the turn context, a move) */
	synthetic?: boolean;
	/** on the notice message (notice.source moved) an import onto another machine or folder writes, and on its one text part: where the session ran before and where it runs now, for a client to draw a divider (moved from <machine>). the part's text is the line the model reads with its next request; the part is synthetic, so it is not the person's words */
	moved?: {
		from: {
			machine: string;
			os: string;
			arch: string;
			/** the session's folder: the repo root paths translate between */
			directory: string;
			home: string;
			[key: string]: unknown;
		};
		to: {
			machine: string;
			os: string;
			arch: string;
			/** the session's folder: the repo root paths translate between */
			directory: string;
			home: string;
			[key: string]: unknown;
		};
		at: number;
		[key: string]: unknown;
	};
	/** the part is still being written: it was announced with empty text when it started, message.part.delta extends it, and its final message.part.updated (the whole text, no streaming, time with end) ends it, published when the part's block ends, not when the step does; in a read, the text so far, with the deltas after the read's seq continuing it; a part whose block has ended reads final, not streaming */
	streaming?: boolean;
	/** start is when the part was announced (its first delta follows at once), end when its block ended; end is absent on a part that is still streaming */
	time?: {
		start: number;
		end?: number;
	};
	[key: string]: unknown;
};

/** the model's visible thinking; it streams like text, in content order with the text parts of its message */
export type ReasoningPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "reasoning";
	text: string;
	/** the part is still being written: it was announced with empty text when it started, message.part.delta extends it, and its final message.part.updated (the whole text, no streaming, time with end) ends it, published when the part's block ends, not when the step does; in a read, the text so far, with the deltas after the read's seq continuing it; a part whose block has ended reads final, not streaming */
	streaming?: boolean;
	/** start is when the part was announced (its first delta follows at once), end when its block ended; end is absent on a part that is still streaming */
	time?: {
		start: number;
		end?: number;
	};
	[key: string]: unknown;
};

/** one tool call and its state */
export type ToolPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "tool";
	callID: string;
	tool: string;
	/** discriminated on status */
	state: ToolState;
	[key: string]: unknown;
};

/** an attached photo or document */
export type FilePart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "file";
	mime: string;
	filename: string;
	/** a data url */
	url: string;
	[key: string]: unknown;
};

/** a compaction: the summary follows as an assistant message marked summary */
export type CompactionPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "compaction";
	auto: boolean;
	overflow?: boolean;
	/** the first message kept verbatim after the summary */
	tail_start_id?: string;
	[key: string]: unknown;
};

/** imported history only: a model step began */
export type StepStartPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "step-start";
	/** the work-tree snapshot hash the step started from, when the source took one */
	snapshot?: string;
	[key: string]: unknown;
};

/** imported history only: a model step ended, with its cost and tokens */
export type StepFinishPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "step-finish";
	/** why the step ended (stop, tool-calls, length, ...) */
	reason: string;
	/** the work-tree snapshot hash at the step's end, when the source took one */
	snapshot?: string;
	/** usd the step cost */
	cost: number;
	tokens: {
		total?: number;
		input: number;
		output: number;
		reasoning: number;
		cache: {
			read: number;
			write: number;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** imported history only: the files a step changed */
export type PatchPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "patch";
	/** the snapshot hash the files changed against */
	hash: string;
	/** absolute paths the step changed */
	files: Array<string>;
	[key: string]: unknown;
};

/** imported history only: a subtask or command the user started */
export type SubtaskPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: "subtask";
	agent: string;
	description: string;
	prompt: string;
	command?: string;
	model?: {
		providerID: string;
		modelID: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** one file's change: full text before and after */
export type FileDiff = {
	/** relative to the session's directory */
	file: string;
	before: string;
	after: string;
	additions: number;
	deletions: number;
	status: "added" | "deleted" | "modified";
	/** or over 256 kb: before and after are left empty, the counts stand */
	binary?: boolean;
};

/** opencode-compatible session info plus cmx2's fields */
export type SessionInfo = {
	id: string;
	slug: string;
	/** the project root (git top level, or the directory) */
	projectID: string;
	directory: string;
	parentID?: string;
	/** set on a session made by fork: where it came from */
	forkedFrom?: {
		sessionID: string;
		/** the parent's message the fork was cut before: the fork holds the parent's history up to, not including, this message. absent when the whole history was forked */
		messageID?: string;
	};
	/** set on a session imported from another machine or folder (POST /session/import): where it ran before. its timeline holds the move as a notice message (notice.source moved, with moved on the info and the part). absent on a session that never moved, and on one imported from a bundle with no origin (written before this field) */
	movedFrom?: {
		/** the short hostname of the machine the session was exported from */
		machine: string;
		/** macos, linux, windows, or the platform name */
		os: string;
		/** the session's folder there */
		directory: string;
		/** when it was imported here (ms) */
		at: number;
	};
	title: string;
	/** daemon version that created the session */
	version: string;
	time: {
		created: number;
		updated: number;
		/** when the session was archived (deleted from view); its history stays */
		archived?: number;
	};
	model?: {
		id: string;
		providerID: string;
	};
	summary?: {
		additions: number;
		deletions: number;
		files: number;
	};
	/** cmx sessions are imported history: browse only */
	source: "cmx2" | "cmx";
	effort?: string;
	cost: number;
	tokens: {
		input: number;
		output: number;
		cache: {
			read: number;
			write: number;
		};
	};
	/** discriminated on type. idle sessions are absent from the status map unless parked=true is asked for */
	status?: {
		type: "idle";
		/** when this state began (ms); on a parked session, when it parked */
		since?: number;
		/** prompts an abort left waiting (GET /session/:id/queue lists them; loop runs them) */
		queued?: number;
		/** the turn has ended and the session waits on these; a report or a job notice wakes it */
		parked?: {
			/** agents under it still working or queued */
			agents: number;
			/** background jobs that will notify it; serve jobs never count */
			jobs: number;
		};
	} | {
		type: "busy";
		/** steers and queued prompts admitted but not yet sent to the model */
		queued?: number;
		/** when the turn began (ms) */
		since?: number;
		/** why the turn has not started yet, short and lowercase, shown as is: the session's directory has not answered (a macos privacy prompt, a hung mount) */
		waiting?: string;
	} | {
		type: "retry";
		attempt: number;
		/** short and lowercase, shown as is */
		message: string;
		/** when the next attempt goes (ms) */
		next: number;
		since?: number;
	};
	/** the git branch of the session's directory, when it is in a work tree */
	vcs?: {
		branch: string;
		/** the work tree has uncommitted changes, untracked files included */
		dirty: boolean;
	};
	/** context fill */
	context?: {
		/** tokens in the context now: the last step's usage plus an estimate of what came after it */
		used: number;
		/** the model's context window */
		limit: number;
		/** where automatic compaction runs */
		compactAt?: number;
	};
	/** an armed revert: the files are back as they were before messageID */
	revert?: {
		/** messages from this one on are parked; the next send makes it permanent, unrevert brings them back */
		messageID: string;
		partID?: string;
		snapshot?: string;
		diff?: {
			files: number;
			additions: number;
			deletions: number;
		};
	};
	/** the session's transcript revision: 0 for a new session, persisted with it, and moved on (never back) in the same transaction as every write that changes what GET /session/:id/message answers, streamed text aside: a message landed or updated, a part created or replaced, a message removed (taken back, a queued prompt that failed, a provisional message swapped for its committed one, a revert made permanent), a revert and its undo, a compaction summary. status, idle, model, title, archive, message.part.delta and a shell's tail leave it. on every rest answer that returns a session; on session.created and session.updated only for a stream that asks with rev=1. imported history stays at 0, and a session that had history before the revision existed starts at 0 too: 0 does not mean empty, and a client with no revision stored for a session reads it */
	transcriptRev?: number;
};

/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
export type MessageInfo = {
	id: string;
	sessionID: string;
	/** user or assistant */
	role: string;
	time: {
		created: number;
		completed?: number;
	};
	/** on a user message: the client id of the request that sent it */
	clientID?: string;
	/** a provisional message waiting behind the running turn; it reissues under its transcript id when it lands */
	queued?: boolean;
	/** on a user message sent as a steer (read at the next tool boundary of the running turn), provisional or landed; absent on a prompt that waited for the turn to end */
	steer?: boolean;
	/** on a user message: the agent it was sent for */
	agent?: string;
	/** on a queued or steered user message: the model it asked for, applied when it runs */
	model?: {
		providerID: string;
		modelID: string;
	};
	/** on a queued or steered user message: the effort it asked for, applied when it runs (a steer's from the next turn) */
	variant?: string;
	/** on a user message made by promoting a btw: the btw's id. its text is the question and the answer, framed as a btw the user asked */
	btw?: string;
	/** on a user message that is runtime words, not the person's: what said it (job ..., moved) */
	notice?: {
		source: string;
		[key: string]: unknown;
	};
	/** on the notice message (notice.source moved) an import onto another machine or folder writes, and on its one text part: where the session ran before and where it runs now, for a client to draw a divider (moved from <machine>). the part's text is the line the model reads with its next request; the part is synthetic, so it is not the person's words */
	moved?: {
		from: {
			machine: string;
			os: string;
			arch: string;
			/** the session's folder: the repo root paths translate between */
			directory: string;
			home: string;
			[key: string]: unknown;
		};
		to: {
			machine: string;
			os: string;
			arch: string;
			/** the session's folder: the repo root paths translate between */
			directory: string;
			home: string;
			[key: string]: unknown;
		};
		at: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** opencode-shaped part, discriminated on type. step-start, step-finish, patch and subtask appear in imported (source cmx) history only */
export type Part = TextPart | ReasoningPart | ToolPart | FilePart | CompactionPart | StepStartPart | StepFinishPart | PatchPart | SubtaskPart;

export type PermissionRequest = {
	id: string;
	sessionID: string;
	/** shell, edit, read, grep, glob, webfetch, external_directory, ... */
	permission: string;
	/** what the call touches: the command, the path */
	patterns: Array<string>;
	metadata: Record<string, unknown>;
	/** patterns an always answer saves for the project */
	always: Array<string>;
	/** the tool call that raised the ask */
	tool?: {
		messageID: string;
		callID: string;
	};
};

export type QuestionOption = {
	label: string;
	description: string;
};

export type QuestionInfo = {
	question: string;
	header: string;
	options: Array<QuestionOption>;
	multiple?: boolean;
	/** a typed answer is accepted; always true in cmx2 */
	custom?: boolean;
};

export type QuestionRequest = {
	id: string;
	sessionID: string;
	questions: Array<QuestionInfo>;
	/** the tool call that raised the ask */
	tool?: {
		messageID: string;
		callID: string;
	};
};

/** one telemetry row per assistant step */
export type StepRow = {
	session_id: string;
	seq: number;
	at: number;
	model: string;
	effort: string | null;
	input: number;
	cache_read: number;
	cache_write: number;
	output: number;
	cache_read_pct: number;
	ttft_ms: number | null;
	duration_ms: number;
	tool_calls: number;
	nested_calls: number;
	calls: number;
	tool_names: string;
	tool_ms: number;
	cost: number;
	stop_reason: string;
	refusal: string | null;
	prefix_hash: string;
	prefix_same: number;
	steered: number;
	dropped_blocks: number;
	/** 1 when every call in the step only waited: a sleep, a retry loop, a read of process output */
	poll_only: number;
	/** on the first step at a raised effort: from→to and the failure signals that raised it */
	escalation: string | null;
	/** 1 when refreshes kept the session's cache warm while it sat parked before this step */
	warm: number;
	/** 1 when the reply hit the output limit and the turn went on with a continuation request */
	continued: number;
};

/** every error the daemon returns */
export type ErrorBody = {
	/** BadRequestError, UnauthorizedError, NotFoundError, BusyError, ConflictError, UnknownError */
	name: string;
	data: {
		message: string;
		[key: string]: unknown;
	};
};

/** a terminal, in cmx's shape */
export type PtyInfo = {
	id: string;
	title: string;
	/** empty for a login shell */
	command: string;
	args: Array<string>;
	cwd: string;
	status: "running" | "exited";
	pid: number;
	/** tui: a person opened it; model: a session's pty */
	origin: "tui" | "model";
};

/** a process a session owns (a background job or a pty), or a terminal a person opened */
export type ProcessInfo = {
	id: string;
	/** the owning session; null for a terminal a person opened */
	sessionID: string | null;
	pid: number;
	command: string;
	cwd: string;
	title: string;
	kind: "pty" | "job";
	status: "running" | "exited";
	exitCode: number | null;
	/** tcp ports the job's own process group listens on, as last looked up (a server in another group, under docker or setsid, shows []). kept fresh for jobs by a sweep every few seconds while any job runs, and a change goes out as process.updated; a pty's are looked up when its session's procs are read */
	ports: Array<number>;
	/** started with serve: a dev server or preview the person will open, left running. the session is not waiting on it: it never counts in parked.jobs, even with a notify still armed */
	serve: boolean;
	/** the notifications that can still fire: on_port goes once it fired, everything once the process exited; null when none */
	notify: {
		on_exit?: boolean;
		on_pattern?: string;
		on_port?: number;
	} | null;
	origin: "model" | "user";
	startedAt: number;
	endedAt?: number;
	/** survives session end under this name */
	keep?: string;
	/** survives daemon restart */
	detached?: boolean;
	/** taken over from a previous daemon; earlier output is gone */
	adopted?: boolean;
};

/** one mcp server from the profile */
export type McpStatus = {
	name: string;
	transport: "stdio" | "http";
	status: "connecting" | "connected" | "failed" | "disabled" | "needs_auth";
	/** the server's tool names; sessions see them as <server>_<tool> through tool_search */
	tools: Array<string>;
	error?: string;
	server?: {
		name: string;
		version: string;
	};
	/** which sessions see its tools: all, or root (top-level sessions only; spawned helpers never see them) */
	sessions?: "all" | "root";
	/** true when each tools/call carries the calling session in _meta["cmx2/caller"] */
	caller?: boolean;
	/** true when the entry sets instructions: true and the server sent instructions; they reach the turn context of sessions that see the server */
	instructions?: boolean;
};

/** every event the daemon publishes, by type */
export interface EventMap {
	/** first frame of every event stream (v1) */
	"server.connected": {
		version?: string;
	};
	/** every 10 s on every stream; a silent stream for 25 s is dead (v1) */
	"server.heartbeat": Record<string, never>;
	/** the daemon is exiting (restart or shutdown); every stream ends after it (v1) */
	"global.disposed": Record<string, never>;
	/** first frame when a resume cursor cannot be replayed: expired (older than the window), epoch (another store) or invalid (malformed, or ahead of the log). the stream continues live from seq; reconcile from reads, whose x-cmx2-seq is a cursor (v1) */
	"stream.reset": {
		reason: "expired" | "epoch" | "invalid";
		/** the head of the log when the stream started */
		seq: number;
		epoch: string;
	};
	/** config was reloaded from disk (v1) */
	"config.updated": {
		directory: string;
		changed: Array<string>;
	};
	/** an mcp server connected, failed, needs a sign-in, or changed its tools (v1) */
	"mcp.status": {
		name: string;
		transport: "stdio" | "http";
		status: "connecting" | "connected" | "failed" | "disabled" | "needs_auth";
		/** the server's tool names; sessions see them as <server>_<tool> through tool_search */
		tools: Array<string>;
		error?: string;
		server?: {
			name: string;
			version: string;
		};
		/** which sessions see its tools: all, or root (top-level sessions only; spawned helpers never see them) */
		sessions?: "all" | "root";
		/** true when each tools/call carries the calling session in _meta["cmx2/caller"] */
		caller?: boolean;
		/** true when the entry sets instructions: true and the server sent instructions; they reach the turn context of sessions that see the server */
		instructions?: boolean;
	};
	/** a session was created (v1) */
	"session.created": {
		sessionID: string;
		/** opencode-compatible session info plus cmx2's fields */
		info: SessionInfo;
	};
	/** a session's info changed (title, totals, effort) (v1) */
	"session.updated": {
		sessionID: string;
		/** opencode-compatible session info plus cmx2's fields */
		info: SessionInfo;
	};
	/** a session was archived (deleted from view); its history stays on disk (v1) */
	"session.deleted": {
		sessionID: string;
		/** opencode-compatible session info plus cmx2's fields */
		info?: {
			id: string;
			slug: string;
			/** the project root (git top level, or the directory) */
			projectID: string;
			directory: string;
			parentID?: string;
			/** set on a session made by fork: where it came from */
			forkedFrom?: {
				sessionID: string;
				/** the parent's message the fork was cut before: the fork holds the parent's history up to, not including, this message. absent when the whole history was forked */
				messageID?: string;
			};
			/** set on a session imported from another machine or folder (POST /session/import): where it ran before. its timeline holds the move as a notice message (notice.source moved, with moved on the info and the part). absent on a session that never moved, and on one imported from a bundle with no origin (written before this field) */
			movedFrom?: {
				/** the short hostname of the machine the session was exported from */
				machine: string;
				/** macos, linux, windows, or the platform name */
				os: string;
				/** the session's folder there */
				directory: string;
				/** when it was imported here (ms) */
				at: number;
			};
			title: string;
			/** daemon version that created the session */
			version: string;
			time: {
				created: number;
				updated: number;
				/** when the session was archived (deleted from view); its history stays */
				archived?: number;
			};
			model?: {
				id: string;
				providerID: string;
			};
			summary?: {
				additions: number;
				deletions: number;
				files: number;
			};
			/** cmx sessions are imported history: browse only */
			source: "cmx2" | "cmx";
			effort?: string;
			cost: number;
			tokens: {
				input: number;
				output: number;
				cache: {
					read: number;
					write: number;
				};
			};
			/** discriminated on type. idle sessions are absent from the status map unless parked=true is asked for */
			status?: {
				type: "idle";
				/** when this state began (ms); on a parked session, when it parked */
				since?: number;
				/** prompts an abort left waiting (GET /session/:id/queue lists them; loop runs them) */
				queued?: number;
				/** the turn has ended and the session waits on these; a report or a job notice wakes it */
				parked?: {
					/** agents under it still working or queued */
					agents: number;
					/** background jobs that will notify it; serve jobs never count */
					jobs: number;
				};
			} | {
				type: "busy";
				/** steers and queued prompts admitted but not yet sent to the model */
				queued?: number;
				/** when the turn began (ms) */
				since?: number;
				/** why the turn has not started yet, short and lowercase, shown as is: the session's directory has not answered (a macos privacy prompt, a hung mount) */
				waiting?: string;
			} | {
				type: "retry";
				attempt: number;
				/** short and lowercase, shown as is */
				message: string;
				/** when the next attempt goes (ms) */
				next: number;
				since?: number;
			};
			/** the git branch of the session's directory, when it is in a work tree */
			vcs?: {
				branch: string;
				/** the work tree has uncommitted changes, untracked files included */
				dirty: boolean;
			};
			/** context fill */
			context?: {
				/** tokens in the context now: the last step's usage plus an estimate of what came after it */
				used: number;
				/** the model's context window */
				limit: number;
				/** where automatic compaction runs */
				compactAt?: number;
			};
			/** an armed revert: the files are back as they were before messageID */
			revert?: {
				/** messages from this one on are parked; the next send makes it permanent, unrevert brings them back */
				messageID: string;
				partID?: string;
				snapshot?: string;
				diff?: {
					files: number;
					additions: number;
					deletions: number;
				};
			};
			/** the session's transcript revision: 0 for a new session, persisted with it, and moved on (never back) in the same transaction as every write that changes what GET /session/:id/message answers, streamed text aside: a message landed or updated, a part created or replaced, a message removed (taken back, a queued prompt that failed, a provisional message swapped for its committed one, a revert made permanent), a revert and its undo, a compaction summary. status, idle, model, title, archive, message.part.delta and a shell's tail leave it. on every rest answer that returns a session; on session.created and session.updated only for a stream that asks with rev=1. imported history stays at 0, and a session that had history before the revision existed starts at 0 too: 0 does not mean empty, and a client with no revision stored for a session reads it */
			transcriptRev?: number;
		};
	};
	/** the session's model changed (the picker); applies from the next turn (v1) */
	"session.model": {
		sessionID: string;
		/** provider/model-id */
		model: string;
	};
	/** a stored session was reopened from its transcript into memory (v1) */
	"session.resumed": {
		sessionID: string;
	};
	/** a session's run state changed; queued counts steers and prompts not yet sent (v1) */
	"session.status": {
		sessionID: string;
		/** discriminated on type. idle sessions are absent from the status map unless parked=true is asked for */
		status: SessionStatus;
	};
	/** a session's turn settled (deprecated in cmx, kept for boxbox) (v1) */
	"session.idle": {
		sessionID: string;
	};
	/** a turn hit an error. name is RefusalError (data.refusal names the classifier, content filters included), ContextOverflowError, AuthError, RateLimitError, ProviderUnavailableError (after retries), ProviderError (unknown) or EngineError; data.message is short and lowercase, data.kind the class (v1) */
	"session.error": {
		sessionID?: string;
		error: {
			name: string;
			data: {
				message: string;
				[key: string]: unknown;
			};
		};
	};
	/** a steer was admitted into the running turn (v1) */
	"session.steered": {
		sessionID: string;
		text: string;
		/** the steer's provisional id, as message.updated announced it */
		messageID?: string;
		clientID?: string;
	};
	/** a prompt was queued behind the running turn (v1) */
	"session.queued": {
		sessionID: string;
		text: string;
		/** the prompt's provisional id, as message.updated announced it */
		messageID?: string;
		clientID?: string;
	};
	/** the session's effort dial changed (v1) */
	"session.effort": {
		sessionID: string;
		effort: string;
	};
	/** deferred tools were loaded into the session (v1) */
	"session.tools": {
		sessionID: string;
		loaded: Array<string>;
	};
	/** something odd that did not stop the session (v1) */
	"session.warning": {
		sessionID: string;
		message: string;
	};
	/** the context was compacted: a summary and the recent messages replaced it (the transcript keeps everything) (v1) */
	"session.compacted": {
		sessionID: string;
		trigger: "auto" | "manual" | "overflow";
		tokensBefore: number;
		/** an estimate */
		tokensAfter: number;
		/** how long the session waited on the compaction */
		durationMs: number;
		/** of that, waiting on a background summary still being written */
		waitedMs: number;
		/** the summary request's own wall time */
		summaryMs: number;
		summaryChars: number;
		/** the summary was made in the background before the threshold */
		prefire: boolean;
		/** compacted under the threshold because the prompt cache had gone cold (past its ttl, or a model switch) and a background summary was ready */
		cold: boolean;
		tailFrom: number;
		tailStartID?: string;
		/** tool outputs the kept tail carries cleared (recall reads them) */
		cleared: number;
		cacheRead: number;
		cacheWrite: number;
		input: number;
		output: number;
		cost: number;
		/** of the summary request */
		cacheReadPct: number;
	};
	/** the background summary started, is ready, failed, or no longer fits the context (v1) */
	"compaction.prefire": {
		sessionID: string;
		state: "started" | "ready" | "failed" | "stale";
		tokens: number;
		ms?: number;
		chars?: number;
		message?: string;
		cacheReadPct?: number;
		/** a newer summary over the grown context, made while the ready one stays in use; stale here means a compaction or a revert came first and it was dropped */
		refresh?: boolean;
	};
	/** a compaction did not happen; sticky ones are not tried again on this model until a manual compact or a model switch (v1) */
	"compaction.failed": {
		sessionID: string;
		trigger: string;
		reason: "degenerate" | "too_large" | "transient";
		message: string;
		sticky: boolean;
		tokens: number;
	};
	/** images left the context: past the image budget, over the provider's limits for a request, or unreadable to it; the transcript keeps them, the model reads a marker where each was (v1) */
	"session.images_dropped": {
		sessionID: string;
		/** budget: past images.budget; turn: near it at a turn's first request; compaction: past the keep line right after a compaction; limit: the request would pass the provider's byte or image count limit; rejected: the provider refused a request for its size, its image count or an image's size; unreadable: the provider could not read an image, so the images since its last reply went (all of them when there were none) */
		reason: "budget" | "turn" | "compaction" | "limit" | "rejected" | "unreadable";
		dropped: number;
		imagesBefore: number;
		imagesAfter: number;
		/** base64 bytes of images in the context */
		bytesBefore: number;
		bytesAfter: number;
		budget: number | null;
		/** the request byte limit the session holds to */
		requestLimit: number;
	};
	/** a request's prefix bytes differ from the session's recorded prefix (a cache miss risk) (v1) */
	"session.prefix_changed": {
		sessionID: string;
		request: number;
		/** byte offset of the first difference */
		at: number;
		hash: string;
	};
	/** a message was created or finished (v1) */
	"message.updated": {
		sessionID: string;
		/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
		info: MessageInfo;
		/** the session's transcriptRev after this write; only on a stream that asks with rev=1 */
		rev?: number;
	};
	/** a part was created or changed (a tool call running, then completed). every text and reasoning part of a streaming message is announced when it starts, before its first delta: this event with empty text and streaming true, logged like any other, in content order; its final update carries the whole text, no streaming, and time {start, end}, and is published when that part's block ends (a reasoning part when the reply begins), not when the step does; the step's end publishes it again, the same text and time.end. a running shell's output tail (state.metadata.output on its running tool part, at most once a second, numbered by state.metadata.progress) goes out unnumbered and is not logged; reads carry the latest tail and a resume gets it at its seam, not every tick, so a client that buffers frames until its read lands orders tails by progress, not by seq (v1) */
	"message.part.updated": {
		sessionID: string;
		/** opencode-shaped part, discriminated on type. step-start, step-finish, patch and subtask appear in imported (source cmx) history only */
		part: Part;
		/** the session's transcriptRev after this write; only on a stream that asks with rev=1 */
		rev?: number;
	};
	/** streamed text for a text or reasoning part that was announced (a message.part.updated with streaming true); never sent to a part that was not (v1) */
	"message.part.delta": {
		sessionID: string;
		messageID: string;
		partID: string;
		/** text */
		field: string;
		delta: string;
		/** utf-16 units of the part's text before this delta; deltas are not logged, so a consumer checks contiguity with this */
		offset: number;
	};
	/** a btw was asked, finished (done or error), dismissed or promoted; it carries the whole btw. on a resume a running btw is sent again with its answer so far where the stream goes live (v1) */
	"btw.updated": {
		sessionID: string;
		/** a side question about a session, answered by the session's model from the session's context in a request that reads the session's prompt cache. it is never part of the transcript: not in message reads, forks or compaction, and the model does not see it later unless it is promoted */
		btw: {
			id: string;
			sessionID: string;
			/** the question */
			text: string;
			/** the answer so far: empty when asked, grown by btw.delta while running, final when done. an error keeps the text that came before it */
			answer: string;
			status: "running" | "done" | "error";
			/** on status error: what went wrong, short and lowercase, to show as is */
			error?: string;
			/** the session's last message when the btw was asked; a client places the card after it */
			afterMessageID?: string;
			time: {
				created: number;
				/** when it finished, done or error */
				completed?: number;
				/** when it was dismissed; a dismissed btw stays readable, clients hide it */
				dismissed?: number;
			};
			/** the user message it was promoted into */
			promotedMessageID?: string;
			/** the model that answers: the session's */
			model?: {
				providerID: string;
				modelID: string;
			};
			/** once finished: what its requests used; added to the session's totals, not to its context fill */
			tokens?: {
				input: number;
				output: number;
				cache: {
					read: number;
					write: number;
				};
			};
			/** once finished: what it cost, added to the session's cost */
			cost?: number;
		};
	};
	/** streamed answer text for a running btw, appended to its answer in order. not logged and not numbered, like message.part.delta; coalesce=100 merges a btw's deltas into one per batch (v1) */
	"btw.delta": {
		sessionID: string;
		btwID: string;
		delta: string;
	};
	/** a session's write or edit changed a file (after the formatter ran) (v1) */
	"file.edited": {
		sessionID: string;
		/** absolute path */
		file: string;
		/** lines this edit or write added, counted against the file as it was before and as it is after the formatter; the same numbers as the tool part's metadata.filediff. absent from a revert's event, and from a change too big to diff (the part has no filediff either) */
		additions?: number;
		/** lines this edit or write removed */
		deletions?: number;
	};
	/** a message left the transcript's reads: a queued prompt taken back before the model saw it or that failed to start, a provisional message swapped for its committed one, or a message a revert made permanent (v1) */
	"message.removed": {
		sessionID: string;
		messageID: string;
		/** the session's transcriptRev after this write; only on a stream that asks with rev=1 */
		rev?: number;
	};
	/** a / command ran as a prompt (v1) */
	"command.executed": {
		sessionID: string;
		name: string;
		arguments: string;
		clientID?: string;
	};
	/** a terminal opened (v1) */
	"pty.created": {
		/** a terminal, in cmx's shape */
		info: PtyInfo;
	};
	/** a terminal was renamed or resized (v1) */
	"pty.updated": {
		/** a terminal, in cmx's shape */
		info: PtyInfo;
	};
	/** a terminal's process exited (v1) */
	"pty.exited": {
		id: string;
		exitCode: number;
	};
	/** a terminal was closed and forgotten (v1) */
	"pty.deleted": {
		id: string;
	};
	/** a job or pty started (v1) */
	"process.started": {
		/** a process a session owns (a background job or a pty), or a terminal a person opened */
		process: ProcessInfo;
	};
	/** a process changed (title, size, keep, the ports it listens on, what notify is still armed) (v1) */
	"process.updated": {
		/** a process a session owns (a background job or a pty), or a terminal a person opened */
		process: ProcessInfo;
	};
	/** a process exited (v1) */
	"process.exited": {
		/** a process a session owns (a background job or a pty), or a terminal a person opened */
		process: ProcessInfo;
	};
	/** a process was forgotten (v1) */
	"process.deleted": {
		/** a process a session owns (a background job or a pty), or a terminal a person opened */
		process: ProcessInfo;
	};
	/** a background job reported (exit, a matching line, a port opening); the owning session gets it as a turn message (v1) */
	"process.notify": {
		/** a process a session owns (a background job or a pty), or a terminal a person opened */
		process: ProcessInfo;
		reason: "exit" | "pattern" | "port";
		detail: string;
	};
	/** one assistant step's telemetry (v1) */
	"step.recorded": {
		sessionID: string;
		/** one telemetry row per assistant step */
		step: StepRow;
	};
	/** failure signals raised a helper's effort for its next turn; the stored effort does not change (v1) */
	"session.escalated": {
		sessionID: string;
		from: string;
		to: string;
		reason: string;
	};
	/** a turn without failure signals put an escalated effort back to where the session stands; the stored effort does not change (v1) */
	"session.deescalated": {
		sessionID: string;
		from: string;
		to: string;
		reason: string;
	};
	/** a parked session's prompt cache was refreshed: its last request was re-sent and cut off once the provider had read the prompt, costing a cache read and a few output tokens (v1) */
	"session.warmed": {
		sessionID: string;
		cache_read: number;
		cache_write: number;
		input: number;
		output: number;
		cost: number;
		ms: number;
	};
	/** a project's checkouts changed: one was made, merged or discarded. sandboxes is the full list after the change (v1) */
	"project.updated": {
		/** the project's path */
		id: string;
		/** the project's main checkout */
		worktree: string;
		time: {
			created: number;
			updated: number;
		};
		/** directories of the checkouts made for agents */
		sandboxes: Array<string>;
		/** with worktrees=true: the checkouts, from git's own list */
		worktrees?: Array<{
			name: string;
			/** absolute; sessions homed here fold under project */
			directory: string;
			/** cmx2/<name> */
			branch?: string;
			/** the branch it was made from and merges back into */
			base?: string;
			/** the repository's main checkout */
			project: string;
		}>;
	};
	/** a checkout is ready: made, files carried, setup commands done. framed with the checkout's directory (v1) */
	"worktree.ready": {
		name: string;
		branch?: string;
		mode?: "clone" | "git";
	};
	/** a checkout's setup failed; the checkout stays so the failure can be looked at. framed with the checkout's directory (v1) */
	"worktree.failed": {
		name?: string;
		message: string;
		/** the tail of the failing command's output */
		log?: string;
	};
	/** the agent in a checkout says its work is ready to look at (request_review). the only thing that raises a review card. framed with the checkout's directory (v1) */
	"worktree.review.requested": {
		name: string;
		branch?: string;
		note?: string;
		sessionID?: string;
	};
	/** a checkout's branch was squash-merged into its base and the checkout removed. framed with the checkout's directory (v1) */
	"worktree.merged": {
		name: string;
		branch: string;
		base: string;
		commit: string;
		commits: number;
	};
	/** a checkout was removed without merging; snapshot and ref hold its last state when it had work. framed with the checkout's directory (v1) */
	"worktree.discarded": {
		name: string;
		branch?: string;
		snapshot?: string;
		ref?: string;
	};
	/** an agent was spawned; its session follows as session.created with parentID (v1) */
	"agent.spawned": {
		sessionID: string;
		/** one agent in a session's tree */
		agent: {
			/** the agent's session id */
			id: string;
			rootID: string;
			parentID: string | null;
			/** canonical path: /root, /root/<name>, /root/<name>/<child> */
			path: string;
			name: string;
			depth: number;
			/** the model label a helper runs on (haiku, sonnet, a provider/model-id's bare id); driver for the root */
			seat: string | null;
			agentType: string | null;
			model: string | null;
			effort: string | null;
			/** queued waits for a running-turn slot; parked is idle, addressable and free; closed is a tombstone */
			state: "queued" | "working" | "parked" | "interrupted" | "closed";
			/** why it is interrupted or closed: interrupted, budget, daemon_restart, closed, respawned, pool_collected, pool_failed, session_ended; or asking while a working helper waits on its question to its spawner */
			cause?: string;
			previousState?: string;
			/** paths it wrote or edited */
			files: Array<string>;
			lastTask?: string;
			lastReport?: string;
			/** why the spawner picked this model and effort; for people reading the tree, never sent to the helper */
			why?: string;
			/** mailbox items not yet in its transcript */
			pending: number;
			/** input, output and cache-write tokens it has spent */
			tokens: number;
			/** input, cache read and cache write of its last step: how big its context is now */
			contextTokens?: number;
			/** what its last step cost, in dollars */
			lastStepCost?: number;
			/** what its session has cost so far, in dollars */
			cost?: number;
			pool?: {
				id: string;
				name: string;
				index: number;
				n: number;
			};
			createdAt: number;
			updatedAt: number;
			closedAt?: number;
		};
	};
	/** an agent changed state (queued, working, parked, interrupted, closed) or its roster entry changed; sessionID is the tree's root (v1) */
	"agent.updated": {
		sessionID: string;
		/** one agent in a session's tree */
		agent: {
			/** the agent's session id */
			id: string;
			rootID: string;
			parentID: string | null;
			/** canonical path: /root, /root/<name>, /root/<name>/<child> */
			path: string;
			name: string;
			depth: number;
			/** the model label a helper runs on (haiku, sonnet, a provider/model-id's bare id); driver for the root */
			seat: string | null;
			agentType: string | null;
			model: string | null;
			effort: string | null;
			/** queued waits for a running-turn slot; parked is idle, addressable and free; closed is a tombstone */
			state: "queued" | "working" | "parked" | "interrupted" | "closed";
			/** why it is interrupted or closed: interrupted, budget, daemon_restart, closed, respawned, pool_collected, pool_failed, session_ended; or asking while a working helper waits on its question to its spawner */
			cause?: string;
			previousState?: string;
			/** paths it wrote or edited */
			files: Array<string>;
			lastTask?: string;
			lastReport?: string;
			/** why the spawner picked this model and effort; for people reading the tree, never sent to the helper */
			why?: string;
			/** mailbox items not yet in its transcript */
			pending: number;
			/** input, output and cache-write tokens it has spent */
			tokens: number;
			/** input, cache read and cache write of its last step: how big its context is now */
			contextTokens?: number;
			/** what its last step cost, in dollars */
			lastStepCost?: number;
			/** what its session has cost so far, in dollars */
			cost?: number;
			pool?: {
				id: string;
				name: string;
				index: number;
				n: number;
			};
			createdAt: number;
			updatedAt: number;
			closedAt?: number;
		};
	};
	/** an agent was closed and kept as a tombstone (v1) */
	"agent.closed": {
		sessionID: string;
		/** one agent in a session's tree */
		agent: {
			/** the agent's session id */
			id: string;
			rootID: string;
			parentID: string | null;
			/** canonical path: /root, /root/<name>, /root/<name>/<child> */
			path: string;
			name: string;
			depth: number;
			/** the model label a helper runs on (haiku, sonnet, a provider/model-id's bare id); driver for the root */
			seat: string | null;
			agentType: string | null;
			model: string | null;
			effort: string | null;
			/** queued waits for a running-turn slot; parked is idle, addressable and free; closed is a tombstone */
			state: "queued" | "working" | "parked" | "interrupted" | "closed";
			/** why it is interrupted or closed: interrupted, budget, daemon_restart, closed, respawned, pool_collected, pool_failed, session_ended; or asking while a working helper waits on its question to its spawner */
			cause?: string;
			previousState?: string;
			/** paths it wrote or edited */
			files: Array<string>;
			lastTask?: string;
			lastReport?: string;
			/** why the spawner picked this model and effort; for people reading the tree, never sent to the helper */
			why?: string;
			/** mailbox items not yet in its transcript */
			pending: number;
			/** input, output and cache-write tokens it has spent */
			tokens: number;
			/** input, cache read and cache write of its last step: how big its context is now */
			contextTokens?: number;
			/** what its last step cost, in dollars */
			lastStepCost?: number;
			/** what its session has cost so far, in dollars */
			cost?: number;
			pool?: {
				id: string;
				name: string;
				index: number;
				n: number;
			};
			createdAt: number;
			updatedAt: number;
			closedAt?: number;
		};
		cause: string;
	};
	/** a child's turn ended and its report went to its spawner (or its pool) (v1) */
	"agent.report": {
		sessionID: string;
		from: string;
		childID: string;
		/** parked, failed, partial */
		label: string;
		body_length: number;
		/** the file holding the whole report body, under the daemon's data dir; absent when the body was empty */
		file?: string;
		abort_reason?: {
			reason: string;
			details: string;
		};
		behavior_violation?: unknown;
	};
	/** one agent sent another a note (v1) */
	"agent.message": {
		sessionID: string;
		from: string;
		to: string;
		toID: string;
		wake: boolean;
		length: number;
		correlation_id?: string;
	};
	/** an agent started waiting on its mailbox (v1) */
	"agent.wait": {
		sessionID: string;
		path: string;
		timeout_ms: number;
		correlation_id?: string;
	};
	/** a child's report arrived; source says how (explicit_send, extracted, safety_net) (v1) */
	"agent.metric.deliverable_arrived": {
		sessionID: string;
		childID?: string;
		source: string;
		body_length: number;
		child_path: string;
	};
	/** a report carried the no-deliverable warning (v1) */
	"agent.metric.safety_net_fired": {
		sessionID: string;
		childID?: string;
		child_path: string;
	};
	/** a wait timed out with nothing new (v1) */
	"agent.metric.sibling_deadlock": {
		sessionID: string;
		timeout_ms: number;
		tool: string;
		correlation_id?: string;
	};
	/** a helper took over an earlier attempt at a task on another model or at another effort (v1) */
	"agent.metric.step_up": {
		sessionID: string;
		childID?: string;
		/** the earlier helper */
		from_id: string;
		from_model: string | null;
		from_effort: string | null;
		to_model: string;
		to_effort: string;
		/** the model label the earlier helper ran under */
		from_label: string | null;
		to_label: string;
		why?: string;
	};
	/** a helper took over an earlier attempt at a task on the same model at the same effort (v1) */
	"agent.metric.retry": {
		sessionID: string;
		childID?: string;
		/** the earlier helper */
		from_id: string;
		from_model: string | null;
		from_effort: string | null;
		to_model: string;
		to_effort: string;
		/** the model label the earlier helper ran under */
		from_label: string | null;
		to_label: string;
		why?: string;
	};
	/** an agent verb failed in a way the model can recover from (v1) */
	"agent.metric.subagent_tool_error": {
		sessionID: string;
		tool: string;
		error_kind: string;
	};
	/** a tool call waits for the user's permission (v1) */
	"permission.asked": {
		id: string;
		sessionID: string;
		/** shell, edit, read, grep, glob, webfetch, external_directory, ... */
		permission: string;
		/** what the call touches: the command, the path */
		patterns: Array<string>;
		metadata: Record<string, unknown>;
		/** patterns an always answer saves for the project */
		always: Array<string>;
		/** the tool call that raised the ask */
		tool?: {
			messageID: string;
			callID: string;
		};
	};
	/** a permission ask was answered; by is who (a client's name, abort, cascade, always rule, session_ended) (v1) */
	"permission.replied": {
		sessionID: string;
		requestID: string;
		reply: "once" | "always" | "reject";
		by?: string;
		clientID?: string;
	};
	/** the model asked the user a question and waits (v1) */
	"question.asked": {
		id: string;
		sessionID: string;
		questions: Array<QuestionInfo>;
		/** the tool call that raised the ask */
		tool?: {
			messageID: string;
			callID: string;
		};
	};
	/** a question was answered (v1) */
	"question.replied": {
		sessionID: string;
		requestID: string;
		answers: Array<Array<string>>;
		by?: string;
		clientID?: string;
	};
	/** a question was dismissed, or its turn was stopped (by: abort) (v1) */
	"question.rejected": {
		sessionID: string;
		requestID: string;
		by?: string;
		clientID?: string;
	};
}

export type EventType = keyof EventMap;
/** a payload, discriminated on `type` */
/** logged events carry seq and epoch (the id is <epoch>:<seq>); server frames, deltas and streaming resends carry neither */
export type Event = { [K in EventType]: { id: string; type: K; properties: EventMap[K]; seq?: number; epoch?: string } }[EventType];
/** a /global/event frame; server frames carry no directory */
export interface GlobalFrame {
	directory?: string;
	project?: string;
	workspace?: string;
	payload: Event;
}

export const EVENT_VERSIONS: Record<EventType, number> = {
	"server.connected": 1,
	"server.heartbeat": 1,
	"global.disposed": 1,
	"stream.reset": 1,
	"config.updated": 1,
	"mcp.status": 1,
	"session.created": 1,
	"session.updated": 1,
	"session.deleted": 1,
	"session.model": 1,
	"session.resumed": 1,
	"session.status": 1,
	"session.idle": 1,
	"session.error": 1,
	"session.steered": 1,
	"session.queued": 1,
	"session.effort": 1,
	"session.tools": 1,
	"session.warning": 1,
	"session.compacted": 1,
	"compaction.prefire": 1,
	"compaction.failed": 1,
	"session.images_dropped": 1,
	"session.prefix_changed": 1,
	"message.updated": 1,
	"message.part.updated": 1,
	"message.part.delta": 1,
	"btw.updated": 1,
	"btw.delta": 1,
	"file.edited": 1,
	"message.removed": 1,
	"command.executed": 1,
	"pty.created": 1,
	"pty.updated": 1,
	"pty.exited": 1,
	"pty.deleted": 1,
	"process.started": 1,
	"process.updated": 1,
	"process.exited": 1,
	"process.deleted": 1,
	"process.notify": 1,
	"step.recorded": 1,
	"session.escalated": 1,
	"session.deescalated": 1,
	"session.warmed": 1,
	"project.updated": 1,
	"worktree.ready": 1,
	"worktree.failed": 1,
	"worktree.review.requested": 1,
	"worktree.merged": 1,
	"worktree.discarded": 1,
	"agent.spawned": 1,
	"agent.updated": 1,
	"agent.closed": 1,
	"agent.report": 1,
	"agent.message": 1,
	"agent.wait": 1,
	"agent.metric.deliverable_arrived": 1,
	"agent.metric.safety_net_fired": 1,
	"agent.metric.sibling_deadlock": 1,
	"agent.metric.step_up": 1,
	"agent.metric.retry": 1,
	"agent.metric.subagent_tool_error": 1,
	"permission.asked": 1,
	"permission.replied": 1,
	"question.asked": 1,
	"question.replied": 1,
	"question.rejected": 1
};

export function isEventType(type: unknown): type is EventType {
	return typeof type === "string" && Object.hasOwn(EVENT_VERSIONS, type);
}

/** narrows a payload to one event type */
export function isEvent<K extends EventType>(e: { type?: unknown } | undefined, type: K): e is { id: string; type: K; properties: EventMap[K] } {
	return e?.type === type;
}

export type Decoded =
	| { ok: true; directory?: string; project?: string; event: Event }
	| { ok: false; reason: "json" | "shape" | "unknown-type"; type?: string };

/**
 * decodes one sse data line from either stream: a bare payload (/event) or an envelope (/global/event).
 * an unknown type is reported, never thrown, so a newer daemon cannot break an older client.
 */
export function decodeFrame(data: string): Decoded {
	let v: any;
	try {
		v = JSON.parse(data);
	} catch {
		return { ok: false, reason: "json" };
	}
	const payload = v && typeof v === "object" && "payload" in v ? v.payload : v;
	if (!payload || typeof payload !== "object" || typeof payload.type !== "string" || typeof payload.properties !== "object") return { ok: false, reason: "shape" };
	if (!isEventType(payload.type)) return { ok: false, reason: "unknown-type", type: payload.type };
	return {
		ok: true,
		...(typeof v.directory === "string" ? { directory: v.directory } : {}),
		...(typeof v.project === "string" ? { project: v.project } : {}),
		event: payload as Event,
	};
}
