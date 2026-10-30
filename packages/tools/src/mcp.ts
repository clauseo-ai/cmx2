import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult, McpClient, Tool as McpTool } from "@earendil-works/pi-mcp";
import type { McpOAuthProvider, McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { Type } from "typebox";
import { imageParts } from "./image.ts";
import { clip, clipNote } from "./limits.ts";
import { type ImagePart, text, type TextPart, type Tool, type ToolResult } from "./types.ts";

/**
 * mcp servers from the profile, one connection per server shared by every session. their tools are
 * deferred: they stay out of the recorded prefix and the model loads them with tool_search, named
 * `<server>_<tool>`. a reload closes every connection and dials again. built on pi-mcp.
 */

/** one server in `mcp` of cmx2.jsonc. opencode's shape (`type: local | remote`, `environment`) reads too */
export interface McpServerConfig {
	/** a local server: argv, or a command with args */
	command?: string[] | string;
	args?: string[];
	env?: Record<string, string>;
	environment?: Record<string, string>;
	cwd?: string;
	/** a remote server over streamable http */
	url?: string;
	headers?: Record<string, string>;
	type?: "local" | "remote";
	/** false keeps it configured but not connected */
	enabled?: boolean;
	/** ms to wait for the connection and the tool list, default 15 s */
	timeout?: number;
	/** oauth for a remote server that asks for it; client id and secret when it does not register clients itself */
	oauth?: false | { clientId?: string; clientSecret?: string; scope?: string };
	/** which sessions see its tools: every session (default), or only top-level ones (no parent; forks count, spawned helpers do not) */
	sessions?: "all" | "root";
	/** true sends the calling session with every tools/call, in `_meta["cmx2/caller"]`; off by default, since it names sessions and folders */
	caller?: boolean;
	/** true puts the instructions the server sent at initialize in the turn context of sessions that see it; off by default */
	instructions?: boolean;
}

/** the most of a server's instructions that reaches the turn context, in characters */
export const MCP_INSTRUCTIONS_CAP = 4096;

/** the session behind a tools/call, sent as `_meta["cmx2/caller"]` to a server with `caller: true` */
export interface McpCaller {
	sessionID: string;
	/** the top of its agent tree; the session itself for a top-level session */
	rootID: string;
	parentID: string | null;
	/** 0 for a top-level session, 1 for its helpers, and so on */
	depth: number;
	/** its path in the agent tree, such as /root/worker_a */
	path: string;
	directory: string;
	/** the machine's short hostname */
	host: string;
	/** the model's tool call id */
	callID: string;
}

/** the session asking for tools: helpers skip servers offered to top-level sessions only, and caller servers learn who called */
export interface McpScope {
	child: boolean;
	caller: () => Omit<McpCaller, "callID">;
}

/** the `_meta` key the caller travels under */
export const CALLER_META = "cmx2/caller";

export type McpState = "connecting" | "connected" | "failed" | "disabled" | "needs_auth";

export interface McpStatus {
	name: string;
	transport: "stdio" | "http";
	status: McpState;
	tools: string[];
	error?: string;
	server?: { name: string; version: string };
	/** which sessions see its tools */
	sessions?: "all" | "root";
	/** whether its calls carry the calling session */
	caller?: boolean;
	/** whether its instructions reach the turn context (the entry says so and the server sent some) */
	instructions?: boolean;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/**
 * a server that closes its connection is dialled again after these waits, one per try; the last one
 * repeats until REDIAL_TRIES tries have failed. a stdio server is a process that can go away (xcode's
 * mcpbridge exits when xcode's own service quits) and comes back as soon as it is started again
 */
const REDIAL_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const REDIAL_TRIES = 12;

/** provider tool names allow 64 characters of [A-Za-z0-9_-] */
export function mcpToolName(server: string, tool: string): string {
	return `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** where a remote server's oauth credentials live between daemon runs */
export class FileOAuthStore implements McpOAuthStateStore {
	constructor(readonly path: string) {}
	load(): McpOAuthState | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			return JSON.parse(readFileSync(this.path, "utf8")) as McpOAuthState;
		} catch {
			return undefined;
		}
	}
	save(state: McpOAuthState) {
		mkdirSync(join(this.path, ".."), { recursive: true });
		writeFileSync(this.path, JSON.stringify(state, null, 1), { mode: 0o600 });
	}
}

/** the redirect the cli's `cmx2 mcp auth` flow listens on; the daemon only refreshes tokens, so it never needs the callback */
export const OAUTH_REDIRECT = "http://127.0.0.1:19876/callback";

/** pi-mcp loads on the first connection, so a daemon without mcp servers never carries it */
const lib = () => Promise.all([import("@earendil-works/pi-mcp"), import("@earendil-works/pi-mcp/oauth")]).then(([core, oauth]) => ({ ...core, ...oauth }));

export async function oauthProvider(name: string, config: McpServerConfig, dataDir: string, onRedirect: (url: URL) => void = () => {}): Promise<McpOAuthProvider> {
	const { McpOAuthProvider } = await lib();
	const o = config.oauth || {};
	return new McpOAuthProvider({
		serverUrl: config.url!,
		redirectUrl: OAUTH_REDIRECT,
		clientMetadata: { client_name: "cmx2", ...(o.scope ? { scope: o.scope } : {}) },
		...(o.clientId ? { clientId: o.clientId } : {}),
		...(o.clientSecret ? { clientSecret: o.clientSecret } : {}),
		store: new FileOAuthStore(join(dataDir, "mcp-auth", `${name}.json`)),
		onRedirect,
	});
}

interface Entry {
	name: string;
	key: string;
	config: McpServerConfig;
	status: McpStatus;
	client?: McpClient;
	tools: Tool[];
	/** the server's tool list as it sent it, for wrappers bound to a caller */
	listed: McpTool[];
	/** what the server sent as `instructions` at initialize */
	instructions?: string;
	toLlm?: ToLlm;
	ready: Promise<void>;
	/** failed redials since the connection was last up; 0 for a first dial */
	tries: number;
	/** the next redial, while one is waiting */
	timer?: ReturnType<typeof setTimeout>;
}

export class McpPool {
	private entries = new Map<string, Entry>();
	/** wrappers bound to one session's caller, per server, rebuilt when the server's tool list changes */
	private bound = new WeakMap<McpScope, Map<string, { from: Tool[]; tools: Tool[] }>>();

	constructor(private readonly opts: { dataDir: string; version: string; cwd: string; onChange?: (s: McpStatus) => void; log?: (line: string) => void; redialMs?: number[] }) {}

	/** matches the connections to a config: new or changed servers dial, removed ones close */
	configure(servers: Record<string, McpServerConfig> | undefined) {
		const want = new Map(Object.entries(servers ?? {}).map(([name, c]) => [name, JSON.stringify(c)]));
		for (const [name, e] of this.entries) {
			if (want.get(name) !== e.key) {
				this.entries.delete(name);
				clearTimeout(e.timer);
				void e.client?.close().catch(() => {});
			}
		}
		for (const [name, config] of Object.entries(servers ?? {})) {
			if (!this.entries.has(name)) this.entries.set(name, this.dial(name, config));
		}
	}

	/** every connection closed and dialled again (`/global/reload`) */
	async reconnect(servers: Record<string, McpServerConfig> | undefined, waitMs = CONNECT_TIMEOUT_MS): Promise<McpStatus[]> {
		const old = [...this.entries.values()];
		this.entries.clear();
		for (const e of old) clearTimeout(e.timer);
		await Promise.all(old.map((e) => e.client?.close().catch(() => {})));
		this.configure(servers);
		await this.ready(waitMs);
		return this.status();
	}

	/** waits for servers still connecting, up to a limit; a slow server keeps connecting after */
	async ready(waitMs = CONNECT_TIMEOUT_MS) {
		await Promise.race([Promise.all([...this.entries.values()].map((e) => e.ready)), Bun.sleep(waitMs)]);
	}

	status(): McpStatus[] {
		return [...this.entries.values()].map((e) => ({ ...e.status, tools: [...e.status.tools] }));
	}

	/**
	 * the tools of the connected servers among these names (a session's config), as deferred tools. with a
	 * scope, a helper gets nothing from a server offered to top-level sessions only, and a server with
	 * `caller: true` gets tools that send the scope's caller. without one, every server, and no caller
	 */
	toolsFor(names?: string[], scope?: McpScope): Tool[] {
		const out: Tool[] = [];
		for (const e of this.entries.values()) {
			if (e.status.status !== "connected" || (names && !names.includes(e.name))) continue;
			if (!scope) out.push(...e.tools);
			else if (!(scope.child && e.config.sessions === "root")) out.push(...(e.config.caller === true ? this.boundTools(e, scope) : e.tools));
		}
		return out;
	}

	/**
	 * turn-context entries for the servers among these names whose profile entry says `instructions: true`:
	 * `["mcp:<name>", text]` when the server is connected, sent instructions and is offered to this scope;
	 * `["mcp:<name>", undefined]` otherwise, so the session drops the entry and sends it again if it comes back
	 */
	instructionsFor(names?: string[], scope?: McpScope): Array<[string, string | undefined]> {
		const out: Array<[string, string | undefined]> = [];
		for (const e of this.entries.values()) {
			if (e.config.instructions !== true || (names && !names.includes(e.name))) continue;
			const offered = e.status.status === "connected" && !!e.instructions && !(scope?.child && e.config.sessions === "root");
			out.push([`mcp:${e.name}`, offered ? mcpInstructionsText(e.name, e.instructions!) : undefined]);
		}
		return out;
	}

	/** a caller server's tools for one scope, made once per tool list so a session's every step reuses them */
	private boundTools(e: Entry, scope: McpScope): Tool[] {
		let byServer = this.bound.get(scope);
		if (!byServer) this.bound.set(scope, (byServer = new Map()));
		const hit = byServer.get(e.name);
		if (hit && hit.from === e.tools) return hit.tools;
		const tools = e.listed.map((t) => wrap(e.name, t, () => this.clientOf(e.name), e.toLlm!, scope.caller));
		byServer.set(e.name, { from: e.tools, tools });
		return tools;
	}

	async close() {
		const all = [...this.entries.values()];
		this.entries.clear();
		for (const e of all) clearTimeout(e.timer);
		await Promise.all(all.map((e) => e.client?.close().catch(() => {})));
	}

	private set(e: Entry, patch: Partial<McpStatus>) {
		Object.assign(e.status, patch);
		if (!patch.error) delete e.status.error;
		this.opts.onChange?.({ ...e.status });
	}

	/**
	 * a dropped connection, or a redial that failed: the server is dialled again after a wait, unless the
	 * entry was replaced or closed meanwhile, it needs a sign-in, or the tries ran out
	 */
	private redial(e: Entry, why: string) {
		if (this.entries.get(e.name) !== e) return;
		const waits = this.opts.redialMs ?? REDIAL_MS;
		if (e.tries >= REDIAL_TRIES) {
			this.set(e, { status: "failed", error: `${why}; gave up after ${REDIAL_TRIES} tries to reconnect (a reload dials again)` });
			this.opts.log?.(`cmx2: mcp ${e.name}: ${e.status.error}`);
			return;
		}
		const wait = waits[Math.min(e.tries, waits.length - 1)]!;
		this.set(e, { status: "failed", error: `${why}; reconnecting in ${Math.max(1, Math.round(wait / 1000))} s` });
		this.opts.log?.(`cmx2: mcp ${e.name}: ${e.status.error}`);
		e.timer = setTimeout(() => {
			e.timer = undefined;
			if (this.entries.get(e.name) !== e) return;
			this.entries.set(e.name, this.dial(e.name, e.config, e.tries + 1));
		}, wait);
		(e.timer as { unref?: () => void }).unref?.();
	}

	private dial(name: string, config: McpServerConfig, tries = 0): Entry {
		const remote = config.type === "remote" || (!!config.url && !config.command);
		const e: Entry = {
			name,
			key: JSON.stringify(config),
			config,
			status: { name, transport: remote ? "http" : "stdio", status: "connecting", tools: [], sessions: config.sessions === "root" ? "root" : "all", caller: config.caller === true },
			tools: [],
			listed: [],
			ready: Promise.resolve(),
			tries,
		};
		if (config.enabled === false) {
			e.status.status = "disabled";
			return e;
		}
		e.ready = this.connect(e, remote).catch(async (err) => {
			// with saved tokens an expired sign-in is an oauth error; without any, the server's 401 is a plain auth error
			const { McpOAuthAuthorizationRequiredError, McpAuthRequiredError } = await lib();
			const needsAuth = err instanceof McpOAuthAuthorizationRequiredError || err instanceof McpAuthRequiredError;
			// a redial that failed waits and tries again; a first dial that fails is a config problem and stays failed
			if (tries > 0 && !needsAuth) return this.redial(e, err instanceof Error ? err.message : String(err));
			this.set(e, {
				status: needsAuth ? "needs_auth" : "failed",
				error: needsAuth ? `${name} needs you to sign in: run cmx2 mcp auth ${name} on this machine` : err instanceof Error ? err.message : String(err),
			});
			this.opts.log?.(`cmx2: mcp ${name}: ${e.status.error}`);
		});
		return e;
	}

	private async connect(e: Entry, remote: boolean) {
		const { name, config } = e;
		const { McpClient, StdioTransport, StreamableHttpTransport, adaptOAuthProvider, toLlmContent } = await lib();
		let stderr = "";
		const transport = remote
			? new StreamableHttpTransport({
					url: config.url!,
					...(config.headers ? { headers: config.headers } : {}),
					...(config.oauth === false ? {} : existsSync(join(this.opts.dataDir, "mcp-auth", `${name}.json`)) || config.oauth ? { authProvider: adaptOAuthProvider(await oauthProvider(name, config, this.opts.dataDir)) } : {}),
				})
			: (() => {
					const argv = Array.isArray(config.command) ? config.command : [config.command ?? "", ...(config.args ?? [])];
					if (!argv[0]) throw new Error(`mcp ${name} has neither a command nor a url`);
					return new StdioTransport({
						command: argv[0],
						args: [...argv.slice(1), ...(Array.isArray(config.command) ? (config.args ?? []) : [])],
						cwd: config.cwd ?? this.opts.cwd,
						env: { ...(config.environment ?? {}), ...(config.env ?? {}) },
						inheritEnv: true,
						stderr: "pipe",
						onStderr: (chunk) => {
							stderr = (stderr + chunk).slice(-2000);
						},
					});
				})();
		const client = new McpClient({ name: "cmx2", version: this.opts.version, requestTimeoutMs: CALL_TIMEOUT_MS });
		e.client = client;
		const timeout = config.timeout ?? CONNECT_TIMEOUT_MS;
		const guard = <T>(p: Promise<T>, what: string) =>
			Promise.race([p, Bun.sleep(timeout).then(() => Promise.reject(new Error(`${what} took longer than ${timeout / 1000} s${stderr.trim() ? `; it said: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`)))]);
		try {
			const init = await guard(client.connect(transport), `connecting to ${name}`);
			const listed = await guard(client.listTools(), `listing ${name}'s tools`);
			const connectedAt = Date.now();
			// the server says when its tools change; the list is read again
			client.onNotification("notifications/tools/list_changed", () => void client.listTools().then((t) => this.adopt(e, t, toLlmContent)).catch(() => {}));
			client.onClose(() => {
				if (this.entries.get(name) !== e) return;
				// a connection that held for a while starts the waits over; one that drops at once keeps backing off
				if (Date.now() - connectedAt > 30_000) e.tries = 0;
				this.redial(e, `${name} closed the connection${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
			});
			this.adopt(e, listed, toLlmContent);
			e.status.server = { name: init.serverInfo.name, version: init.serverInfo.version };
			e.instructions = typeof init.instructions === "string" && init.instructions.trim() ? init.instructions.trim() : undefined;
			e.status.instructions = config.instructions === true && !!e.instructions;
			this.set(e, { status: "connected" });
		} catch (err) {
			void client.close().catch(() => {});
			throw err;
		}
	}

	private adopt(e: Entry, listed: McpTool[], toLlm: ToLlm) {
		e.listed = listed;
		e.toLlm = toLlm;
		e.tools = listed.map((t) => wrap(e.name, t, () => this.clientOf(e.name), toLlm));
		e.status.tools = listed.map((t) => t.name);
	}

	/** a server's live connection; a session holds tools across reloads, so they look it up at each call */
	private clientOf(name: string): McpClient {
		const e = this.entries.get(name);
		if (!e?.client || e.status.status !== "connected") throw new Error(`mcp server ${name} is ${e ? e.status.status : "no longer configured"}${e?.status.error ? `: ${e.status.error}` : ""}`);
		return e.client;
	}
}

/**
 * a server's instructions as one turn-context block in <mcp-instructions server="name">, cut at MCP_INSTRUCTIONS_CAP
 * characters with a note saying so. every "</" in the server's text becomes "<\\/", so no closing tag it sends
 * (</mcp-instructions>, </system-reminder>) can end the block and make what follows read as cmx2's or the person's words
 */
export function mcpInstructionsText(server: string, text: string): string {
	const cut = text.length > MCP_INSTRUCTIONS_CAP ? `${text.slice(0, MCP_INSTRUCTIONS_CAP)}\n(cut at ${MCP_INSTRUCTIONS_CAP} of ${text.length} characters)` : text;
	const body = cut.replaceAll("</", "<\\/");
	return `<mcp-instructions server="${server}">\ninstructions from mcp server ${server} (its tools load through tool_search as ${mcpToolName(server, "")}*):\n${body}\n</mcp-instructions>`;
}

/** one mcp tool as a cmx2 tool: same schema, output under the shared limits */
type ToLlm = typeof import("@earendil-works/pi-mcp").toLlmContent;

/**
 * what a tool call returned, as content parts: text under the shared limits, images through the same
 * edge and byte limits as every other image (an unreadable one becomes a placeholder line)
 */
export async function mcpContent(result: Parameters<ToLlm>[0], server: string, tool: string, toLlmContent: ToLlm): Promise<Array<TextPart | ImagePart>> {
	const content: Array<TextPart | ImagePart> = [];
	for (const c of toLlmContent(result)) {
		if (c.type === "image") content.push(...(await imageParts(new Uint8Array(Buffer.from(c.data, "base64")), c.mimeType, `from mcp ${server} ${tool}`)));
		else {
			const cut = clip(c.text, { keep: "head", label: `mcp-${server}` });
			content.push(text(cut.text + clipNote(cut, "the first")));
		}
	}
	if (!content.length) content.push(text("(the tool returned nothing)"));
	return content;
}

/**
 * what a tools/call answered, checked the way pi-mcp's callTool checks it: an object, content a list when
 * present (servers that send only structuredContent leave it out), structuredContent an object
 */
function callResult(value: unknown): CallToolResult {
	const v = value as Record<string, unknown> | null;
	if (!v || typeof v !== "object" || Array.isArray(v) || (v.content !== undefined && !Array.isArray(v.content))) throw new Error("the server answered tools/call with no content list");
	if (v.structuredContent !== undefined && (typeof v.structuredContent !== "object" || v.structuredContent === null || Array.isArray(v.structuredContent))) throw new Error("the server answered tools/call with structuredContent that is not an object");
	return (v.content === undefined ? { ...v, content: [] } : v) as unknown as CallToolResult;
}

/**
 * one server tool as a deferred cmx2 tool. a server the user configured is trusted, so its `readOnlyHint` stands (the spec treats annotations as untrusted otherwise).
 * with `caller`, each call carries the calling session and the call id in `_meta["cmx2/caller"]`; the model's arguments, a `_meta` key among them, stay in `arguments`
 */
export function wrap(server: string, tool: McpTool, client: () => McpClient, toLlmContent: ToLlm, caller?: () => Omit<McpCaller, "callID">): Tool {
	const schema = (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>;
	return {
		name: mcpToolName(server, tool.name),
		label: tool.title ?? tool.name,
		description: `${tool.description?.trim() || tool.name} (mcp server ${server}, tool ${tool.name})`,
		parameters: Type.Unsafe({ ...schema, type: "object", properties: (schema.properties as object) ?? {} }),
		readOnly: tool.annotations?.readOnlyHint === true,
		async execute(id, params, signal): Promise<ToolResult<Record<string, unknown>>> {
			const args = (params ?? {}) as Record<string, unknown>;
			const options = { signal, timeoutMs: CALL_TIMEOUT_MS };
			const result = caller
				? callResult(await client().request("tools/call", { name: tool.name, arguments: args, _meta: { [CALLER_META]: { ...caller(), callID: id } } }, options))
				: await client().callTool(tool.name, args, options);
			const content = await mcpContent(result, server, tool.name, toLlmContent);
			return { content, details: { server, tool: tool.name }, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), isError: result.isError === true };
		},
	};
}

/**
 * the browser sign-in for a remote server (`cmx2 mcp auth`): a callback listener on this machine, the
 * authorization url handed to `onUrl`, the code exchanged for tokens, which land where the daemon reads them
 */
export async function mcpSignIn(name: string, config: McpServerConfig, dataDir: string, opts: { version: string; onUrl: (url: URL) => void }): Promise<{ already: boolean; tools: number }> {
	const { authorizeMcp, OAuthCallbackServer, McpClient, StreamableHttpTransport, adaptOAuthProvider, McpOAuthAuthorizationRequiredError } = await lib();
	const redirect = new URL(OAUTH_REDIRECT);
	const callback = await OAuthCallbackServer.listen({ host: redirect.hostname, port: Number(redirect.port), path: redirect.pathname, timeoutMs: 5 * 60_000 });
	const provider = await oauthProvider(name, config, dataDir, opts.onUrl);
	const dial = async () => {
		const client = new McpClient({ name: "cmx2", version: opts.version });
		await client.connect(new StreamableHttpTransport({ url: config.url!, ...(config.headers ? { headers: config.headers } : {}), authProvider: adaptOAuthProvider(provider) }));
		return client;
	};
	let already = true;
	let client: McpClient;
	try {
		try {
			client = await dial();
		} catch (e) {
			if (!(e instanceof McpOAuthAuthorizationRequiredError)) throw e;
			already = false;
			const { code } = await callback.waitForCallback(await provider.state());
			await authorizeMcp(provider, { serverUrl: config.url!, authorizationCode: code });
			client = await dial();
		}
		const tools = (await client.listTools()).length;
		await client.close();
		return { already, tools };
	} finally {
		await (callback as unknown as { close?: () => Promise<void> }).close?.();
	}
}
