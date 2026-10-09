import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Type } from "typebox";
import { resolvePath, shown } from "./fs.ts";
import { clip, clipNote } from "./limits.ts";
import { text, type Tool, defineTool, type ToolEnv, type ToolResult } from "./types.ts";

/**
 * a small language server client: json-rpc over stdio with content-length framing, one server per
 * project root and language, started on first use, stopped after it sits idle and on config reload.
 */

export interface LspServerConfig {
	language: string;
	extensions: string[];
	/** argv; the first word is looked up in the project's node_modules/.bin, then on PATH */
	command: string[];
	/** files that mark a project root for this language, nearest first */
	roots: string[];
	initializationOptions?: Record<string, unknown>;
}

export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
	{ language: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], command: ["typescript-language-server", "--stdio"], roots: ["tsconfig.json", "jsconfig.json", "package.json"] },
	{ language: "python", extensions: [".py", ".pyi"], command: ["pyright-langserver", "--stdio"], roots: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"] },
	{ language: "go", extensions: [".go"], command: ["gopls"], roots: ["go.mod"] },
	{ language: "rust", extensions: [".rs"], command: ["rust-analyzer"], roots: ["Cargo.toml"] },
];

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
};

export interface LspLocation {
	path: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
}

export interface LspDiagnostic extends LspLocation {
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	source?: string;
	code?: string | number;
}

export interface LspSymbol extends LspLocation {
	name: string;
	kind: string;
	container?: string;
}

const SEVERITY = ["", "error", "warning", "info", "hint"] as const;
const SYMBOL_KINDS = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event", "operator", "type parameter"];

function walkUp(from: string, test: (dir: string) => string | undefined): string | undefined {
	let dir = from;
	for (;;) {
		const hit = test(dir);
		if (hit) return hit;
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

/** a command's executable: the project's node_modules/.bin, cmx2's own, then PATH */
function executable(name: string, root: string): string | undefined {
	const local = (dir: string) => {
		const p = join(dir, "node_modules", ".bin", name);
		return existsSync(p) ? p : undefined;
	};
	return walkUp(root, local) ?? walkUp(import.meta.dir, local) ?? Bun.which(name) ?? undefined;
}

function tsserverPath(root: string): string | undefined {
	const hit = walkUp(root, (d) => {
		const p = join(d, "node_modules", "typescript", "lib", "tsserver.js");
		return existsSync(p) ? p : undefined;
	});
	if (hit) return hit;
	try {
		return Bun.resolveSync("typescript/lib/tsserver.js", import.meta.dir);
	} catch {
		return undefined;
	}
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class LspServer {
	private proc: ReturnType<typeof Bun.spawn>;
	private buf = Buffer.alloc(0);
	private seq = 0;
	private pending = new Map<number, Pending>();
	private versions = new Map<string, number>();
	private diagnostics = new Map<string, { gen: number; items: any[] }>();
	private waiters = new Set<() => void>();
	private gen = 0;
	private stderr = "";
	exited = false;

	constructor(
		readonly config: LspServerConfig,
		readonly root: string,
		argv: string[],
	) {
		const proc = Bun.spawn(argv, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
		this.proc = proc;
		void this.pump(proc.stdout as unknown as AsyncIterable<Uint8Array>);
		void (async () => {
			for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) this.stderr = (this.stderr + new TextDecoder().decode(chunk)).slice(-4000);
		})();
		void proc.exited.then(() => {
			this.exited = true;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error(`${config.command[0]} exited${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
			}
			this.pending.clear();
		});
	}

	private async pump(s: AsyncIterable<Uint8Array>) {
		for await (const chunk of s) {
			this.buf = Buffer.concat([this.buf, chunk]);
			for (;;) {
				const end = this.buf.indexOf("\r\n\r\n");
				if (end < 0) break;
				const len = Number(this.buf.subarray(0, end).toString("ascii").match(/content-length:\s*(\d+)/i)?.[1]);
				if (!Number.isFinite(len)) {
					this.buf = this.buf.subarray(end + 4);
					continue;
				}
				if (this.buf.length < end + 4 + len) break;
				const body = this.buf.subarray(end + 4, end + 4 + len).toString("utf8");
				this.buf = this.buf.subarray(end + 4 + len);
				try {
					this.onMessage(JSON.parse(body));
				} catch {}
			}
		}
	}

	private send(msg: Record<string, unknown>) {
		const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
		const stdin = this.proc.stdin as import("bun").FileSink;
		stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		stdin.flush();
	}

	private onMessage(msg: any) {
		if (msg.id !== undefined && msg.method) {
			// requests from the server: answer what a plain client would, so it never waits on us
			const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : msg.method === "workspace/workspaceFolders" ? [{ uri: pathToFileURL(this.root).href, name: "root" }] : null;
			this.send({ id: msg.id, result });
			return;
		}
		if (msg.id !== undefined) {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(`${this.config.command[0]}: ${msg.error.message ?? "request failed"}`));
			else p.resolve(msg.result);
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics") {
			this.diagnostics.set(msg.params.uri, { gen: this.gen, items: msg.params.diagnostics ?? [] });
			for (const w of this.waiters) w();
		}
	}

	request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
		if (this.exited) return Promise.reject(new Error(`${this.config.command[0]} is not running`));
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.config.command[0]} did not answer ${method} in ${timeoutMs / 1000}s`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params: unknown) {
		if (!this.exited) this.send({ method, params });
	}

	async initialize() {
		const uri = pathToFileURL(this.root).href;
		await this.request("initialize", {
			processId: process.pid,
			rootUri: uri,
			workspaceFolders: [{ uri, name: "root" }],
			initializationOptions: this.config.initializationOptions ?? {},
			capabilities: {
				workspace: { configuration: true, workspaceFolders: true },
				textDocument: {
					synchronization: { didSave: true },
					publishDiagnostics: { relatedInformation: false },
					definition: { linkSupport: true },
					references: {},
					hover: { contentFormat: ["plaintext", "markdown"] },
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				},
			},
		});
		this.notify("initialized", {});
	}

	/** opens the file (or sends its current text again) so the server works on what is on disk */
	sync(path: string): string {
		const uri = pathToFileURL(path).href;
		const content = readFileSync(path, "utf8");
		this.gen++;
		const v = this.versions.get(uri);
		if (v === undefined) {
			this.versions.set(uri, 1);
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId: LANGUAGE_IDS[extname(path).toLowerCase()] ?? this.config.language, version: 1, text: content } });
		} else {
			this.versions.set(uri, v + 1);
			this.notify("textDocument/didChange", { textDocument: { uri, version: v + 1 }, contentChanges: [{ text: content }] });
		}
		return uri;
	}

	/** diagnostics published after the latest sync, with a short settle for servers that publish twice */
	async diagnosticsFor(uri: string, timeoutMs = 20_000, settleMs = 600): Promise<any[]> {
		const want = this.gen;
		const fresh = () => {
			const d = this.diagnostics.get(uri);
			return d && d.gen >= want ? d : undefined;
		};
		const t0 = Date.now();
		while (!fresh()) {
			if (this.exited) throw new Error(`${this.config.command[0]} exited before publishing diagnostics`);
			if (Date.now() - t0 > timeoutMs) throw new Error(`${this.config.command[0]} published no diagnostics in ${timeoutMs / 1000}s`);
			await new Promise<void>((r) => {
				const w = () => {
					this.waiters.delete(w);
					clearTimeout(t);
					r();
				};
				const t = setTimeout(w, 250);
				this.waiters.add(w);
			});
		}
		await Bun.sleep(settleMs);
		return fresh()!.items;
	}

	kill() {
		try {
			process.kill(-this.proc.pid, "SIGKILL");
		} catch {
			this.proc.kill("SIGKILL");
		}
	}
}

/** the language servers of the daemon, one per (root, language), stopped when idle and on flush */
export class LspPool {
	private servers = new Map<string, { server: Promise<LspServer>; timer?: ReturnType<typeof setTimeout> }>();
	private configs: LspServerConfig[];

	constructor(opts: { servers?: LspServerConfig[]; idleMs?: number } = {}) {
		this.configs = [...(opts.servers ?? []), ...DEFAULT_LSP_SERVERS];
		this.idleMs = opts.idleMs ?? 5 * 60_000;
	}

	private readonly idleMs: number;

	configFor(path: string): LspServerConfig | undefined {
		const ext = extname(path).toLowerCase();
		return this.configs.find((c) => c.extensions.includes(ext));
	}

	rootFor(config: LspServerConfig, path: string, fallback: string): string {
		return walkUp(dirname(path), (d) => (config.roots.some((r) => existsSync(join(d, r))) ? d : undefined)) ?? fallback;
	}

	async get(path: string, fallbackRoot: string): Promise<LspServer> {
		const config = this.configFor(path);
		if (!config) throw new Error(`no language server is configured for ${extname(path) || "files without an extension"}`);
		const root = this.rootFor(config, path, fallbackRoot);
		const key = `${config.language}:${root}`;
		let entry = this.servers.get(key);
		if (entry) {
			const s = await entry.server.catch(() => undefined);
			if (!s || s.exited) {
				this.servers.delete(key);
				entry = undefined;
			}
		}
		if (!entry) {
			const exe = executable(config.command[0]!, root);
			if (!exe) throw new Error(`${config.command[0]} is not installed; install it or point lsp at another server in cmx2.jsonc`);
			let cfg = config;
			if (config.language === "typescript") {
				const tsserver = tsserverPath(root);
				if (tsserver) cfg = { ...config, initializationOptions: { tsserver: { path: tsserver }, ...config.initializationOptions } };
			}
			const server = (async () => {
				const s = new LspServer(cfg, root, [exe, ...config.command.slice(1)]);
				try {
					await s.initialize();
				} catch (e) {
					s.kill();
					throw e;
				}
				return s;
			})();
			entry = { server };
			this.servers.set(key, entry);
		}
		if (entry.timer) clearTimeout(entry.timer);
		const e = entry;
		entry.timer = setTimeout(() => {
			if (this.servers.get(key) !== e) return;
			this.servers.delete(key);
			void e.server.then((s) => s.kill()).catch(() => {});
		}, this.idleMs);
		entry.timer.unref?.();
		return entry.server;
	}

	/** stops every server; the next call starts fresh ones (config reload) */
	flush() {
		for (const e of this.servers.values()) {
			if (e.timer) clearTimeout(e.timer);
			void e.server.then((s) => s.kill()).catch(() => {});
		}
		this.servers.clear();
	}

	get size(): number {
		return this.servers.size;
	}
}

/** errors after a write: at most this many, and this long in all, so a broken file cannot flood the result */
const WRITE_ERRORS_MAX = 20;
const WRITE_ERRORS_CHARS = 2000;

/**
 * the language server's errors for a file write or edit just changed, as a note for the tool result;
 * nothing when the file has no server, the server is not installed, it finds no errors, or it does not
 * answer in time (the first start of a server can take a few seconds)
 */
export async function errorsAfterWrite(pool: LspPool, abs: string, cwd: string, timeoutMs = 8_000): Promise<string | undefined> {
	if (!pool.configFor(abs)) return undefined;
	let server: LspServer;
	try {
		server = await Promise.race([pool.get(abs, cwd), Bun.sleep(timeoutMs).then(() => Promise.reject(new Error("slow start")))]);
	} catch {
		return undefined;
	}
	let raw: any[];
	try {
		raw = await server.diagnosticsFor(server.sync(abs), timeoutMs, 300);
	} catch {
		return undefined;
	}
	const errors = raw.filter((d) => (d.severity ?? 1) === 1);
	if (!errors.length) return undefined;
	const rel = abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
	let body = errors
		.slice(0, WRITE_ERRORS_MAX)
		.map((d) => `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${String(d.message).split("\n")[0]}${d.code !== undefined ? ` (${d.source ?? ""}${d.code})` : ""}`)
		.join("\n");
	if (body.length > WRITE_ERRORS_CHARS) body = `${body.slice(0, WRITE_ERRORS_CHARS)}…`;
	const more = errors.length > WRITE_ERRORS_MAX ? `\n(${errors.length - WRITE_ERRORS_MAX} more; the lsp tool lists them all)` : "";
	return `${server.config.command[0]} reports ${errors.length} error${errors.length > 1 ? "s" : ""} in this file now:\n${body}${more}`;
}

function toLocation(l: any): LspLocation | undefined {
	const uri = l?.uri ?? l?.targetUri;
	const range = l?.range ?? l?.targetSelectionRange ?? l?.targetRange;
	if (!uri || !range) return undefined;
	return { path: uri.startsWith("file:") ? fileURLToPath(uri) : uri, line: range.start.line + 1, character: range.start.character + 1, endLine: range.end.line + 1, endCharacter: range.end.character + 1 };
}

function hoverText(contents: any): string {
	if (!contents) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
	return String(contents.value ?? "");
}

function flattenSymbols(items: any[], container?: string, out: LspSymbol[] = [], path = ""): LspSymbol[] {
	for (const s of items ?? []) {
		const range = s.selectionRange ?? s.range ?? s.location?.range;
		const p = s.location?.uri ? fileURLToPath(s.location.uri) : path;
		if (range) out.push({ name: s.name, kind: SYMBOL_KINDS[s.kind] ?? String(s.kind), path: p, line: range.start.line + 1, character: range.start.character + 1, ...(container ?? s.containerName ? { container: container ?? s.containerName } : {}) });
		if (s.children) flattenSymbols(s.children, s.name, out, p);
	}
	return out;
}

export function lspTool(pool: LspPool, env: ToolEnv): Tool {
	return defineTool({
		name: "lsp",
		label: "lsp",
		description:
			"ask the project's language server about a file: diagnostics (type errors and warnings as the compiler sees them now), definition, references and hover at a 1-based line and character, or the file's symbols. the server starts on first use and stays warm for a few minutes.",
		parameters: Type.Object({
			operation: Type.Union([Type.Literal("diagnostics"), Type.Literal("definition"), Type.Literal("references"), Type.Literal("hover"), Type.Literal("symbols")]),
			path: Type.String({ description: "file path, relative to the working directory or absolute" }),
			line: Type.Optional(Type.Number({ description: "1-based line, for definition, references and hover" })),
			character: Type.Optional(Type.Number({ description: "1-based column, for definition, references and hover" })),
		}),
		async execute(_id, params): Promise<ToolResult<Record<string, unknown>>> {
			const abs = resolvePath(env, params.path);
			if (!existsSync(abs)) throw new Error(`${shown(env, abs)} does not exist`);
			const server = await pool.get(abs, env.cwd);
			const uri = server.sync(abs);
			const where = (l: LspLocation) => `${shown(env, l.path)}:${l.line}:${l.character}`;
			const position = () => {
				if (params.line === undefined) throw new Error(`${params.operation} needs a line (and a character, default 1)`);
				return { textDocument: { uri }, position: { line: Math.max(0, params.line - 1), character: Math.max(0, (params.character ?? 1) - 1) } };
			};
			const done = (body: string, details: Record<string, unknown>) => {
				const c = clip(body, { keep: "head", spillDir: env.spillDir, label: "lsp" });
				return { content: [text(c.text + clipNote(c, "the first"))], details: { operation: params.operation, path: abs, server: server.config.command[0], root: server.root, ...details } };
			};
			switch (params.operation) {
				case "diagnostics": {
					const raw = await server.diagnosticsFor(uri);
					const diagnostics: LspDiagnostic[] = raw.map((d: any) => ({
						path: abs,
						line: d.range.start.line + 1,
						character: d.range.start.character + 1,
						endLine: d.range.end.line + 1,
						endCharacter: d.range.end.character + 1,
						severity: SEVERITY[d.severity ?? 1] || "error",
						message: String(d.message),
						...(d.source ? { source: d.source } : {}),
						...(d.code !== undefined ? { code: d.code } : {}),
					}));
					return done(diagnostics.length ? diagnostics.map((d) => `${where(d)}: ${d.severity} ${d.message}${d.code !== undefined ? ` (${d.source ?? ""}${d.code})` : ""}`).join("\n") : `no diagnostics in ${shown(env, abs)}`, { diagnostics });
				}
				case "definition":
				case "references": {
					const res = await server.request(params.operation === "definition" ? "textDocument/definition" : "textDocument/references", {
						...position(),
						...(params.operation === "references" ? { context: { includeDeclaration: true } } : {}),
					});
					const locations = (Array.isArray(res) ? res : res ? [res] : []).map(toLocation).filter((l): l is LspLocation => !!l);
					return done(locations.length ? locations.map(where).join("\n") : `no ${params.operation} found`, { locations });
				}
				case "hover": {
					const res = await server.request("textDocument/hover", position());
					const body = hoverText(res?.contents).trim();
					return done(body || "nothing to show here", { hover: body });
				}
				case "symbols": {
					const res = await server.request("textDocument/documentSymbol", { textDocument: { uri } });
					const symbols = flattenSymbols(res ?? [], undefined, [], abs);
					return done(symbols.length ? symbols.map((s) => `${where(s)} ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}`).join("\n") : "no symbols", { symbols });
				}
				default:
					throw new Error(`unknown operation ${String(params.operation)}`);
			}
		},
	});
}
