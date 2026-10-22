import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "./pi-agent.ts";
import { type Api, calculateCost, getCurrentTools, type Model, normalizeContext, type Usage } from "@earendil-works/pi-ai";
import { profileFor, profileText } from "@cmx2/prompts";
import {
	type AfterWrite,
	type AgentAnswer,
	type AskQuestions,
	type Before,
	type CallDecision,
	defaultSkillDirs,
	diffOnDisk,
	deferredTools,
	type FileDiffResult,
	hotTools,
	errorsAfterWrite,
	formatFile,
	LspPool,
	notesTool,
	type ProcHost,
	type QuestionPrompt,
	readNotes,
	type RecallHit,
	type RecallSearch,
	recallTool,
	type RunDetails,
	runOnlyTools,
	Skills,
	type Tool,
	type ToolResult,
	toolSearchTool,
	type WebOptions,
} from "@cmx2/tools";
import { type GateOptions, gateCall, nestedCall } from "./calls.ts";
import { Value } from "typebox/value";
import type { Config, Effort, TurnMessageMode } from "./config.ts";
import {
	applyAsk,
	asideBreakpoint,
	effortMarkers,
	forcedToolInstruction,
	type GateNotes,
	moveTrailingSystemBreakpoint,
	rollingBreakpoint,
	prefixOf,
	type Refusal,
	RefusalError,
	type RequestAsk,
	refusalFromError,
	refusalFromEvent,
	rejectsForcedToolUse,
} from "./gates.ts";
import { resolveApiKey, resolveModel, resolveSecret, streamFn } from "./models.ts";
import { PERMISSION_REJECTED, type PermissionCheck, type PermissionReply, type PermissionRule, rulesFromConfig, SUBAGENT_RULES, subagentEnv } from "./permission.ts";
import { configDir } from "./config.ts";
import { type PollCall, pollOnly } from "./poll.ts";
import { Transcript } from "./transcript.ts";
import { collapseToolChurn } from "./tool-churn.ts";
import { classifyProviderError, type MediaRefusal, mediaRefusal, type TypedProviderError } from "./errors.ts";
import {
	checkedImages,
	COUNT_HIGH,
	COUNT_KEEP,
	DEFAULT_MAX_IMAGES,
	type DropReason,
	type DropRecord,
	documentsIn,
	dropBlocks,
	GATEWAY_REQUEST_BYTES,
	inventory,
	imageEdge,
	planDrop,
	planOversized,
	planUnreadable,
	REQUEST_HEADROOM,
	requestBytes,
} from "./images.ts";
import { type RetryPolicy, withRetry } from "./retry.ts";
import { prefixGate } from "./prefix-gate.ts";
import {
	type CompactionRecord,
	clearedResult,
	coldFloorOf,
	compactionText,
	contextUsed,
	contextWithSeq,
	degenerate,
	estimateTokens,
	type RevertRecord,
	SUMMARY_INSTRUCTION,
	tailStart,
	thresholdOf,
	toClear,
	toolCarrier,
} from "./compaction.ts";

/** the batching nudge (`PROMPTS.md` → turn-scoped messages) */
export const BATCHING_NUDGE =
	"first privately list what you need next; then request every item that does not depend on another's result in this one response, as parallel calls or one run script.";

/** automatic continuations after an output-limit stop, per turn */
const MAX_CONTINUATIONS = 3;

/**
 * the text before a btw's question in its one user message. plain framing, no rules: the request still
 * declares every tool (dropping them would change the cached prefix), so it says why it is not a task
 */
export const BTW_FRAMING =
	"btw, a side question from the user while you work. reply with a few sentences of plain text only, from what this conversation already shows; this reply sits outside the task and nothing in it is run. the task picks up again by itself afterwards. keep this note to yourself and answer as if the question had come up in conversation.";
/** the result a btw's tool call gets instead of running */
export const BTW_NO_TOOLS = "btw answers cannot use tools. answer the question from the conversation so far, in words.";
/** a btw's answer stops here (about 4k tokens of text); the request's max_tokens stays the session's */
export const BTW_MAX_CHARS = 16_000;
/** a btw that has not finished by then stops with an error */
export const BTW_TIMEOUT_MS = 180_000;

/** what a btw answered and spent */
export interface AsideResult {
	text: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	model: { providerID: string; modelID: string };
	/** the answer reached BTW_MAX_CHARS and was cut there */
	capped: boolean;
	/** asked while a turn ran: the request carried the messages of the one on the wire */
	midTurn: boolean;
}

/** a btw that failed; what it spent and any text it had still count */
export class AsideError extends Error {
	constructor(
		message: string,
		readonly usage: AsideResult["usage"],
		readonly text: string,
	) {
		super(message);
		this.name = "AsideError";
	}
}
/** recoveries from a media refusal (size, image count, an unreadable image) per prompt before the session stops and says so */
const MAX_SIZE_RECOVERIES = 3;
/** request summaries a session keeps for `/session/:id/requests`, newest last */
export const REQUEST_SUMMARIES = 50;
/** after a size refusal the session holds requests to this share of the one that was refused */
const LEARNED_CAP_SHARE = 0.85;
/** past this many images in a request every image must be under 2000 px (anthropic's many-image rule) */
const MANY_IMAGES = 20;
const CONTINUE_TEXT = "your reply hit the output limit. continue exactly where it stopped, without repeating what you already wrote.";

/** commands whose failure right after an edit is an escalation signal: tests, type checks, linters, builds */
const CHECK_COMMAND = /\b(test|tests|tsc|typecheck|pytest|jest|vitest|mocha|cargo (test|check|build|clippy)|go (test|vet|build)|eslint|biome|ruff|mypy|pyright|lint)\b/;

/** files a shell command writes by redirection, tee or an in-place sed; a heuristic for the roster, never a permission check */
export function shellWrites(command: string): string[] {
	const out = new Set<string>();
	for (const m of command.matchAll(/(?:^|[^<>&0-9])>>?\s*([^\s;&|<>()]+)/g)) if (!m[1]!.startsWith("&")) out.add(m[1]!.replace(/^["']|["']$/g, ""));
	for (const m of command.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|<>()]+)/g)) out.add(m[1]!.replace(/^["']|["']$/g, ""));
	for (const m of command.matchAll(/\bsed\s+(?:-[a-zA-Z]*\s+)*-i(?:\s*''|\s*"")?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|<>()]+)/g)) out.add(m[1]!.replace(/^["']|["']$/g, ""));
	out.delete("/dev/null");
	return [...out];
}

/** the profile's web provider for the web tools; a `!command` key runs once, at the first call that needs it, and is kept */
function webOptions(config: Config): WebOptions {
	const w = config.web;
	if (!w || w.provider === "auto") return {};
	let key: { v: string | undefined } | undefined;
	return {
		provider: w.provider,
		key: () => (key ??= { v: resolveSecret(w.apiKey) }).v,
		...(w.url ? { url: w.url } : {}),
		...(w.search ? { search: w.search } : {}),
		fetch: w.fetch,
		crawl: w.crawl,
	};
}

/** a check's own words for failing: test runners' counts, a FAIL banner, compiler errors */
const CHECK_FAILED = /\b[1-9]\d* (fail|failed|failing|failures?|errors?)\b|^\s*FAIL\b|\berror TS\d+|\bTests?:.*\bfailed\b/m;

/** one row per assistant step, the unit every budget is measured in */
export interface StepRow {
	session_id: string;
	seq: number;
	at: number;
	model: string;
	/** provider-native effort when the provider has one, else the requested pi level */
	effort: string | null;
	input: number;
	cache_read: number;
	cache_write: number;
	output: number;
	/** cache_read / (input + cache_read + cache_write) */
	cache_read_pct: number;
	ttft_ms: number | null;
	duration_ms: number;
	/** native tool calls in the assistant message */
	tool_calls: number;
	/** helper calls made inside `run` scripts issued by this step */
	nested_calls: number;
	/** units of work: native calls other than run, plus every nested call */
	calls: number;
	tool_names: string;
	tool_ms: number;
	cost: number;
	stop_reason: string;
	/** classifier that declined, when stop_reason is refusal */
	refusal: string | null;
	prefix_hash: string;
	/** 1 when the request's prefix bytes equal the recorded prefix */
	prefix_same: number;
	/** a steer was promoted into the request that produced this step */
	steered: number;
	/** thinking blocks the provider dropped for a prefix mismatch (anthropic input_transformations) */
	dropped_blocks: number;
	/** 1 when every call in the step only waited (a sleep, a retry loop, a read of process output) */
	poll_only: number;
	/** set on the first step at a raised effort: `from→to: why` */
	escalation: string | null;
	/** 1 when refreshes kept this session's cache warm while it was parked before this step */
	warm: number;
	/** 1 when the reply hit the output limit and the turn went on with a continuation request */
	continued: number;
}

/** what went over the wire, summarised; the evidence for prefix stability, markers and gates */
export interface RequestSummary {
	seq: number;
	at: number;
	model: string;
	betas: string[];
	prefix_hash: string;
	prefix_bytes: number;
	/** byte offset of the first difference from the recorded prefix, or null when identical */
	prefix_diff_at: number | null;
	tools: string[];
	deferred: string[];
	message_count: number;
	effort_markers: string[];
	gates: string[];
	/** the request's size estimated from its messages, the images it carried and their base64 bytes */
	bytes: number;
	images: number;
	image_bytes: number;
	/** role and a text excerpt for the last few messages */
	tail: Array<{ role: string; text: string }>;
}

export type EngineEvent = { type: string; properties: Record<string, unknown> };

/** a document riding a user message (a pdf); models that read documents get it whole, the rest get the block's text */
export interface DocumentData {
	data: string;
	mimeType: string;
	filename: string;
}

/**
 * what a user message carries: text (synthetic text is context the user did not type, like a mentioned
 * file), images, and documents (a text block whose text is the fallback: a pdf's extracted text)
 */
export type UserBlock = { type: "text"; text: string; synthetic?: boolean; document?: DocumentData } | { type: "image"; data: string; mimeType: string };

/** apis whose requests carry documents natively; others read the extracted text */
const DOCUMENT_APIS = new Set(["anthropic-messages", "google-generative-ai"]);
const DOCUMENT_MARK = /^<cmx2-document ([0-9a-f]{16})\/>$/;

/** a `!` line the user ran in the session's shell; the model reads it as user text on its next request */
export interface ShellRecord {
	role: "shell";
	/** the client id of the request that ran it, echoed on its events */
	clientID?: string;
	command: string;
	cwd: string;
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	startedAt: number;
	timestamp: number;
}

/** something the runtime tells the session (a background job finished, a port opened); never typed by the user */
export interface NoticeRecord {
	role: "notice";
	source: string;
	text: string;
	timestamp: number;
}

/**
 * another agent's words in this session: a task from its spawner, a message, a child's report, a job
 * notice routed through the mailbox. lands at the next boundary of a running turn, or starts a turn.
 */
export interface MailRecord {
	role: "mail";
	/** the mailbox item this came from; the runtime marks it delivered once it is in the transcript */
	mailID: string;
	kind: "task" | "message" | "report" | "job" | "system";
	/** the sender's canonical path, or `runtime` */
	from: string;
	fromID?: string;
	correlation_id?: string;
	text: string;
	timestamp: number;
}

/** a turn began (`from` is the transcript position before its first message) or settled */
export type TurnEvent =
	| { type: "start"; from: number }
	| { type: "end"; from: number; to: number; outcome: "completed" | "errored" | "aborted"; stopReason: string; error?: string; refusal?: string; files: string[] };

/**
 * how the custom transcript entries reach the model: as plain user text, marked for what they are. a
 * document becomes a marker the request tap swaps for the api's document block when `documents` is
 * given (the api reads documents), else its fallback text
 */
export function toLlm(messages: AgentMessage[], documents?: Map<string, DocumentData>): AgentMessage[] {
	// a transcript near the provider's cap on tool additions goes out without the withdraw-and-restore churn
	return collapseToolChurn(messages).map((stored: any) => {
		// an image whose bytes are not an image never goes out: one would fail every request from here on
		const m = checkedImages(stored) as any;
		if (m.role === "shell") {
			const r = m as ShellRecord;
			const status = r.timedOut ? "killed at the timeout" : r.exitCode === null ? "aborted" : `exit ${r.exitCode}`;
			return { role: "user", content: `the user ran this in the shell (cwd ${r.cwd}):\n$ ${r.command}\n${r.output.replace(/\n+$/, "") || "(no output)"}\n(${status})`, timestamp: r.timestamp } as AgentMessage;
		}
		if (m.role === "notice") {
			const r = m as NoticeRecord;
			return { role: "user", content: `<runtime-notice source="${r.source}">\n${r.text}\n</runtime-notice>`, timestamp: r.timestamp } as AgentMessage;
		}
		if (m.role === "compaction") return { role: "user", content: compactionText(m as CompactionRecord), timestamp: m.timestamp } as AgentMessage;
		if (m.role === "mail") {
			const r = m as MailRecord;
			const attrs = [`kind="${r.kind}"`, `from="${r.from}"`, ...(r.fromID ? [`id="${r.fromID}"`] : []), ...(r.correlation_id ? [`correlation="${r.correlation_id}"`] : [])].join(" ");
			return { role: "user", content: `<agent-message ${attrs}>\n${r.text}\n</agent-message>`, timestamp: r.timestamp } as AgentMessage;
		}
		if (m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.synthetic !== undefined || b.id !== undefined || b.document !== undefined)) {
			return {
				...m,
				content: m.content.map(({ synthetic: _s, document, ...b }: any) => {
					if (!document || !documents) return b;
					const key = createHash("sha256").update(document.data).digest("hex").slice(0, 16);
					documents.set(key, document);
					return { type: "text", text: `<cmx2-document ${key}/>` };
				}),
			};
		}
		if (m.role === "toolResult" && m.isError && Array.isArray(m.content) && m.content.some((b: any) => b.type !== "text")) return erroredWithMedia(m);
		return m;
	});
}

/**
 * anthropic rejects a tool_result flagged `is_error` that holds anything but text (a 400 on every
 * later request, since the transcript replays it). a failed call that still carries images (a shell
 * command that printed screenshot paths and exited 1, a run script that attached images then threw)
 * goes out unflagged with the images kept and a line saying it failed. the stored record keeps its
 * flag; this only shapes the request, so a transcript saved before the fix replays clean too
 */
function erroredWithMedia(m: any): AgentMessage {
	return { ...m, isError: false, content: [...m.content, { type: "text", text: "(this call failed; it is not flagged as an error only because the result carries images)" }] };
}

/** a permission ask on its way to whoever can answer it */
export interface PermissionAsk extends PermissionCheck {
	callID: string;
	/** transcript position of the assistant message that made the call */
	messageSeq: number;
}

export interface QuestionAsk {
	questions: QuestionPrompt[];
	callID: string;
	messageSeq: number;
}

export interface EngineSessionOptions {
	id?: string;
	cwd: string;
	config: Config;
	dataDir: string;
	title?: string;
	model?: string;
	effort?: Effort;
	nudge?: boolean;
	turnMessages?: TurnMessageMode;
	/** cache ttl for this session's requests; an explicit one is kept as is, and `autoCacheTtl` is not asked */
	cacheTtl?: "5m" | "1h";
	/** reopen from the transcript on disk instead of starting fresh */
	resume?: { recordedPrefix?: string };
	onEvent: (event: EngineEvent) => void;
	onStep: (row: StepRow) => void;
	/** called once with the first request's prefix bytes, so the store can keep the record */
	onPrefix?: (hash: string, bytes: string) => void;
	/** every message appended to the transcript, with its position; the store projects it */
	onMessage?: (seq: number, message: AgentMessage) => void;
	/** runs before a turn starts and may refuse it by throwing (the cross-process run lock) */
	beforeTurn?: () => void;
	/** runs when a turn has fully settled, including a turn that failed to start */
	afterTurn?: () => void;
	/** answers a permission ask; without it, calls that need asking are refused */
	askPermission?: (ask: PermissionAsk, signal?: AbortSignal) => Promise<{ reply: PermissionReply; message?: string }>;
	/** saved rules ("always" answers), read at every check */
	savedRules?: () => PermissionRule[];
	/** what the session has running, appended to the turn context when it changed */
	ledger?: () => string | undefined;
	/** answers the question tool (a helper's goes to its spawner, which answers in text); without it the tool reports that nobody can answer */
	askQuestion?: (ask: QuestionAsk, signal?: AbortSignal) => Promise<string[][] | AgentAnswer>;
	/** the session's processes, bound to it; without them background jobs and ptys are unavailable */
	procs?: ProcHost;
	/** skills for this working directory, shared so a config reload can flush them; one is made when absent */
	skills?: Skills;
	/** the daemon's language servers, shared across sessions; one is made when absent */
	lsp?: LspPool;
	/** text appended to the profile's system prompt when the session is created (a helper's prompt fragment, or the user's notes for a session they start); recorded with the prefix */
	systemExtra?: string;
	/** tools bound to this session beyond the core set (the agent verbs); declared with the hot tools */
	extraTools?: Tool[];
	/** core tools this session does not get (a read-only agent type) */
	excludeTools?: string[];
	/** a subagent: its commands get the push guard (SUBAGENT_RULES after every other rule, subagentEnv on every command) */
	child?: boolean;
	/** tools that come and go with the daemon (mcp servers); deferred like webfetch, read at every use */
	dynamicTools?: () => Tool[];
	/** mail waiting for this session, taken into the transcript at the start of every turn */
	inbox?: () => MailRecord[];
	/** a mail record reached the transcript at this position */
	onMailDelivered?: (mailID: string, seq: number) => void;
	/** turn boundaries, for the agent runtime (state, reports, caps) */
	onTurn?: (e: TurnEvent) => void;
	/** turn-context blocks (the helpers line, the routing table) appended when their text changed since the last turn */
	appendix?: () => Array<[key: string, text: string | undefined]>;
	/** what a compaction carries over about the session's agents: the post-compaction state block only, never a turn's context */
	roster?: () => string | undefined;
	/** the next effort above `from` that this model may run at when a turn showed failure signals; undefined stops. a session that should not escalate passes none */
	escalate?: (model: string, from: Effort) => Effort | undefined;
	/** whether this model runs at this effort (routing's `never`); an effort carried from one model to another is checked with it */
	allowed?: (model: string, effort: Effort) => boolean;
	/** how transient provider failures are retried; the default is 4 retries from 1 s, capped at 30 s */
	retry?: RetryPolicy;
	/**
	 * the ttl a session with no explicit `cacheTtl` should use now: asked once per request. the first "1h" answer is kept for the
	 * rest of this instance's life, so the switch (a 5m entry is not read by a request marked 1h, and the reverse) happens at most once
	 */
	autoCacheTtl?: () => "5m" | "1h";
	/**
	 * whether to keep this session's prompt cache warm while it sits parked, and for how long. asked each time the session parks,
	 * with the ttl in force: a refresh goes at 90% of it, so the ttl sets how many refreshes a horizon buys
	 */
	warm?: (ttl: "5m" | "1h") => { enabled: boolean; horizonMs: number };
	/** searches the session's stored history (the store's index); without it recall reads the transcript file */
	recall?: RecallSearch;
}

export type SessionState = "idle" | "busy";

function sha(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** the same tools by name, in the same order (a count alone misses one tool gone and another come) */
function sameToolNames(a: ReadonlyArray<{ name: string }>, b: ReadonlyArray<{ name: string }>): boolean {
	return a.length === b.length && a.every((t, i) => t.name === b[i]!.name);
}

function firstDiff(a: string, b: string): number | null {
	if (a === b) return null;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
	return n;
}

function excerpt(content: unknown, max = 160): string {
	if (typeof content === "string") return content.slice(0, max);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content as Array<Record<string, unknown>>) {
		if (b.type === "text") parts.push(String(b.text));
		else if (b.type === "tool_use" || b.type === "toolCall") parts.push(`[tool_use ${String(b.name)}]`);
		else if (b.type === "tool_result") parts.push(`[tool_result ${excerpt(b.content, 60)}]`);
		else if (b.type === "tool_addition") parts.push(`[tool_addition ${String((b.tool as any)?.name)}]`);
		else if (b.type === "thinking") parts.push("[thinking]");
		else parts.push(`[${String(b.type)}]`);
	}
	return parts.join(" ").slice(0, max);
}

/** distinguishes capture files of one daemon process from the next, so a resume never overwrites evidence */
const BOOT = Date.now().toString(36);

function localDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class EngineSession {
	readonly id: string;
	readonly cwd: string;
	title: string;
	readonly createdAt = Date.now();
	state: SessionState = "idle";
	effort: Effort;
	readonly requests: RequestSummary[] = [];
	readonly nudge: boolean;
	readonly turnMode: "system" | "user-part";
	profile = "";
	private agent!: Agent;
	private model!: Model<Api>;
	private transcript: Transcript;
	private hot: Tool[] = [];
	private deferred = new Map<string, Tool>();
	private loaded = new Set<string>();
	/** tools only run helpers reach (shell.spawn, pty.*), never declared */
	private runOnly = new Map<string, Tool>();
	private pendingEffort: Effort | undefined;
	/** where the session stands by choice (the dial, a prompt's own effort, the stored effort at open); escalation moves `effort` for a turn and comes back here */
	private baseEffort: Effort;
	/**
	 * orders the explicit effort choices (the dial, a prompt's, a steer's) so the newest wins: `dialAt` is when the
	 * newest one took effect or was applied, `choiceAt` when a waiting prompt or steer asked for its own
	 */
	private effortClock = 0;
	private dialAt = 0;
	/** the newest move of the dial itself, and when it was said: a waiting prompt's older effort runs its own turn, then gives it back */
	private dialMove: { effort: Effort; at: number } | undefined;
	private choiceAt = new WeakMap<object, number>();
	private stepSeq = 0;
	reqSeq = 0;
	private reqStartedAt = 0;
	private firstTokenAt: number | null = null;
	/**
	 * the streaming message's text and reasoning parts by content position: each is announced before its
	 * first delta (`message.part.started`), is closed when its block ends (`message.part.ended`, with the
	 * whole text), and the times ride the finished message (`partTimes`)
	 */
	private streamParts = new Map<number, { type: "text" | "reasoning"; start: number; end?: number }>();
	private open: StepRow | undefined;
	/** the open step's calls, for the poll-only verdict once run scripts report their helpers */
	private openCalls: PollCall[] = [];
	private toolStarts = new Map<string, number>();
	private steerPending = false;
	private requestSteered = false;
	private lastPrefix = { hash: "", same: 1 };
	private recordedPrefix: string | undefined;
	private turnAsk: RequestAsk | undefined;
	/** the ask the last real request carried (a btw sent mid-turn carries the same, so its cached messages match) */
	private lastAsk: RequestAsk | undefined;
	/** btw requests on the wire; the residency cache keeps such a session loaded */
	private asides = 0;
	private turnRequests = 0;
	private refusal: Refusal | undefined;
	private lastDate: string | undefined;
	/** the ttl in force: fixed by the creator's `cacheTtl`, else the rule's, and once long it stays long */
	private retention: "short" | "long";
	/** what the request being built was marked with, so pi's marker, cmx2's copies and the prefix gate agree */
	private requestRetention: "short" | "long" | undefined;
	/** steers and follow-ups admitted but not yet in the transcript: the status map's queue depth */
	private waiting: AgentMessage[] = [];
	private lastAssistantSeq = 0;
	/** the agent type the user picked last; stamped on assistant messages */
	private agentName: string | undefined;
	private lastLedger: string | undefined;
	/** turn-context blocks as last sent, by key */
	private lastAppendix = new Map<string, string>();
	/** mail steered into the running turn and not yet in the transcript */
	private mailQueued: AgentMessage[] = [];
	/** queued prompts that wait for a turn of their own (another model or effort than the running one), in `waiting` too */
	private held = new Set<AgentMessage>();
	/** transcript position before the running turn's first message */
	private turnFrom = 0;
	private aborting = false;
	private turnError: string | undefined;
	/** failure signals seen this turn, for escalation at the boundary */
	private signals: string[] = [];
	private toolErrors = new Map<string, number>();
	/** failures of each check command this turn; a pass of it starts the count over */
	private checkFailures = new Map<string, number>();
	private callCounts = new Map<string, number>();
	private toolArgs = new Map<string, unknown>();
	private editedThisTurn = false;
	/** files this turn wrote: write and edit, run's fs helpers, shell redirections */
	private touched = new Set<string>();
	/** the escalation the next step carries in telemetry */
	private escalationNote: string | undefined;
	/**
	 * the last real request, re-sent and cut off at the provider's first event to keep the cache warm while parked. its context (the
	 * copy of the message list) is dropped once warming stops; the model and options stay for the idle summary
	 */
	private lastCall: { model: Model<Api>; context: any; options: any } | undefined;
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	private warmUntil = 0;
	private warmed = false;
	/** a warm refresh is on the wire */
	private warmBusy = false;
	/** the idle summary waits for the cache's last minutes (compaction.cold) */
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** the idle summary is on the wire */
	private idleBusy = false;
	/** a test hook: the next turn fails before any request, as a provider failure would */
	private fault: string | undefined;
	/** a transient provider failure is being waited out; the status clients see while it lasts */
	private retry: { type: "retry"; attempt: number; message: string; next: number } | undefined;
	/** automatic continuations after an output-limit stop, this turn */
	private continuations = 0;
	/** transcript position the last prompt's user message lands at; set when the turn starts */
	lastPromptSeq = 0;
	/** documents in the transcript by content hash, for the request tap to put back as the api's document blocks */
	private documents = new Map<string, DocumentData>();
	/** each transcript message's position, for messages this process holds; copies made at compaction carry their original's */
	private seqOf = new WeakMap<object, number>();
	/** the model's notes file: offered through the notes tool, carried in every post-compaction block */
	readonly notesFile: string;
	/** a compaction that cannot succeed on this model (a degenerate summary twice, too large even stripped) is not retried every request */
	private suppressed: { model: string; reason: "degenerate" | "too_large" } | undefined;
	/** the summary made in the background before the threshold: valid while its messages are still the context's head */
	private prefire: Prefire | undefined;
	/** a prefire that failed does not fire again before the next compaction */
	private prefireBlocked = false;
	/**
	 * a newer summary being made while the ready prefire's tail grows; it replaces the prefire when it lands,
	 * unless a compaction or a revert dropped the prefire meanwhile (they clear this too)
	 */
	private refresh: Prefire | undefined;
	/** a refresh that failed does not run again before the next compaction; the old summary stays usable */
	private refreshBlocked = false;
	/** when and on which model this session last sent a request that read or wrote its prompt cache; 0 is never */
	private lastCacheUseAt = 0;
	private lastCacheModel: string | undefined;
	/** a transient failure waits this long before the next automatic attempt */
	private compactRetryAt = 0;
	private compacting: Promise<AgentMessage[] | undefined> | undefined;
	/** a disposed session starts nothing: no recovery turn, no background summary */
	private disposed = false;
	/** a request the provider refused for its size teaches the session a lower limit than the config says */
	private learnedCap: number | undefined;
	/** and one refused for its image count, a lower count */
	private learnedMaxImages: number | undefined;
	/** the context as the last request carried it: its size in bytes (an estimate), its images and their base64 bytes */
	private lastSize = { bytes: 0, images: 0, imageBytes: 0 };
	/** recoveries from a media refusal since the last prompt from the user or the last turn that finished */
	private sizeRecoveries = 0;

	private constructor(private readonly opts: EngineSessionOptions) {
		this.id = opts.id ?? `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		this.cwd = opts.cwd;
		this.title = opts.title ?? "untitled";
		this.effort = opts.effort ?? opts.config.effort;
		this.baseEffort = this.effort;
		this.nudge = opts.nudge ?? opts.config.nudge;
		this.transcript = new Transcript(join(opts.dataDir, "sessions", `${this.id}.jsonl`));
		this.recordedPrefix = opts.resume?.recordedPrefix;
		this.retention = opts.cacheTtl === "1h" ? "long" : "short";
		this.turnMode = "system";
		this.notesFile = join(opts.dataDir, "notes", `${this.id}.md`);
	}

	static async create(opts: EngineSessionOptions): Promise<EngineSession> {
		const s = new EngineSession(opts);
		await s.init();
		return s;
	}

	private emit(type: string, properties: Record<string, unknown>) {
		this.opts.onEvent({ type, properties: { sessionID: this.id, ...properties } });
	}

	private async init() {
		const { config, dataDir, cwd } = this.opts;
		this.model = await resolveModel(config, this.opts.model ?? config.model);
		const mode = this.opts.turnMessages ?? config.turnMessages;
		(this as { turnMode: "system" | "user-part" }).turnMode =
			mode === "auto" ? (this.model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages ? "system" : "user-part" : mode;

		const lsp = this.opts.lsp ?? new LspPool();
		const env = { cwd, spillDir: join(dataDir, "tool-output"), ...(this.opts.procs ? { procs: this.opts.procs } : {}), afterWrite: (abs: string, before?: Before) => this.afterWrite(abs, lsp, before), ...(this.opts.child ? { env: subagentEnv() } : {}) };
		const skills = this.opts.skills ?? new Skills(() => defaultSkillDirs(cwd, configDir()));
		for (const t of deferredTools(env, { skills, lsp, web: webOptions(config) })) this.deferred.set(t.name, t);
		for (const t of runOnlyTools(env)) this.runOnly.set(t.name, t);
		const search = toolSearchTool(
			() => [...this.deferredAll().values()].filter((t) => !this.loaded.has(t.name)).map((t) => ({ name: t.name, description: t.description })),
			(names) => this.loadTools(names),
		);
		const ask: AskQuestions = (questions, callID, signal) => {
			if (!this.opts.askQuestion) return Promise.reject(new Error("no client is connected that can answer questions; decide with what you have and say what you assumed"));
			return this.opts.askQuestion({ questions, callID, messageSeq: this.lastAssistantSeq }, signal);
		};
		const exclude = this.exclude;
		const memory = [notesTool(this.notesFile), recallTool((query, limit) => this.recall(query, limit))];
		this.hot = [...hotTools(env, (tool, args, signal) => this.nestedCall(tool, args, signal), ask, this.opts.child ? "spawner" : "user"), search, ...memory, ...(this.opts.extraTools ?? [])]
			.filter((t) => !exclude.has(t.name))
			.sort((a, b) => a.name.localeCompare(b.name));

		let messages: AgentMessage[] | undefined;
		if (this.opts.resume) {
			const t = this.transcript.load();
			// the context is the transcript after its last compaction and without reverted ranges; the file keeps everything
			messages = this.adopt(t.messages);
			this.profile = t.header.profile;
			if (t.skipped) this.emit("session.warning", { message: `${t.skipped} unreadable transcript line(s) skipped on resume` });
			// deferred tools the model had loaded stay executable; the transcript still declares them
			// an mcp server may still be connecting on resume, so every declared tool that is not hot counts as loaded
			const hot = new Set(this.hot.map((t) => t.name));
			for (const decl of getCurrentTools(messages as never)) if (!hot.has(decl.name)) this.loaded.add(decl.name);
			// the last turn context sent, so a resumed session only repeats it when the date moved
			for (const m of messages as any[]) {
				const d = JSON.stringify(m.content ?? "").match(/turn context: [^"]*?date: (\d{4}-\d{2}-\d{2})/)?.[1];
				if (d) this.lastDate = d;
			}
			this.stepSeq = t.messages.filter((m: any) => m.role === "assistant").length;
			this.lastAssistantSeq = t.messages.findLastIndex((m: any) => m.role === "assistant") + 1;
			this.pickUp(messages);
		} else {
			this.profile = profileFor(this.model.api, this.model.id);
		}

		this.agent = new Agent({
			initialState: {
				...(messages ? { messages } : { systemPrompt: this.opts.systemExtra ? `${profileText(this.profile as never)}\n${this.opts.systemExtra}` : profileText(this.profile as never) }),
				model: this.model,
				thinkingLevel: this.effort,
				tools: this.agentTools(),
			},
			streamFn: (model, context, options) => {
				this.lastCall = { model, context: { ...context, messages: [...context.messages] }, options };
				// transient failures (429, 529, overloaded, 5xx, a dropped connection) before text or a tool call are retried with backoff; clients see a retry status
				// one value for the whole request: a retry after a switch mid-wait must not mark half of it differently
				const retention = (this.requestRetention = this.cacheRetention());
				return withRetry(() => streamFn(model, context, { ...options, cacheRetention: retention }), {
					...(options?.signal ? { signal: options.signal } : {}),
					...(this.opts.retry ? { policy: this.opts.retry } : {}),
					hooks: {
						onRetry: (attempt, delayMs, message) => {
							const typed = classifyProviderError({ provider: model.provider, model: model.id, errorMessage: message });
							const why = typed.kind === "rate_limit" ? `rate limited by ${model.provider}` : typed.kind === "overloaded" ? `${model.id} is overloaded` : `${model.id} failed`;
							this.retry = { type: "retry", attempt, message: `${why}; retrying in ${Math.max(1, Math.round(delayMs / 1000))} s`, next: Date.now() + delayMs };
							this.emit("session.status", { status: this.retry });
						},
						onResume: () => {
							this.retry = undefined;
							if (this.state === "busy") this.emit("session.status", { status: { type: "busy", queued: this.waiting.length } });
						},
						// the failed attempt's thinking is thrown away: its parts and first token no longer describe the message. the retry's
						// request clears them too (onPayload); clearing here keeps an abort during the wait from timing parts it does not have
						onDiscard: () => {
							this.streamParts.clear();
							this.firstTokenAt = null;
						},
					},
				});
			},
			convertToLlm: (messages) =>
				toLlm(messages, DOCUMENT_APIS.has(this.model.api) ? this.documents : undefined).filter((m: any) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as never,
			getApiKey: (provider) => resolveApiKey(config, provider),
			onPayload: (payload, model) => this.onPayload(payload as Record<string, any>, model),
			onProviderStreamEvent: (event, model) => {
				// the prompt is processed and its cache entry readable from here; requests waiting on this prefix go
				if ((event as any)?.type === "message_start") this.releasePrefix(true);
				const r = refusalFromEvent(model.api, model.provider, model.id, event);
				if (r) this.refusal = r;
			},
			// a context past the threshold is compacted here, between steps, so the turn goes on with it
			prepareRequest: async ({ context }, signal) => {
				const next = await this.beforeRequest(context.messages, signal);
				return next ? { context: { ...context, messages: next } } : undefined;
			},
			// a tool loaded mid-run (tool_search) is declared before the next request of the same run, and one whose
			// mcp server went away is withdrawn. the agent's own list is updated too: the next prompt declares from it,
			// and a stale one would re-add what this just removed (53 tool_additions every turn, until the api refuses)
			prepareNextTurnWithContext: (turn) => {
				const tools = this.syncTools();
				if (sameToolNames(turn.context.tools ?? [], tools)) return undefined;
				return { context: { ...turn.context, tools } };
			},
			// sequential tools are gated here; the rest in their execution (agentTools), so a response's asks are all open at once
			beforeToolCall: async ({ toolCall, args }, signal) => {
				if (this.toolByName(toolCall.name)?.executionMode !== "sequential") return undefined;
				const reason = await this.gate(toolCall.name, args, toolCall.id, signal);
				// a plain reject ends the turn after this batch, as in cmx; feedback lets the model carry on
				return reason ? { block: true, reason, terminate: reason === PERMISSION_REJECTED } : undefined;
			},
			// an output-limit stop with nothing left to run continues the turn instead of ending it (capped per turn)
			finishTurn: (turn) => {
				const m = turn.message as any;
				const calls = (m?.content ?? []).some((b: any) => b.type === "toolCall");
				if (m?.stopReason !== "length" || calls || this.continuations >= MAX_CONTINUATIONS) return undefined;
				this.continuations++;
				if (this.open) this.open.continued = 1;
				this.agent.steer({ role: "user", content: [{ type: "text", text: CONTINUE_TEXT, synthetic: true }], timestamp: Date.now() } as unknown as AgentMessage);
				return { action: "continue" };
			},
			sessionId: this.id,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		});
		if (!this.opts.resume) {
			this.transcript.create({ type: "header", version: 1, id: this.id, cwd, created: this.createdAt, profile: this.profile });
			// the leading system message is the recorded prefix: prompt text and tool declarations, once
			const first = this.agent.state.messages[0]!;
			const seq = this.transcript.append(first);
			this.seqOf.set(first, seq);
			this.opts.onMessage?.(seq, first);
		}
		this.agent.subscribe((e) => this.onAgentEvent(e));
	}

	/**
	 * after write or edit: the project's formatter (unless the profile turns it off), then the language
	 * server's errors for the file, returned as notes for the tool result; clients hear file.edited
	 */
	private async afterWrite(abs: string, lsp: LspPool, before?: Before): Promise<AfterWrite> {
		const notes: string[] = [];
		const c = this.opts.config;
		if (c.format !== false) {
			const f = await formatFile(abs, this.cwd).catch(() => undefined);
			if (f?.changed) notes.push(`${f.tool} reformatted the file; read it before editing it again`);
			else if (f?.error) notes.push(`${f.tool} could not format the file: ${f.error}`);
		}
		// the call's one diff, after the formatter (a16): its counts go on the event, the tool puts it on the part; a diff that cannot be taken leaves both without it
		let diff: FileDiffResult | undefined;
		if (before !== undefined) {
			try {
				diff = diffOnDisk(abs, before);
			} catch {}
		}
		this.emit("file.edited", { file: abs, ...(diff ? { additions: diff.filediff.additions, deletions: diff.filediff.deletions } : {}) });
		if (c.diagnostics !== false) {
			const errors = await errorsAfterWrite(lsp, abs, this.cwd).catch(() => undefined);
			if (errors) notes.push(errors);
		}
		return { ...(notes.length ? { notes: notes.join("\n\n") } : {}), ...(diff ? { diff } : {}) };
	}

	private executableTools(): Tool[] {
		const all = this.deferredAll();
		// a loaded tool whose mcp server is gone drops out until the server is back
		return [...this.hot, ...[...this.loaded].sort().flatMap((n) => all.get(n) ?? [])];
	}

	/**
	 * the tools as the agent runs them. pi prepares a response's calls one after another and only then runs
	 * them together, so a permission ask in its before-call hook would hold every later call until it is
	 * answered. tools that run in parallel ask inside their execution instead: two gated reads in one
	 * response are two open asks at once, each answered on its own. a refusal reads as a blocked call does.
	 */
	private agentTools(): AgentTool[] {
		return this.executableTools().map((t) =>
			t.executionMode === "sequential"
				? t
				: {
						...t,
						execute: async (id: string, params: never, signal?: AbortSignal, onUpdate?: never) => {
							const reason = await this.gate(t.name, params, id, signal);
							if (reason) return { content: [{ type: "text" as const, text: reason }], details: {}, isError: true, ...(reason === PERMISSION_REJECTED ? { terminate: true } : {}) };
							return t.execute(id, params, signal, onUpdate);
						},
					},
		) as unknown as AgentTool[];
	}

	/** the agent's tool list brought up to date when its names changed; the current list either way */
	private syncTools(): AgentTool[] {
		const tools = this.agentTools();
		if (sameToolNames(this.agent.state.tools ?? [], tools)) return this.agent.state.tools as AgentTool[];
		this.agent.state.tools = tools;
		return tools;
	}

	/** tools this session never has (a read-only agent's), declared, deferred or dynamic */
	private get exclude(): Set<string> {
		return new Set(this.opts.excludeTools ?? []);
	}

	/** the deferred tools as of now: the fixed set plus whatever the daemon's mcp servers offer */
	private deferredAll(): Map<string, Tool> {
		const dynamic = this.opts.dynamicTools?.() ?? [];
		const exclude = this.exclude;
		if (!dynamic.length && !exclude.size) return this.deferred;
		const all = new Map(this.deferred);
		// a read-only agent (explore, review: no edit) gets an mcp tool only when its server marks it readOnlyHint
		const readOnly = exclude.has("edit");
		for (const t of dynamic) if (!all.has(t.name) && !(readOnly && t.readOnly === false)) all.set(t.name, t);
		for (const name of exclude) all.delete(name);
		return all;
	}

	private loadTools(names: string[]): string[] {
		const all = this.deferredAll();
		const added = names.filter((n) => all.has(n) && !this.loaded.has(n));
		for (const n of added) this.loaded.add(n);
		if (added.length) {
			this.agent.state.tools = this.agentTools();
			this.emit("session.tools", { loaded: added });
		}
		return added;
	}

	/** what the gate needs from this session: its directory, its rules, and whoever can answer an ask */
	private gateOptions(): GateOptions {
		const ask = this.opts.askPermission;
		return {
			cwd: this.cwd,
			rules: () => [...rulesFromConfig(this.opts.config.permission), ...(this.opts.savedRules?.() ?? []), ...(this.opts.child ? SUBAGENT_RULES : [])],
			...(ask ? { ask: (check: PermissionCheck, callID: string, signal?: AbortSignal) => ask({ ...check, callID, messageSeq: this.lastAssistantSeq }, signal) } : {}),
		};
	}

	/**
	 * the permission check for one call, native or nested in `run`: deny wins at once, allow passes,
	 * anything else asks whoever is connected and waits. returns the refusal text, or nothing to proceed.
	 */
	private async gate(tool: string, args: unknown, callID: string, signal?: AbortSignal): Promise<string | undefined> {
		return (await gateCall(this.gateOptions(), tool, args, callID, signal)).refused;
	}

	/** any tool a helper may reach: declared, deferred (loaded or not) and run-only */
	private toolByName(name: string): Tool | undefined {
		return this.executableTools().find((t) => t.name === name) ?? this.deferredAll().get(name) ?? this.runOnly.get(name);
	}

	/** a helper call from inside `run`: same tool object, schema check, permission check and error shape as a direct call */
	private nestedCall(name: string, args: unknown, signal?: AbortSignal): Promise<{ result: ToolResult; isError: boolean; decision?: CallDecision }> {
		return nestedCall(this.gateOptions(), (n) => this.toolByName(n), name, args, signal).then((r) => {
			const a = args as Record<string, unknown> | undefined;
			if (!r.isError && (name === "write" || name === "edit")) this.touch(a?.path);
			if (!r.isError && name === "shell" && typeof a?.command === "string") for (const f of shellWrites(a.command)) this.touch(f);
			return r;
		});
	}

	get modelRef(): string {
		return `${this.model.provider}/${this.model.id}`;
	}

	get transcriptPath(): string {
		return this.transcript.path;
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** a reloaded config: permission rules and keys apply from the next check; the recorded prefix never changes */
	reconfigure(config: Config) {
		(this.opts as { config: Config }).config = config;
	}

	/** steers and follow-ups admitted but not yet sent */
	/** the retry wait in progress, if a transient provider failure is being waited out */
	get retryStatus(): { type: "retry"; attempt: number; message: string; next: number } | undefined {
		return this.state === "busy" ? this.retry : undefined;
	}

	get queued(): number {
		return this.waiting.length;
	}

	/** the prompts and steers waiting, in the order admitted, as a client draws them: the provisional id, what was typed, and what each asked for */
	queuedPrompts(): Array<{ id: string; content: string | UserBlock[]; created: number; clientID?: string; agent?: string; steer?: boolean; model?: string; effort?: Effort; btw?: string }> {
		return this.waiting.flatMap((w) => {
			const m = w as unknown as { id?: string; content: string | UserBlock[]; timestamp: number; clientID?: string; agent?: string; btw?: string };
			if (!m.id) return [];
			const pick = this.pickOf(w);
			return [{ id: m.id, content: m.content, created: m.timestamp, ...(m.clientID ? { clientID: m.clientID } : {}), ...(m.agent ? { agent: m.agent } : {}), ...(this.isSteer(w) ? { steer: true } : {}), ...pick, ...(m.btw ? { btw: m.btw } : {}) }];
		});
	}

	/** another process appended to this session's transcript since this process last read or wrote it */
	get staleOnDisk(): boolean {
		return this.transcript.changedOnDisk();
	}

	/** the before-send tap: gates, prefix comparison against the record, request summary */
	/** the prefix gate's release for the request in flight, until its first event */
	private prefixRelease: ((answered: boolean) => void) | undefined;

	private releasePrefix(answered: boolean) {
		this.prefixRelease?.(answered);
		this.prefixRelease = undefined;
	}

	private async onPayload(payload: Record<string, any>, model: Model<Api>): Promise<Record<string, any> | undefined> {
		this.cacheUsed(model);
		this.finalizeStep();
		this.releasePrefix(false);
		this.reqSeq++;
		this.turnRequests++;
		this.reqStartedAt = performance.now();
		this.firstTokenAt = null;
		this.streamParts.clear();
		this.requestSteered = this.steerPending;
		this.steerPending = false;
		this.refusal = undefined;

		const notes: GateNotes = { applied: [] };
		this.lastAsk = undefined;
		if (this.turnAsk) {
			// a forced tool choice binds the first request of the turn only; later requests would loop on it
			const ask: RequestAsk = { ...this.turnAsk, ...(this.turnRequests > 1 ? { toolChoice: undefined } : {}) };
			applyAsk(model.api, model.id, payload, ask, notes);
			this.lastAsk = ask;
		}

		this.putDocuments(model.api, payload, notes);
		moveTrailingSystemBreakpoint(model.api, payload, notes);
		rollingBreakpoint(model.api, payload, notes);
		const prefix = prefixOf(model.api, payload);
		const hash = sha(prefix.bytes);
		if (this.recordedPrefix === undefined) {
			this.recordedPrefix = prefix.bytes;
			this.opts.onPrefix?.(hash, prefix.bytes);
		}
		const diffAt = firstDiff(this.recordedPrefix, prefix.bytes);
		this.lastPrefix = { hash, same: diffAt === null ? 1 : 0 };
		if (diffAt !== null) this.emit("session.prefix_changed", { request: this.reqSeq, at: diffAt, hash });

		const captureDir = process.env.CMX2_CAPTURE_DIR;
		if (captureDir) {
			// debugging and byte-diff evidence: full bodies hold the whole transcript, so only when asked for
			mkdirSync(captureDir, { recursive: true });
			const n = `${BOOT}-${String(this.reqSeq).padStart(3, "0")}`;
			writeFileSync(join(captureDir, `${this.id}-${n}.json`), JSON.stringify(payload, null, 1));
			writeFileSync(join(captureDir, `${this.id}-${n}.prefix`), prefix.bytes);
		}
		const sentMessages: any[] = payload.messages ?? payload.contents ?? [];
		this.requests.push({
			seq: this.reqSeq,
			at: Date.now(),
			model: String(payload.model),
			betas: payload.betas ?? [],
			prefix_hash: hash,
			prefix_bytes: prefix.bytes.length,
			prefix_diff_at: diffAt,
			tools: prefix.tools,
			deferred: prefix.deferred,
			message_count: sentMessages.length,
			effort_markers: effortMarkers(model.api, payload),
			gates: notes.applied,
			bytes: this.lastSize.bytes,
			images: this.lastSize.images,
			image_bytes: this.lastSize.imageBytes,
			tail: sentMessages.slice(-5).map((m) => ({ role: m.role, text: excerpt(m.content ?? m.parts) })),
		});
		if (this.requests.length > REQUEST_SUMMARIES) this.requests.shift();
		if (model.api === "anthropic-messages") {
			// the ttl is part of what an entry is found by, so a sibling at the other ttl is not waiting for the same entry
			const retention = this.requestRetention ?? this.cacheRetention();
			// a sibling on the same cold prefix waits for the first one's entry instead of writing its own
			const gate = await prefixGate.enter(`${model.provider}/${model.id}:${hash}:${retention}`, retention === "long" ? 3_600_000 : 300_000);
			this.prefixRelease = gate.release;
			if (gate.waitedMs) {
				notes.applied.push(`waited ${gate.waitedMs} ms for a request writing the same prefix`);
				this.reqStartedAt = performance.now();
			}
		}
		return notes.applied.length ? payload : undefined;
	}

	/** document markers in the request become the api's own blocks: an anthropic document, gemini inline data */
	private putDocuments(api: string, payload: Record<string, any>, notes: GateNotes) {
		if (!this.documents.size) return;
		let n = 0;
		if (api === "anthropic-messages") {
			for (const m of payload.messages ?? []) {
				if (!Array.isArray(m.content)) continue;
				m.content = m.content.map((b: any) => {
					const key = b?.type === "text" ? String(b.text).match(DOCUMENT_MARK)?.[1] : undefined;
					const d = key ? this.documents.get(key) : undefined;
					if (!d) return b;
					n++;
					return { type: "document", source: { type: "base64", media_type: d.mimeType, data: d.data }, title: d.filename, ...(b.cache_control ? { cache_control: b.cache_control } : {}) };
				});
			}
		} else if (api === "google-generative-ai") {
			for (const c of payload.contents ?? []) {
				if (!Array.isArray(c.parts)) continue;
				c.parts = c.parts.map((p: any) => {
					const key = typeof p?.text === "string" ? p.text.match(DOCUMENT_MARK)?.[1] : undefined;
					const d = key ? this.documents.get(key) : undefined;
					if (!d) return p;
					n++;
					return { inlineData: { mimeType: d.mimeType, data: d.data } };
				});
			}
		}
		if (n) notes.applied.push(`documents:${n}`);
	}

	private onAgentEvent(e: AgentEvent) {
		switch (e.type) {
			case "message_update": {
				if (this.firstTokenAt === null) {
					this.firstTokenAt = performance.now();
					// the step's message exists from its first token; it lands at the next transcript position
					this.emit("message.started", { seq: this.transcript.count + 1, model: this.modelRef, agent: this.agentName ?? "build", effort: this.effort });
				}
				this.streamPart(e.assistantMessageEvent as any);
				break;
			}
			case "message_end": {
				const m = e.message as any;
				// when each streamed text and reasoning part started and ended, by content position, so the projection (and a rebuild of it) carries them
				if (m?.role === "assistant" && this.streamParts.size) {
					const now = Date.now();
					m.partTimes = Object.fromEntries([...this.streamParts].map(([i, p]) => [i, { start: p.start, end: p.end ?? now }]));
				}
				this.streamParts.clear();
				if (m?.role === "assistant" && this.agentName) m.agent = this.agentName;
				// a decline rides the message itself, so every reader of the transcript sees a refusal, not a provider error
				if (m?.role === "assistant" && m.stopReason === "error") m.refusal = this.refusal ?? refusalFromError(m.provider, m.model, m.errorMessage);
				// every other provider failure rides the message typed (overflow, auth, rate limit, overloaded, unknown)
				if (m?.role === "assistant" && m.stopReason === "error" && !m.refusal) {
					const t = classifyProviderError({ provider: m.provider, model: m.model, errorMessage: m.errorMessage, contextWindow: this.model.contextWindow, message: m });
					m.errorType = { name: t.name, kind: t.kind, message: t.message };
				}
				const seq = this.transcript.append(m);
				this.seqOf.set(m, seq);
				if (m?.role === "assistant") this.lastAssistantSeq = seq;
				this.opts.onMessage?.(seq, m);
				if (m?.role === "mail") {
					this.mailQueued = this.mailQueued.filter((q) => q !== m && (q as any).mailID !== m.mailID);
					this.opts.onMailDelivered?.(m.mailID, seq);
				}
				if (m?.role === "assistant" && m.stopReason === "length") this.signal("the reply hit the output token limit");
				// a steer's effort takes the dial when the steer is read, not when it was sent (one taken back never moved it), and only
				// if nothing explicit came after it: a dial moved since, or an effort a turn already started with, is newer
				if (m?.role === "user" && m.steer === true && typeof m.variant === "string" && (this.choiceAt.get(m) ?? 0) > this.dialAt) {
					// compared with where the session stands (an escalation is a turn's own, never what a steer is measured against)
					const cancels = this.pendingEffort !== undefined && m.variant === this.baseEffort;
					this.pendingEffort = m.variant === this.baseEffort ? undefined : (m.variant as Effort);
					// a pending move that was called off: the stored effort (the dial wrote it when it was said) and the clients that showed it pending hear that it stayed
					if (cancels) this.emit("session.effort", { effort: this.baseEffort });
				}
				if (m?.role === "user" && this.waiting.length) {
					const i = this.waiting.findIndex((w) => w === m || ((w as any).timestamp === m.timestamp && (w as any).content === m.content));
					if (i >= 0) {
						// the agent the user picked for a prompt answers once it lands
						const agent = (this.waiting[i] as { agent?: string }).agent;
						if (agent) this.agentName = agent;
						this.waiting.splice(i, 1);
						this.emit("session.status", { status: { type: "busy", queued: this.waiting.length } });
					}
				}
				if (m?.role === "assistant") this.openStep(m);
				break;
			}
			case "tool_execution_start": {
				this.toolStarts.set(e.toolCallId, performance.now());
				this.toolArgs.set(e.toolCallId, e.args);
				const key = `${e.toolName}:${JSON.stringify(e.args ?? {})}`;
				const n = (this.callCounts.get(key) ?? 0) + 1;
				this.callCounts.set(key, n);
				// waiting on helpers and listing them are what a parent does; repeating them says nothing about the model
				if (n === 3 && e.toolName !== "wait" && e.toolName !== "agents") this.signal(`the same ${e.toolName} call three times`);
				break;
			}
			case "tool_execution_update": {
				// a running tool's output tail (shell reports at most once a second)
				const tail = (e.partialResult as { details?: { progress?: boolean; tail?: string } } | undefined)?.details;
				if (tail?.progress && typeof tail.tail === "string") this.emit("tool.progress", { callID: e.toolCallId, tool: e.toolName, output: tail.tail });
				break;
			}
			case "tool_execution_end": {
				const t0 = this.toolStarts.get(e.toolCallId);
				if (this.open) {
					if (t0 !== undefined) this.open.tool_ms += Math.round(performance.now() - t0);
					if (e.toolName === "run") {
						const details = e.result?.details as RunDetails | undefined;
						const n = details?.calls ?? 0;
						this.open.nested_calls += n;
						this.open.calls += n;
						const call = this.openCalls.find((c) => (c as { id?: string }).id === e.toolCallId);
						if (call) call.nested = details?.nested ?? [];
						this.open.poll_only = pollOnly(this.openCalls);
					}
				}
				this.toolStarts.delete(e.toolCallId);
				this.watchSignals(e.toolCallId, e.toolName, e.result, e.isError);
				break;
			}
			case "agent_end": {
				this.finalizeStep();
				this.turnAsk = undefined;
				this.turnRequests = 0;
				const last = [...e.messages].reverse().find((m: any) => m.role === "assistant") as any;
				const stopReason: string = last?.stopReason ?? (this.turnError ? "error" : "stop");
				const outcome: "completed" | "errored" | "aborted" =
					this.aborting || stopReason === "aborted" ? "aborted" : stopReason === "error" || this.turnError ? "errored" : "completed";
				const error = this.turnError ?? (stopReason === "error" ? (last?.errorMessage ?? "the provider returned an error") : undefined);
				// mail that arrived after the loop's last look goes back to the mailbox; the runtime starts a turn for it
				this.returnQueuedMail();
				if (this.pendingEffort) {
					this.applyEffort(this.pendingEffort);
					this.pendingEffort = undefined;
				} else if (outcome !== "aborted") this.maybeEscalate();
				const from = this.turnFrom;
				this.setState("idle");
				this.opts.onTurn?.({ type: "end", from, to: this.transcript.count, outcome, stopReason, ...(error ? { error } : {}), ...(this.refusal ? { refusal: this.refusal.classifier } : {}), files: [...this.touched] });
				this.aborting = false;
				this.turnError = undefined;
				const media = outcome === "errored" ? mediaRefusal(last?.errorMessage) : undefined;
				// recoveries count until a prompt from the user or a turn that finished: a recovery turn whose model
				// fetches the same unreadable image again cannot go round for ever
				if (outcome === "completed") this.sizeRecoveries = 0;
				if (outcome !== "aborted" && !media && last?.errorType?.kind !== "context_overflow") {
					this.scheduleWarm();
					this.scheduleIdleSummary();
				} else this.dropWarmCopy();
				// a turn the provider refused for its media (size, image count, an image it cannot read) learns the
				// limit it showed now, before anything else can send, and drops images; one refused for length compacts
				// and goes on; one that ended near the threshold summarises ahead
				if (media) {
					this.learnLimit(media);
					setTimeout(() => void this.recoverMedia(media, last?.errorMessage), 0);
				} else if (outcome === "errored" && last?.errorType?.kind === "context_overflow") setTimeout(() => void this.recoverOverflow(), 0);
				else if (outcome === "completed" && this.held.size) setTimeout(() => void this.runHeld(), 0);
				else if (outcome === "completed") this.prefireAhead(this.agent.state.messages);
				break;
			}
		}
	}

	/**
	 * a streamed text or reasoning part: announced before its first delta (`message.part.started`, at the
	 * provider's start event, or ahead of a delta when a provider sent none), then its text as deltas, then
	 * closed when its block ends (`message.part.ended`: the provider's whole text and when it ended, so a
	 * client does not wait for the step to learn a thought is over). the streaming message lands at the next
	 * transcript position once it ends; clients key parts by it.
	 */
	private streamPart(ae: { type?: string; contentIndex?: number; delta?: string; content?: string } | undefined) {
		const m = /^(text|thinking)_(start|delta|end)$/.exec(ae?.type ?? "");
		if (!m || typeof ae?.contentIndex !== "number") return;
		const index = ae.contentIndex;
		const seq = this.transcript.count + 1;
		let part = this.streamParts.get(index);
		if (!part) {
			part = { type: m[1] === "text" ? "text" : "reasoning", start: Date.now() };
			this.streamParts.set(index, part);
			this.emit("message.part.started", { seq, index, type: part.type, start: part.start });
		}
		if (m[2] === "delta") this.emit("message.part.delta", { seq, index, field: "text", delta: ae.delta });
		else if (m[2] === "end" && part.end === undefined) {
			part.end = Date.now();
			this.emit("message.part.ended", { seq, index, type: part.type, start: part.start, end: part.end, ...(typeof ae.content === "string" ? { text: ae.content } : {}) });
		}
	}

	private openStep(m: any) {
		this.finalizeStep();
		const u = m.usage ?? {};
		const denom = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		const toolCalls = (m.content ?? []).filter((b: any) => b.type === "toolCall");
		const refusal = m.stopReason === "error" ? (this.refusal ?? refusalFromError(m.provider, m.model, m.errorMessage)) : undefined;
		const dropped = (m.diagnostics ?? [])
			.filter((d: any) => d.type === "anthropic_input_transformations")
			.reduce((a: number, d: any) => a + (d.details?.transformations?.length ?? d.transformations?.length ?? 1), 0);
		this.open = {
			session_id: this.id,
			seq: ++this.stepSeq,
			at: Date.now(),
			model: `${m.provider}/${m.model}`,
			effort: m.providerThinkingLevel ?? m.thinkingLevel ?? null,
			input: u.input ?? 0,
			cache_read: u.cacheRead ?? 0,
			cache_write: u.cacheWrite ?? 0,
			output: u.output ?? 0,
			cache_read_pct: denom ? Math.round((1000 * (u.cacheRead ?? 0)) / denom) / 10 : 0,
			ttft_ms: this.firstTokenAt === null ? null : Math.round(this.firstTokenAt - this.reqStartedAt),
			duration_ms: Math.round(performance.now() - this.reqStartedAt),
			tool_calls: toolCalls.length,
			nested_calls: 0,
			calls: toolCalls.filter((c: any) => c.name !== "run").length,
			tool_names: toolCalls.map((c: any) => c.name).join(","),
			tool_ms: 0,
			cost: u.cost?.total ?? 0,
			stop_reason: refusal ? "refusal" : (m.stopReason ?? "unknown"),
			refusal: refusal?.classifier ?? null,
			prefix_hash: this.lastPrefix.hash,
			prefix_same: this.lastPrefix.same,
			steered: this.requestSteered ? 1 : 0,
			dropped_blocks: dropped,
			poll_only: 0,
			escalation: this.escalationNote ?? null,
			warm: this.warmed ? 1 : 0,
			continued: 0,
		};
		this.escalationNote = undefined;
		this.warmed = false;
		this.openCalls = toolCalls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} }) as PollCall);
		this.open.poll_only = pollOnly(this.openCalls);
		if (refusal) {
			const err = new RefusalError(refusal);
			this.emit("session.error", { error: { name: err.name, data: { message: err.message, refusal } } });
		} else if (m.stopReason === "error") {
			const t: TypedProviderError = classifyProviderError({ provider: m.provider, model: m.model, errorMessage: m.errorMessage, contextWindow: this.model.contextWindow, message: m });
			this.emit("session.error", { error: { name: t.name, data: { message: t.message, kind: t.kind, detail: t.detail, ...(t.status ? { status: t.status } : {}) } } });
		}
	}

	private finalizeStep() {
		this.releasePrefix(false);
		if (!this.open) return;
		const row = this.open;
		this.open = undefined;
		this.opts.onStep(row);
		this.emit("step.recorded", { step: row });
	}

	/** when the current run state began (ms), for clients that show how long a session has been busy */
	stateSince = Date.now();

	private setState(state: SessionState) {
		if (this.state === state) return;
		this.state = state;
		this.stateSince = Date.now();
		// an abort leaves queued prompts in place for loop to run; a turn that ran them all leaves none. what pi no
		// longer holds has landed; the prompts held for a turn of their own stay (the idle status counts them)
		if (state === "idle" && !this.agent.hasQueuedMessages()) this.waiting = this.waiting.filter((w) => this.held.has(w));
		this.emit("session.status", { status: state === "busy" ? { type: "busy", queued: this.waiting.length } : { type: "idle", ...(this.waiting.length ? { queued: this.waiting.length } : {}) } });
		if (state === "idle") {
			this.opts.afterTurn?.();
			this.emit("session.idle", {});
		}
	}

	/** the effort the session stands at by choice: what a client's dial shows and the server stores. `effort` is the one the next turn runs at, which an escalation moves for a turn */
	get standingEffort(): Effort {
		return this.baseEffort;
	}

	/**
	 * the ttl to mark requests with now. an explicit `cacheTtl` is final; otherwise the server's rule decides, and its first "1h"
	 * sticks: switching costs one rewrite of the prefix (measured), so it is made once and never undone
	 */
	private cacheRetention(): "short" | "long" {
		if (this.retention === "long" || this.opts.cacheTtl !== undefined) return this.retention;
		if (this.opts.autoCacheTtl?.() === "1h") this.retention = "long";
		return this.retention;
	}

	/** an effort the session stands at by choice: it becomes the baseline escalation comes back to, and clients hear it (the server stores it) */
	private applyEffort(effort: Effort) {
		this.baseEffort = effort;
		this.effort = effort;
		this.agent.state.thinkingLevel = effort;
		this.emit("session.effort", { effort });
	}

	/** the effort for the coming turn only: escalation's, and the way back down. nothing is stored and no session.effort goes out */
	private applyTurnEffort(effort: Effort) {
		this.effort = effort;
		this.agent.state.thinkingLevel = effort;
	}

	/**
	 * the dial. applies from the next user turn (DECISIONS Q2 default): mid-turn changes wait for the
	 * turn to settle, so a marker never lands after a tool result until that placement is verified.
	 */
	setEffort(effort: Effort): "applied" | "pending" {
		this.dialAt = ++this.effortClock;
		this.dialMove = { effort, at: this.dialAt };
		if (this.state === "busy") {
			this.pendingEffort = effort;
			return "pending";
		}
		this.applyEffort(effort);
		return "applied";
	}

	/**
	 * turn-scoped text: the turn context when it changed, the batching nudge, the stand-in for a forced
	 * tool choice. appended to the transcript after the user message and never edited afterwards, so the
	 * cache and the thinking-block binding both see an append-only history.
	 */
	private turnText(ask?: RequestAsk): string | undefined {
		const lines: string[] = [];
		const date = localDate();
		if (date !== this.lastDate) {
			lines.push(`turn context: cwd: ${this.cwd}, host: ${hostname().split(".")[0]}, date: ${date}`);
			this.lastDate = date;
		}
		const ledger = this.opts.ledger?.() ?? "no processes running";
		if (ledger !== this.lastLedger) {
			// only on change: an unchanged ledger would repeat itself every turn
			if (this.lastLedger !== undefined || ledger !== "no processes running") lines.push(ledger);
			this.lastLedger = ledger;
		}
		for (const [key, text] of this.opts.appendix?.() ?? []) {
			// roster and routing blocks ride only when they changed since the last turn
			// a block that has gone away is sent again if it comes back, even as the same words
			if (text === undefined) {
				this.lastAppendix.delete(key);
				continue;
			}
			if (text === this.lastAppendix.get(key)) continue;
			lines.push(text);
			this.lastAppendix.set(key, text);
		}
		if (this.nudge) lines.push(BATCHING_NUDGE);
		if (ask?.toolChoice && rejectsForcedToolUse(this.model.api, this.model.id)) lines.push(forcedToolInstruction(ask.toolChoice));
		return lines.length ? lines.join("\n") : undefined;
	}

	/** a user message from typed blocks; queued and steered messages carry the id clients know them by */
	private userMessage(content: string | UserBlock[], opts: { id?: string; agent?: string; clientID?: string; steer?: boolean; model?: string; effort?: Effort; btw?: string } = {}): AgentMessage {
		const slash = opts.model ? opts.model.indexOf("/") : -1;
		return {
			role: "user",
			content,
			timestamp: Date.now(),
			...(opts.id ? { id: opts.id } : {}),
			...(opts.agent ? { agent: opts.agent } : {}),
			...(opts.clientID ? { clientID: opts.clientID } : {}),
			// a promoted btw says which one it was, on reads, on the stream and after a restart
			...(opts.btw ? { btw: opts.btw } : {}),
			// what a queued or steered prompt asked for rides the message, so a read, a stream and a restart all say it (a18, a20)
			...(opts.steer ? { steer: true } : {}),
			...(opts.model && slash > 0 ? { model: { providerID: opts.model.slice(0, slash), modelID: opts.model.slice(slash + 1) } } : {}),
			...(opts.effort ? { variant: opts.effort } : {}),
		} as AgentMessage;
	}

	/** the model and effort a queued prompt asked for, as it carries them */
	private pickOf(m: AgentMessage): { model?: string; effort?: Effort } {
		const x = m as { model?: { providerID?: string; modelID?: string }; variant?: Effort };
		return { ...(x.model?.providerID && x.model.modelID ? { model: `${x.model.providerID}/${x.model.modelID}` } : {}), ...(x.variant ? { effort: x.variant } : {}) };
	}

	/**
	 * a queued prompt that asked for another model or effort than the session has (or will have, once what
	 * runs before it has run) does not ride the running loop. pi could switch both between inner turns
	 * (prepareNextTurn), but the model is part of the recorded prefix and the prompt cache is per model, so the
	 * switch is a turn of its own: it starts after the turn that is running, with its choice applied.
	 */
	private needsTurn(m: AgentMessage, model = this.modelRef, effort: Effort = this.effort, base: Effort = this.baseEffort): boolean {
		const p = this.pickOf(m);
		// an effort that is only the escalated one still needs its turn: riding the loop would not make it where the session stands
		return (p.model !== undefined && p.model !== model) || (p.effort !== undefined && (p.effort !== effort || p.effort !== base));
	}

	/** pi's queues rebuilt from what waits, in the order admitted: a prompt that needs its own turn, and every prompt after it, waits in `held` instead */
	private syncQueues() {
		this.agent.clearAllQueues();
		this.held.clear();
		let gated = false;
		for (const w of this.waiting) {
			if (this.isSteer(w)) {
				this.agent.steer(w);
				continue;
			}
			if (gated || this.needsTurn(w)) {
				gated = true;
				this.held.add(w);
				continue;
			}
			this.agent.followUp(w);
		}
	}

	/** prompts admitted and not yet sent, in pi's queues or held back for a turn of their own */
	private hasWaiting(): boolean {
		return this.agent.hasQueuedMessages() || this.held.size > 0;
	}

	/**
	 * takes what waits out of the queues to start a turn with: every steer, and the prompts in order up to
	 * the first one that needs another model or effort. with `own`, a first prompt that needs them is taken
	 * with its choice (returned); without, it stays held behind the turn being started.
	 */
	private takeBatch(own: boolean): { batch: AgentMessage[]; pick?: { model?: string; effort?: Effort } } {
		const plan = this.planBatch(own);
		this.waiting = this.waiting.filter((w) => !plan.batch.includes(w));
		for (const m of plan.batch) this.held.delete(m);
		return plan;
	}

	/** what takeBatch would take, without taking it */
	private planBatch(own: boolean): { batch: AgentMessage[]; pick?: { model?: string; effort?: Effort } } {
		const batch: AgentMessage[] = [];
		let pick: { model?: string; effort?: Effort } | undefined;
		let model = this.modelRef;
		let effort = this.effort;
		let base = this.baseEffort;
		let prompts = 0;
		for (const w of this.waiting) {
			if (this.isSteer(w)) {
				batch.push(w);
				continue;
			}
			if (this.needsTurn(w, model, effort, base)) {
				if (!own || prompts > 0) break;
				pick = this.pickOf(w);
				model = pick.model ?? model;
				effort = pick.effort ?? effort;
				base = effort;
			}
			batch.push(w);
			prompts++;
		}
		return { batch, ...(pick ? { pick } : {}) };
	}

	/**
	 * the effort a turn started from waiting prompts runs at, when one of them asked: the newest explicit choice
	 * among them. a prompt's own choice always counts; a steer's counts only if the dial has not moved since it
	 * was sent. the turn has one effort, so a later steer's wins over an earlier prompt's.
	 */
	private batchEffort(batch: AgentMessage[]): { effort: Effort; at: number } | undefined {
		let best: { effort: Effort; at: number } | undefined;
		for (const m of batch) {
			const effort = (m as { variant?: Effort }).variant;
			const at = this.choiceAt.get(m);
			if (!effort || at === undefined || (this.isSteer(m) && at <= this.dialAt)) continue;
			if (!best || at > best.at) best = { effort, at };
		}
		return best;
	}

	/** startTurn for prompts taken out of the queue: when it cannot start (the run lock is held elsewhere), they go back where they were */
	private begin(batch: AgentMessage[], opts: { effort?: Effort; effortAt?: number; ask?: RequestAsk; context?: boolean; prompt?: AgentMessage }, taken: AgentMessage[]): Promise<void> {
		try {
			return this.startTurn(batch, opts);
		} catch (e) {
			this.waiting = [...taken, ...this.waiting];
			this.syncQueues();
			throw e;
		}
	}

	/** a finished turn left prompts that asked for another model or effort: the next one runs now, with its choice */
	private async runHeld(): Promise<void> {
		try {
			await this.drainQueue();
		} catch (e) {
			this.emit("session.warning", { message: `the queued prompt did not start: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	/** starts a turn; rejects when one is running (use steer or queue) */
	prompt(content: string | UserBlock[], opts: { effort?: Effort; ask?: RequestAsk; id?: string; agent?: string; clientID?: string; btw?: string } = {}): Promise<void> {
		if (this.state === "busy") throw new BusyError(this.id);
		if (opts.agent) this.agentName = opts.agent;
		const extra = this.turnText(opts.ask);
		const batch: AgentMessage[] = [];
		const user = this.userMessage(content, opts) as any;
		if (extra && this.turnMode === "user-part") {
			const blocks: UserBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
			user.content = [...blocks, { type: "text", text: `<system-reminder>\n${extra}\n</system-reminder>` }];
			batch.push(user);
		} else {
			batch.push(user);
			if (extra) batch.push({ role: "system", content: extra, timestamp: user.timestamp } as AgentMessage);
		}
		// prompts a stopped turn left waiting go first, in the order they were admitted
		// (one that asked for another model or effort keeps its place in the queue and runs after this turn)
		const leftover = this.hasWaiting() ? this.takeBatch(false).batch : [];
		if (leftover.length) this.agent.clearAllQueues();
		// an effort sent with this prompt is the newest word; without one, what the waiting steers asked for stands
		const carried = opts.effort ? undefined : this.batchEffort(leftover);
		const turn = this.begin([...leftover, ...batch], { ...opts, prompt: user, ...(carried ? { effort: carried.effort, effortAt: carried.at } : {}) }, leftover);
		if (this.waiting.length) this.syncQueues();
		return turn;
	}

	/**
	 * starts a turn. mail waiting for the session goes in first, oldest first; `context` appends the turn
	 * context when it changed (prompt() builds its own around the user's message).
	 */
	private startTurn(batch: AgentMessage[], opts: { effort?: Effort; effortAt?: number; ask?: RequestAsk; context?: boolean; prompt?: AgentMessage } = {}): Promise<void> {
		this.opts.beforeTurn?.();
		this.cancelWarm();
		this.cancelIdleSummary();
		if (opts.effort) {
			// an explicit effort, applied now: a steer waiting from before it does not move the dial when it lands
			const before = this.baseEffort;
			const at = opts.effortAt ?? ++this.effortClock;
			this.dialAt = Math.max(this.dialAt, at);
			this.applyEffort(opts.effort);
			// a prompt's own effort runs its own turn. a dial move said after the prompt was sent is the newer word: the effort the
			// session stood at (the dial's or the stored one; an escalation never counts) comes back when the turn ends, if the model the turn runs on allows it
			if (this.dialMove && this.dialMove.at > at && before !== opts.effort && (this.opts.allowed?.(this.modelRef, before) ?? true)) this.pendingEffort = before;
		}
		this.turnAsk = opts.ask;
		this.turnRequests = 0;
		this.continuations = 0;
		this.retry = undefined;
		this.resetSignals();
		this.turnFrom = this.transcript.count;
		// a prompt the user sent gets the size recoveries afresh
		if (opts.prompt) this.sizeRecoveries = 0;
		const taken = new Set<unknown>(batch);
		const mail = (this.opts.inbox?.() ?? []).filter((m) => !taken.has(m)) as unknown as AgentMessage[];
		const full = [...mail, ...batch];
		// the turn's messages land in this order from the next position on; a client gets the prompt's id at once
		if (opts.prompt) this.lastPromptSeq = this.transcript.count + 1 + full.indexOf(opts.prompt);
		if (opts.context) {
			const extra = this.turnText();
			if (extra) full.push(this.turnMessage(extra));
		}
		this.setState("busy");
		this.opts.onTurn?.({ type: "start", from: this.turnFrom });
		if (this.fault) return this.failTurn(full, this.fault);
		// the tools as of now (an mcp server may have come or gone since the last turn), declared once at the turn's start
		this.syncTools();
		return this.agent.prompt(full).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			this.emit("session.error", { error: { name: "EngineError", data: { message } } });
			this.turnAsk = undefined;
			if (this.state === "busy") this.settleWithoutRun(message);
		});
	}

	/** the injected fault: the turn's messages land, then it fails before any request, the way a provider failure ends one */
	private async failTurn(batch: AgentMessage[], message: string): Promise<void> {
		this.fault = undefined;
		for (const m of batch) {
			this.agent.state.messages.push(m);
			const seq = this.transcript.append(m);
			this.seqOf.set(m, seq);
			this.opts.onMessage?.(seq, m);
			if ((m as any).role === "mail") this.opts.onMailDelivered?.((m as any).mailID, seq);
		}
		await Promise.resolve();
		this.emit("session.error", { error: { name: "EngineError", data: { message } } });
		this.settleWithoutRun(message);
	}

	/** a turn that ended without the loop's own end event (it failed to start) */
	private settleWithoutRun(error: string) {
		const from = this.turnFrom;
		this.returnQueuedMail();
		this.setState("idle");
		this.opts.onTurn?.({ type: "end", from, to: this.transcript.count, outcome: "errored", stopReason: "error", error, files: [...this.touched] });
		this.aborting = false;
		this.turnError = undefined;
	}

	/** turn text as its own message: a system message, or a reminder the user message would have carried */
	private turnMessage(extra: string): AgentMessage {
		return this.turnMode === "user-part"
			? ({ role: "user", content: [{ type: "text", text: `<system-reminder>\n${extra}\n</system-reminder>`, synthetic: true }], timestamp: Date.now() } as unknown as AgentMessage)
			: ({ role: "system", content: extra, timestamp: Date.now() } as AgentMessage);
	}

	/** makes the next turn fail before its first request (the supervision tests' crash, `CMX2_FAULT`) */
	failNextTurn(message: string) {
		this.fault = message;
	}

	/** mail for a running turn lands at its next tool boundary; false when the session is idle (the runtime wakes it or holds the mail) */
	deliver(items: MailRecord[]): boolean {
		if (this.state !== "busy") return false;
		for (const m of items) {
			this.mailQueued.push(m as unknown as AgentMessage);
			this.agent.steer(m as unknown as AgentMessage);
		}
		this.steerPending = true;
		return true;
	}

	/** starts a turn for the mail waiting in the inbox; false when a turn is running or nothing waits */
	wake(): boolean {
		if (this.state === "busy") return false;
		const queued = this.hasWaiting();
		if (!queued && !(this.opts.inbox?.() ?? []).length) return false;
		const leftover = queued ? this.takeBatch(false).batch : [];
		if (queued) this.agent.clearAllQueues();
		const carried = this.batchEffort(leftover);
		void this.begin(leftover, { context: true, ...(carried ? { effort: carried.effort, effortAt: carried.at } : {}) }, leftover);
		if (this.waiting.length) this.syncQueues();
		return true;
	}

	/** steered mail the loop never took goes back to the mailbox (still undelivered there); queued prompts stay */
	private returnQueuedMail() {
		if (!this.mailQueued.length) return;
		this.mailQueued = [];
		this.syncQueues();
	}

	private signal(why: string) {
		if (!this.signals.includes(why)) this.signals.push(why);
	}

	private resetSignals() {
		this.signals = [];
		this.toolErrors.clear();
		this.checkFailures.clear();
		this.callCounts.clear();
		this.toolArgs.clear();
		this.editedThisTurn = false;
		this.touched.clear();
	}

	private touch(path: unknown) {
		if (typeof path !== "string" || !path || path === "/dev/null") return;
		const abs = isAbsolute(path) ? path : join(this.cwd, path);
		this.touched.add(abs.startsWith(`${this.cwd}/`) ? abs.slice(this.cwd.length + 1) : abs);
		this.editedThisTurn = true;
	}

	/** failure signals from one finished tool call: a repeated error, a check failing right after an edit */
	private watchSignals(id: string, name: string, result: any, isError: boolean) {
		const args = this.toolArgs.get(id) as Record<string, unknown> | undefined;
		this.toolArgs.delete(id);
		const command = typeof args?.command === "string" ? args.command : undefined;
		// a check has its own rule below (the same one failing twice); a failing exit is a tool error too, and counting it here would undo the reset
		const check = name === "shell" && command !== undefined && CHECK_COMMAND.test(command);
		if (isError && !check) {
			const text = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			const key = `${name}:${text.slice(0, 160)}`;
			const n = (this.toolErrors.get(key) ?? 0) + 1;
			this.toolErrors.set(key, n);
			if (n === 2) this.signal(`the same ${name} error twice`);
		}
		if (!isError && (name === "write" || name === "edit")) this.touch(args?.path);
		if (name === "run" && (result?.details?.nested ?? []).some((r: any) => r.ok && (r.helper === "fs.write" || r.helper === "fs.edit"))) this.editedThisTurn = true;
		if (name === "shell" && command && !isError) for (const f of shellWrites(command)) this.touch(f);
		if (check && this.editedThisTurn) {
			const code = result?.details?.exit_code;
			// a pipe hides the exit code (`bun test | tail` exits 0), so the output's own verdict counts too
			const out = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			if ((code !== 0 && code !== undefined) || CHECK_FAILED.test(out)) {
				// the red half of red-green is normal; the same check failing twice in one turn is not
				const n = (this.checkFailures.get(command) ?? 0) + 1;
				this.checkFailures.set(command, n);
				if (n === 2) this.signal(`the same check failed twice after an edit (${command.slice(0, 80)})`);
			} else this.checkFailures.delete(command);
		}
	}

	/**
	 * at the boundary, for the next turn only: one allowed rung higher when this turn showed failure signals, and back to
	 * the baseline when it showed none. the move is never stored, so the stored effort stays the session's own choice
	 */
	private maybeEscalate() {
		if (!this.opts.escalate) return;
		const from = this.effort;
		if (this.signals.length) {
			const next = this.opts.escalate(this.modelRef, from);
			if (!next) return;
			const reason = this.signals.join("; ");
			this.applyTurnEffort(next);
			this.escalationNote = `${from}→${next}: ${reason}`;
			this.emit("session.escalated", { from, to: next, reason });
		} else if (from !== this.baseEffort) {
			this.applyTurnEffort(this.baseEffort);
			this.emit("session.deescalated", { from, to: this.baseEffort, reason: "a turn without failure signals" });
		}
	}

	/** while parked, re-send the last request before the cache entry expires, and hang up once the provider has read it */
	private scheduleWarm() {
		this.cancelWarm();
		const long = this.cacheRetention() === "long";
		const w = this.opts.warm?.(long ? "1h" : "5m");
		if (!w?.enabled || !this.lastCall?.context) return this.dropWarmCopy();
		const ttl = long ? 3_600_000 : 300_000;
		// CMX2_WARM_DELAY_MS shortens the wait for tests; the default refreshes at 90% of the ttl
		const delay = Number(process.env.CMX2_WARM_DELAY_MS) || Math.max(1, Math.min(ttl * 0.9, ttl - 10_000));
		this.warmUntil = Date.now() + w.horizonMs;
		if (Date.now() + delay > this.warmUntil) return this.dropWarmCopy();
		this.warmTimer = setTimeout(() => void this.warmOnce(delay), delay);
	}

	/** warming has stopped: the copy of the last request's messages goes; the next real request makes a new one */
	private dropWarmCopy() {
		if (this.lastCall?.context) this.lastCall = { ...this.lastCall, context: undefined };
	}

	/** whether the session still holds a copy of its last request to warm with (tests read it) */
	get holdsWarmCopy(): boolean {
		return this.lastCall?.context !== undefined;
	}

	private cancelWarm() {
		if (this.warmTimer) clearTimeout(this.warmTimer);
		this.warmTimer = undefined;
	}

	/**
	 * a refresh is scheduled or on the wire, an idle summary is scheduled or on the wire, or a summary made ahead
	 * (prefire or its refresh) is on the wire; the residency cache keeps such a session loaded, so none of them is
	 * lost to an eviction or left running on a disposed session
	 */
	get warming(): boolean {
		return this.warmTimer !== undefined || this.warmBusy || this.idleTimer !== undefined || this.idleBusy || this.summaryOnWire || this.asides > 0;
	}

	/**
	 * warming, and only on timers: a refresh or idle summary is scheduled and nothing (refresh, summary, btw) is on the
	 * wire. disposing such a session cancels the timers and loses nothing in flight; the server may evict a root then
	 */
	get warmingOnTimers(): boolean {
		return (this.warmTimer !== undefined || this.idleTimer !== undefined) && !this.warmBusy && !this.idleBusy && !this.summaryOnWire && this.asides === 0;
	}

	/** a background summary has started and not landed */
	private get summaryOnWire(): boolean {
		return (this.prefire !== undefined && this.prefire.result === undefined) || this.refresh !== undefined;
	}

	private async warmOnce(delay: number) {
		this.warmTimer = undefined;
		const call = this.lastCall;
		if (this.disposed || this.state !== "idle") return;
		if (!call?.context || Date.now() > this.warmUntil) return this.dropWarmCopy();
		const t0 = performance.now();
		this.warmBusy = true;
		try {
			// the same request byte for byte (a smaller max_tokens changes thinking parameters, which the message
			// cache is keyed on); the prompt is processed, and the cache refreshed, before the provider's first event,
			// so the refresh hangs up there. on anthropic that is the raw message_start, which pi reads for usage
			// without passing anything on: the first event pi pushes is the first content block, which can come after
			// seconds of thinking, all of it billed as output. a request cut at message_start pays a few output tokens.
			// (anthropic's max_tokens: 0 pre-warm is no use here: vertex refuses it streamed, and unstreamed it wrote
			// the prefix again instead of reading the live entry)
			const { onPayload: _p, onResponse: _r, onProviderStreamEvent: _e, signal: _s, ...options } = call.options ?? {};
			const ctl = new AbortController();
			let started: Usage | undefined;
			const onProviderStreamEvent = (event: unknown) => {
				const ev = event as { type?: string; message?: { usage?: Record<string, any> } };
				if (ev?.type !== "message_start" || started) return;
				const mu = ev.message?.usage ?? {};
				const usage: Usage = {
					input: mu.input_tokens || 0,
					output: mu.output_tokens || 0,
					cacheRead: mu.cache_read_input_tokens || 0,
					cacheWrite: mu.cache_creation_input_tokens || 0,
					cacheWrite1h: mu.cache_creation?.ephemeral_1h_input_tokens || 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				calculateCost(call.model, usage);
				started = usage;
				ctl.abort();
			};
			// the same breakpoints the real request gets, so the refresh touches the entries the next turn reads
			const onPayload = (payload: unknown) => {
				const notes: GateNotes = { applied: [] };
				moveTrailingSystemBreakpoint(call.model.api, payload as Record<string, any>, notes);
				rollingBreakpoint(call.model.api, payload as Record<string, any>, notes);
				return payload;
			};
			const stream = (await streamFn(call.model, call.context, { ...options, cacheRetention: this.cacheRetention(), signal: ctl.signal, onPayload, onProviderStreamEvent })) as AsyncIterable<any>;
			let u: any;
			try {
				for await (const ev of stream) {
					// disposed mid-refresh (evicted or deleted): stop here, and arm nothing below
					if (this.disposed) {
						ctl.abort();
						return;
					}
					// after the hang-up the stream ends aborted or in an error; neither is a failed refresh
					if (started) break;
					if (ev.type === "error") throw new Error(ev.error?.errorMessage ?? "the provider returned an error");
					// providers that send no message_start: the first event with usage, then hang up
					const pu = ev.partial?.usage;
					if (pu && (pu.input || pu.cacheRead || pu.cacheWrite)) {
						u = pu;
						ctl.abort();
						break;
					}
				}
			} catch (e) {
				if (!started) throw e;
			}
			if (this.disposed) return;
			if (started) u = started;
			if (!u) throw new Error("the refresh ended before the provider reported usage");
			this.cacheUsed(call.model);
			this.warmed = true;
			this.emit("session.warmed", { cache_read: u.cacheRead ?? 0, cache_write: u.cacheWrite ?? 0, input: u.input ?? 0, output: u.output ?? 0, cost: u.cost?.total ?? 0, ms: Math.round(performance.now() - t0) });
		} catch (e) {
			if (this.disposed) return;
			this.emit("session.warning", { message: `cache warming stopped: ${e instanceof Error ? e.message : String(e)}` });
			// (a turn that started meanwhile holds its own request)
			if (this.state === "idle" && this.lastCall === call) this.dropWarmCopy();
			return;
		} finally {
			this.warmBusy = false;
		}
		if (this.disposed) return;
		if (this.state === "idle" && Date.now() + delay <= this.warmUntil) this.warmTimer = setTimeout(() => void this.warmOnce(delay), delay);
		else if (this.state === "idle" && this.lastCall === call) this.dropWarmCopy();
	}

	/** the cache's ttl in force, in ms */
	private ttlMs(): number {
		return this.cacheRetention() === "long" ? 3_600_000 : 300_000;
	}

	/** how long after the last cache use an idle summary goes: 90% of the ttl, as a warm refresh. CMX2_IDLE_SUMMARY_MS shortens it for tests */
	private idleSummaryDelay(): number {
		const ttl = this.ttlMs();
		return Number(process.env.CMX2_IDLE_SUMMARY_MS) || Math.max(1, Math.min(ttl * 0.9, ttl - 10_000));
	}

	/** the context is at or past the cold floor and auto compaction may run */
	private pastColdFloor(messages: AgentMessage[] = this.agent.state.messages): boolean {
		const s = this.opts.config.compaction;
		const floor = coldFloorOf(s, this.model.contextWindow);
		return s.auto && floor !== undefined && !this.suppressedNow() && contextUsed(messages) >= floor;
	}

	/**
	 * a turn settled at or past the cold floor: shortly before the cache expires, the summary is made from it
	 * (a cache read), so a return after the expiry compacts without paying for the whole context again. a
	 * session that never comes back pays for that summary only
	 */
	private scheduleIdleSummary() {
		this.cancelIdleSummary();
		if (this.disposed || !this.pastColdFloor()) return;
		// the ttl runs from the last request's start, not from the turn's end
		const since = this.lastCacheUseAt ? Date.now() - this.lastCacheUseAt : 0;
		this.idleTimer = setTimeout(() => this.idleSummary(), Math.max(1, this.idleSummaryDelay() - since));
	}

	private cancelIdleSummary() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private idleSummary() {
		this.idleTimer = undefined;
		if (this.disposed || this.state !== "idle" || !this.lastCacheUseAt) return;
		const delay = this.idleSummaryDelay();
		// a warm refresh still to come, or on the wire, moves the expiry: the summary waits for the last one
		if (this.warmTimer || this.warmBusy) {
			this.idleTimer = setTimeout(() => this.idleSummary(), delay);
			return;
		}
		const wait = this.lastCacheUseAt + delay - Date.now();
		if (wait > 1000) {
			this.idleTimer = setTimeout(() => this.idleSummary(), wait);
			return;
		}
		// the entry expired already (the machine slept through the timer): a summary now would pay for the whole
		// context, so it waits for the session to come back, and is made then only if it does
		if (Date.now() - this.lastCacheUseAt >= this.ttlMs() || this.lastCacheModel !== this.modelRef) return;
		const messages = this.agent.state.messages;
		if (!this.pastColdFloor(messages)) return;
		// a ready summary whose tail is still short is left as it is; startPrefire makes the first or the refresh
		const before = { prefire: this.prefire, refresh: this.refresh };
		this.startPrefire(messages, contextUsed(messages));
		const started = this.prefire !== before.prefire ? this.prefire : this.refresh !== before.refresh ? this.refresh : undefined;
		if (!started) return;
		this.idleBusy = true;
		void started.promise.finally(() => {
			this.idleBusy = false;
		});
	}


	// ---------- compaction ----------

	/** the context's size and the model's window, for clients (a10); `compactAt` is where auto compaction runs */
	get contextFill(): { used: number; limit: number; compactAt: number } {
		return { used: contextUsed(this.agent.state.messages), limit: this.model.contextWindow, compactAt: thresholdOf(this.opts.config.compaction, this.model.contextWindow) };
	}

	private cacheUsed(model: Model<Api>) {
		this.lastCacheUseAt = Date.now();
		this.lastCacheModel = `${model.provider}/${model.id}`;
	}

	/**
	 * the next request would rewrite the whole prompt cache: the entry outlived its ttl (with a grace for the
	 * provider's clock), or the model changed. a session that never used its cache is not cold; it has no prefire
	 */
	private cacheCold(): boolean {
		if (!this.lastCacheUseAt) return false;
		if (this.lastCacheModel !== this.modelRef) return true;
		const ttl = this.cacheRetention() === "long" ? 3_600_000 : 300_000;
		return Date.now() - this.lastCacheUseAt > ttl + 30_000;
	}

	private suppressedNow(): boolean {
		if (this.suppressed && this.suppressed.model !== this.modelRef) this.suppressed = undefined;
		return this.suppressed !== undefined;
	}

	/**
	 * before every request: images past the budget or the provider's limit leave the context, then a context
	 * past the threshold compacts, or the summary starts in the background as it nears. images go first so a
	 * summary request never carries more than the provider takes. under the threshold, a cold cache with a
	 * summary ready compacts too: the request rewrites the cache anyway, and the summary makes that rewrite small.
	 * at or past the cold floor (compaction.cold), a cold cache compacts whether a summary is ready or not; one
	 * asked for then skips the cache write, since the prefix it would write is about to be replaced
	 */
	private async beforeRequest(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[] | undefined> {
		const dropped = this.dropImages(messages, this.turnRequests === 0 ? "turn" : "budget");
		let out = dropped?.messages ?? messages;
		let changed = dropped !== undefined;
		const s = this.opts.config.compaction;
		if (s.auto) {
			// the last reply's usage still counts the dropped images; take them off at the flat estimate
			const used = Math.max(0, contextUsed(out) - (dropped?.tokens ?? 0));
			const limit = thresholdOf(s, this.model.contextWindow);
			const may = !this.suppressedNow() && Date.now() >= this.compactRetryAt;
			const floor = coldFloorOf(s, this.model.contextWindow);
			const expired = may && this.cacheCold();
			// past the floor the summary is worth asking for now: it reads the context once without caching it,
			// where the request would write all of it
			const pastFloor = expired && floor !== undefined && used >= floor && used < limit;
			// under it only with the ready summary: one asked for now would itself rewrite the cold cache
			const aheadOnly = !pastFloor && used < limit && expired && this.prefire?.result !== undefined;
			if ((used >= limit && may) || pastFloor || aheadOnly) {
				// a compaction drops what is over the keep line itself, while it rewrites the prompt anyway
				const next = await this.compactNow(out, "auto", used, signal, { aheadOnly, cold: pastFloor || aheadOnly, noCache: expired && floor !== undefined });
				if (next) {
					out = next;
					changed = true;
				}
			} else if (s.prefire !== false && used >= limit * s.prefire) this.startPrefire(out, used);
		}
		this.measure(out);
		return changed ? out : undefined;
	}

	/** the context's size as the next request will carry it, for the request log and a size refusal */
	private measure(messages: AgentMessage[]) {
		const images = inventory(messages, () => undefined);
		this.lastSize = { bytes: requestBytes(messages), images: images.length, imageBytes: images.reduce((n, i) => n + i.bytes, 0) };
	}

	/** the most bytes a request may carry: the provider's configured limit, else the catalog's (at most 20 MB through an endpoint that is not the provider's own), lowered by a refusal */
	private requestCap(): number {
		const o = this.opts.config.providers[this.model.provider];
		const catalog = (this.model as { inputLimits?: { maxRequestBytes?: number } }).inputLimits?.maxRequestBytes ?? GATEWAY_REQUEST_BYTES;
		const configured = o?.maxRequestBytes ?? (o?.baseUrl ? Math.min(catalog, GATEWAY_REQUEST_BYTES) : catalog);
		return Math.min(configured, this.learnedCap ?? Number.POSITIVE_INFINITY);
	}

	/**
	 * images past the budget, the provider's image count or its byte limit leave the context (images.ts): a
	 * transcript line names them, and the context gets copies with a marker where each was. `oversized` takes
	 * the images over the many-image edge, `unreadable` the images since the last reply. undefined when nothing
	 * goes; `scope` says, for `unreadable`, whether that was the images since the last reply or all of them
	 */
	private dropImages(messages: AgentMessage[], mode: Exclude<DropReason, "limit"> | "oversized"): { messages: AgentMessage[]; tokens: number; scope?: "unseen" | "all" } | undefined {
		const images = inventory(messages, (m) => this.seqOf.get(m as object));
		if (!images.length) return undefined;
		const s = this.opts.config.images;
		const catalogMax = (this.model as { inputLimits?: { images?: { maxPerRequest?: number } } }).inputLimits?.images?.maxPerRequest ?? DEFAULT_MAX_IMAGES;
		// documents ride the catalog's count where the api reads them whole; a learned count already saw them
		const docs = DOCUMENT_APIS.has(this.model.api) ? documentsIn(messages) : 0;
		const maxImages = Math.max(1, Math.min(catalogMax - docs, this.learnedMaxImages ?? Number.POSITIVE_INFINITY));
		const imageBytes = images.reduce((n, i) => n + i.bytes, 0);
		const cap = this.requestCap();
		const room = Math.max(0, Math.floor(cap * REQUEST_HEADROOM) - (requestBytes(messages) - imageBytes));
		const budget = s.budget === false ? Number.POSITIVE_INFINITY : s.budget;
		const dataOf = (i: { at: number; block: number }) => ((messages[i.at] as { content?: Array<{ data?: string }> }).content?.[i.block]?.data ?? "") as string;
		const plan =
			mode === "unreadable"
				? planUnreadable(images)
				: mode === "oversized"
					? planOversized(images, (i) => imageEdge(dataOf(i)))
					: planDrop(images, mode, {
							budget,
							// a drop for the limit leaves the same share of the room a budget drop leaves of the budget, so
							// the next image does not put the request straight back over it
							keepBytes: Math.min(budget, room) * s.keep,
							maxImages,
							highImages: s.budget === false ? maxImages : Math.floor(maxImages * COUNT_HIGH),
							keepImages: Math.floor(maxImages * COUNT_KEEP),
							room,
						});
		if (!plan) return undefined;
		const rec: DropRecord = { role: "drop", images: plan.drop.map((i) => [i.seq!, i.block]), reason: plan.reason, bytes: plan.bytes, count: plan.count, timestamp: Date.now() };
		const seq = this.transcript.append(rec);
		this.opts.onMessage?.(seq, rec as unknown as AgentMessage);
		const byAt = new Map<number, Map<number, DropReason>>();
		for (const i of plan.drop) {
			let blocks = byAt.get(i.at);
			if (!blocks) byAt.set(i.at, (blocks = new Map()));
			blocks.set(i.block, plan.reason);
		}
		const next = messages.map((m, at) => {
			const blocks = byAt.get(at);
			if (!blocks) return m;
			const copy = dropBlocks(m, blocks);
			this.seqOf.set(copy as object, this.seqOf.get(m as object)!);
			return copy;
		});
		this.agent.state.messages = next;
		this.emit("session.images_dropped", {
			reason: plan.reason,
			dropped: plan.drop.length,
			imagesBefore: plan.count[0],
			imagesAfter: plan.count[1],
			bytesBefore: plan.bytes[0],
			bytesAfter: plan.bytes[1],
			budget: s.budget === false ? null : s.budget,
			requestLimit: cap,
		});
		return { messages: next, tokens: plan.drop.length * 1600, ...("scope" in plan ? { scope: plan.scope as "unseen" | "all" } : {}) };
	}

	/** a settled turn near the threshold: the summary starts now, while the session is idle */
	private prefireAhead(messages: AgentMessage[]) {
		const s = this.opts.config.compaction;
		if (!s.auto || s.prefire === false) return;
		const used = contextUsed(messages);
		if (used >= thresholdOf(s, this.model.contextWindow) * s.prefire) this.startPrefire(messages, used);
	}

	/**
	 * the background summary: a first one near the threshold, then, once it is ready and the messages after it
	 * pass max(keep, 20k tokens), a refresh over the current messages. one summary request runs at a time, and
	 * the ready one stays usable until a refresh replaces it, so a compaction never waits on a refresh
	 */
	private startPrefire(messages: AgentMessage[], used: number) {
		if (this.disposed || this.compacting || this.suppressedNow()) return;
		const old = this.prefire;
		if (!old) {
			if (!this.prefireBlocked) this.prefire = this.summaryAhead(messages, used, false);
			return;
		}
		if (!old.result || this.refresh || this.refreshBlocked) return;
		const s = this.opts.config.compaction;
		const refreshAt = Math.max(s.keep * thresholdOf(s, this.model.contextWindow), 20_000);
		const tail = messages.slice(old.at).reduce((n, m) => n + estimateTokens(m), 0);
		if (tail > refreshAt) this.refresh = this.summaryAhead(messages, used, true);
	}

	private summaryAhead(messages: AgentMessage[], used: number, refresh: boolean): Prefire {
		const snapshot = messages.slice();
		const p: Prefire = { at: snapshot.length, last: snapshot[snapshot.length - 1]!, startedAt: Date.now(), promise: Promise.resolve(undefined) };
		const mark = refresh ? { refresh: true } : {};
		this.emit("compaction.prefire", { state: "started", tokens: used, ...mark });
		p.promise = this.summarize(snapshot).then(
			(r) => {
				p.result = r;
				if (!refresh) this.emit("compaction.prefire", { state: "ready", tokens: used, ms: r.ms, chars: r.text.length, ...usageOf(r) });
				else if (this.refresh === p) {
					// still current: nothing consumed or dropped the summary it refreshes since it started
					this.refresh = undefined;
					this.prefire = p;
					this.emit("compaction.prefire", { state: "ready", tokens: used, ms: r.ms, chars: r.text.length, refresh: true, ...usageOf(r) });
				} else this.emit("compaction.prefire", { state: "stale", tokens: used, ms: r.ms, chars: r.text.length, refresh: true, ...usageOf(r) });
				return r;
			},
			(e: unknown) => {
				const message = e instanceof Error ? e.message : String(e);
				if (refresh) {
					// the old summary stays; only refreshing stops until the next compaction
					if (this.refresh === p) {
						this.refresh = undefined;
						this.refreshBlocked = true;
					}
					this.emit("compaction.prefire", { state: "failed", tokens: used, message, refresh: true });
					return undefined;
				}
				if (this.prefire === p) this.prefire = undefined;
				this.prefireBlocked = true;
				this.emit("compaction.prefire", { state: "failed", tokens: used, message });
				return undefined;
			},
		);
		return p;
	}

	/**
	 * the summary request: the session's own request (system prompt, tools, history, all as the next step
	 * would send them) with the instruction as the last user message, so the provider reads the prefix from
	 * cache. models that take effort per message answer it at low effort without touching the cached prefix.
	 * with `noCache` (the cache is cold and the context is about to be compacted) it carries no cache marks:
	 * nothing is read, nothing written, and it does not count as cache use.
	 */
	private async summaryRequest(messages: AgentMessage[], clearAll: boolean, noCache = false): Promise<Summary> {
		const model = this.model;
		const source = clearAll ? messages.map((m) => ((m as { role?: string }).role === "toolResult" && estimateTokens(m) > 500 ? clearedResult(m) : m)) : messages;
		const llm = toLlm(source, DOCUMENT_APIS.has(model.api) ? this.documents : undefined).filter((m: any) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult");
		const context = normalizeContext({ messages: [...(llm as never[]), { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }], timestamp: Date.now() }] } as never);
		const { onPayload: _p, onResponse: _r, onProviderStreamEvent: _e, signal: _s, ...base } = (this.lastCall?.options ?? {}) as Record<string, unknown>;
		const perMessageEffort = (model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort === true;
		const onPayload = (payload: unknown) => {
			const notes: GateNotes = { applied: [] };
			if (noCache) {
				this.putDocuments(model.api, payload as Record<string, any>, notes);
				stripCacheMarks(payload as Record<string, any>);
				return payload;
			}
			this.cacheUsed(model);
			this.putDocuments(model.api, payload as Record<string, any>, notes);
			moveTrailingSystemBreakpoint(model.api, payload as Record<string, any>, notes);
			rollingBreakpoint(model.api, payload as Record<string, any>, notes);
			return payload;
		};
		const t0 = performance.now();
		let ttft: number | null = null;
		const stream = await withRetry(
			() =>
				streamFn(model, context, {
					...base,
					sessionId: this.id,
					apiKey: (base.apiKey as string | undefined) ?? resolveApiKey(this.opts.config, model.provider),
					reasoning: perMessageEffort ? "low" : ((base.reasoning as never) ?? (this.effort as never)),
					cacheRetention: noCache ? "none" : this.cacheRetention(),
					onPayload,
				} as never),
			{ ...(this.opts.retry ? { policy: this.opts.retry } : {}) },
		);
		for await (const ev of stream as AsyncIterable<any>) if (ttft === null && (ev.type === "text_delta" || ev.type === "thinking_delta")) ttft = performance.now() - t0;
		const m = (await (stream as any).result()) as any;
		if (m.stopReason === "error" || m.stopReason === "aborted") {
			const t = classifyProviderError({ provider: m.provider, model: m.model, errorMessage: m.errorMessage, contextWindow: model.contextWindow, message: m });
			throw new SummaryError(t.kind === "context_overflow" ? "too_large" : "transient", t.message);
		}
		const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
		const u = m.usage ?? {};
		return { text, ms: Math.round(performance.now() - t0), ttftMs: ttft === null ? null : Math.round(ttft), usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 } };
	}

	/** a summary that passes the sanity checks, in at most two tries; a context too long even for that is tried once more with tool output cleared */
	private async summarize(messages: AgentMessage[], clearAll = false, noCache = false): Promise<Summary> {
		const head = messages.filter((m: any) => m.role !== "system").length;
		let why: string | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			let r: Summary;
			try {
				r = await this.summaryRequest(messages, clearAll, noCache);
			} catch (e) {
				if (e instanceof SummaryError && e.reason === "too_large" && !clearAll) {
					clearAll = true;
					continue;
				}
				throw e;
			}
			why = degenerate(r.text, head);
			if (!why) return clearAll ? { ...r, cleared: true } : r;
		}
		throw new SummaryError(why ? "degenerate" : "too_large", why ?? "the context is too long to summarise even with tool output cleared");
	}

	/**
	 * a btw: a side question answered from this session's context, never added to it. the request is the
	 * session's own, so the provider reads it from cache: the same model, options (effort, max tokens, ttl),
	 * system prompt and tools, and the same messages. mid-turn those are the messages of the request already
	 * on the wire; otherwise the context the next request would carry. one user message holding the question
	 * goes after them, with the session's breakpoints kept where they were (asideBreakpoint). the answer is
	 * capped by length and time here, not through max_tokens, which the message cache is keyed on. a tool call
	 * is not run: it gets an error result and one more step, then whatever text there is stands.
	 */
	async aside(question: string, opts: { signal?: AbortSignal; onDelta?: (delta: string) => void; maxChars?: number; timeoutMs?: number } = {}): Promise<AsideResult> {
		const maxChars = opts.maxChars ?? BTW_MAX_CHARS;
		const midTurn = this.state === "busy" && this.turnRequests > 0 && this.lastCall?.context !== undefined;
		const call = this.lastCall;
		const model = midTurn ? call!.model : this.model;
		let prefix: any[];
		if (midTurn) prefix = [...call!.context.messages];
		else {
			// a turn that has not sent its first request yet: its messages so far, without a reply still streaming
			const own = this.agent.state.messages.filter((m: any, i, all) => !(i === all.length - 1 && m.role === "assistant" && !m.stopReason));
			prefix = normalizeContext({ messages: toLlm(own, DOCUMENT_APIS.has(model.api) ? this.documents : undefined).filter((m: any) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as never }).messages as any[];
		}
		const marker = `${BTW_FRAMING}\n\n${question}`;
		const ask = midTurn ? this.lastAsk : undefined;
		const { onPayload: _p, onResponse: _r, onProviderStreamEvent: _e, signal: _s, ...base } = (call?.options ?? {}) as Record<string, unknown>;
		const options = {
			...(call?.options ? {} : { reasoning: this.agent.state.thinkingLevel === "off" ? undefined : this.agent.state.thinkingLevel, transport: "auto" }),
			...base,
			sessionId: this.id,
			apiKey: (base.apiKey as string | undefined) ?? resolveApiKey(this.opts.config, model.provider),
			cacheRetention: midTurn ? (this.requestRetention ?? this.cacheRetention()) : this.cacheRetention(),
		};
		const ctl = new AbortController();
		let why: string | undefined;
		const stop = (reason: string) => {
			why ??= reason;
			ctl.abort();
		};
		const onAbort = () => stop("stopped");
		if (opts.signal?.aborted) onAbort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => stop("timeout"), opts.timeoutMs ?? BTW_TIMEOUT_MS);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let text = "";
		let capped = false;
		let toolCalls = 0;
		this.asides++;
		try {
			let messages: any[] = [...prefix, { role: "user", content: [{ type: "text", text: marker }], timestamp: Date.now() }];
			for (let step = 0; step < 2; step++) {
				const stepAsk: RequestAsk | undefined = step === 0 ? ask : ask ? { ...ask, toolChoice: undefined } : undefined;
				const onPayload = (payload: unknown) => {
					const p = payload as Record<string, any>;
					const notes: GateNotes = { applied: [] };
					this.cacheUsed(model);
					if (stepAsk) applyAsk(model.api, model.id, p, stepAsk, notes);
					this.putDocuments(model.api, p, notes);
					// the session's own gates first, as its request had them; then nothing from the question on is marked,
					// and a mark that lands on a turn-context system message moves to the user message before it, as the session's did
					moveTrailingSystemBreakpoint(model.api, p, notes);
					rollingBreakpoint(model.api, p, notes);
					asideBreakpoint(model.api, p, marker, notes);
					moveTrailingSystemBreakpoint(model.api, p, notes);
					const captureDir = process.env.CMX2_CAPTURE_DIR;
					if (captureDir) {
						mkdirSync(captureDir, { recursive: true });
						writeFileSync(join(captureDir, `${this.id}-${BOOT}-btw-${Date.now()}-${step}.json`), JSON.stringify(p, null, 1));
					}
					return p;
				};
				const sep = step > 0 && text ? "\n\n" : "";
				let stepText = "";
				const stream = await withRetry(() => streamFn(model, { messages } as never, { ...options, signal: ctl.signal, onPayload } as never), {
					signal: ctl.signal,
					...(this.opts.retry ? { policy: this.opts.retry } : {}),
				});
				for await (const ev of stream as AsyncIterable<any>) {
					if (ev.type !== "text_delta" || capped || typeof ev.delta !== "string") continue;
					let d = (stepText ? "" : sep) + ev.delta;
					const room = maxChars - text.length;
					if (d.length >= room) {
						d = d.slice(0, Math.max(0, room));
						capped = true;
					}
					if (d) {
						text += d;
						stepText += d;
						opts.onDelta?.(d);
					}
					if (capped) stop("capped");
				}
				const m = (await (stream as any).result()) as any;
				const u = m.usage ?? {};
				usage.input += u.input ?? 0;
				usage.output += u.output ?? 0;
				usage.cacheRead += u.cacheRead ?? 0;
				usage.cacheWrite += u.cacheWrite ?? 0;
				usage.cost += u.cost?.total ?? 0;
				if (m.stopReason === "aborted" || ctl.signal.aborted) {
					if (why === "capped") break;
					throw new AsideError(why === "timeout" ? `no answer within ${Math.round((opts.timeoutMs ?? BTW_TIMEOUT_MS) / 1000)} s` : "stopped before it answered", usage, text);
				}
				if (m.stopReason === "error") {
					const t = classifyProviderError({ provider: m.provider, model: m.model, errorMessage: m.errorMessage, contextWindow: model.contextWindow, message: m });
					throw new AsideError(t.message, usage, text);
				}
				const calls = (m.content ?? []).filter((b: any) => b.type === "toolCall");
				if (!calls.length || step > 0) {
					toolCalls += calls.length;
					break;
				}
				toolCalls += calls.length;
				// the call is not run: an error result, and one more step to answer in words
				messages = [
					...messages,
					m,
					...calls.map((c: any) => ({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: BTW_NO_TOOLS }], isError: true, timestamp: Date.now() })),
				];
			}
		} catch (e) {
			if (e instanceof AsideError) throw e;
			throw new AsideError(why === "timeout" ? `no answer within ${Math.round((opts.timeoutMs ?? BTW_TIMEOUT_MS) / 1000)} s` : ctl.signal.aborted ? "stopped before it answered" : e instanceof Error ? e.message : String(e), usage, text);
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			this.asides--;
		}
		if (!text.trim()) throw new AsideError(toolCalls ? "the model asked for tools instead of answering" : "the model gave no answer", usage, text);
		return { text, usage, model: { providerID: model.provider, modelID: model.id }, capped, midTurn };
	}

	/**
	 * replaces the context with the summary, the post-compaction state block and the recent messages. a
	 * summary made ahead (prefire) is used when it still describes the context's head, so the turn does not
	 * wait on the model; otherwise the summary is asked for now. the transcript gets one more line. with
	 * `aheadOnly` (a cold cache under the floor) only the ready summary is used: when it no longer fits, nothing
	 * compacts. `cold` marks the record; `noCache` asks for a summary made now without writing the cache.
	 */
	private compactNow(messages: AgentMessage[], trigger: CompactionRecord["trigger"], used: number, signal?: AbortSignal, opts: CompactOpts = {}): Promise<AgentMessage[] | undefined> {
		if (this.compacting) return this.compacting;
		const run = this.runCompaction(messages, trigger, used, signal, opts).finally(() => {
			this.compacting = undefined;
		});
		this.compacting = run;
		return run;
	}

	private async runCompaction(messages: AgentMessage[], trigger: CompactionRecord["trigger"], used: number, _signal?: AbortSignal, opts: CompactOpts = {}): Promise<AgentMessage[] | undefined> {
		const t0 = performance.now();
		const s = this.opts.config.compaction;
		const limit = thresholdOf(s, this.model.contextWindow);
		// the kept tail only holds messages written after the last compaction line; the ones before it stay behind it
		const c = messages.findLastIndex((m: any) => m.role === "compaction");
		const cSeq = c >= 0 ? (this.seqOf.get(messages[c] as object) ?? 0) : 0;
		let floor = c >= 0 ? c + 1 : 1;
		while (floor < messages.length && (this.seqOf.get(messages[floor] as object) ?? 0) <= cSeq) floor++;

		let summary: Summary | undefined;
		let tailIdx = messages.length;
		let ahead = false;
		let waitedMs = 0;
		const p = this.prefire;
		this.prefire = undefined;
		// a refresh in flight describes this context; once it is compacted (or the attempt drops p) it describes nothing
		this.refresh = undefined;
		const cold = opts.cold === true || opts.aheadOnly === true;
		if (p && trigger !== "overflow" && p.at >= floor && p.at <= messages.length && this.sameMessage(messages[p.at - 1], p.last)) {
			if (!p.result) {
				const w0 = performance.now();
				await p.promise;
				waitedMs = Math.round(performance.now() - w0);
			}
			const tailTokens = messages.slice(p.at).reduce((n, m) => n + estimateTokens(m), 0);
			if (p.result && tailTokens <= limit / 2) {
				summary = p.result;
				ahead = true;
				tailIdx = tailStart(messages.slice(0, messages.length), p.at, Number.POSITIVE_INFINITY);
			} else if (p.result) this.emit("compaction.prefire", { state: "stale", tokens: used, tail: tailTokens });
		} else if (p) this.emit("compaction.prefire", { state: "stale", tokens: used });
		if (!summary && opts.aheadOnly) return undefined;
		if (!summary) {
			tailIdx = tailStart(messages, floor, s.keep * limit);
			try {
				summary = await this.summarize(messages, trigger === "overflow", opts.noCache === true);
			} catch (e) {
				const err = e instanceof SummaryError ? e : new SummaryError("transient", e instanceof Error ? e.message : String(e));
				const sticky = err.reason !== "transient" && trigger !== "manual";
				if (err.reason !== "transient") this.suppressed = { model: this.modelRef, reason: err.reason };
				else this.compactRetryAt = Date.now() + 60_000;
				this.emit("compaction.failed", { trigger, reason: err.reason, message: err.message, sticky, tokens: used });
				if (trigger === "manual") throw err;
				return undefined;
			}
		}

		const tail = messages.slice(tailIdx);
		const cleared = toClear(tail, s.protect);
		const clearedSet = new Set(cleared);
		const rec: CompactionRecord = {
			role: "compaction",
			summary: summary.text,
			state: this.stateBlock(),
			tailFrom: tail.length ? (this.seqOf.get(tail[0] as object) ?? this.transcript.count + 1) : this.transcript.count + 1,
			cleared,
			trigger,
			tokensBefore: used,
			usage: summary.usage,
			model: this.modelRef,
			summaryMs: summary.ms,
			prefire: ahead,
			...(cold ? { cold: true as const } : {}),
			timestamp: Date.now(),
		};
		const seq = this.transcript.append(rec);
		this.seqOf.set(rec, seq);
		this.opts.onMessage?.(seq, rec as unknown as AgentMessage);
		const kept = tail.map((m) => {
			const r = m as { role?: string; toolCallId?: string };
			if (r.role !== "toolResult" || !clearedSet.has(r.toolCallId!)) return m;
			const copy = clearedResult(m);
			this.seqOf.set(copy, this.seqOf.get(m as object) ?? 0);
			return copy;
		});
		const next = [messages[0]!, ...messages.slice(1, tailIdx).flatMap((m) => toolCarrier(m) ?? []), rec as unknown as AgentMessage, ...kept];
		this.agent.state.messages = next;
		this.suppressed = undefined;
		this.prefireBlocked = false;
		this.refreshBlocked = false;
		const after = next.reduce((n, m) => n + estimateTokens(m), 0);
		const blockedMs = Math.round(performance.now() - t0);
		this.emit("session.compacted", {
			trigger,
			tokensBefore: used,
			tokensAfter: after,
			durationMs: blockedMs,
			waitedMs,
			summaryMs: summary.ms,
			summaryChars: summary.text.length,
			prefire: ahead,
			cold,
			tailFrom: rec.tailFrom,
			cleared: cleared.length,
			...usageOf(summary),
		});
		// the prompt was rewritten from the summary on, so images over the keep line go now at no extra cost
		return this.dropImages(next, "compaction")?.messages ?? next;
	}

	/** what the model needs to pick up after a compaction that no summary should be trusted with: the runtime's own state */
	private stateBlock(): string {
		const date = localDate();
		this.lastDate = date;
		const lines = [`turn context: cwd: ${this.cwd}, host: ${hostname().split(".")[0]}, date: ${date}`];
		const ledger = this.opts.ledger?.() ?? "no processes running";
		lines.push(ledger);
		this.lastLedger = ledger;
		for (const [key, text] of this.opts.appendix?.() ?? []) {
			if (text === undefined) continue;
			lines.push(text);
			this.lastAppendix.set(key, text);
		}
		const roster = this.opts.roster?.();
		if (roster) lines.push(roster);
		const notes = readNotes(this.notesFile).trim();
		lines.push(notes ? `your notes (the notes tool keeps them):\n${notes}` : "your notes file is empty; the notes tool keeps what should survive the next compaction.");
		lines.push("recall searches everything this session said, ran and read, including what this summary replaced and tool output cleared from the context.");
		return lines.join("\n\n");
	}

	/** compacts now, whatever the threshold (a client's compact verb); a failure is thrown. false when there is nothing to compact */
	async compact(): Promise<boolean> {
		if (this.state === "busy") throw new BusyError(this.id);
		this.suppressed = undefined;
		const messages = this.agent.state.messages;
		if (!messages.some((m: any) => m.role === "assistant")) return false;
		return (await this.compactNow(messages, "manual", contextUsed(messages))) !== undefined;
	}

	/** the provider refused the context as too long: compact it and go on with the task in a new turn */
	private async recoverOverflow() {
		if (this.disposed || this.state === "busy" || this.suppressedNow() || !this.opts.config.compaction.auto) return;
		const messages = this.agent.state.messages;
		const next = await this.compactNow(messages, "overflow", contextUsed(messages)).catch(() => undefined);
		if (!next || this.disposed || (this.state as SessionState) === "busy") return;
		const go: AgentMessage = { role: "user", content: [{ type: "text", text: "the context overflowed and was compacted. carry on with the task from where it stopped.", synthetic: true }], timestamp: Date.now() } as unknown as AgentMessage;
		try {
			await this.startTurn([go], { context: true });
		} catch (e) {
			this.emit("session.warning", { message: `the turn after compaction did not start: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	/**
	 * what a refusal teaches, learned when the turn ends so nothing goes out at the old limit: a byte limit under
	 * the refused request's size, or an image count under its count. one image too heavy, too large for a
	 * many-image request or unreadable teaches nothing here; the drop that follows takes it
	 */
	private learnLimit(kind: MediaRefusal) {
		if (kind === "bytes" && this.lastSize.bytes) this.learnedCap = Math.min(this.learnedCap ?? Number.POSITIVE_INFINITY, Math.floor(this.lastSize.bytes * LEARNED_CAP_SHARE));
		if (kind === "count" && this.lastSize.images) this.learnedMaxImages = Math.min(this.learnedMaxImages ?? Number.POSITIVE_INFINITY, Math.max(1, Math.floor(this.lastSize.images * LEARNED_CAP_SHARE)));
	}

	/**
	 * the provider refused a request for its media: for its size, every image but the newest may leave; for an
	 * image over the many-image edge, the images over it (and only when none is found, a 20-image count); for an
	 * image it could not read, the images since its last reply. then the task goes on in a new turn. a context
	 * with no image to drop compacts instead. capped per prompt, so a refusal the drops cannot fix stops with a
	 * warning rather than looping
	 */
	private async recoverMedia(kind: MediaRefusal, errorMessage?: string) {
		if (this.disposed || this.state === "busy") return;
		if (++this.sizeRecoveries > MAX_SIZE_RECOVERIES) {
			this.emit("session.warning", { message: "the provider still refuses the request after images were dropped; compact the session or start a new one" });
			return;
		}
		const messages = this.agent.state.messages;
		const manyImage = kind === "image" && /many-image/i.test(errorMessage ?? "");
		let dropped = manyImage ? this.dropImages(messages, "oversized") : undefined;
		if (!dropped) {
			if (manyImage) this.learnedMaxImages = Math.min(this.learnedMaxImages ?? Number.POSITIVE_INFINITY, MANY_IMAGES);
			dropped = this.dropImages(messages, kind === "unreadable" ? "unreadable" : "rejected");
		}
		if (!dropped) return this.recoverOverflow();
		const text =
			kind === "unreadable"
				? `the provider could not read an image in the last request, so ${dropped.scope === "all" ? "every image" : "the images since your last reply"} left the context. carry on with the task from where it stopped.`
				: kind === "bytes"
					? "the last request was over the provider's size limit, so older images left the context. carry on with the task from where it stopped."
					: "the last request was over the provider's limits for images, so images left the context. carry on with the task from where it stopped.";
		const go: AgentMessage = { role: "user", content: [{ type: "text", text, synthetic: true }], timestamp: Date.now() } as unknown as AgentMessage;
		try {
			await this.startTurn([go], { context: true });
		} catch (e) {
			this.emit("session.warning", { message: `the turn after dropping images did not start: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	/** the same transcript message, or a copy of it (a drop's or a compaction's) */
	private sameMessage(a: AgentMessage | undefined, b: AgentMessage): boolean {
		if (a === b) return true;
		const s = a ? this.seqOf.get(a as object) : undefined;
		return s !== undefined && s === this.seqOf.get(b as object);
	}

	/** the context a transcript holds, with every message in it (copies included) mapped to its transcript position */
	private adopt(all: AgentMessage[]): AgentMessage[] {
		all.forEach((m, i) => this.seqOf.set(m as object, i + 1));
		return contextWithSeq(all).map((x) => {
			this.seqOf.set(x.m as object, x.seq);
			return x.m;
		});
	}

	/**
	 * a revert made permanent: messages from transcript position `from` on leave the context (they stay in
	 * the transcript and the store, marked). the context is rebuilt from the transcript.
	 */
	revert(from: number): void {
		if (this.state === "busy") throw new BusyError(this.id);
		const rec: RevertRecord = { role: "revert", from, timestamp: Date.now() };
		const seq = this.transcript.append(rec);
		this.opts.onMessage?.(seq, rec as unknown as AgentMessage);
		const t = this.transcript.load();
		this.agent.state.messages = this.adopt(t.messages);
		// the loaded tools are what the remaining context declares, as on a resume: one loaded in the reverted
		// range is no longer loaded, and the next turn declares what changed
		const hot = new Set(this.hot.map((x) => x.name));
		this.loaded = new Set(getCurrentTools(this.agent.state.messages as never).map((d) => d.name).filter((n) => !hot.has(n)));
		this.prefire = undefined;
		this.prefireBlocked = false;
		this.refresh = undefined;
		this.refreshBlocked = false;
		this.lastAssistantSeq = t.messages.findLastIndex((m: any, i: number) => m.role === "assistant" && i + 1 < from) + 1;
	}

	/** the store's search over the session's history, each hit marked with where the model stands with it */
	private async recall(query: string, limit: number): Promise<{ hits: RecallHit[]; matches: number }> {
		// what the model cannot see any more comes first: more candidates are read, then ranked by that
		const wide = Math.min(80, limit * 4);
		const found = this.opts.recall ? await this.opts.recall(query, wide) : this.recallTranscript(query, wide);
		const inContext = new Set<number>();
		let cleared = new Set<string>();
		for (const m of this.agent.state.messages) {
			const seq = this.seqOf.get(m as object);
			if (seq) inContext.add(seq);
			if ((m as any).role === "compaction") cleared = new Set((m as unknown as CompactionRecord).cleared);
		}
		const rank = (h: RecallHit) => (h.note?.startsWith("[recovered") ? 0 : h.note ? 1 : 2);
		for (const h of found.hits) {
			if (h.callID && cleared.has(h.callID) && h.kind === "tool output") h.note = "[recovered from tool output cleared from your context]";
			else if (!inContext.has(h.seq)) h.note = "[compacted away: not in your context]";
		}
		const hits = found.hits.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h).slice(0, limit);
		return { hits, matches: found.matches };
	}

	/** recall without a store: every term, case-insensitive, over the transcript file */
	private recallTranscript(query: string, limit: number): { hits: RecallHit[]; matches: number } {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits: RecallHit[] = [];
		const all = new Transcript(this.transcript.path).load().messages;
		all.forEach((m: any, i: number) => {
			const texts: Array<[string, string]> = [];
			if (typeof m.content === "string") texts.push(["text", m.content]);
			else if (Array.isArray(m.content)) for (const b of m.content) if (typeof b?.text === "string") texts.push([m.role === "toolResult" ? "tool output" : "text", b.text]);
			if (m.role === "compaction") texts.push(["summary", m.summary]);
			if (m.role === "toolResult" && m.toolName === "recall") return;
			for (const [kind, t] of texts) {
				const lower = t.toLowerCase();
				if (terms.every((x) => lower.includes(x))) hits.push({ messageID: String(i + 1), seq: i + 1, role: m.role, kind, at: m.timestamp ?? 0, text: t, ...(m.toolCallId ? { callID: m.toolCallId, tool: m.toolName } : {}) });
			}
		});
		return { hits: hits.reverse().slice(0, limit), matches: hits.length };
	}

	/** promoted at the next tool boundary of the running turn; starts a turn when idle */
	async steer(content: string | UserBlock[], opts: { id?: string; clientID?: string; agent?: string; effort?: Effort; btw?: string } = {}): Promise<"steered" | "started"> {
		if (this.state !== "busy") {
			void this.prompt(content, opts);
			return "started";
		}
		this.steerPending = true;
		// the running turn keeps its model; the effort a steer asked for is set when the steer lands, and applies from the next turn, as the dial does
		const m = this.userMessage(content, { ...opts, steer: true });
		if (opts.effort) this.choiceAt.set(m, ++this.effortClock);
		this.waiting.push(m);
		this.steered.add(m as object);
		this.agent.steer(m);
		this.emit("session.steered", { text: excerpt(content, 400), ...(opts.id ? { messageID: opts.id } : {}), ...(opts.clientID ? { clientID: opts.clientID } : {}) });
		this.emit("session.status", { status: { type: "busy", queued: this.waiting.length } });
		return "steered";
	}

	/** waits for the running turn to finish; starts a turn when idle */
	async queue(content: string | UserBlock[], opts: { id?: string; clientID?: string; agent?: string; model?: string; effort?: Effort } = {}): Promise<"queued" | "started"> {
		if (this.state !== "busy") {
			void this.prompt(content, opts);
			return "started";
		}
		const m = this.userMessage(content, opts);
		if (opts.effort) this.choiceAt.set(m, ++this.effortClock);
		this.waiting.push(m);
		// a prompt that asked for another model or effort waits for a turn of its own (see needsTurn), and so does everything behind it
		if (this.held.size || this.needsTurn(m)) this.held.add(m);
		else this.agent.followUp(m);
		this.emit("session.queued", { text: excerpt(content, 400), ...(opts.id ? { messageID: opts.id } : {}), ...(opts.clientID ? { clientID: opts.clientID } : {}) });
		this.emit("session.status", { status: { type: "busy", queued: this.waiting.length } });
		return "queued";
	}

	/** takes back a steer or queued prompt the model has not seen yet; false when it already went out */
	unqueue(id: string): boolean {
		const target = this.waiting.find((w: any) => w.id === id);
		if (!target) return false;
		this.waiting = this.waiting.filter((w) => w !== target);
		// pi's queues have no remove: the message leaves them where pi keeps them (the steers that are not prompts stay)
		const queues = this.agent as unknown as { steeringQueue: { messages: AgentMessage[] }; followUpQueue: { messages: AgentMessage[] } };
		queues.steeringQueue.messages = queues.steeringQueue.messages.filter((x) => x !== target);
		queues.followUpQueue.messages = queues.followUpQueue.messages.filter((x) => x !== target);
		// what the removed prompt held back may not need to wait any more
		if (this.held.delete(target)) {
			let gated = false;
			for (const w of [...this.held]) {
				if (gated || this.needsTurn(w)) gated = true;
				else {
					this.held.delete(w);
					this.agent.followUp(w);
				}
			}
		}
		this.emit("session.status", { status: this.state === "busy" ? { type: "busy", queued: this.waiting.length } : { type: "idle" } });
		return true;
	}

	private steered = new WeakSet<object>();
	private isSteer(m: AgentMessage): boolean {
		return this.steered.has(m as object);
	}

	/**
	 * the runtime's word to the session (a job exited, a port opened): lands at the next boundary of a
	 * running turn, or starts a turn when the session is idle, so a parked session wakes on it.
	 */
	notice(source: string, text: string): "steered" | "started" {
		const m: NoticeRecord = { role: "notice", source, text, timestamp: Date.now() };
		if (this.state === "busy") {
			this.steerPending = true;
			this.agent.steer(m as unknown as AgentMessage);
			return "steered";
		}
		void this.startTurn([m as unknown as AgentMessage], { context: true });
		return "started";
	}

	/** a `!` line: recorded for the model's next request without starting a turn */
	recordShell(rec: Omit<ShellRecord, "role" | "timestamp">): void {
		const m = { role: "shell", ...rec, timestamp: Date.now() } as unknown as AgentMessage;
		if (this.state === "busy") {
			this.agent.steer(m);
			return;
		}
		this.agent.state.messages.push(m);
		const seq = this.transcript.append(m);
		this.seqOf.set(m, seq);
		this.opts.onMessage?.(seq, m);
	}

	/**
	 * runs what abort left in the queues (boxbox's loop verb) and what a finished turn held back for a turn of
	 * its own; answers how many messages it started (0 when nothing waited or a turn is running)
	 */
	async drainQueue(): Promise<number> {
		if (this.state === "busy" || !this.hasWaiting()) return 0;
		// every prompt still waiting, in the order admitted (pi's peek shows only the next one in one-at-a-time mode),
		// up to one that needs another model or effort: that one goes first, alone, with its choice applied
		if (!this.waiting.length) {
			const batch = this.agent.peekQueuedMessages();
			if (!batch.length) return 0;
			this.agent.clearAllQueues();
			void this.begin(batch, { context: true }, batch);
			return batch.length;
		}
		// the model is resolved before anything leaves the queue (the prompts stay readable and unsendable meanwhile);
		// from the check that no turn began to the start there is no await, so nothing can slip in between
		let plan = this.planBatch(true);
		let resolved: { ref: string; model: Model<Api> } | undefined;
		const failed = new Set<string>();
		for (;;) {
			const ref = plan.pick?.model;
			if (!ref || ref === this.modelRef || resolved?.ref === ref || failed.has(ref)) break;
			try {
				resolved = { ref, model: await resolveModel(this.opts.config, ref) };
			} catch (e) {
				failed.add(ref);
				this.emit("session.warning", { message: `the queued prompt asked for ${ref}, which could not be set (${e instanceof Error ? e.message : String(e)}); it runs on ${this.modelRef}` });
			}
			// a turn began while the model resolved: what waits stays queued, and runs after it
			if ((this.state as string) === "busy") return 0;
			plan = this.planBatch(true);
			if (!plan.batch.length) return 0;
		}
		if (resolved && plan.pick?.model === resolved.ref && resolved.ref !== this.modelRef) this.adoptModel(resolved.model);
		const { batch } = this.takeBatch(true);
		this.agent.clearAllQueues();
		for (const m of batch) {
			// the agent the user picked for a prompt is the agent that answers once it lands
			if ((m as { agent?: string }).agent) this.agentName = (m as { agent?: string }).agent;
		}
		const carried = this.batchEffort(batch);
		void this.begin(batch, { context: true, ...(carried ? { effort: carried.effort, effortAt: carried.at } : {}) }, batch);
		if (this.waiting.length) this.syncQueues();
		return batch.length;
	}

	/** switches the model for the next turn (the picker); the recorded prefix stays the session's first */
	async setModel(ref: string): Promise<boolean> {
		if (ref === this.modelRef) return false;
		if (this.state === "busy") throw new BusyError(this.id);
		this.adoptModel(await resolveModel(this.opts.config, ref));
		return true;
	}

	/** the session's model, from the next request on (no await: callers that must not be interleaved use it after resolving) */
	private adoptModel(model: Model<Api>) {
		// a byte limit learned from one endpoint's refusal says nothing about another's, an image count nothing about another model's
		if (model.provider !== this.model.provider) this.learnedCap = undefined;
		this.learnedMaxImages = undefined;
		this.model = model;
		this.agent.state.model = model;
		this.emit("session.model", { model: this.modelRef });
	}

	async abort() {
		if (this.state === "busy") this.aborting = true;
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	async idle() {
		await this.agent.waitForIdle();
	}

	/**
	 * an evicted session leaves its ready summary and its last cache use behind, so a reload can still compact
	 * from that summary when its cache went cold (compaction.cold)
	 */
	private leaveBehind() {
		if (!this.lastCacheUseAt || !this.agent) return;
		const p = this.prefire?.result ? this.prefire : undefined;
		const lastSeq = p ? this.seqOf.get(p.last as object) : undefined;
		leftBehind.delete(this.id);
		leftBehind.set(this.id, { at: this.lastCacheUseAt, model: this.lastCacheModel, ...(p && lastSeq !== undefined ? { summary: { at: p.at, lastSeq, result: p.result! } } : {}) });
		for (const id of leftBehind.keys()) {
			if (leftBehind.size <= LEFT_BEHIND_MAX) break;
			leftBehind.delete(id);
		}
	}

	/**
	 * on a reload, when the cache was last used and the summary made ahead: what the evicted session left, else
	 * the last reply's time and model from the transcript. off with compaction.cold false, as before it existed
	 */
	private pickUp(messages: AgentMessage[]) {
		const left = leftBehind.get(this.id);
		leftBehind.delete(this.id);
		if (this.opts.config.compaction.cold === false) return;
		if (left) {
			this.lastCacheUseAt = left.at;
			this.lastCacheModel = left.model;
			const sum = left.summary;
			const last = sum ? messages[sum.at - 1] : undefined;
			if (sum && last && this.seqOf.get(last as object) === sum.lastSeq) this.prefire = { at: sum.at, last, startedAt: 0, promise: Promise.resolve(sum.result), result: sum.result };
			return;
		}
		const a = messages.findLast((m: any) => m.role === "assistant" && typeof m.timestamp === "number" && m.stopReason !== "error" && m.stopReason !== "aborted") as { timestamp: number; provider?: string; model?: string } | undefined;
		if (!a?.provider || !a.model) return;
		this.lastCacheUseAt = a.timestamp;
		this.lastCacheModel = `${a.provider}/${a.model}`;
	}

	dispose() {
		this.disposed = true;
		this.cancelWarm();
		this.cancelIdleSummary();
		this.leaveBehind();
		this.finalizeStep();
		this.agent.abort();
	}
}

/** what evicted sessions left behind, by id, oldest first: a ready summary (a few kb) and when the cache was last used */
const leftBehind = new Map<string, { at: number; model: string | undefined; summary?: { at: number; lastSeq: number; result: Summary } }>();
const LEFT_BEHIND_MAX = 64;

interface CompactOpts {
	aheadOnly?: boolean;
	cold?: boolean;
	noCache?: boolean;
}

/** cache marks off every block of an anthropic payload: pi leaves them off for "none", the breakpoint gates and document blocks may not */
function stripCacheMarks(payload: Record<string, any>) {
	const strip = (blocks: unknown) => {
		if (Array.isArray(blocks)) for (const b of blocks) if (b && typeof b === "object") delete (b as { cache_control?: unknown }).cache_control;
	};
	strip(payload.system);
	strip(payload.tools);
	if (Array.isArray(payload.messages)) for (const m of payload.messages) strip(m?.content);
}

/** a summary made in the background, for the context as it was `at` messages long */
interface Prefire {
	at: number;
	last: AgentMessage;
	startedAt: number;
	promise: Promise<Summary | undefined>;
	result?: Summary;
}

/** one summary request's answer */
interface Summary {
	text: string;
	ms: number;
	ttftMs: number | null;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** made with tool output cleared, because the whole context did not fit */
	cleared?: boolean;
}

function usageOf(s: Summary) {
	const denom = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
	return { cacheRead: s.usage.cacheRead, cacheWrite: s.usage.cacheWrite, input: s.usage.input, output: s.usage.output, cost: s.usage.cost, cacheReadPct: denom ? Math.round((1000 * s.usage.cacheRead) / denom) / 10 : 0 };
}

export class SummaryError extends Error {
	constructor(
		readonly reason: "degenerate" | "too_large" | "transient",
		message: string,
	) {
		super(message);
	}
}

export class BusyError extends Error {
	constructor(readonly sessionID: string) {
		super(`session ${sessionID} is running a turn; send it as steer or queue`);
	}
}
