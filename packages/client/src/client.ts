// generated from packages/contract/src/manifest.ts by packages/contract/src/generate.ts. edit the manifest, then run `bun run contract`.

import { type Decoded, decodeFrame, type SessionStatusIdle, type SessionStatusBusy, type SessionStatusRetry, type SessionStatus, type ToolStatePending, type ToolStateRunning, type ToolStateCompleted, type ToolStateError, type ToolState, type TextPart, type ReasoningPart, type ToolPart, type FilePart, type CompactionPart, type StepStartPart, type StepFinishPart, type PatchPart, type SubtaskPart, type FileDiff, type SessionInfo, type MessageInfo, type Part, type PermissionRequest, type QuestionOption, type QuestionInfo, type QuestionRequest, type StepRow, type ErrorBody, type PtyInfo, type ProcessInfo, type McpStatus } from "./events.ts";

export interface ClientOptions {
	/** e.g. http://127.0.0.1:4097 */
	baseUrl: string;
	/** basic auth password (CMX2_SERVER_PASSWORD on the daemon) */
	password?: string;
	/** basic auth user, default cmx2 */
	user?: string;
	/** default directory for scoped routes (sent as x-cmx2-directory) */
	directory?: string;
	/** a fetch implementation; pass the daemon's in-process handler to test without a socket */
	fetch?: (request: Request) => Promise<Response>;
}

/** a non-2xx answer: the daemon's typed error body */
export class Cmx2Error extends Error {
	constructor(
		readonly status: number,
		readonly name: string,
		readonly data: { message: string; [key: string]: unknown },
	) {
		super(data.message);
	}
}

export interface CallOptions {
	directory?: string;
	signal?: AbortSignal;
	/** event streams: resume after this cursor (<epoch>:<seq>), sent as Last-Event-ID */
	lastEventId?: string;
}

export interface Page<T> {
	data: T;
	/** the x-next-cursor header, when the route pages that way */
	next?: string;
	/** the x-cmx2-seq header on reads: the cursor of the last event this state includes */
	seq?: string;
}

export interface BytesOptions extends CallOptions {
	/** an etag from an earlier answer: if it still holds the daemon answers 304 and the result has notModified and no data */
	ifNoneMatch?: string;
}

/** a file's bytes with the content type and etag the daemon sent; notModified (and no data) after a 304 */
export type FileBytes = { data: Uint8Array; contentType: string; etag?: string; notModified?: undefined } | { notModified: true; etag?: string; data?: undefined; contentType?: undefined };

/** one decoded frame and the sse id it came with (logged events only) */
export type StreamFrame = Decoded & { cursor?: string };

function sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<{ id?: string; data: string }> {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					buf += decoder.decode(value, { stream: true });
					let at: number;
					while ((at = buf.indexOf("\n\n")) >= 0) {
						const block = buf.slice(0, at);
						buf = buf.slice(at + 2);
						const lines = block.split("\n");
						const data = lines
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).replace(/^ /, ""))
							.join("\n");
						const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
						if (data) yield { ...(id ? { id } : {}), data };
					}
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}

export function createClient(opts: ClientOptions) {
	const doFetch = opts.fetch ?? ((r: Request) => fetch(r));
	const base = opts.baseUrl.replace(/\/$/, "");
	function headers(directory?: string): Record<string, string> {
		const h: Record<string, string> = {};
		if (opts.password) h.authorization = `Basic ${btoa(`${opts.user ?? "cmx2"}:${opts.password}`)}`;
		const d = directory ?? opts.directory;
		if (d) h["x-cmx2-directory"] = encodeURIComponent(d);
		return h;
	}
	async function call<T>(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown, o: CallOptions = {}): Promise<Page<T>> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
		const url = `${base}${path}${qs.size ? `?${qs}` : ""}`;
		const h = headers(o.directory);
		if (body !== undefined) h["content-type"] = "application/json";
		const res = await doFetch(new Request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal }));
		const text = await res.text();
		const json = text ? JSON.parse(text) : undefined;
		if (!res.ok) throw new Cmx2Error(res.status, json?.name ?? "UnknownError", json?.data ?? { message: text || res.statusText });
		const next = res.headers.get("x-next-cursor") ?? undefined;
		const seq = res.headers.get("x-cmx2-seq") ?? undefined;
		return { data: json as T, ...(next ? { next } : {}), ...(seq ? { seq } : {}) };
	}
	/** a route whose answer is a file's bytes: the bytes with the type and etag they came with; a 304 has no bytes */
	async function callBytes(path: string, query: Record<string, unknown> | undefined, o: BytesOptions = {}): Promise<FileBytes> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
		const h = headers(o.directory);
		if (o.ifNoneMatch) h["if-none-match"] = o.ifNoneMatch;
		const res = await doFetch(new Request(`${base}${path}${qs.size ? `?${qs}` : ""}`, { headers: h, signal: o.signal }));
		const etag = res.headers.get("etag") ?? undefined;
		if (res.status === 304) return { notModified: true, ...(etag ? { etag } : {}) };
		if (!res.ok) {
			const text = await res.text();
			let json: { name?: string; data?: { message: string; [key: string]: unknown } } | undefined;
			try {
				json = text ? JSON.parse(text) : undefined;
			} catch {}
			throw new Cmx2Error(res.status, json?.name ?? "UnknownError", json?.data ?? { message: text || res.statusText });
		}
		return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream", ...(etag ? { etag } : {}) };
	}
	async function* stream(path: string, o: CallOptions = {}): AsyncIterable<StreamFrame> {
		const h: Record<string, string> = { ...headers(o.directory), accept: "text/event-stream" };
		if (o.lastEventId) h["last-event-id"] = o.lastEventId;
		const res = await doFetch(new Request(`${base}${path}`, { headers: h, signal: o.signal }));
		if (!res.ok || !res.body) throw new Cmx2Error(res.status, "StreamError", { message: `event stream answered ${res.status}` });
		for await (const f of sseLines(res.body)) yield { ...decodeFrame(f.data), ...(f.id ? { cursor: f.id } : {}) };
	}
	return {
		/** liveness and version */
		health: (o?: CallOptions) =>
			call<{
				healthy: true;
				version: string;
				name: "cmx2";
				contract: number;
				pid: number;
			}>("GET", "/global/health", undefined, undefined, o),
		/** every event on the host, wrapped in {directory, project, payload} */
		globalEvents: (o?: CallOptions) => stream("/global/event", o),
		/** events for one directory, bare payloads */
		events: (o?: CallOptions) => stream("/event", o),
		/** list the directories inside a directory (default home) */
		browse: (query: {
			/** absolute, ~ or ~/... */
			path?: string;
			hidden?: "true" | "false";
		} = {}, o?: CallOptions) =>
			call<{
				path: string;
				parent: string | null;
				home: string;
				entries: Array<{
					name: string;
					absolute: string;
					hidden: boolean;
					git: boolean;
				}>;
			}>("GET", "/global/fs", query, undefined, o),
		/** re-read config from disk, flush skills, agents, commands, the model list and language servers, and reconnect mcp servers (the answer waits up to 15 s for them); sessions are untouched */
		reload: (o?: CallOptions) =>
			call<{
				instances: number;
				changed: Array<string>;
				flushed: Array<string>;
				mcp: Array<McpStatus>;
			}>("POST", "/global/reload", undefined, undefined, o),
		/** the profile's mcp servers and how each is doing */
		mcp: (o?: CallOptions) =>
			call<Array<McpStatus>>("GET", "/mcp", undefined, undefined, o),
		/** abort turns, close streams and exit cleanly so the supervisor starts a fresh daemon */
		restart: (o?: CallOptions) =>
			call<true>("POST", "/global/restart", undefined, undefined, o),
		/** resident memory and live sessions, for the budget check */
		memory: (query: {
			/** run a full garbage collection before measuring */
			gc?: "true" | "false";
		} = {}, o?: CallOptions) =>
			call<{
				rss: number;
				heapUsed: number;
				heapTotal: number;
				external: number;
				live_sessions: number;
				uptime_s: number;
				/** published events that failed their manifest schema (counted when the daemon runs with event checks on) */
				contract_violations: number;
			}>("GET", "/global/memory", query, undefined, o),
		/** the machine the daemon runs on: os, model, cpu and live load, memory, the data volume's disk space and uptimes. static fields are read once; live ones on each request without spawning a process */
		system: (o?: CallOptions) =>
			call<{
				os: {
					/** process.platform: darwin, linux, win32, ... */
					platform: string;
					/** macOS, Ubuntu, Debian, ... */
					name: string;
					/** the os version (26.1, 24.04); empty when unknown */
					version: string;
					kernel: string;
					/** arm64, x64, ... */
					arch: string;
				};
				machine: {
					/** a mac's family (Mac mini, MacBook Pro), else the dmi product name (Google Compute Engine) */
					model: string | null;
					/** a mac's model identifier (Mac16,11); null elsewhere */
					identifier: string | null;
					/** a vm or cloud instance */
					virtual: boolean;
				};
				cpu: {
					model: string;
					/** logical cores */
					cores: number;
					/** load average over 1, 5 and 15 minutes */
					load: Array<number>;
				};
				memory: {
					/** bytes */
					total: number;
					/** bytes usable without swapping: MemAvailable on linux; on macos physical memory less app, wired and compressed memory, as activity monitor counts it */
					available: number;
				};
				disk: {
					/** mount point of the volume holding the daemon's data */
					path: string;
					total: number;
					/** bytes free to an unprivileged user */
					available: number;
				} | null;
				/** host uptime in seconds */
				uptime: number;
				daemon: {
					/** bytes */
					rss: number;
					/** seconds */
					uptime: number;
				};
				/** epoch ms the live fields were read */
				at: number;
			}>("GET", "/global/system", undefined, undefined, o),
		/** projects that have sessions or checkouts, newest activity first; worktrees=true adds each project's checkouts */
		projects: (query: {
			worktrees?: "true" | "false";
		} = {}, o?: CallOptions) =>
			call<Array<{
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
			}>>("GET", "/project", query, undefined, o),
		/** a checkout of the directory's repository on a new branch (cmx2/<name>), from what the directory has checked out unless from says otherwise. answers once the files are in place; setup commands run after, then worktree.ready (or worktree.failed). wait=true answers after setup instead. refusals are 409 WorktreeRefusedError with data.reason cap or disk; outside a repository 400 WorktreeNotGitError */
		createWorktree: (body: {
			/** lowercase words; made up when omitted */
			name?: string;
			/** a branch or commit; what the directory has checked out when omitted */
			from?: string;
			/** one more setup command after the project's worktree.setup */
			startCommand?: string;
			/** answer after the setup commands, with their results */
			wait?: boolean;
		}, o?: CallOptions) =>
			call<{
				name: string;
				/** absolute; sessions homed here fold under project */
				directory: string;
				/** cmx2/<name> */
				branch?: string;
				/** the branch it was made from and merges back into */
				base?: string;
				/** the repository's main checkout */
				project: string;
				/** clone: an apfs copy-on-write clone of the working tree (macos); git: git worktree add plus carried files */
				mode: "clone" | "git";
				/** why the clone was not used when the profile wanted it */
				fallback?: string;
				/** how long making the checkout took, setup excluded */
				ms: number;
				/** the directory it was made from */
				source: string;
				/** the commit it starts at */
				from: string;
				/** untracked paths brought along (directories end in /) */
				carried: Array<string>;
				/** secret-shaped files left behind because worktree.carry does not name them */
				left: Array<string>;
				/** package stores linked to the source's (the git path) */
				linked: Array<string>;
				/** the setup commands, when the caller waited for them */
				setup?: Array<{
					command: string;
					ok: boolean;
					exitCode: number | null;
					ms: number;
					/** the tail of stdout and stderr, 4000 characters at most */
					log: string;
					timedOut?: boolean;
				}>;
			}>("POST", "/experimental/worktree", undefined, body, o),
		/** the checkouts of the directory's repository */
		worktrees: (o?: CallOptions) =>
			call<Array<{
				name: string;
				/** absolute; sessions homed here fold under project */
				directory: string;
				/** cmx2/<name> */
				branch?: string;
				/** the branch it was made from and merges back into */
				base?: string;
				/** the repository's main checkout */
				project: string;
			}>>("GET", "/experimental/worktree", undefined, undefined, o),
		/** what a checkout's branch holds beyond its base: commits, files with line counts, the patch, and whether it merges clean */
		worktreeDiff: (query: {
			/** the checkout */
			directory: string;
		}, o?: CallOptions) =>
			call<{
				branch?: string;
				base: string;
				baseRef: string;
				/** on the branch beyond its base */
				commits: number;
				/** uncommitted changes in the checkout (merge refuses until they are committed) */
				dirty: boolean;
				/** false when the branch conflicts with its base */
				mergeable?: boolean;
				additions: number;
				deletions: number;
				files: Array<{
					path: string;
					status: "added" | "deleted" | "modified" | "renamed";
					additions: number;
					deletions: number;
				}>;
				/** the unified patch of the commits, 2 MB at most */
				diff: string;
				truncated: boolean;
			}>("GET", "/experimental/worktree/diff", query, undefined, o),
		/** squash-merge a checkout's branch into its base on this machine, then remove the checkout and the branch; never pushes. 409 BusyError while a session in the checkout runs a turn (the run lock), WorktreeMergeConflictError with data.files when the branches conflict, WorktreeRefusedError with data.reason dirty, nothing, detached or target_dirty */
		mergeWorktree: (body: {
			/** the checkout */
			directory: string;
			/** the squash commit's message; made from the branch's commits when omitted */
			message?: string;
		}, o?: CallOptions) =>
			call<{
				merged: true;
				commit: string;
				base: string;
				branch: string;
				commits: number;
				/** where the base is checked out; the merge ran there */
				into?: string;
				/** processes stopped because they ran in the checkout */
				stopped: Array<string>;
			}>("POST", "/experimental/worktree/merge", undefined, body, o),
		/** remove a checkout and its branch without merging. when it held work, its last state (uncommitted files included) is kept first as a commit under refs/cmx2/rescue/<name>. 409 BusyError while a session in the checkout runs a turn */
		discardWorktree: (body: {
			/** the checkout */
			directory: string;
		}, o?: CallOptions) =>
			call<{
				discarded: true;
				snapshot?: string;
				ref?: string;
				stopped: Array<string>;
			}>("POST", "/experimental/worktree/discard", undefined, body, o),
		/** sessions, newest updated first (ties by id, descending); the next page's `before` comes back in x-next-cursor */
		listSessions: (query: {
			directory?: string;
			/** list the directory's whole project, not just the directory */
			scope?: "project";
			roots?: "true" | "false";
			/** title contains */
			search?: string;
			/** only sessions updated at or after this time (ms) */
			start?: string;
			limit?: string;
			/** x-next-cursor from the previous page: `<updated_at>:<id>` continues exactly after that row, so sessions sharing one updated time are not dropped at a page edge; a bare `<updated_at>` (what version 5 answered) pages strictly older than it */
			before?: string;
		} = {}, o?: CallOptions) =>
			call<Array<SessionInfo>>("GET", "/session", query, undefined, o),
		/** sessions by creation time, cursor-paginated; an empty page is the end */
		pageSessions: (query: {
			directory?: string;
			/** list the directory's whole project, not just the directory */
			scope?: "project";
			roots?: "true" | "false";
			/** title contains */
			search?: string;
			/** only sessions updated at or after this time (ms) */
			start?: string;
			limit?: string;
			order?: "asc" | "desc";
			/** a cursor from a previous page; no other filter may be sent with it */
			cursor?: string;
		} = {}, o?: CallOptions) =>
			call<{
				items: Array<SessionInfo>;
				cursor: {
					previous?: string;
					next?: string;
				};
			}>("GET", "/api/session", query, undefined, o),
		/** run state of every non-idle session; with parked=true, parked sessions too (off by default: boxbox v1 reads any entry as busy) */
		sessionStatus: (query: {
			parked?: "true" | "false";
		} = {}, o?: CallOptions) =>
			call<Record<string, {
				type: "idle";
				/** when this state began (ms); on a parked session, when it parked */
				since?: number;
				/** prompts an abort left waiting (GET /session/:id/queue lists them; loop runs them) */
				queued?: number;
				/** the turn has ended and the session waits on these; a report or a job notice wakes it */
				parked?: {
					/** agents under it still working or queued */
					agents: number;
					/** background jobs that will notify it */
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
			}>>("GET", "/session/status", query, undefined, o),
		/** create a session in a directory */
		createSession: (body: {
			directory?: string;
			title?: string;
			/** provider/model-id */
			model?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
			nudge?: boolean;
			turn_messages?: "auto" | "system" | "user-part";
			cache_ttl?: "5m" | "1h";
		}, o?: CallOptions) =>
			call<SessionInfo>("POST", "/session", undefined, body, o),
		/** one session */
		getSession: (params: { sessionID: string }, o?: CallOptions) =>
			call<SessionInfo>("GET", `/session/${encodeURIComponent(params.sessionID)}`, undefined, undefined, o),
		/** rename a session, or archive it with time.archived */
		updateSession: (params: { sessionID: string }, body: {
			title?: string;
			time?: {
				archived?: number;
			};
		}, o?: CallOptions) =>
			call<SessionInfo>("PATCH", `/session/${encodeURIComponent(params.sessionID)}`, undefined, body, o),
		/** end a session: abort its turn, stop its processes (keep'd ones stay) and archive it. nothing is deleted; listings leave it out */
		deleteSession: (params: { sessionID: string }, o?: CallOptions) =>
			call<true>("DELETE", `/session/${encodeURIComponent(params.sessionID)}`, undefined, undefined, o),
		/** sessions this one started (its subagents), newest first */
		children: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<SessionInfo>>("GET", `/session/${encodeURIComponent(params.sessionID)}/children`, undefined, undefined, o),
		/** the agent tree this session belongs to: live agents, then the newest closed ones */
		roster: (params: { sessionID: string }, query: {
			path_prefix?: string;
		} = {}, o?: CallOptions) =>
			call<{
				root: string;
				/** this session's path */
				self: string;
				agents: Array<{
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
				}>;
			}>("GET", `/session/${encodeURIComponent(params.sessionID)}/agents`, query, undefined, o),
		/** spawn an agent as this session (the same verb the model calls); returns at once */
		spawnAgent: (params: { sessionID: string }, body: {
			brief: string;
			/** gone: seats were replaced by models in routing.jsonc version 2; a request that sends it is refused with SeatsRemovedError */
			seat?: string;
			name?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
			agent_type?: string;
			/** a model name from routing.jsonc, or provider/model-id; required unless the agent type names one */
			model?: string;
			/** id, path or name of an earlier helper whose attempt this one takes over; its brief and last report ride along, and it keeps running unless closed */
			after?: string;
			files?: Array<string>;
			fork_turns?: number;
			on_failure?: "escalate" | "respawn" | "ignore";
			pool?: {
				n: number;
				collect?: "all" | "first" | "any_n";
				any_n?: number;
				strategy?: "one_for_one" | "one_for_all" | "rest_for_one";
				briefs?: Array<string>;
			};
			cache_ttl?: "5m" | "1h";
			/** keep its cache warm while it is parked (default on for subagents) */
			warm?: boolean;
			mailbox_capacity?: number;
			behavior_version?: "subagent_v1" | "subagent_v2";
			/** tokens one dispatch may spend before it stops with a partial report */
			budget_tokens?: number;
			/** where the agent works instead of the spawner's directory, such as a checkout */
			directory?: string;
			/** why the spawner picked this model and effort; for people reading the tree, never sent to the helper */
			why?: string;
		}, o?: CallOptions) =>
			call<{
				agents: Array<{
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
				}>;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/agents`, undefined, body, o),
		/** send a note as this session to an agent in its tree */
		messageAgent: (params: { sessionID: string }, body: {
			/** id, path, name or parent */
			to: string;
			body: string;
			wake?: boolean;
			correlation_id?: string;
		}, o?: CallOptions) =>
			call<{
				to: string;
				id: string;
				state: string;
				woke: boolean;
				pending: number;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/agents/message`, undefined, body, o),
		/** wait on this session's mailbox (the model's wait verb) */
		waitAgents: (params: { sessionID: string }, body: {
			timeout_ms?: number;
			correlation_id?: string;
		}, o?: CallOptions) =>
			call<{
				arrived: boolean;
				timed_out: boolean;
				waited_ms: number;
				items: Array<Record<string, unknown>>;
				already_delivered?: boolean;
				warning?: string;
				[key: string]: unknown;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/agents/wait`, undefined, body, o),
		/** stop an agent's current turn; it stays resumable */
		interruptAgent: (params: { sessionID: string }, body: {
			target: string;
		}, o?: CallOptions) =>
			call<{
				path: string;
				previous_state: string;
				interrupted: boolean;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/agents/interrupt`, undefined, body, o),
		/** close an agent and everything under it; transcripts stay */
		closeAgent: (params: { sessionID: string }, body: {
			target: string;
		}, o?: CallOptions) =>
			call<{
				path: string;
				previous_state: string;
				already_terminated: boolean;
				closed: Array<string>;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/agents/close`, undefined, body, o),
		/** delivery, safety-net, wait-timeout and tool-error rates for the tree */
		agentMetrics: (params: { sessionID: string }, o?: CallOptions) =>
			call<Record<string, unknown>>("GET", `/session/${encodeURIComponent(params.sessionID)}/agents/metrics`, undefined, undefined, o),
		/** mailbox items not yet in this session's transcript */
		mailbox: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<Record<string, unknown>>>("GET", `/session/${encodeURIComponent(params.sessionID)}/mailbox`, undefined, undefined, o),
		/** messages oldest first; with limit, the newest page, and x-next-cursor for the page before it. the newest page ends with the message being streamed, if any, with every text and reasoning part it has started, in content order, typed, its text so far, marked streaming with time.start (a part whose block has ended reads final: the whole text, time with end, no streaming) */
		messages: (params: { sessionID: string }, query: {
			limit?: string;
			before?: string;
		} = {}, o?: CallOptions) =>
			call<Array<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			}>>("GET", `/session/${encodeURIComponent(params.sessionID)}/message`, query, undefined, o),
		/** one message with its parts; the message being streamed reads with every text and reasoning part it has started (typed, in content order, text so far, marked streaming; a part whose block has ended reads final) */
		getMessage: (params: { sessionID: string; messageID: string }, o?: CallOptions) =>
			call<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			}>("GET", `/session/${encodeURIComponent(params.sessionID)}/message/${encodeURIComponent(params.messageID)}`, undefined, undefined, o),
		/** start a turn, or queue it behind the running one; messageID is the prompt's id either way */
		prompt: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			text?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
			model?: {
				providerID: string;
				modelID: string;
			};
			/** cmx's name for the effort; one of the model's variants */
			variant?: string;
			agent?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
			tool_choice?: "required" | {
				name: string;
			};
			format?: {
				schema: Record<string, unknown>;
				name?: string;
			};
		}, o?: CallOptions) =>
			call<{
				accepted: true;
				effort: string;
				messageID: string;
				/** present when the prompt waits behind a running turn: its provisional id */
				queued?: string;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/prompt`, undefined, body, o),
		/** cmx's blocking send: runs a turn and answers with the assistant message once it settles (headers at once, the body when it settles); a busy session queues the prompt and answers 202 with its id */
		sendMessage: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			text?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
			model?: {
				providerID: string;
				modelID: string;
			};
			/** cmx's name for the effort; one of the model's variants */
			variant?: string;
			agent?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
			tool_choice?: "required" | {
				name: string;
			};
			format?: {
				schema: Record<string, unknown>;
				name?: string;
			};
		}, o?: CallOptions) =>
			call<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			} | null>("POST", `/session/${encodeURIComponent(params.sessionID)}/message`, undefined, body, o),
		/** start or queue a turn and answer at once with the prompt's id; a queued prompt is announced as a provisional message */
		promptAsync: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			text?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
			model?: {
				providerID: string;
				modelID: string;
			};
			/** cmx's name for the effort; one of the model's variants */
			variant?: string;
			agent?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
			tool_choice?: "required" | {
				name: string;
			};
			format?: {
				schema: Record<string, unknown>;
				name?: string;
			};
		}, o?: CallOptions) =>
			call<{
				messageID: string;
				queued: boolean;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/prompt_async`, undefined, body, o),
		/** run a `!` line in the session's directory; the model reads it on its next request. answers with the shell message */
		shell: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			command: string;
			agent?: string;
			model?: {
				providerID: string;
				modelID: string;
			};
		}, o?: CallOptions) =>
			call<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			} | null>("POST", `/session/${encodeURIComponent(params.sessionID)}/shell`, undefined, body, o),
		/** run a / command (a command file or a skill) as a prompt; blocks like /message */
		runCommand: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			command: string;
			arguments?: string;
			agent?: string;
			/** provider/model-id */
			model?: string;
			variant?: string;
			messageID?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
		}, o?: CallOptions) =>
			call<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			} | null>("POST", `/session/${encodeURIComponent(params.sessionID)}/command`, undefined, body, o),
		/** take back a queued prompt the model has not seen; 409 once it went out */
		unsend: (params: { sessionID: string; messageID: string }, o?: CallOptions) =>
			call<true>("DELETE", `/session/${encodeURIComponent(params.sessionID)}/message/${encodeURIComponent(params.messageID)}`, undefined, undefined, o),
		/** run what abort left queued, now: ran is how many waiting messages it started (0 when nothing waited); 409 while a turn is running */
		loop: (params: { sessionID: string }, o?: CallOptions) =>
			call<{
				/** waiting messages the turn it started took */
				ran: number;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/loop`, undefined, undefined, o),
		/** the prompts and steers waiting behind the running turn, or left by an abort, oldest first, as the provisional messages the stream announced (queued: true, steer: true on a steer, clientID, the model, variant and agent each asked for). x-cmx2-seq is the cursor the list reflects; message.updated and message.removed after it keep it current; DELETE /session/:id/message/:messageID takes one back */
		queuedMessages: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<{
				/** opencode-shaped message info; assistant messages add modelID, providerID, cost, tokens, finish, variant (effort) */
				info: MessageInfo;
				parts: Array<Part>;
			}>>("GET", `/session/${encodeURIComponent(params.sessionID)}/queue`, undefined, undefined, o),
		/** not supported: sessions stay on this machine (501 NotSupportedError) */
		share: (params: { sessionID: string }, o?: CallOptions) =>
			call<ErrorBody>("POST", `/session/${encodeURIComponent(params.sessionID)}/share`, undefined, undefined, o),
		/** not supported (501 NotSupportedError) */
		unshare: (params: { sessionID: string }, o?: CallOptions) =>
			call<ErrorBody>("DELETE", `/session/${encodeURIComponent(params.sessionID)}/share`, undefined, undefined, o),
		/** compact the session now, on its own cached prefix; answers once the summary is in (the model given is taken for the next turn, as the picker would) */
		summarize: (params: { sessionID: string }, body: {
			providerID?: string;
			modelID?: string;
			auto?: boolean;
		}, o?: CallOptions) =>
			call<true>("POST", `/session/${encodeURIComponent(params.sessionID)}/summarize`, undefined, body, o),
		/** put the files back as they were before a message and park it and everything after it; the next send makes it permanent (the messages stay on disk, out of lists), unrevert undoes it */
		revert: (params: { sessionID: string }, body: {
			messageID: string;
			partID?: string;
		}, o?: CallOptions) =>
			call<SessionInfo>("POST", `/session/${encodeURIComponent(params.sessionID)}/revert`, undefined, body, o),
		/** undo an armed revert: the files and the parked messages come back */
		unrevert: (params: { sessionID: string }, o?: CallOptions) =>
			call<SessionInfo>("POST", `/session/${encodeURIComponent(params.sessionID)}/unrevert`, undefined, undefined, o),
		/** a new session with this one's history up to (not including) a message, or all of it; titled (fork #n) */
		fork: (params: { sessionID: string }, body: {
			messageID?: string;
		}, o?: CallOptions) =>
			call<SessionInfo>("POST", `/session/${encodeURIComponent(params.sessionID)}/fork`, undefined, body, o),
		/** what the session changed in its files, one entry per file (with messageID, what that turn changed) */
		sessionDiff: (params: { sessionID: string }, query: {
			messageID?: string;
		} = {}, o?: CallOptions) =>
			call<Array<FileDiff>>("GET", `/session/${encodeURIComponent(params.sessionID)}/diff`, query, undefined, o),
		/** start a job (or a pty with tty) the session owns; notify reports back to the session as a turn message */
		startProc: (params: { sessionID: string }, body: {
			command: string;
			tty?: boolean;
			title?: string;
			/** survives session end under this name */
			keep?: string;
			/** survives daemon restart */
			detach?: boolean;
			notify?: {
				on_exit?: boolean;
				on_pattern?: string;
				on_port?: number;
			};
		}, o?: CallOptions) =>
			call<ProcessInfo>("POST", `/session/${encodeURIComponent(params.sessionID)}/procs`, undefined, body, o),
		/** the session's jobs and ptys, ports refreshed */
		sessionProcs: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<ProcessInfo>>("GET", `/session/${encodeURIComponent(params.sessionID)}/procs`, undefined, undefined, o),
		/** land a message at the next tool boundary of the running turn (announced as a provisional message marked steer: true), or start a turn. an effort or agent rides the steer (the effort applies from the next turn, the agent when it lands); a model other than the running turn's answers 400, since a steer joins the turn that is running (queue it instead). an effort the model does not allow answers 400 */
		steer: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			text?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
			model?: {
				providerID: string;
				modelID: string;
			};
			/** cmx's name for the effort; one of the model's variants */
			variant?: string;
			agent?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
		}, o?: CallOptions) =>
			call<{
				result: "steered" | "started";
				messageID: string;
				/** provider/model-id the prompt will run on */
				model?: string;
				effort?: string;
				agent?: string;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/steer`, undefined, body, o),
		/** run a message after the running turn (announced as a provisional message), or start a turn. the model, effort and agent stay on the waiting message and apply when it runs: one that asks for another model or effort than the session has runs as its own turn after the running one. an effort the model does not allow, or a model that cannot be set, answers 400 now */
		queue: (params: { sessionID: string }, body: {
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
			text?: string;
			parts?: Array<{
				/** text, or file: a data url (photos, pdfs) or a file url (an @ mention) */
				type: string;
				text?: string;
				mime?: string;
				filename?: string;
				url?: string;
				[key: string]: unknown;
			}>;
			model?: {
				providerID: string;
				modelID: string;
			};
			/** cmx's name for the effort; one of the model's variants */
			variant?: string;
			agent?: string;
			effort?: "low" | "medium" | "high" | "xhigh" | "max";
		}, o?: CallOptions) =>
			call<{
				result: "queued" | "started";
				messageID: string;
				/** provider/model-id the prompt will run on */
				model?: string;
				effort?: string;
				agent?: string;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/queue`, undefined, body, o),
		/** move the effort dial; applies from the next turn */
		setEffort: (params: { sessionID: string }, body: {
			effort: "low" | "medium" | "high" | "xhigh" | "max";
		}, o?: CallOptions) =>
			call<{
				result: "applied" | "pending";
				effort: string;
			}>("POST", `/session/${encodeURIComponent(params.sessionID)}/effort`, undefined, body, o),
		/** stop the running turn */
		abort: (params: { sessionID: string }, o?: CallOptions) =>
			call<true>("POST", `/session/${encodeURIComponent(params.sessionID)}/abort`, undefined, undefined, o),
		/** per-step telemetry */
		steps: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<StepRow>>("GET", `/session/${encodeURIComponent(params.sessionID)}/steps`, undefined, undefined, o),
		/** the recorded prefix bytes and hash */
		prefix: (params: { sessionID: string }, o?: CallOptions) =>
			call<{
				hash: string;
				bytes: string;
			}>("GET", `/session/${encodeURIComponent(params.sessionID)}/prefix`, undefined, undefined, o),
		/** summaries of the last 50 model requests (prefix hash, markers, gates) */
		requests: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<Record<string, unknown>>>("GET", `/session/${encodeURIComponent(params.sessionID)}/requests`, undefined, undefined, o),
		/** the engine transcript as the model sees it (pi's message shapes), for evals and debugging */
		transcript: (params: { sessionID: string }, o?: CallOptions) =>
			call<Array<Record<string, unknown>>>("GET", `/session/${encodeURIComponent(params.sessionID)}/messages`, undefined, undefined, o),
		/** / commands: command files from the profile and the project, then skills */
		commands: (o?: CallOptions) =>
			call<Array<{
				name: string;
				description?: string;
				agent?: string;
				model?: string;
				source: "command" | "skill";
				template: string;
				hints: Array<string>;
			}>>("GET", "/command", undefined, undefined, o),
		/** fuzzy paths relative to the directory, for the @ picker; directories end in / */
		findFile: (query: {
			query?: string;
			/** 1 to 200, default 10 */
			limit?: string;
			dirs?: "true" | "false";
			type?: "file" | "directory";
		} = {}, o?: CallOptions) =>
			call<Array<string>>("GET", "/find/file", query, undefined, o),
		/** ripgrep over the directory (.gitignore holds): regex unless literal, smart case; x-truncated when limit cut it */
		findText: (query: {
			pattern: string;
			literal?: "true" | "false";
			/** only files matching this glob, e.g. *.ts */
			glob?: string;
			/** 1 to 1000, default 100 */
			limit?: string;
		}, o?: CallOptions) =>
			call<Array<{
				/** relative to the directory */
				path: string;
				line: number;
				/** the line, cut at 500 characters */
				text: string;
				submatches: Array<{
					/** utf-16 offset in text */
					start: number;
					end: number;
					text: string;
				}>;
			}>>("GET", "/find/text", query, undefined, o),
		/** one file's raw bytes, for a favicon or a preview: content-type from the magic bytes first (png, jpeg, gif, webp, avif, ico, svg) and the extension second, an etag (if-none-match answers 304) and content-length. a missing path or a directory is 404 FileNotFoundError; a path that leaves the directory, by .. or a symlink, is 403; a file over max is 413 FileTooLargeError, refused from its size without reading it. a file that kept changing while it was read is 409 ConflictError. HEAD answers the same headers without the body. a read never creates an instance for a directory */
		fileContent: (query: {
			/** relative to the directory */
			path: string;
			/** bytes, 1 to 1048576 (the default and the ceiling) */
			max?: string;
		}, o?: BytesOptions) => callBytes("/file/content", query, o),
		/** the directory's git work tree against HEAD: changed, added, deleted and untracked files with line counts, so a client can show what a session changed */
		fileStatus: (o?: CallOptions) =>
			call<Array<{
				/** relative to the directory */
				path: string;
				status: "added" | "modified" | "deleted" | "renamed" | "untracked";
				added: number;
				removed: number;
			}>>("GET", "/file/status", undefined, undefined, o),
		/** agent types: build, then agent files from the profile and the project */
		agents: (o?: CallOptions) =>
			call<Array<{
				name: string;
				description?: string;
				mode: "primary" | "subagent" | "all";
				native: boolean;
				hidden?: boolean;
				model?: {
					providerID: string;
					modelID: string;
				};
				[key: string]: unknown;
			}>>("GET", "/agent", undefined, undefined, o),
		/** the models this daemon can run, by provider, without the profile's blacklist; variants are the efforts each accepts, then the profile's named variants for it. a model's cost is {input, output, cache: {read, write}} per million tokens, plus tiers (inputTokensAbove, input, output, cache) when it has a long-context rate that applies to every token of a request once its input passes the threshold (haiku 5.5 from 100k) */
		providers: (o?: CallOptions) =>
			call<{
				providers: Array<{
					id: string;
					name: string;
					models: Record<string, {
						id: string;
						providerID: string;
						name: string;
						[key: string]: unknown;
					}>;
					[key: string]: unknown;
				}>;
				default: Record<string, string>;
			}>("GET", "/config/providers", undefined, undefined, o),
		/** the merged profile (defaults, cmx2.jsonc, the machine overlay, the project layer): literal keys, header and env values masked as [redacted]; $ENV references stay */
		getConfig: (o?: CallOptions) =>
			call<Record<string, unknown>>("GET", "/config", undefined, undefined, o),
		/** change the profile's cmx2.jsonc with a json merge patch (null removes a key); comments are kept, a patch that would not load is refused and the file left as it was, the daemon reloads */
		patchConfig: (body: Record<string, unknown>, o?: CallOptions) =>
			call<{
				path: string;
				changed: Array<string>;
				config: Record<string, unknown>;
			}>("PATCH", "/config", undefined, body, o),
		/** trade the one-time token cmx2 pair printed for a bearer credential (send it as authorization: Bearer). needs no other auth; a spent, expired or unknown token is 401 */
		pair: (body: {
			token: string;
			/** what the client calls itself; cmx2 pair --list shows it */
			name?: string;
		}, o?: CallOptions) =>
			call<{
				id: string;
				name: string;
				credential: string;
				scheme: "Bearer";
				version: string;
				contract: number;
			}>("POST", "/pair", undefined, body, o),
		/** open terminals (exited ones a person opened drop off) */
		ptys: (o?: CallOptions) =>
			call<Array<PtyInfo>>("GET", "/pty", undefined, undefined, o),
		/** login shells on this host */
		ptyShells: (o?: CallOptions) =>
			call<Array<{
				path: string;
				name: string;
				acceptable: boolean;
			}>>("GET", "/pty/shells", undefined, undefined, o),
		/** open a terminal (a login shell unless command is given) */
		createPty: (body: {
			command?: string;
			args?: Array<string>;
			cwd?: string;
			title?: string;
			env?: Record<string, string>;
			origin?: "tui" | "model";
		}, o?: CallOptions) =>
			call<PtyInfo>("POST", "/pty", undefined, body, o),
		/** one terminal */
		getPty: (params: { ptyID: string }, o?: CallOptions) =>
			call<PtyInfo>("GET", `/pty/${encodeURIComponent(params.ptyID)}`, undefined, undefined, o),
		/** rename or resize a terminal */
		updatePty: (params: { ptyID: string }, body: {
			title?: string;
			size?: {
				rows: number;
				cols: number;
			};
		}, o?: CallOptions) =>
			call<PtyInfo>("PUT", `/pty/${encodeURIComponent(params.ptyID)}`, undefined, body, o),
		/** kill and forget a terminal */
		deletePty: (params: { ptyID: string }, o?: CallOptions) =>
			call<true>("DELETE", `/pty/${encodeURIComponent(params.ptyID)}`, undefined, undefined, o),
		/** every process on the daemon (the kill list) */
		procs: (o?: CallOptions) =>
			call<Array<ProcessInfo>>("GET", "/proc", undefined, undefined, o),
		/** what the orphan sweep at daemon start found */
		sweep: (o?: CallOptions) =>
			call<Record<string, unknown>>("GET", "/proc/sweep", undefined, undefined, o),
		/** stop a process and its group (sigterm, then sigkill) */
		killProc: (params: { procID: string }, o?: CallOptions) =>
			call<ProcessInfo>("POST", `/proc/${encodeURIComponent(params.procID)}/kill`, undefined, undefined, o),
		/** pending permission asks */
		permissions: (o?: CallOptions) =>
			call<Array<PermissionRequest>>("GET", "/permission", undefined, undefined, o),
		/** answer a permission ask. reject settles this ask only (cascade: true rejects the session's other pending asks too); always saves the patterns for the project. an unknown id is 404; an ask already settled is 409 ConflictError with {reply, settledAt, by} */
		replyPermission: (params: { requestID: string }, body: {
			reply: "once" | "always" | "reject";
			/** with reject: feedback the model reads and continues from */
			message?: string;
			/** with reject: reject the session's other pending asks too */
			cascade?: boolean;
			/** who is answering, shown to the next client that tries (default: the x-cmx2-client header, else the user agent) */
			by?: string;
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
		}, o?: CallOptions) =>
			call<true>("POST", `/permission/${encodeURIComponent(params.requestID)}/reply`, undefined, body, o),
		/** pending questions */
		questions: (o?: CallOptions) =>
			call<Array<QuestionRequest>>("GET", "/question", undefined, undefined, o),
		/** answer a question: one list of chosen labels (or typed text) per question. unknown is 404; already settled is 409 ConflictError with {answers | state, settledAt, by} */
		replyQuestion: (params: { requestID: string }, body: {
			answers: Array<Array<string>>;
			/** who is answering, shown to the next client that tries (default: the x-cmx2-client header, else the user agent) */
			by?: string;
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
		}, o?: CallOptions) =>
			call<true>("POST", `/question/${encodeURIComponent(params.requestID)}/reply`, undefined, body, o),
		/** dismiss a question. unknown is 404; already settled is 409 */
		rejectQuestion: (params: { requestID: string }, body: {
			/** who is answering, shown to the next client that tries (default: the x-cmx2-client header, else the user agent) */
			by?: string;
			/** a uuid the client picks; a repeat within 24 h returns the first answer and does nothing, and events the request causes carry it */
			clientID?: string;
		}, o?: CallOptions) =>
			call<true>("POST", `/question/${encodeURIComponent(params.requestID)}/reject`, undefined, body, o),
	};
}

export type Client = ReturnType<typeof createClient>;
