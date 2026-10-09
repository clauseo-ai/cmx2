import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { imageMimeOf, imageParts, sniffImage } from "./image.ts";
import { type Before, diffOnDisk, type FileDiff, snapshot } from "./diff.ts";
import { clip, clipNote, spill } from "./limits.ts";
import { MAX_BYTES, MAX_LINE_CHARS, MAX_LINES, text, type Tool, defineTool, type ToolEnv, type ToolResult } from "./types.ts";

/** a line longer than this is cut in every listing; the file on disk keeps all of it */
function cutLine(line: string): { line: string; cut: boolean } {
	if (line.length <= MAX_LINE_CHARS) return { line, cut: false };
	return { line: `${line.slice(0, MAX_LINE_CHARS)}…[line cut at ${MAX_LINE_CHARS} of ${line.length} characters]`, cut: true };
}

export function resolvePath(env: ToolEnv, p: string): string {
	const expanded = p.startsWith("~/") ? `${process.env.HOME}${p.slice(1)}` : p;
	return isAbsolute(expanded) ? expanded : resolve(env.cwd, expanded);
}

export function shown(env: ToolEnv, abs: string): string {
	const rel = relative(env.cwd, abs);
	return rel && !rel.startsWith("..") ? rel : abs;
}

export interface ReadDetails {
	path: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	truncated: boolean;
	/** lines longer than the per-line limit, cut in this page */
	cutLines: number;
}

export interface ImageReadDetails {
	path: string;
	mime: string;
	bytes: number;
}

export interface WriteDetails {
	path: string;
	bytes: number;
	created: boolean;
	/** what the write changed, counted against the file as it was before and as it is after the formatter; absent when the diff could not be taken */
	filediff?: FileDiff;
	truncated?: boolean;
}

export interface EditDetails {
	path: string;
	replacements: number;
	line: number;
	filediff?: FileDiff;
	truncated?: boolean;
}

/**
 * what a write or edit does once the file is changed: the hook (formatter, the file.edited event, language server errors),
 * then the diff, taken once. a hook that returns an object has taken the diff itself, at the end of the formatter, and its
 * answer stands; with no hook, or one that returns only notes, the diff is taken here. a diff that cannot be taken (a read
 * that fails, a file or a change too big to diff) leaves the part without filediff and never fails a call whose file is already written.
 */
async function afterChange(env: ToolEnv, abs: string, before: Before | undefined): Promise<{ notes?: string; diff?: { filediff: FileDiff; truncated: boolean } }> {
	const hook = await env.afterWrite?.(abs, before);
	if (hook && typeof hook === "object") return { ...(hook.notes ? { notes: hook.notes } : {}), ...(hook.diff ? { diff: hook.diff } : {}) };
	const notes = hook || undefined;
	if (before === undefined) return notes ? { notes } : {};
	try {
		const diff = diffOnDisk(abs, before);
		return { ...(notes ? { notes } : {}), ...(diff ? { diff } : {}) };
	} catch {
		return notes ? { notes } : {};
	}
}

export function readTool(env: ToolEnv): Tool {
	return defineTool({
		name: "read",
		label: "read",
		description: `read a file. text comes back with line numbers, up to ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB per call, lines over ${MAX_LINE_CHARS} characters cut; offset (1-based line) and limit page through longer files. png, jpg, gif and webp come back as images, resized when large; a heic photo comes back as a jpeg.`,
		parameters: Type.Object({
			path: Type.String({ description: "file path, relative to the working directory or absolute" }),
			offset: Type.Optional(Type.Number({ description: "first line to return, 1-based" })),
			limit: Type.Optional(Type.Number({ description: "how many lines to return" })),
		}),
		async execute(_id, params): Promise<ToolResult<ReadDetails | ImageReadDetails>> {
			const abs = resolvePath(env, params.path);
			if (!existsSync(abs)) throw new Error(`${shown(env, abs)} does not exist`);
			const st = statSync(abs);
			if (st.isDirectory()) throw new Error(`${shown(env, abs)} is a directory; use glob to list it`);
			const raw = readFileSync(abs);
			if (imageMimeOf(abs)) {
				const mime = sniffImage(raw) ?? imageMimeOf(abs)!;
				const details: ReadDetails | ImageReadDetails = { path: abs, mime, bytes: st.size };
				return { content: await imageParts(new Uint8Array(raw), mime, shown(env, abs)), details };
			}
			if (raw.subarray(0, 8000).includes(0)) throw new Error(`${shown(env, abs)} looks binary (${st.size} bytes); inspect it with shell instead`);
			const lines = raw.toString("utf8").split("\n");
			if (lines.at(-1) === "") lines.pop();
			const start = Math.max(1, Math.floor(params.offset ?? 1));
			if (start > lines.length && lines.length > 0) throw new Error(`offset ${start} is past the end; ${shown(env, abs)} has ${lines.length} lines`);
			const want = Math.min(Math.max(1, Math.floor(params.limit ?? MAX_LINES)), MAX_LINES);
			const out: string[] = [];
			let bytes = 0;
			let end = start - 1;
			let cutLines = 0;
			for (let i = start - 1; i < lines.length && out.length < want; i++) {
				const c = cutLine(lines[i]!);
				if (c.cut) cutLines++;
				const line = `${String(i + 1).padStart(6)}\t${c.line}`;
				bytes += Buffer.byteLength(line) + 1;
				if (bytes > MAX_BYTES && out.length > 0) break;
				out.push(line);
				end = i + 1;
			}
			const truncated = end < lines.length;
			const cutNote = cutLines ? `\n\n(${cutLines} long line${cutLines > 1 ? "s" : ""} cut at ${MAX_LINE_CHARS} characters; grep or shell reach the rest)` : "";
			const note = (truncated ? `\n\n(lines ${start}-${end} of ${lines.length}; continue with offset ${end + 1})` : "") + cutNote;
			const details: ReadDetails | ImageReadDetails = { path: abs, startLine: start, endLine: end, totalLines: lines.length, truncated, cutLines };
			return { content: [text(lines.length === 0 ? "(empty file)" : out.join("\n") + note)], details };
		},
	});
}

export function writeTool(env: ToolEnv): Tool {
	return defineTool({
		name: "write",
		label: "write",
		description: "write a whole file, creating parent directories as needed. replaces the file if it exists.",
		parameters: Type.Object({
			path: Type.String({ description: "file path, relative to the working directory or absolute" }),
			content: Type.String({ description: "the complete file content" }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const abs = resolvePath(env, params.path);
			const existed = existsSync(abs);
			const before = snapshot(abs);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, params.content);
			const bytes = Buffer.byteLength(params.content);
			const { notes, diff } = await afterChange(env, abs, before);
			const details: WriteDetails = { path: abs, bytes, created: !existed, ...diff };
			return { content: [text(`${existed ? "replaced" : "created"} ${shown(env, abs)} (${bytes} bytes)${notes ? `\n\n${notes}` : ""}`)], details };
		},
	});
}

export function editTool(env: ToolEnv): Tool {
	return defineTool({
		name: "edit",
		label: "edit",
		description: "replace exact text in a file. the edit applies when old_text matches the file byte for byte, whitespace included, and occurs exactly once; replace_all changes every occurrence.",
		parameters: Type.Object({
			path: Type.String({ description: "file path, relative to the working directory or absolute" }),
			old_text: Type.String({ description: "text to find, exactly as it appears" }),
			new_text: Type.String({ description: "replacement text" }),
			replace_all: Type.Optional(Type.Boolean({ description: "replace every occurrence instead of exactly one" })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const abs = resolvePath(env, params.path);
			if (!existsSync(abs)) throw new Error(`${shown(env, abs)} does not exist; use write to create it`);
			const beforeBytes: Before = readFileSync(abs);
			const before = beforeBytes.toString("utf8");
			if (params.old_text === params.new_text) throw new Error("old_text and new_text are identical; nothing to change");
			const count = params.old_text ? before.split(params.old_text).length - 1 : 0;
			if (count === 0) throw new Error(`old_text was not found in ${shown(env, abs)}; read the file again and copy the text exactly`);
			if (count > 1 && !params.replace_all) {
				throw new Error(`old_text appears ${count} times in ${shown(env, abs)}; add surrounding lines to make it unique, or set replace_all`);
			}
			const after = params.replace_all ? before.split(params.old_text).join(params.new_text) : before.replace(params.old_text, () => params.new_text);
			writeFileSync(abs, after);
			const line = before.slice(0, before.indexOf(params.old_text)).split("\n").length;
			const { notes, diff } = await afterChange(env, abs, beforeBytes);
			const details: EditDetails = { path: abs, replacements: params.replace_all ? count : 1, line, ...diff };
			return {
				content: [text(`edited ${shown(env, abs)}: ${details.replacements} replacement${details.replacements > 1 ? "s" : ""} at line ${line}${notes ? `\n\n${notes}` : ""}`)],
				details,
			};
		},
	});
}

export interface GrepHit {
	path: string;
	line: number;
	text: string;
}

export interface GrepDetails {
	hits: GrepHit[];
	total: number;
	truncated: boolean;
	spillPath?: string;
}

export interface GlobDetails {
	paths: string[];
	total: number;
	truncated: boolean;
	spillPath?: string;
}

async function rg(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["rg", ...args], { cwd, stdout: "pipe", stderr: "pipe", signal });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out, err };
}

export function grepTool(env: ToolEnv): Tool {
	return defineTool({
		name: "grep",
		label: "grep",
		description: "search file contents with ripgrep (regex by default). respects .gitignore. returns path:line: text for each hit, up to limit hits (default 200).",
		parameters: Type.Object({
			pattern: Type.String({ description: "ripgrep regex, or a plain string with literal" }),
			path: Type.Optional(Type.String({ description: "file or directory to search, default the working directory" })),
			glob: Type.Optional(Type.String({ description: "only files matching this glob, e.g. *.ts or src/**/*.tsx" })),
			ignore_case: Type.Optional(Type.Boolean()),
			literal: Type.Optional(Type.Boolean({ description: "treat pattern as a fixed string" })),
			context: Type.Optional(Type.Number({ description: "lines of context around each hit" })),
			limit: Type.Optional(Type.Number({ description: "maximum hits, default 200" })),
		}),
		async execute(_id, params, signal) {
			const target = params.path ? resolvePath(env, params.path) : env.cwd;
			const limit = Math.max(1, Math.floor(params.limit ?? 200));
			const args = ["--json", "--no-messages"];
			if (params.ignore_case) args.push("-i");
			if (params.literal) args.push("-F");
			if (params.glob) args.push("-g", params.glob);
			if (params.context) args.push("-C", String(Math.floor(params.context)));
			args.push("-e", params.pattern, target);
			const r = await rg(args, env.cwd, signal);
			if (r.code === 2 && !r.out) throw new Error(`grep failed: ${r.err.trim() || "ripgrep exited 2"}`);
			const hits: GrepHit[] = [];
			const lines: string[] = [];
			let total = 0;
			for (const raw of r.out.split("\n")) {
				if (!raw) continue;
				const ev = JSON.parse(raw) as { type: string; data: any };
				if (ev.type !== "match" && ev.type !== "context") continue;
				const path = shown(env, resolve(env.cwd, ev.data.path.text ?? ""));
				const body = cutLine(String(ev.data.lines.text ?? "").replace(/\n$/, "")).line;
				if (ev.type === "match") {
					total++;
					if (hits.length >= limit) continue;
					hits.push({ path, line: ev.data.line_number, text: body });
					lines.push(`${path}:${ev.data.line_number}: ${body}`);
				} else if (hits.length < limit) {
					lines.push(`${path}-${ev.data.line_number}- ${body}`);
				}
			}
			if (total === 0) {
				const none: GrepDetails = { hits: [], total: 0, truncated: false };
				return { content: [text("no matches")], details: none, structuredContent: none };
			}
			const c = clip(lines.join("\n"), { keep: "head", spillDir: env.spillDir, label: "grep" });
			const more = total > hits.length ? `\n\n(${hits.length} of ${total} hits shown; narrow the pattern or raise limit)` : "";
			const details: GrepDetails = { hits, total, truncated: total > hits.length || c.truncated, ...(c.spillPath ? { spillPath: c.spillPath } : {}) };
			return { content: [text(c.text + clipNote(c, "some") + more)], details, structuredContent: details };
		},
	});
}

export function globTool(env: ToolEnv): Tool {
	return defineTool({
		name: "glob",
		label: "glob",
		description: "list files matching a glob pattern (e.g. **/*.test.ts), sorted by path. respects .gitignore. returns up to limit paths (default 500).",
		parameters: Type.Object({
			pattern: Type.String({ description: "glob, matched against paths relative to the search root" }),
			path: Type.Optional(Type.String({ description: "directory to search, default the working directory" })),
			limit: Type.Optional(Type.Number({ description: "maximum paths, default 500" })),
		}),
		async execute(_id, params, signal) {
			const root = params.path ? resolvePath(env, params.path) : env.cwd;
			const limit = Math.max(1, Math.floor(params.limit ?? 500));
			const r = await rg(["--files", "--no-messages", "-g", params.pattern], root, signal);
			if (r.code === 2 && !r.out) throw new Error(`glob failed: ${r.err.trim() || "ripgrep exited 2"}`);
			const all = r.out
				.split("\n")
				.filter(Boolean)
				.map((p) => shown(env, resolve(root, p)))
				.sort();
			if (all.length === 0) {
				const none: GlobDetails = { paths: [], total: 0, truncated: false };
				return { content: [text("no files match")], details: none, structuredContent: none };
			}
			let paths = all.slice(0, limit);
			// the listing obeys the shared limits too; the full list goes to a spill file
			const c = clip(paths.join("\n"), { keep: "head", label: "glob" });
			if (c.truncated) paths = c.text.split("\n");
			const truncated = paths.length < all.length;
			const spillPath = truncated ? spill(env.spillDir, "glob", all.join("\n")) : undefined;
			const more = truncated ? `\n\n(${paths.length} of ${all.length} paths shown${spillPath ? `; all of them in ${spillPath}` : ""}; narrow the pattern or raise limit)` : "";
			const details: GlobDetails = { paths, total: all.length, truncated, ...(spillPath ? { spillPath } : {}) };
			return { content: [text(paths.join("\n") + more)], details, structuredContent: details };
		},
	});
}
