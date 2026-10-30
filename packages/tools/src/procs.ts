import { Type } from "typebox";
import { MAX_BYTES, text, type ProcHost, type ProcSummary, type Tool, defineTool, type ToolEnv } from "./types.ts";

/**
 * the session's processes as tools the `run` helpers call (`shell.spawn`, `pty.*`). they are never
 * declared to the model on their own, so the prefix does not carry them; every call still goes through
 * the engine's nested call, so spawning a command and typing into a terminal are checked like shell.
 */

const NO_PROCS = "background jobs and terminals are not available in this session";

function host(env: ToolEnv): ProcHost {
	if (!env.procs) throw new Error(NO_PROCS);
	return env.procs;
}

export const Notify = Type.Object(
	{
		on_exit: Type.Optional(Type.Boolean({ description: "when the process exits" })),
		on_pattern: Type.Optional(Type.String({ description: "each time a new output line matches this regex" })),
		on_port: Type.Optional(Type.Number({ description: "once, when this port accepts connections on localhost" })),
	},
	{ description: "a message arrives in this session when any of these fires; nothing needs to poll" },
);

export function describeNotify(n: { on_exit?: boolean; on_pattern?: string; on_port?: number } | undefined): string {
	if (!n) return "no notification set";
	const parts = [n.on_port !== undefined ? `when port ${n.on_port} opens` : "", n.on_pattern ? `when a line matches /${n.on_pattern}/` : "", n.on_exit ? "when it exits" : ""].filter(Boolean);
	return parts.length ? `a message arrives ${parts.join(", ")}; it starts your next turn if you have ended this one` : "no notification set";
}

export function procLine(p: ProcSummary): string {
	const state = p.status === "running" ? "running" : `exited ${p.exitCode ?? "?"}`;
	const ports = p.ports.length ? `, ports ${p.ports.join(",")}` : "";
	return `${p.id} pid ${p.pid} ${state}${p.serve ? ", serve" : ""}${ports}${p.keep ? `, keep ${p.keep}` : ""}: ${p.command}`;
}

export function procTools(env: ToolEnv): Tool[] {
	return [
		defineTool({
			name: "proc_spawn",
			label: "proc_spawn",
			description: "start a process owned by this session: a background job (pipes) or a terminal (tty: true).",
			parameters: Type.Object({
				command: Type.String({ description: "bash command line" }),
				cwd: Type.Optional(Type.String()),
				env: Type.Optional(Type.Record(Type.String(), Type.String())),
				tty: Type.Optional(Type.Boolean()),
				cols: Type.Optional(Type.Number()),
				rows: Type.Optional(Type.Number()),
				title: Type.Optional(Type.String()),
				keep: Type.Optional(Type.String({ description: "name it to keep it alive after the session ends" })),
				detach: Type.Optional(Type.Boolean({ description: "keep it alive across a daemon restart" })),
				notify: Type.Optional(Notify),
				serve: Type.Optional(Type.Boolean({ description: "a dev server or preview the person will open; not waited on. a server you start only to test against is a plain job; stop it when done." })),
			}),
			async execute(_id, params) {
				const p = host(env).spawn({ ...params, cwd: params.cwd ?? env.cwd });
				return { content: [text(`started ${procLine(p)}; ${describeNotify(params.notify)}`)], details: p, structuredContent: p };
			},
		}),
		defineTool({
			name: "proc_write",
			label: "proc_write",
			description: "type into a terminal or a job's stdin; include \\n to press enter.",
			parameters: Type.Object({ id: Type.String(), data: Type.String() }),
			async execute(_id, params) {
				host(env).write(params.id, params.data);
				return { content: [text(`wrote ${params.data.length} characters to ${params.id}`)], details: { id: params.id, chars: params.data.length }, structuredContent: { ok: true } };
			},
		}),
		defineTool({
			name: "proc_read",
			label: "proc_read",
			description: "output of a process from a cursor; wait_ms waits for new output to arrive and settle.",
			parameters: Type.Object({
				id: Type.String(),
				cursor: Type.Optional(Type.Number({ description: "from this byte offset; the cursor of the last read gives only what is new" })),
				limit: Type.Optional(Type.Number({ description: `bytes, default ${MAX_BYTES}` })),
				wait_ms: Type.Optional(Type.Number()),
			}),
			async execute(_id, params) {
				const r = await host(env).read(params.id, { cursor: params.cursor, limit: Math.min(params.limit ?? MAX_BYTES, MAX_BYTES), wait_ms: params.wait_ms });
				const gap = r.dropped ? `(${r.dropped} bytes before this were no longer kept)\n` : "";
				return { content: [text(`${gap}${r.data}`)], details: { ...r, data: undefined }, structuredContent: r };
			},
		}),
		defineTool({
			name: "proc_kill",
			label: "proc_kill",
			description: "stop a process this session owns, with its children.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, params) {
				host(env).kill(params.id);
				return { content: [text(`killed ${params.id}`)], details: { id: params.id }, structuredContent: { ok: true } };
			},
		}),
		defineTool({
			name: "proc_list",
			label: "proc_list",
			description: "the processes this session owns.",
			parameters: Type.Object({}),
			async execute() {
				const list = host(env).list();
				return { content: [text(list.length ? list.map(procLine).join("\n") : "no processes")], details: { procs: list }, structuredContent: list };
			},
		}),
	];
}
