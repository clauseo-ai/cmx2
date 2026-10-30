import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { imageMimeOf, imageParts } from "./image.ts";
import { clip, clipNote } from "./limits.ts";
import { describeNotify, Notify, procLine } from "./procs.ts";
import { text, type ImagePart, type TextPart, type Tool, defineTool, type ToolEnv, type ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
/** images a single command's output may bring along */
const MAX_OUTPUT_IMAGES = 4;
/** while a command runs, its output tail is reported at most this often, and this much of it */
const PROGRESS_MS = 1000;
const PROGRESS_TAIL_CHARS = 2048;
/**
 * once the command's shell has exited, how long its output pipes may take to close before the call
 * returns without them: a background process started with `&` that inherited them keeps them open
 */
const PIPE_DRAIN_MS = 300;
const TIMEOUT_HINT = "; for long builds, tests or servers, run with background: true and notify";

export interface ShellResult {
	exit_code: number | null;
	output: string;
	truncated: boolean;
	wall_time_seconds: number;
	timed_out: boolean;
	/**
	 * a process the command started still holds its output pipes: the call returned without the rest
	 * of the output, and that process keeps running
	 */
	output_held: boolean;
	/** the job the held process was taken over as (env.procs), when there was one still running */
	job_id?: string;
	spill_path?: string;
	/** image files the command wrote and named in its output, attached to the result */
	images?: string[];
}

/**
 * image files a command wrote and named in its output: a screenshot tool that prints where it saved,
 * a test that writes a diff png. only files modified since the command started count, so an image
 * that merely appears in a listing does not ride along.
 */
export function outputImages(output: string, cwd: string, since: number): string[] {
	const found: string[] = [];
	for (const raw of output.split(/[\s'"`()<>[\]{},;=]+/)) {
		const token = raw.replace(/^file:\/\//, "").replace(/[.:]+$/, "");
		if (!token || !imageMimeOf(token)) continue;
		const expanded = token.startsWith("~/") ? `${process.env.HOME}${token.slice(1)}` : token;
		const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
		if (found.includes(abs) || !existsSync(abs)) continue;
		try {
			const st = statSync(abs);
			// file times are coarse on some filesystems; a second of slack
			if (!st.isFile() || st.mtimeMs < since - 1000) continue;
		} catch {
			continue;
		}
		found.push(abs);
		if (found.length >= MAX_OUTPUT_IMAGES) break;
	}
	return found;
}

/** runs one command in its own process group so a timeout or abort takes its children with it */
export async function runCommand(env: ToolEnv, command: string, timeoutS: number, signal?: AbortSignal, onProgress?: (tail: string) => void): Promise<ShellResult> {
	const t0 = performance.now();
	const startedAt = Date.now();
	const proc = Bun.spawn(["bash", "-c", command], {
		cwd: env.cwd,
		env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb", ...env.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	let timedOut = false;
	const kill = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeoutS * 1000);
	const onAbort = () => kill();
	signal?.addEventListener("abort", onAbort, { once: true });
	const chunks: string[] = [];
	let reported = 0;
	let tail = "";
	// set when the call returns: a process still holding the pipes may keep writing. the pipe is still read to its
	// end, not closed (a child that writes after that would take SIGPIPE); its bytes go to the job taking it over, if any
	let closed = false;
	let late: ((bytes: Uint8Array) => void) | undefined;
	const pump = async (s: ReadableStream<Uint8Array>) => {
		const dec = new TextDecoder();
		const reader = s.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (closed) {
				late?.(value);
				continue;
			}
			const piece = dec.decode(value, { stream: true });
			chunks.push(piece);
			if (!onProgress) continue;
			tail = (tail + piece).slice(-PROGRESS_TAIL_CHARS);
			if (performance.now() - reported >= PROGRESS_MS) {
				reported = performance.now();
				onProgress(tail);
			}
		}
	};
	let held = false;
	let jobID: string | undefined;
	try {
		const pumped = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
		// the timeout and an abort still kill the group while bash runs; once bash has exited, its pipes get a short grace
		await proc.exited;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			pumped.then(() => true),
			new Promise<boolean>((ok) => {
				graceTimer = setTimeout(() => ok(false), PIPE_DRAIN_MS);
			}),
		]);
		clearTimeout(graceTimer);
		held = !drained;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
	if (held) {
		// the group is taken over as a job of the session; an empty group is not (the holder is outside it)
		const adopted = env.procs?.adoptGroup?.({ pgid: proc.pid, command, cwd: env.cwd });
		if (adopted) {
			jobID = adopted.job.id;
			late = adopted.output;
		}
	}
	closed = true;
	const full = chunks.join("");
	const c = clip(full, { keep: "tail", spillDir: env.spillDir, label: "shell" });
	const images = outputImages(full, env.cwd, startedAt);
	return {
		exit_code: timedOut || signal?.aborted ? null : proc.exitCode,
		output: c.text + clipNote(c, "the last"),
		truncated: c.truncated,
		wall_time_seconds: Math.round((performance.now() - t0) / 100) / 10,
		timed_out: timedOut,
		output_held: held,
		...(jobID ? { job_id: jobID } : {}),
		...(c.spillPath ? { spill_path: c.spillPath } : {}),
		...(images.length ? { images } : {}),
	};
}

/** what the model is told when a command left a process holding its output */
function heldNote(jobID: string | undefined): string {
	if (jobID) return `a background process is still holding this command's output; it keeps running as job ${jobID}. read it or stop it with pty.read or pty.kill in run.`;
	return "a background process is still holding this command's output; it keeps running. use background: true to run it as a job you can read and stop.";
}

export function shellTool(env: ToolEnv): Tool {
	return defineTool({
		name: "shell",
		label: "shell",
		description: `run one bash command in the working directory and get its combined stdout and stderr (the last 2000 lines, full output spilled to a file when longer). no stdin; timeout in seconds, default ${DEFAULT_TIMEOUT_S}, up to ${MAX_TIMEOUT_S}. image files the command writes and prints the path of come back as images.

with background, notify, keep, serve or tty the command starts as a job this session owns and the call returns at once with its id. notify says when you hear back: a message lands in this session when the job exits, when an output line matches a pattern, or when a port opens. if your turn has ended by then, the message starts a new one, so you can end your turn after starting a long build and pick up from the message. jobs end with the session unless keep names them.

serve marks a job left running for a person or other tools to use, such as a dev server or a preview: it gets no exit notification by default and you are not waiting on it. start it with serve (on_port tells you when it is up), then give the url.`,
		parameters: Type.Object({
			command: Type.String({ description: "bash command line" }),
			timeout: Type.Optional(Type.Number({ description: `seconds before the command is killed, default ${DEFAULT_TIMEOUT_S}; not used for jobs` })),
			background: Type.Optional(Type.Boolean({ description: "start as a job and return at once; notify defaults to on exit" })),
			notify: Type.Optional(Notify),
			keep: Type.Optional(Type.String({ description: "a name that keeps the job alive after the session ends" })),
			tty: Type.Optional(Type.Boolean({ description: "run the job in a terminal (for programs that need one)" })),
			serve: Type.Optional(Type.Boolean({ description: "a job left running for a person or other tools to use (a dev server, a preview); starts it in the background with no default notify" })),
		}),
		async execute(_id, params, signal, onUpdate): Promise<ToolResult<Record<string, unknown>>> {
			if (params.background || params.notify || params.keep || params.tty || params.serve) {
				if (!env.procs) throw new Error("background jobs are not available in this session; run the command in the foreground");
				// a serve job is not waited on, so it has no exit notice unless one is asked for
				const notify = params.notify ?? (params.serve ? undefined : { on_exit: true });
				const job = env.procs.spawn({ command: params.command, cwd: env.cwd, tty: params.tty, keep: params.keep, notify, ...(params.serve ? { serve: true } : {}) });
				return {
					content: [text(`started job ${procLine(job)}\n${params.serve && !notify ? "a serve job: nothing waits on it and no message arrives unless notify asks for one" : describeNotify(notify)}. its output: pty.read({ id: "${job.id}" }) in run.`)],
					details: { job },
					structuredContent: job,
				};
			}
			const timeout = Math.min(Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);
			// a running command reports its output tail at most once a second, so clients can show it live
			const progress = onUpdate ? (tail: string) => onUpdate({ content: [text(tail)], details: { progress: true, tail } }) : undefined;
			const r = await runCommand(env, params.command, timeout, signal, progress);
			const status = r.timed_out ? `killed after ${timeout}s` : r.exit_code === null ? "aborted" : `exit ${r.exit_code}`;
			const body = r.output.trim() ? r.output.replace(/\n+$/, "") : "(no output)";
			const held = r.output_held ? `\n\n${heldNote(r.job_id)}` : "";
			const content: Array<TextPart | ImagePart> = [text(`${body}${held}\n\n(${status}, ${r.wall_time_seconds}s${r.timed_out ? TIMEOUT_HINT : ""})`)];
			for (const path of r.images ?? []) content.push(...(await imageParts(new Uint8Array(readFileSync(path)), imageMimeOf(path)!, path)));
			return {
				content,
				details: { exit_code: r.exit_code, timed_out: r.timed_out, output_held: r.output_held, truncated: r.truncated, spill_path: r.spill_path, images: r.images },
				structuredContent: r,
				isError: r.exit_code !== 0,
			};
		},
	});
}
