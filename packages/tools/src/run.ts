import { CodemodeSandbox, type CodemodeTool, loadQuickJSWasm } from "@earendil-works/pi-codemode";
// embedded in a compiled binary (bun's `type: "file"` gives a path its fs can read), the package file otherwise
import quickjsWasm from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { Type } from "typebox";
import { imageParts } from "./image.ts";
import { nestedDetails, titleLine, toolTitle } from "./record.ts";
import { type CallDecision, type ImagePart, text, type NestedCall, type TextPart, type Tool, defineTool, type ToolResult } from "./types.ts";

/**
 * `run`: one confined script per call. the only capabilities are the namespaced helpers below, and
 * each helper is a nested call of a tool through the engine, so it passes the same schema check and
 * permission gate and is counted in the same telemetry as a direct call.
 */

/**
 * the worker entry next to this file. a compiled binary (scripts/build.ts) embeds it as a second
 * entrypoint under bun's virtual root, at its path below `packages/`
 */
const WORKER = import.meta.url.includes("/$bunfs/") ? new URL("file:///$bunfs/root/tools/src/codemode-worker.js") : new URL(import.meta.url.endsWith(".ts") ? "./codemode-worker.ts" : "./codemode-worker.js", import.meta.url);

/** what a helper hands back to the script: the tool's text, or its machine-readable result */
type Returns = "text" | "structured";

interface Helper {
	name: string;
	tool: string;
	returns: Returns;
	signature: string;
	/** fixed arguments the helper adds (pty.spawn is a job with a terminal) */
	extra?: Record<string, unknown>;
	/** kept for scripts written against an older name; not listed */
	alias?: boolean;
}

const HELPERS: Helper[] = [
	{ name: "fs.read", tool: "read", returns: "structured", signature: "fs.read({ path, offset?, limit? }): Promise<string>" },
	{ name: "fs.write", tool: "write", returns: "text", signature: "fs.write({ path, content }): Promise<string>" },
	{ name: "fs.edit", tool: "edit", returns: "text", signature: "fs.edit({ path, old_text, new_text, replace_all? }): Promise<string>" },
	{ name: "fs.list", tool: "glob", returns: "structured", signature: "fs.list({ pattern, path?, limit? }): Promise<{ paths, total, truncated }>" },
	{ name: "fs.grep", tool: "grep", returns: "text", signature: "", alias: true },
	{ name: "fs.glob", tool: "glob", returns: "text", signature: "", alias: true },
	{
		name: "search.grep",
		tool: "grep",
		returns: "structured",
		signature: "search.grep({ pattern, path?, glob?, ignore_case?, literal?, context?, limit? }): Promise<{ hits: [{ path, line, text }], total, truncated }>",
	},
	{ name: "search.glob", tool: "glob", returns: "structured", signature: "search.glob({ pattern, path?, limit? }): Promise<{ paths, total, truncated }>" },
	{ name: "search.web", tool: "websearch", returns: "text", signature: "search.web({ query, results? }): Promise<string>" },
	{ name: "search.fetch", tool: "webfetch", returns: "text", signature: "search.fetch({ url, timeout? }): Promise<string>" },
	{
		name: "shell.exec",
		tool: "shell",
		returns: "structured",
		signature: "shell.exec({ command, timeout? }): Promise<{ exit_code, output, truncated, wall_time_seconds, timed_out, output_held, job_id?, images? }>",
	},
	{
		name: "shell.spawn",
		tool: "proc_spawn",
		returns: "structured",
		signature: "shell.spawn({ command, cwd?, env?, notify?: { on_exit?, on_pattern?, on_port? }, keep?, detach?, serve? }): Promise<{ id, pid, status, cursor, ... }>",
	},
	{ name: "shell.read", tool: "proc_read", returns: "structured", signature: "shell.read({ id, cursor?, limit?, wait_ms? }): Promise<{ data, cursor, dropped, status, exitCode }>" },
	{ name: "shell.kill", tool: "proc_kill", returns: "structured", signature: "shell.kill({ id })" },
	{ name: "shell.list", tool: "proc_list", returns: "structured", signature: "shell.list(): Promise<[{ id, pid, command, status, ports, keep? }]>" },
	{ name: "pty.spawn", tool: "proc_spawn", returns: "structured", extra: { tty: true }, signature: "pty.spawn({ command, cwd?, cols?, rows?, title?, keep? }): Promise<{ id, pid, cursor, ... }>" },
	{ name: "pty.write", tool: "proc_write", returns: "structured", signature: "pty.write({ id, data })" },
	{ name: "pty.read", tool: "proc_read", returns: "structured", signature: "pty.read({ id, cursor?, limit?, wait_ms? }): Promise<{ data, cursor, dropped, status, exitCode }>" },
	{ name: "pty.kill", tool: "proc_kill", returns: "structured", signature: "pty.kill({ id })" },
	{ name: "pty.list", tool: "proc_list", returns: "structured", signature: "pty.list()" },
	{ name: "agents.spawn", tool: "spawn", returns: "structured", signature: "agents.spawn({ brief, model, effort?, why?, after?, name?, agent_type?, files?, pool? }): Promise<{ id, path, agents }>" },
	{ name: "agents.message", tool: "message", returns: "structured", signature: "agents.message({ to, body, wake?, correlation_id? }): Promise<{ to, id, state, woke, pending }>" },
	{ name: "agents.wait", tool: "wait", returns: "structured", signature: "agents.wait({ timeout_ms?, correlation_id? }): Promise<{ arrived, timed_out, items }>" },
	{ name: "agents.list", tool: "agents", returns: "structured", extra: { action: "list" }, signature: "agents.list({ path_prefix? }): Promise<{ self, agents: [{ id, path, model, effort, state, files, lastReport }] }>" },
	{ name: "agents.close", tool: "agents", returns: "structured", extra: { action: "close" }, signature: "agents.close({ target })" },
	{ name: "agents.interrupt", tool: "agents", returns: "structured", extra: { action: "interrupt" }, signature: "agents.interrupt({ target })" },
];

/** which tools this agent has; a helper over a tool it lacks is left out of the description and refuses when called */
export type ToolCheck = (tool: string) => boolean;

/** a helper is there when its tool is; shell.spawn and pty.* run commands, so they also need shell */
function helperAvailable(h: Helper, has: ToolCheck): boolean {
	return has(h.tool) && (!h.tool.startsWith("proc_") || has("shell"));
}

/** run's description for an agent with these tools; it depends only on the tool set, so one agent type gets one prefix */
export function runDescription(has: ToolCheck = () => true): string {
	const on = new Set(HELPERS.filter((h) => !h.alias && helperAvailable(h, has)).map((h) => h.name));
	const signatures = HELPERS.filter((h) => on.has(h.name)).map((h) => `  ${h.signature}`);
	const imageFile = on.has("fs.read") ? "; an image file needs no helper, fs.read it" : "";
	const notes = ["paths resolve against the working directory."];
	if (on.has("fs.read")) notes.push("fs.read returns the file's text as it is on disk, without line numbers; offset and limit count lines.");
	if (on.has("shell.exec")) notes.push("shell.exec resolves with a non-zero exit_code instead of throwing.");
	if (on.has("shell.spawn")) notes.push("shell.spawn starts a background job this session owns and returns at once; with notify, a message arrives in the session when it fires and starts a new turn if yours has ended, so nothing needs to wait on it; serve: true marks one left running for a person or other tools (a dev server, a preview), which nothing waits on.");
	if (on.has("pty.spawn")) notes.push("pty.* drives a terminal: write input with a trailing \\n, then read from the last cursor with wait_ms to get the reply.");
	if ([...on].some((n) => n.startsWith("agents."))) notes.push("agents.* are the agent verbs, for fanning out work from a script.");
	const imaging = ["fs.read", "shell.exec"].filter((n) => on.has(n));
	if (imaging.length) notes.push(`images that ${imaging.join(" or ")} return${imaging.length > 1 ? "" : "s"} are attached to the run's result.`);
	notes.push(
		"there is no fetch, process, require, module or timer. the script may declare any name, these globals included. every helper call is checked by the same permission rules as the direct tool; a refused or failed call rejects with the reason, which the script can catch and carry on from.",
	);
	return `run a javascript script in a confined interpreter and get back only what it prints and returns. the code is the body of an async function, so top-level await and return work. intermediate results stay inside the script, which makes one run the cheap way to read several files, search, run commands and keep only what matters.

helpers (all return promises):
${signatures.join("\n")}
  text(value) and console.log(value) add output; image("data:image/png;base64,...") attaches an image the script made (a data url, or an mcp image block)${imageFile}; a returned value is appended as json.

${notes.join(" ")}`;
}

/** the description for an agent with every tool */
export const RUN_DESCRIPTION = runDescription();

/**
 * the script as the sandbox runs it. pi-codemode wraps it as `(async (tools, console) => {code})`,
 * so a top-level `const tools` would redeclare a parameter; an inner block lets the script declare
 * any name. its undocumented globals are shadowed, so only the documented ones are visible. the
 * prefix stays on the first line, so line numbers in errors match the script as written
 */
export function wrapScript(code: string): string {
	return `tools = undefined; var store, load, ALL_TOOLS, exit; {${code}\n}`;
}

function textOf(content: ToolResult["content"]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

/** a helper call's own answer kept on its record; past this only its scalars (ids, paths, counts) stay */
const NESTED_DETAILS_CAP = 2048;

export interface NestedCallRecord {
	helper: string;
	tool: string;
	ok: boolean;
	ms: number;
	/** how the permission check came out: allow, ask:once, ask:always, ask:reject, deny, or none */
	permission?: CallDecision["permission"];
	/** the rule that decided */
	rule?: string;
	/** the refusal or error text, for calls that did not succeed */
	error?: string;
	/** what the call is, as a transcript row titles it: a path, a command, "agent helper" */
	title?: string;
	/** the tool's own answer (for spawn: child_session_id, path, agents), what a direct call records as metadata */
	details?: Record<string, unknown>;
}

export interface RunDetails {
	ok: boolean;
	/** every helper call the script made, successful or not */
	calls: number;
	nested: NestedCallRecord[];
	/** images attached to the result, from helpers and from image() */
	attachments: number;
	error?: string;
}

/** how long one script may run */
export const RUN_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
	timeoutMs?: number;
	/** the tools this agent has; every tool when absent */
	has?: ToolCheck;
}

export function runTool(call: NestedCall, opts: RunOptions = {}): Tool {
	const has = opts.has ?? (() => true);
	return defineTool({
		name: "run",
		label: "run",
		description: runDescription(has),
		parameters: Type.Object({
			code: Type.String({ description: "script body; top-level await and return work" }),
		}),
		async execute(_id, params, signal) {
			const nested: NestedCallRecord[] = [];
			// images from helpers stay on the host and ride the result; the script sees their captions
			const attachments: Array<TextPart | ImagePart> = [];
			// a script that times out returns while its calls may still be running; this tells them to stop,
			// so a shell.exec past the deadline does not keep its command going after run has answered.
			// a script that ends normally leaves an unawaited call alone, as before
			const stop = new AbortController();
			const callSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
			// codemode only counts `tools`, not `globals`; helpers are globals so dotted names become frozen
			// namespace objects inside the vm, so the count is kept here, one record per helper call
			const globals: CodemodeTool[] = HELPERS.map((h) => ({
				name: h.name,
				execute: async (args: unknown) => {
					const t0 = performance.now();
					const record: NestedCallRecord = { helper: h.name, tool: h.tool, ok: false, ms: 0 };
					nested.push(record);
					if (!helperAvailable(h, has)) {
						record.error = `${h.name} is not available to this agent`;
						throw new Error(record.error);
					}
					try {
						const input = h.extra ? { ...((args ?? {}) as object), ...h.extra } : (args ?? {});
						record.title = titleLine(toolTitle(h.tool, input));
						const { result, isError, decision } = await call(h.tool, input, callSignal);
						record.ok = !isError;
						record.title = titleLine(toolTitle(h.tool, input, result.details));
						const answer = nestedDetails(h.tool, result.details, NESTED_DETAILS_CAP);
						if (answer) record.details = answer;
						if (decision) {
							record.permission = decision.permission;
							if (decision.rule) record.rule = decision.rule;
						}
						result.content.forEach((c, i) => {
							if (c.type !== "image") return;
							// each image carries the caption before it (what it is, its size)
							const caption = result.content[i - 1];
							if (caption?.type === "text" && caption.text.startsWith("image ")) attachments.push(caption);
							attachments.push(c);
						});
						// shell reports a failing command as data so scripts can branch on exit_code
						if (h.tool === "shell" && result.structuredContent !== undefined) {
							const code = (result.structuredContent as { exit_code?: number | null }).exit_code;
							if (isError) record.error = code === null ? "killed or timed out" : `exit ${code}`;
							return result.structuredContent;
						}
						if (isError) {
							record.error = textOf(result.content).slice(0, 300);
							throw new Error(textOf(result.content) || `${h.name} failed`);
						}
						if (h.returns === "structured" && result.structuredContent !== undefined) return result.structuredContent;
						return textOf(result.content);
					} finally {
						record.ms = Math.round(performance.now() - t0);
					}
				},
			}));
			const sandbox = new CodemodeSandbox({ tools: [], globals, timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS, wasm: loadQuickJSWasm(quickjsWasm), workerUrl: WORKER });
			try {
				const result = await sandbox.execute(wrapScript(params.code), { signal });
				if (!result.ok && result.error.kind === "timeout") stop.abort(new Error(result.error.message));
				const content: ToolResult["content"] = [];
				let fromScript = 0;
				for (const item of result.output) {
					if (item.type === "text") content.push(text(item.text));
					else if (item.type === "image") {
						fromScript++;
						content.push(...(await imageParts(new Uint8Array(Buffer.from(item.data, "base64")), item.mimeType, `from the script (${fromScript})`)));
					}
				}
				if (result.ok && result.value !== undefined) content.push(text(JSON.stringify(result.value, null, 1)));
				if (!result.ok) content.push(text(`script failed (${result.error.kind}): ${result.error.stack ?? result.error.message}`));
				content.push(...attachments);
				if (content.length === 0) content.push(text("(script finished with no output)"));
				const images = content.filter((c) => c.type === "image").length;
				const details: RunDetails = { ok: result.ok, calls: nested.length, nested, attachments: images, ...(result.ok ? {} : { error: result.error.message }) };
				return { content, details, isError: !result.ok };
			} finally {
				await sandbox.close();
			}
		},
	});
}
