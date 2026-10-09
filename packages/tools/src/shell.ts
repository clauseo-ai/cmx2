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

export interface ShellResult {
	exit_code: number | null;
	output: string;
	truncated: boolean;
	wall_time_seconds: number;
	timed_out: boolean;
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
	const pump = async (s: ReadableStream<Uint8Array>) => {
		const dec = new TextDecoder();
		const reader = s.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
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
	try {
		await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
	const full = chunks.join("");
	const c = clip(full, { keep: "tail", spillDir: env.spillDir, label: "shell" });
	const images = outputImages(full, env.cwd, startedAt);
	return {
		exit_code: timedOut || signal?.aborted ? null : proc.exitCode,
		output: c.text + clipNote(c, "the last"),
		truncated: c.truncated,
		wall_time_seconds: Math.round((performance.now() - t0) / 100) / 10,
		timed_out: timedOut,
		...(c.spillPath ? { spill_path: c.spillPath } : {}),
		...(images.length ? { images } : {}),
	};
}

export function shellTool(env: ToolEnv): Tool {
	return defineTool({
		name: "shell",
		label: "shell",
		description: `run one bash command in the working directory and get its combined stdout and stderr (the last 2000 lines, full output spilled to a file when longer). no stdin; timeout in seconds, default ${DEFAULT_TIMEOUT_S}, up to ${MAX_TIMEOUT_S}. image files the command writes and prints the path of come back as images.

with background, notify, keep or tty the command starts as a job this session owns and the call returns at once with its id. notify says when you hear back: a message lands in this session when the job exits, when an output line matches a pattern, or when a port opens. if your turn has ended by then, the message starts a new one, so you can end your turn after starting a dev server or a long build and pick up from the message. jobs end with the session unless keep names them.`,
		parameters: Type.Object({
			command: Type.String({ description: "bash command line" }),
			timeout: Type.Optional(Type.Number({ description: `seconds before the command is killed, default ${DEFAULT_TIMEOUT_S}; not used for jobs` })),
			background: Type.Optional(Type.Boolean({ description: "start as a job and return at once; notify defaults to on exit" })),
			notify: Type.Optional(Notify),
			keep: Type.Optional(Type.String({ description: "a name that keeps the job alive after the session ends" })),
			tty: Type.Optional(Type.Boolean({ description: "run the job in a terminal (for programs that need one)" })),
		}),
		async execute(_id, params, signal, onUpdate): Promise<ToolResult<Record<string, unknown>>> {
			if (params.background || params.notify || params.keep || params.tty) {
				if (!env.procs) throw new Error("background jobs are not available in this session; run the command in the foreground");
				const notify = params.notify ?? { on_exit: true };
				const job = env.procs.spawn({ command: params.command, cwd: env.cwd, tty: params.tty, keep: params.keep, notify });
				return {
					content: [text(`started job ${procLine(job)}\n${describeNotify(notify)}. its output: pty.read({ id: "${job.id}" }) in run.`)],
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
			const content: Array<TextPart | ImagePart> = [text(`${body}\n\n(${status}, ${r.wall_time_seconds}s)`)];
			for (const path of r.images ?? []) content.push(...(await imageParts(new Uint8Array(readFileSync(path)), imageMimeOf(path)!, path)));
			return {
				content,
				details: { exit_code: r.exit_code, timed_out: r.timed_out, truncated: r.truncated, spill_path: r.spill_path, images: r.images },
				structuredContent: r,
				isError: r.exit_code !== 0,
			};
		},
	});
}
