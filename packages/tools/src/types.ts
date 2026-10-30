import type { Static, TSchema } from "typebox";
import type { Before, FileDiffResult } from "./diff.ts";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: string; mimeType: string };

export interface ToolResult<D = unknown> {
	content: Array<TextPart | ImagePart>;
	details: D;
	/** machine-readable result for scripts (`run`); never sent to the model */
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * the tool shape cmx2 hands the engine. structurally the same as pi-agent-core's `AgentTool`, so the
 * tools package stays free of pi imports (only the engine talks to pi).
 */
export interface Tool<P extends TSchema = TSchema, D = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: P;
	execute: (toolCallId: string, params: Static<P>, signal?: AbortSignal, onUpdate?: (partial: ToolResult<D>) => void) => Promise<ToolResult<D>>;
	executionMode?: "sequential" | "parallel";
	/**
	 * what the tool's source says about side effects, for tools cmx2 does not write (an mcp server's `readOnlyHint`).
	 * false keeps it from read-only agents (a session that does not get `edit`); unset leaves it to the exclusion list
	 */
	readOnly?: boolean;
}

/** what an afterWrite hook hands back: its notes, and the call's diff when it could take one (without it the tool takes none) */
export interface AfterWrite {
	notes?: string;
	diff?: FileDiffResult;
}

export interface ToolEnv {
	/** working directory every relative path resolves against */
	cwd: string;
	/** where outputs over the spill limit are written in full */
	spillDir: string;
	/** the session's processes (ptys and background jobs), owned by the session; absent in bare tool tests */
	procs?: ProcHost;
	/**
	 * runs after write or edit changed a file (formatter, language server errors, the file.edited event); returns notes for the
	 * result, or an object with the notes and the diff it took. `before` is what the file held before the write (undefined
	 * when it could not be read or was too big to hold), so the hook can take the one diff of the call, right after the formatter,
	 * and the event carries its counts. a hook that returns an object without `diff` means the tool takes no diff of its own
	 * (the hook could not take one: a change too big to diff, a read that failed); only a hook that returns a string, or no hook,
	 * leaves the diff to the tool
	 */
	afterWrite?: (abs: string, before?: Before) => Promise<string | AfterWrite | undefined>;
	/** variables every command gets on top of the daemon's, after anything the call itself sets (a subagent's push guard) */
	env?: Record<string, string>;
}

/** when a background job reports back to the session that owns it */
export interface ProcNotify {
	/** when the process exits */
	on_exit?: boolean;
	/** each time a new output line matches this regex */
	on_pattern?: string;
	/** once, when this tcp port accepts connections on localhost */
	on_port?: number;
}

export interface ProcSpawn {
	command: string;
	/** default the session's working directory */
	cwd?: string;
	env?: Record<string, string>;
	/** a real terminal (REPLs, tuis); without it stdout and stderr are pipes */
	tty?: boolean;
	cols?: number;
	rows?: number;
	title?: string;
	/** survives session end under this name */
	keep?: string;
	/** survives daemon restart; the pid is journaled and reported at the next start */
	detach?: boolean;
	notify?: ProcNotify;
	/**
	 * a dev server or preview the person will open, left running (a server started only to test against is a plain job):
	 * it gets no default notify and never counts as a job the session waits on, even with a notify still armed
	 */
	serve?: boolean;
}

export interface ProcSummary {
	id: string;
	pid: number;
	command: string;
	cwd: string;
	title: string;
	tty: boolean;
	status: "running" | "exited";
	exitCode: number | null;
	/** total output bytes so far; pass as cursor to read only what is new */
	cursor: number;
	/** tcp ports the process group listens on (looked up on demand) */
	ports: number[];
	/** started with serve: a dev server or preview the person will open, not waited on */
	serve: boolean;
	keep?: string;
	detached?: boolean;
	origin: "model" | "user";
	startedAt: number;
}

export interface ProcRead {
	data: string;
	/** cursor after this read */
	cursor: number;
	/** byte offset where `data` starts */
	start: number;
	/** bytes between the requested cursor and `start` that were no longer retained */
	dropped: number;
	status: "running" | "exited";
	exitCode: number | null;
}

/** what tools see of the process registry, already bound to the calling session */
export interface ProcHost {
	spawn(opts: ProcSpawn): ProcSummary;
	write(id: string, data: string): void;
	/** output from `cursor` (default: the retained head); `wait_ms` waits for new output to arrive and settle */
	read(id: string, opts?: { cursor?: number; limit?: number; wait_ms?: number }): Promise<ProcRead>;
	kill(id: string): void;
	list(): ProcSummary[];
	/**
	 * a process group a command left running with its output pipes still held: listed, read and stopped like a job.
	 * undefined when nothing of the group is left. `output` takes what the group writes from now on.
	 */
	adoptGroup?(o: { pgid: number; command: string; cwd: string }): { job: ProcSummary; output: (bytes: Uint8Array) => void } | undefined;
}

/** how the permission check for one call came out, in words a transcript reader follows */
export interface CallDecision {
	/** `none` when the tool has no check of its own (run: its helpers are checked one by one) */
	permission: "allow" | "ask:once" | "ask:always" | "ask:reject" | "deny" | "none";
	/** the rule that decided, as `permission pattern: action` */
	rule?: string;
}

/** a nested call from inside `run`: same tool, same checks as a direct call */
export type NestedCall = (tool: string, args: unknown, signal?: AbortSignal) => Promise<{ result: ToolResult; isError: boolean; decision?: CallDecision }>;

/** output limits every tool shares: the model sees at most this much, the rest goes to a spill file */
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
/** a single line longer than this is cut in listings (minified bundles, lockfiles) */
export const MAX_LINE_CHARS = 2000;

export function text(t: string): TextPart {
	return { type: "text", text: t };
}

/** infers the parameter type from the schema, then widens to the list type the engine holds */
export function defineTool<P extends TSchema, D>(tool: Tool<P, D>): Tool {
	return tool as unknown as Tool;
}
