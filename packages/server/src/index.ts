import { createHash, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, EVENTS, type EventType } from "@cmx2/contract";
import { ActorError, Actors, agentTools, type Host, IDLE_WAIT_MS, ReportFiles, type SpawnInput } from "@cmx2/actors";
import { type Config, ConfigError, configDir, dataDir as defaultDataDir, type Effort, loadConfig, loadConfigAsync, machineName, userNotes } from "@cmx2/engine/config";
import { Routing } from "@cmx2/routing";
import type { RequestAsk } from "@cmx2/engine/gates";
import { ModelError, resolveModel } from "@cmx2/engine/models";
import { Transcript } from "@cmx2/engine/transcript";
import { evaluate, type PermissionRule, rulesFromConfig, subagentEnv } from "@cmx2/engine/permission";
import { BusyError, EngineSession, type EngineEvent, type MailRecord, type StepRow, type TurnEvent, type UserBlock } from "@cmx2/engine/session";
import { defaultSkillDirs, LspPool, McpPool, resizeImage, runCommand, Skills } from "@cmx2/tools";
import { closeOpenSteps, decodeCursor, documentPart, encodeCursor, messageId, partId, projectMessage, projectTranscript, type SessionQuery, type SessionRevert, type SessionStateInfo, type RefreshUsage, Store, type StoredSession } from "@cmx2/store";
import { Value } from "typebox/value";
import { Asks, permissionJson, questionJson, type ReplyOutcome } from "./asks.ts";
import { Catalog, expandTemplate, providersJson } from "./catalog.ts";
import { CONTENT_MAX, readContent } from "./content.ts";
import { findFiles, findText } from "./find.ts";
import { JSON_TYPE, messagesJson } from "./pages.ts";
import { ProjectLists } from "./project-lists.ts";
import { SessionUpdates } from "./session-updates.ts";
import { fileStatus, VcsCache } from "./vcs.ts";
import { browse, knownProject, projectOf, projectOfAsync } from "./fs.ts";
import { Reach, waitingText } from "./reach.ts";
import { systemInfo } from "./system.ts";
import { blocksOf, type PartInput, type Resize } from "./parts.ts";
import { ptyJson, shells, type TermSocketData, Terminals } from "./pty.ts";
import { type ProcEvent, type ProcInfo, Procs, type SweepResult } from "@cmx2/procs";
import { badRequest, bodyOf, errorResponse, HttpError, intParam, notFound, queryOf } from "./http.ts";
import { RunLockHeld, RunLocks } from "./lock.ts";
import { defaultTitle, Titles } from "./title.ts";
import { listen, type StreamResponse } from "./listen.ts";
import { gzipSink, plainSink, type RawSink, type Sink, type StreamSwitches, Supersession, switchesOf, wants } from "./stream.ts";
import { requestReviewTool, worktreeTools } from "./worktree-tools.ts";
import { type Created, type Policy, type SetupRun, WorktreeError, type WorktreeInfo, Worktrees } from "@cmx2/worktrees";
import { Notifier, notifyConfig } from "./notify.ts";
import { PairError, Pairing } from "./pair.ts";
import { type FileDiff, Snapshots } from "./snapshot.ts";
import { BtwError, Btws } from "./btw.ts";
import { blacklisted, checkProfileKeys, patchProfile, redactConfig, scrubText, variantEffort, variantsFor } from "./profile.ts";

/** stamped into release binaries by scripts/build.ts (`--define CMX2_VERSION`); a source run says dev */
declare const CMX2_VERSION: string | undefined;
export const VERSION: string = typeof CMX2_VERSION === "string" ? CMX2_VERSION : "0.8.8-dev";
/** idle sessions kept loaded; the rest reload from their transcripts on the next message (the residency lru) */
export const MAX_RESIDENT = 4;
/** an idle session not used for this long is dropped from memory too, unless it is warming its prompt cache */
export const IDLE_EVICT_MS = 20 * 60_000;
/** evicted sessions whose idle `since` is remembered, oldest dropped first (the session list's page cap) */
export const IDLE_SINCE_MAX = 1000;
const HEARTBEAT_MS = 10_000;
/** a `!` line may run this long; longer work belongs in a background job */
const SHELL_LINE_TIMEOUT_S = 600;
/** events that describe the daemon, not a directory: no envelope fields on /global/event */
const SERVER_EVENTS = new Set(["server.connected", "server.heartbeat", "global.disposed", "stream.reset"]);
/** frames that change no state, or stream too fast to keep: never logged, never numbered (a1) */
const UNLOGGED = new Set([...SERVER_EVENTS, "message.part.delta", "btw.delta"]);
/** the replay window: an event is kept while it is inside either bound (30 minutes or 10,000 events, whichever keeps more) */
/** sessions the start's heal looks at between yields to the loop */
const HEAL_PAGE = 16;
export const EVENT_WINDOW = { events: 10_000, ms: 30 * 60_000 };
/** what one subscriber may fall behind before its stream is closed; the client resumes from its last id */
export const STREAM_CAP_BYTES = 1024 * 1024;
/**
 * the most a streamed-text frame carries, envelope and json escapes included: a burst of deltas is merged
 * into frames up to this size, and one delta bigger than this is split (publishDelta).
 */
export const DELTA_FRAME_BYTES = 64 * 1024;
/** deltas for one part that go out a frame each within one turn of the event loop, before the rest are merged */
export const DELTA_FREE_PER_TURN = 16;
/**
 * a stream held back at the cap, or replaying, whose peer takes nothing for this long (while the loop could serve
 * it) is closed. long, because a reader that reads is seen to in lumps: its kernel opens the window by half its
 * receive buffer at a time, so a 500 KB/s reader with a 64 KB buffer showed nothing for 420 ms at a stretch on
 * macos (neither write callbacks nor the kernel's unsent count move in between)
 */
const STREAM_STALL_MS = 3_000;
/** how often a held-back stream is looked at */
const LAG_BEAT_MS = 50;
/**
 * a held stream owed more than this many caps of frames (beyond the biggest one) whose peer has taken nothing for
 * OWED_SILENT_MS is closed at once (judge): far behind and quiet, it would be caught up from the log either way
 */
const OWED_CAPS = 4;
const OWED_SILENT_MS = 100;
/** a stream held again within this long of catching up goes on with the same account (lag) */
const HOLD_MEMORY_MS = 1_000;
/** replay reads the log in pages this size */
const REPLAY_PAGE = 500;
/** a client id binds a request for this long */
const CLIENT_ID_MS = 24 * 3_600_000;

/**
 * one logged event as stored; frames are rendered from this, live and on replay alike, so both are byte-identical. rev:
 * the transcript revision a rev=1 stream sees on it (properties.rev, or the session info's transcriptRev), null for none
 */
type Logged = { seq: number; directory: string; project: string | null; type: string; properties: string; rev?: number | null };
/** logged events that count a transcript write: each moves its session's revision by one (protocol 14a) */
const REV_COUNTED = new Set(["message.updated", "message.part.updated", "message.removed"]);
/** logged events whose session info carries the revision to a rev=1 stream */
const REV_SESSION = new Set(["session.created", "session.updated"]);

/**
 * properties as a rev=1 stream gets them: the revision spliced in as the last field (properties.rev on a message event,
 * info.transcriptRev on a session event), so the rest of the text is the bytes every other stream gets
 */
export function withRev(type: string, properties: string, rev: number | null | undefined): string {
	if (rev === null || rev === undefined) return properties;
	if (REV_SESSION.has(type)) {
		// {"sessionID":...,"info":{...}}: info is the last field and never empty
		if (properties.endsWith("}}")) return `${properties.slice(0, -2)},"transcriptRev":${rev}}}`;
		const p = JSON.parse(properties);
		return JSON.stringify({ ...p, info: { ...p.info, transcriptRev: rev } });
	}
	return properties === "{}" ? `{"rev":${rev}}` : `${properties.slice(0, -1)},"rev":${rev}}`;
}
type Delta = { sessionID: string; messageID: string; partID: string; field: string; delta: string; offset: number };
/** a btw's streamed answer text (btw.delta): unlogged, coalesced per btw like a part's deltas */
type BtwDelta = { sessionID: string; btwID: string; delta: string };
/** a text or reasoning part of the message being streamed: announced at its start, its text grows with each delta */
type StreamingPart = { index: number; type: "text" | "reasoning"; text: string; start: number; end?: number };
type Inflight = { directory: string; info: Record<string, unknown>; parts: Map<string, StreamingPart> };
type Subscriber = {
	directory?: string;
	/** where the frames go (plain or gzip); its backlog and what the peer has taken count the bytes on the wire */
	sink: Sink;
	/** the opt-in switches the stream asked for (coalesce, types, compact, gzip); none on a stream that asked for none */
	switches?: StreamSwitches;
	/** with coalesce: each part's deltas held for the current batch, merged, in the order the parts first came */
	pending?: Map<string, { directory: string; d: Delta; bytes: number; btw?: BtwDelta }>;
	pendingTimer?: ReturnType<typeof setTimeout>;
	live: boolean;
	closed: boolean;
	close: (why?: string) => void;
	/** the seq of the last logged frame this stream was given */
	seq: number;
	/** set while the stream is held back at the cap: nothing is written until the peer catches up */
	lagging?: ReturnType<typeof setInterval>;
	/** the account of a stream held back, kept for a moment after it catches up (lag) */
	hold?: Hold;
};
/**
 * a held-back stream's account: what its peer had taken when the account began, the bytes of frames it was not
 * given since and the biggest of them, how long the peer has taken nothing as the stall clock counts it (the
 * loop's responsive time, so a stretch no peer could have read in is not held against it), and when the account
 * last moved
 */
type Hold = {
	taken: number;
	withheld: number;
	biggest: number;
	silent: number;
	at: number;
	/** the most the queue has seen taken, the kernel's unsent count at the last look, and when the peer last took anything */
	seen: number;
	unsent?: number;
	quietSince: number;
};

export interface ServeOptions {
	config: Config;
	port: number;
	hostname: string;
	dataDir?: string;
	password?: string;
	/** re-reads config for `/global/reload` and the config watcher; defaults to the engine's loader */
	reload?: (cwd?: string) => Config;
	/** what `/global/restart` does after the daemon has stopped; the cli exits so the supervisor restarts it */
	onRestart?: () => void;
	/** validate every published event against the manifest and log violations (tests turn this on) */
	checkEvents?: boolean;
	/** git status on session rows: how long it is kept and when a slow git is stopped (tests shorten these) */
	vcs?: { freshMs?: number; timeoutMs?: number; unknownMs?: number };
	/** watch the profile dir and reload on change */
	watchConfig?: boolean;
	/** shrinks a photo before it reaches the model; defaults to the tools package's resizer */
	resize?: Resize;
	/** the replay window (tests shrink it to reach an expired cursor) */
	eventWindow?: { events: number; ms: number };
	/** per-subscriber backlog cap in bytes */
	streamCap?: number;
	/** how often every stream gets a heartbeat (tests shorten it) */
	heartbeatMs?: number;
	/** how long an idle session stays loaded unused (tests shrink it); the sweep runs every minute, or every `idleSweepMs` */
	idleEvictMs?: number;
	idleSweepMs?: number;
	/** how many evicted sessions' idle times are kept (tests shrink it) */
	idleSinceMax?: number;
	/** how long a parked helper, or a root on the 5m ttl, is kept warm (20 minutes; tests set 0 to turn warming off) */
	warmHorizonMs?: number;
	/** how long a parked root on the 1h ttl is kept warm (4 hours) */
	rootWarmHorizonMs?: number;
	/** how long close, interrupt and abort wait for a stopped turn to go idle before ending its session (5 s) */
	idleWaitMs?: number;
	/** tools every session also declares (tests add one that ignores the abort signal) */
	extraTools?: () => NonNullable<SessionOptionsOf["extraTools"]>;
}

type SessionOptionsOf = Parameters<typeof EngineSession.create>[0];

/** a request body over this is refused with 413 (photos arrive resized; a transcript import is the biggest body) */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** the unauthenticated pairing exchange carries a token and a name */
const PAIR_BODY_BYTES = 16 * 1024;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** an address only this machine can reach */
export function isLoopback(hostname: string): boolean {
	return LOOPBACK_NAMES.has(hostname.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname.toLowerCase().endsWith(".localhost");
}

/** a Host header naming this machine by a loopback name or an ip literal; a rebinding page can only send its own domain */
function localHost(host: string): boolean {
	const name = host.replace(/:\d+$/, "").toLowerCase();
	return isLoopback(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name) || /^\[[0-9a-f:.]+\]$/.test(name);
}

/** an Origin header for the same scheme-less host and port as the request's Host */
function sameOrigin(origin: string, host: string): boolean {
	try {
		return new URL(origin).host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

function samePassword(given: string, want: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(want).digest();
	return timingSafeEqual(a, b);
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** `real` with the lookup on bun's threadpool, for a path no one has touched yet */
async function realAsync(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		return p;
	}
}

export function serve(opts: ServeOptions) {
	const data = opts.dataDir ?? defaultDataDir();
	const store = new Store(join(data, "cmx2.db"));
	const locks = new RunLocks(data, opts.port);
	const sessions = new Map<string, EngineSession>();
	const subscribers = new Set<Subscriber>();
	const reload = opts.reload ?? ((cwd?: string) => loadConfig({ cwd }));
	let config = opts.config;
	checkProfileKeys(config);
	/** per-directory config (the project layer): the "instance" a routing header selects */
	const instances = new Map<string, Config>();
	let eventSeq = 0;
	let violations = 0;
	const epoch = store.epoch;
	const eventWindow = opts.eventWindow ?? EVENT_WINDOW;
	const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
	const streamCap = opts.streamCap ?? STREAM_CAP_BYTES;
	const idleEvictMs = opts.idleEvictMs ?? IDLE_EVICT_MS;
	/**
	 * what a held stream's peer must take before it counts as reading: more than a peer that reads nothing lets its
	 * kernel take (a paused peer on loopback took 1.2 to 2.1 MB; macos grows a receive buffer up to 4 MB)
	 */
	const readProof = 4 * streamCap;
	/** this turn's deltas for the part streaming fastest (publishDelta) */
	let burst: { key: string; directory: string; count: number; held?: Delta } | undefined;
	/** the newest seq this daemon has seen assigned; the cursor every read carries (a2) */
	let head = store.eventHead();
	/** frames and notices held while a landed message's transaction is open; sent in order after it commits (landed) */
	let holding: Array<() => void> | undefined;
	/**
	 * assistant messages being streamed, by session: the info announced at the first token and each text
	 * or reasoning part announced so far, with its type, start and text so far, so reads include what is
	 * written already (a5) and a resumed stream gets each streaming part once in full (a1)
	 */
	const inflight = new Map<string, Inflight>();
	/** side questions about sessions (btw.ts): answered from a session's cached context, kept out of its transcript */
	const btws = new Btws({
		store,
		publish: (directory, type, properties) => publish(directory, type, properties),
		delta: (directory, properties) => publish(directory, "btw.delta", properties),
		directoryOf: (id) => row(id).directory,
		open: (id) => open(id),
		totalsChanged: (id) => void publishSession("session.updated", id).catch(() => {}),
		send: async (id, text, btw) => {
			const t = await promptTurn(id, [{ type: "text", text }], {}, { busy: "steer", btw });
			store.setSessionEffort(id, t.s.standingEffort);
			return t.messageID;
		},
	});

	const machine = systemInfo(data);
	const procs = new Procs({ dataDir: data, onEvent: (e) => onProc(e) });
	/** running background jobs that will notify this session (ptys, serve jobs and jobs without notify do not count) */
	const liveJobsOf = (id: string) => procs.list({ sessionID: id }).filter((p) => p.status === "running" && !p.tty && !p.serve && p.notify && Object.keys(p.notify).length > 0).length;
	const terminals = new Terminals(procs);
	// what a previous daemon left running: orphans are stopped, keep'd and detached ones adopted
	const swept: SweepResult = procs.sweep();
	if (swept.killed.length || swept.adopted.length) {
		console.error(
			`cmx2: orphan sweep: stopped ${swept.killed.length} (${swept.killed.map((k) => `pid ${k.pid} ${k.command}`).join(", ") || "none"}), adopted ${swept.adopted.length} (${swept.adopted.map((k) => `${k.keep ?? "detached"} pid ${k.pid}`).join(", ") || "none"})`,
		);
	}

	// warnings (version-1 keys, a single ceiling over every model) are logged once per config version, as the file is read
	const routing = new Routing({ configDir, machine: machineName(), onWarnings: (warnings) => console.error(warnings.map((w) => `cmx2: routing.jsonc: ${w}`).join("\n")) });
	routing.current();
	// pairing (a12): clients trade a one-time token for a bearer; this machine's cli uses local.token
	const pairing = new Pairing(data);
	pairing.ensureLocal();
	const loopbackBind = isLoopback(opts.hostname);
	const notifier = new Notifier({ enabled: () => notifyConfig((config as { notify?: unknown }).notify).desktop, watchers: () => subscribers.size, titleOf: (id) => store.session(id)?.title });
	/** sessions a test asked to fail on their next turn (`CMX2_FAULT=first_turn:<agent name>,...`) */
	const faults = new Map<string, string>();
	/** when each loaded session was last used, for the residency lru */
	const lastUsed = new Map<string, number>();
	/**
	 * when each evicted session went idle: its status keeps `since`, and a reopen carries it back. an entry goes on
	 * reopen and on archive (delete archives), and past IDLE_SINCE_MAX entries the oldest go
	 */
	const idleSince = new Map<string, number>();
	const idleSinceMax = opts.idleSinceMax ?? IDLE_SINCE_MAX;
	const idleWaitMs = opts.idleWaitMs ?? IDLE_WAIT_MS;

	/**
	 * a live session whose turn did not stop in time leaves memory without its processes being reaped: disposed (a
	 * disposed session writes and reports nothing more) and its lock released, so the next message reopens it from its
	 * transcript. only the session object that was stuck goes, never a newer one
	 */
	function evictStuck(id: string, stuck?: EngineSession) {
		const s = sessions.get(id);
		if (!s || (stuck && s !== stuck)) return;
		s.dispose();
		sessions.delete(id);
		locks.release(id);
		// a disposed session emits nothing, so clients hear here that it is no longer busy
		publishStatus(id);
	}

	const host: Host = {
		createSession: (spec) => createChild(spec),
		state: (id) => {
			const s = sessions.get(id);
			return s ? s.state : "unloaded";
		},
		deliver: (id, items) => {
			const s = sessions.get(id);
			return !!s && s.state === "busy" && s.deliver(items);
		},
		wake: async (id) => {
			const stored = store.session(id);
			if (!stored || stored.archived_at) return false;
			return admit(id, (s) => {
				const started = s.wake();
				if (!started && s.state !== "busy") locks.release(id);
				return started;
			});
		},
		interrupt: async (id) => {
			const s = sessions.get(id);
			if (s) await s.abort();
		},
		evict: (id) => evictStuck(id),
		// positions are the transcript's: a compacted or reverted context no longer lines up with them, so the file is read
		messages: async (id, from, to) => {
			const file = store.session(id)?.session_file;
			if (!file || !existsSync(file)) return [];
			const all: any[] = [];
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const row = JSON.parse(line);
					if (row.type === "message") all.push(row.message);
				} catch {}
			}
			return all.slice(from, to);
		},
		directory: (id) => store.session(id)?.directory,
		exists: (id) => {
			const r = store.session(id);
			return !!r && !r.archived_at && r.source !== "cmx";
		},
		liveJobs: (id) => liveJobsOf(id),
		end: async (id) => {
			const s = sessions.get(id);
			if (s) {
				s.dispose();
				sessions.delete(id);
				publishStatus(id);
			}
			locks.release(id);
			await procs.reapSession(id);
		},
		publish: (sessionID, type, properties) => publish(store.session(sessionID)?.directory ?? "global", type as EventType, properties),
		statusChanged: (id) => publishStatus(id),
		failNextTurn: (id, message) => {
			faults.set(id, message);
			const s = sessions.get(id);
			if (s) {
				s.failNextTurn(message);
				faults.delete(id);
			}
		},
	};
	const faultNames = (process.env.CMX2_FAULT ?? "")
		.split(",")
		.map((f) => f.trim())
		.filter((f) => f.startsWith("first_turn:"))
		.map((f) => f.slice("first_turn:".length));
	/** every helper report in full, as files the parent's report names (copies of the transcript, pruned oldest first past a cap) */
	const reportFiles = new ReportFiles(join(data, "reports"));
	/**
	 * a session's agents read their own tree's report files without an ask (they sit outside every working directory),
	 * and nobody edits report files: they are the daemon's copies. after every saved rule, so an "always" cannot widen it
	 */
	const reportRules = (id: string): PermissionRule[] => {
		const dir = actors.reportsDirFor(id);
		return dir ? [{ permission: "external_directory", pattern: `${dir}/*`, action: "allow" }, { permission: "edit", pattern: `${reportFiles.dir}/*`, action: "deny" }] : [];
	};
	const actors = new Actors({
		store,
		host,
		routing,
		faults: faultNames,
		blacklisted: (directory, model) => blacklisted(configFor(directory), model),
		reports: reportFiles,
		warmHorizonMs: opts.warmHorizonMs,
		rootWarmHorizonMs: opts.rootWarmHorizonMs,
		idleWaitMs,
		agentType: (directory, name) => {
			const def = catalog.agent(directory, name);
			if (!def || def.path === "(built in)") return undefined;
			return { body: def.body, ...(def.model ? { model: def.model } : {}) };
		},
	});

	/** branch and dirty flag per directory, for session rows */
	const vcs = new VcsCache(opts.vcs);

	/** each project's checkouts as /project lists them, read async; dropped by whatever publishes project.updated */
	const projectLists = new ProjectLists(async (project) => {
		try {
			return (await stat(worktrees.rootOf(project)).then(() => true, () => false)) ? await worktrees.listAsync(project) : [];
		} catch (e) {
			// a git that timed out: unknown, answered as no checkouts and asked again shortly
			return e instanceof WorktreeError && e.data.timedOut ? undefined : [];
		}
	});

	// ---------- checkouts ----------

	const worktrees = new Worktrees(data);
	const worktreeHome = () => real(worktrees.home);
	const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
	/** a directory inside a checkout made for an agent */
	const inCheckout = (directory: string) => within(directory, worktreeHome()) && directory !== worktreeHome();

	function policyFor(directory: string): Policy {
		const w = configFor(directory).worktree;
		return { carry: w.carry, cap: w.cap, minFreeGB: w.minFreeGB, minFreeRatio: w.minFreeRatio, clone: w.clone, setup: typeof w.setup === "string" ? [w.setup] : w.setup };
	}

	/** a project as /project lists it; sandboxes are its checkouts, from git's own list */
	function projectRow(project: string, time?: { created: number; updated: number }, withList = false, listed?: WorktreeInfo[]) {
		let list: WorktreeInfo[] = listed ?? [];
		if (!listed) {
			try {
				list = existsSync(worktrees.rootOf(project)) ? worktrees.list(project) : [];
			} catch {}
			projectLists.set(project, list);
		}
		const t = time ?? { created: Date.now(), updated: Date.now() };
		return { id: project, worktree: project, time: t, sandboxes: list.map((w) => w.directory), ...(withList ? { worktrees: list } : {}) };
	}

	function publishProject(project: string) {
		const r = store.projects().find((x) => x.project === project);
		projectLists.forget(project);
		publish(project, "project.updated", projectRow(project, r ? { created: r.created, updated: r.updated } : undefined));
	}

	/**
	 * a checkout of the repository `directory` is in: made and filled now, setup commands after. clients
	 * hear project.updated at once and worktree.ready (or worktree.failed) when setup is done; wait makes
	 * the caller wait for setup too.
	 */
	async function createWorktree(directory: string, input: { name?: string; from?: string; startCommand?: string }, wait: boolean): Promise<Created & { setup?: SetupRun[] }> {
		const c = worktrees.create(directory, input, policyFor(directory));
		console.error(
			`cmx2: checkout ${c.name} of ${c.project} at ${c.directory}: ${c.mode === "clone" ? "apfs clone" : "git worktree"} in ${c.ms} ms${c.fallback ? ` (${c.fallback})` : ""}; carried ${c.carried.length}${c.linked.length ? `, linked ${c.linked.join(", ")}` : ""}; left behind ${c.left.join(", ") || "nothing"}`,
		);
		publishProject(c.project);
		const commands = [...policyFor(c.directory).setup, ...(input.startCommand?.trim() ? [input.startCommand] : [])];
		const setup = worktrees.setup(c.directory, commands, { CMX2_WORKTREE: c.directory, CMX2_WORKTREE_NAME: c.name, CMX2_WORKTREE_SOURCE: c.source, CMX2_WORKTREE_PROJECT: c.project }).then((runs) => {
			const bad = runs.find((r) => !r.ok);
			if (bad) {
				console.error(`cmx2: checkout ${c.name}: setup \`${bad.command}\` failed (${bad.timedOut ? "timed out" : `exit ${bad.exitCode}`})`);
				publish(c.directory, "worktree.failed", { name: c.name, message: `setup command failed: ${bad.command} (${bad.timedOut ? "timed out after 10 minutes" : `exit ${bad.exitCode}`})`, ...(bad.log ? { log: bad.log } : {}) });
			} else publish(c.directory, "worktree.ready", { name: c.name, ...(c.branch ? { branch: c.branch } : {}), mode: c.mode });
			return runs;
		});
		if (wait) return { ...c, setup: await setup };
		setup.catch((e) => console.error(`cmx2: checkout ${c.name}: setup did not run: ${e instanceof Error ? e.message : String(e)}`));
		return c;
	}

	/**
	 * runs a checkout change with the run lock of every session homed in the checkout held, so no turn can
	 * start there while its directory goes away. a session mid-turn (here or in another daemon process)
	 * refuses with BusyError. processes still running in the checkout are stopped first.
	 */
	async function underLocks<T>(directory: string, self: string | undefined, fn: () => T): Promise<T & { stopped: string[] }> {
		const ids = (store.db.query("select id from session where directory = ? or substr(directory, 1, ?) = ?").all(directory, directory.length + 1, `${directory}/`) as Array<{ id: string }>).map((r) => r.id);
		const taken: string[] = [];
		try {
			for (const id of ids) {
				if (id === self) throw new HttpError(409, "BusyError", "you are working in this checkout, so it cannot go away under you; request_review hands it to the person, or your spawner merges it", { sessionID: id });
				if (sessions.get(id)?.state === "busy" || locks.holds(id)) throw new HttpError(409, "BusyError", `session ${id} is mid-turn in this checkout; let it finish or abort it, then try again`, { sessionID: id });
				try {
					locks.acquire(id);
					taken.push(id);
				} catch (e) {
					if (e instanceof RunLockHeld) throw new HttpError(409, "BusyError", `${e.message}, in this checkout; let it finish or abort it, then try again`, { sessionID: id, ...(e.holder ? { holder: e.holder } : {}) });
					throw e;
				}
			}
			const stopped: string[] = [];
			for (const p of procs.list()) {
				if (p.status !== "running" || !within(real(p.cwd), directory)) continue;
				await procs.kill(p.id);
				stopped.push(`${p.id} (${p.command.length > 60 ? `${p.command.slice(0, 57)}...` : p.command})`);
			}
			if (stopped.length) console.error(`cmx2: stopped ${stopped.length} process(es) running in ${directory}: ${stopped.join(", ")}`);
			return { ...(await fn()), stopped };
		} finally {
			for (const id of taken) locks.release(id);
		}
	}

	/**
	 * a checkout that went away (merged or discarded): its sessions move to the repository's main checkout,
	 * where the work now lives or would be redone, so lists fold them under the repository and a reopened
	 * thread has a directory that exists. a move, never a delete: rows and transcripts stay (rule 15).
	 */
	function rehome(checkout: string, project: string) {
		const rows = store.db.query("select id from session where directory = ? or substr(directory, 1, ?) = ?").all(checkout, checkout.length + 1, `${checkout}/`) as Array<{ id: string }>;
		for (const { id } of rows) {
			const live = sessions.get(id);
			if (live && live.state !== "busy") {
				live.dispose();
				sessions.delete(id);
			}
			store.db.query("update session set directory = ?, project_id = ? where id = ?").run(project, project, id);
			publishSession("session.updated", id);
		}
		if (rows.length) console.error(`cmx2: ${rows.length} session(s) from ${checkout} now live in ${project}`);
	}

	async function mergeWorktree(directory: string, message: string | undefined, self?: string) {
		const w = worktrees.locate(directory);
		const m = await underLocks(w.directory, self, () => worktrees.merge(w.directory, { ...(message ? { message } : {}) }));
		console.error(`cmx2: merged ${m.branch} into ${m.base} as ${m.commit.slice(0, 10)} (${m.commits} commit(s))${m.into ? ` in ${m.into}` : ""}`);
		if (m.into) vcs.forget(m.into);
		publish(w.directory, "worktree.merged", { name: w.name, branch: m.branch, base: m.base, commit: m.commit, commits: m.commits });
		rehome(w.directory, w.project);
		publishProject(w.project);
		return m;
	}

	async function discardWorktree(directory: string, self?: string) {
		const w = worktrees.locate(directory);
		const d = await underLocks(w.directory, self, () => worktrees.discard(w.directory));
		console.error(`cmx2: discarded ${w.branch ?? w.name}${d.ref ? `; its last state is ${d.snapshot!.slice(0, 10)} at ${d.ref}` : ""}`);
		publish(w.directory, "worktree.discarded", { name: w.name, ...(w.branch ? { branch: w.branch } : {}), ...(d.snapshot ? { snapshot: d.snapshot } : {}), ...(d.ref ? { ref: d.ref } : {}) });
		rehome(w.directory, w.project);
		publishProject(w.project);
		return d;
	}

	/** the run state clients see: busy with its queue, or idle, and idle with what it is parked on */
	function statusOf(id: string) {
		const live = sessions.get(id);
		if (live?.state === "busy") return { type: "busy" as const, queued: live.queued, since: live.stateSince };
		const w = reaching.get(id);
		if (w && reach.slow(w.directory)) return { type: "busy" as const, since: w.since, waiting: waitingText(w.directory) };
		const parked = actors.parkedOf(id);
		// an abort leaves prompts waiting: an idle session says how many (a19)
		const queued = live?.queued ? { queued: live.queued } : {};
		const since = live ? live.stateSince : idleSince.get(id);
		return parked ? { type: "idle" as const, parked, since: actors.parkedAt(id) ?? Date.now(), ...queued } : { type: "idle" as const, ...(since !== undefined ? { since } : {}), ...queued };
	}

	function publishStatus(id: string) {
		const r = store.session(id);
		if (r) publish(r.directory, "session.status", { sessionID: id, status: statusOf(id) });
	}

	const orphaned = store.expireOrphanedAsks();
	if (orphaned.permissions || orphaned.questions) {
		console.error(`cmx2: ${orphaned.permissions} permission and ${orphaned.questions} question asks from a previous run expired (their turns ended with that process)`);
	}

	/** bumped whenever `instances` is cleared, so a probe that read a config before a reload does not put it back */
	let instancesGen = 0;
	const reloadAsync = opts.reload ? async (cwd: string) => opts.reload!(cwd) : (cwd: string) => loadConfigAsync({ cwd });
	/** sessions waiting for their directory's first access, by id, and since when */
	const reaching = new Map<string, { directory: string; since: number; shown?: boolean }>();
	const reach = new Reach({
		// what the sync paths read first: the directory, its listing, the project config, the git root
		probe: async (dir) => {
			await stat(dir).catch(() => undefined);
			await readdir(dir).catch(() => undefined);
			const gen = instancesGen;
			// a config error is left for configFor's own read, which turns it into the 400 a client sees
			const c = await reloadAsync(dir).catch(() => undefined);
			if (c && gen === instancesGen && !instances.has(dir)) instances.set(dir, c);
			await projectOfAsync(dir);
		},
		onSlow: (dir) => {
			const ids = [...reaching].filter(([, w]) => w.directory === dir).map(([id]) => id);
			console.error(`cmx2: ${waitingText(dir)}${ids.length ? ` (${ids.join(", ")} waiting)` : ""}; other sessions go on`);
			for (const id of ids) {
				reaching.get(id)!.shown = true;
				publishStatus(id);
			}
		},
		onSettled: (dir, ms, slow) => {
			if (slow) console.error(`cmx2: ${dir} answered after ${Math.round(ms / 1000)} s`);
		},
	});

	/**
	 * waits for a directory's first access to settle without holding the main thread. a session that waits
	 * past the slow mark shows why in its status (busy, with `waiting`) until it goes on.
	 */
	async function reachFor(directory: string, sessionID?: string): Promise<void> {
		if (reach.ready(directory)) return;
		if (!sessionID) return reach.wait(directory);
		const w: { directory: string; since: number; shown?: boolean } = { directory, since: Date.now() };
		reaching.set(sessionID, w);
		if (reach.slow(directory)) {
			w.shown = true;
			publishStatus(sessionID);
		}
		try {
			await reach.wait(directory);
		} finally {
			if (reaching.get(sessionID) === w) reaching.delete(sessionID);
			// the waiting status is replaced by what the session is doing now (the turn's own busy follows when it starts)
			if (w.shown && store.session(sessionID)) publishStatus(sessionID);
		}
	}

	/** the project of a directory, without running git in one that has not been reached: the store's answer or the directory stands in */
	function projectFor(directory: string): string {
		if (reach.ready(directory)) return projectOf(directory);
		const known = knownProject(directory) ?? (store.db.query("select project_id from session where directory = ? and project_id is not null limit 1").get(directory) as { project_id: string } | null)?.project_id;
		if (!known) void reach.wait(directory);
		return known ?? directory;
	}

	function configFor(directory: string): Config {
		let c = instances.get(directory);
		if (!c) {
			try {
				c = reload(directory);
			} catch (e) {
				if (e instanceof ConfigError) throw badRequest(e.message);
				throw e;
			}
			instances.set(directory, c);
		}
		return c;
	}

	/** the cursor of the state as of now: `<epoch>:<seq>` */
	function cursor(): string {
		return `${epoch}:${head}`;
	}

	/** an unnumbered payload: server frames, deltas and streaming resends */
	function unloggedPayload(type: string, properties: Record<string, unknown>, rev?: number): string {
		return JSON.stringify({ id: `evt_${Date.now().toString(36)}_${++eventSeq}`, type, properties: rev === undefined ? properties : { ...properties, rev } });
	}

	/** a logged payload; the id, the seq and the epoch name the same point in the log. rev: as a rev=1 stream gets it */
	function loggedPayload(e: Logged, rev = false): string {
		return `{"id":"${epoch}:${e.seq}","type":${JSON.stringify(e.type)},"properties":${rev ? withRev(e.type, e.properties, e.rev) : e.properties},"seq":${e.seq},"epoch":"${epoch}"}`;
	}

	/** /global/event wraps a payload with where it happened; server frames carry no directory */
	function envelope(directory: string | null, project: string | null, payloadJson: string): string {
		if (directory === null) return `{"payload":${payloadJson}}`;
		if (project === null) return `{"directory":${JSON.stringify(directory)},"payload":${payloadJson}}`;
		return `{"directory":${JSON.stringify(directory)},"project":${JSON.stringify(project)},"payload":${payloadJson}}`;
	}

	/**
	 * one event's frame for each kind of stream, built the first time a subscriber of that kind needs it and shared by the
	 * rest: a stream scoped to a directory gets the bare payload, a global one the payload in its envelope. a stream held
	 * back at the cap builds its own, as every stream did before: the judge's looks at a held peer come one per withheld
	 * frame while a burst holds the loop, so the work per frame paces them and stays as it was
	 */
	function shared(build: (global: boolean, rev: boolean) => string): (sub: Subscriber) => string {
		let scoped: string | undefined;
		let global: string | undefined;
		let scopedRev: string | undefined;
		let globalRev: string | undefined;
		return (sub) => {
			const rev = !!sub.switches?.rev;
			if (sub.lagging) return build(!sub.directory, rev);
			if (rev) return sub.directory ? (scopedRev ??= build(false, true)) : (globalRev ??= build(true, true));
			return sub.directory ? (scoped ??= build(false, false)) : (global ??= build(true, false));
		};
	}

	/** one logged event as an sse frame for this subscriber: `id:` then the body, byte-identical on every send */
	function loggedFrame(sub: Subscriber, e: Logged): string {
		return loggedFrames(e)(sub);
	}

	function loggedFrames(e: Logged): (sub: Subscriber) => string {
		return shared((global, rev) => {
			const p = loggedPayload(e, rev);
			return `id: ${epoch}:${e.seq}\ndata: ${global ? envelope(e.directory, e.project, p) : p}\n\n`;
		});
	}

	function unloggedFrame(sub: Subscriber, type: string, properties: Record<string, unknown>, directory: string | null, id?: string): string {
		return unloggedFrames(type, properties, directory, id)(sub);
	}

	/**
	 * an unnumbered event's frames (each kind of stream numbers its payload once). an unnumbered message.part.updated (a
	 * shell's tail, a streaming part resent at a resume's seam) carries the session's revision now to a rev=1 stream: it
	 * moves nothing, so the revision is the one the stream's last counted event said
	 */
	function unloggedFrames(type: string, properties: Record<string, unknown>, directory: string | null, id?: string): (sub: Subscriber) => string {
		let rev: number | undefined;
		const revOf = () => (rev ??= store.transcriptRev(String(properties.sessionID)));
		return shared((global, withRev) => {
			const p = unloggedPayload(type, properties, withRev && type === "message.part.updated" && typeof properties.sessionID === "string" ? revOf() : undefined);
			const body = global ? envelope(SERVER_EVENTS.has(type) ? null : directory, directory && directory !== "global" && !SERVER_EVENTS.has(type) ? projectFor(directory) : null, p) : p;
			return `${id ? `id: ${id}\n` : ""}data: ${body}\n\n`;
		});
	}

	function reaches(sub: Subscriber, directory: string, type: string): boolean {
		return (!sub.directory || sub.directory === directory || SERVER_EVENTS.has(type)) && wants(sub.switches, type);
	}

	function publish<T extends EventType>(directory: string, type: T, properties: Record<string, unknown>, how?: { unlogged?: true; rev?: number }) {
		if (opts.checkEvents) {
			const def = EVENTS[type];
			if (!def) {
				violations++;
				console.error(`contract violation: ${type} is not in the manifest`);
			} else if (!Value.Check(def.properties, properties)) {
				violations++;
				const e = [...Value.Errors(def.properties, properties)][0] as { instancePath?: string; message?: string } | undefined;
				console.error(`contract violation: ${type} ${e?.instancePath ?? ""} ${e?.message ?? ""} ${JSON.stringify(properties).slice(0, 300)}`);
			}
		}
		const rev = how?.rev;
		if (UNLOGGED.has(type) || how?.unlogged) {
			// live subscribers only: a stream still replaying gets deltas' text from the streaming resend at its seam
			if (type === "message.part.delta" && !holding) return publishDelta(directory, properties as Delta);
			flushBurst();
			// frames are built when they go (after a held batch's commit), once per kind of stream, and each stream's held
			// coalesced deltas go before them (send)
			const fan = () => {
				if (type === "message.part.delta") return publishDelta(directory, properties as Delta);
				if (type === "btw.delta") return publishBtwDelta(directory, properties as BtwDelta);
				const frame = unloggedFrames(type, properties, directory);
				for (const s of subscribers) if (s.live && reaches(s, directory, type)) send(s, frame(s));
			};
			if (holding) holding.push(fan);
			else fan();
			return;
		}
		flushBurst();
		// the log write and the fan-out happen in one synchronous step: a read (a2) or a replay's seam sees both or neither
		const e: Logged = { seq: 0, directory, project: directory === "global" ? null : projectFor(directory), type, properties: JSON.stringify(properties) };
		const sid = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
		if (sid && REV_COUNTED.has(type)) {
			// a counted write: the session's revision moves in the transaction its event is logged in (inside a landed
			// message's, a savepoint of it), so the log never holds an event whose revision did not commit, nor the reverse
			store.db.transaction(() => {
				e.rev = store.bumpTranscriptRev(sid);
				e.seq = store.appendEvent({ at: Date.now(), directory: e.directory, project: e.project, type: e.type, properties: e.properties, rev: e.rev });
			})();
		} else {
			if (sid && REV_SESSION.has(type)) e.rev = rev ?? store.transcriptRev(sid);
			e.seq = store.appendEvent({ at: Date.now(), directory: e.directory, project: e.project, type: e.type, properties: e.properties, rev: e.rev ?? null });
		}
		head = e.seq;
		const fan = () => {
			const frame = loggedFrames(e);
			for (const s of subscribers) if (s.live && reaches(s, directory, type)) send(s, frame(s), e.seq);
			notifier.onEvent(type, properties);
		};
		// inside a landed message's transaction the frames wait for its commit (see landed)
		if (holding) holding.push(fan);
		else fan();
	}

	/**
	 * the directory a request names, symlinks resolved. the lookup is async: realpath lstats inside the
	 * folder, and a folder behind a privacy prompt or on a hung mount would hold the main thread
	 */
	async function directoryOf(req: Request, url: URL): Promise<string | undefined> {
		const d = rawDirectoryOf(req, url);
		return d === undefined ? undefined : realAsync(d);
	}

	/** the directory a request names, absolute, symlinks not yet resolved */
	function rawDirectoryOf(req: Request, url: URL): string | undefined {
		const d = url.searchParams.get("directory") ?? req.headers.get("x-cmx2-directory") ?? req.headers.get("x-opencode-directory");
		if (!d) return undefined;
		let decoded = d;
		try {
			decoded = decodeURIComponent(d);
		} catch {}
		return resolve(decoded);
	}

	/**
	 * whether a request needs a credential at all: always once a password is set or a client is paired,
	 * and always on an address other machines can reach, so a daemon on 0.0.0.0 is never open before its
	 * first pairing. an open loopback daemon still answers only to requests that pass `refuse`.
	 */
	function unguarded(): boolean {
		return !opts.password && loopbackBind && !pairing.required();
	}

	function authorized(req: Request): boolean {
		const h = req.headers.get("authorization") ?? "";
		if (h.startsWith("Bearer ")) return !!pairing.check(h.slice(7).trim());
		if (h.startsWith("Basic ") && opts.password) {
			let decoded = "";
			try {
				decoded = atob(h.slice(6));
			} catch {
				return false;
			}
			const at = decoded.indexOf(":");
			const user = decoded.slice(0, at);
			return at > 0 && (user === "cmx2" || user === "opencode") && samePassword(decoded.slice(at + 1), opts.password);
		}
		return unguarded();
	}

	/**
	 * requests a browser made for some other site, refused before auth: a page the user has open can
	 * post to 127.0.0.1 (a text/plain body needs no preflight) or rebind its own name to it and read the
	 * answers. a cross-site Origin or sec-fetch-site is refused on every daemon; a Host that is not this
	 * machine's is refused on an open one, where it could only come from a rebinding page.
	 */
	function refuse(req: Request): Response | undefined {
		const host = req.headers.get("host") ?? new URL(req.url).host;
		const origin = req.headers.get("origin");
		const site = req.headers.get("sec-fetch-site");
		const foreign = (origin !== null && !sameOrigin(origin, host)) || site === "cross-site";
		if (foreign) {
			return Response.json(
				{ name: "ForbiddenError", data: { message: `requests from web pages on other sites are refused (origin ${origin ?? "unknown"}). clients call the daemon directly or through their own server` } },
				{ status: 403 },
			);
		}
		if (unguarded() && !localHost(host)) {
			return Response.json(
				{ name: "ForbiddenError", data: { message: `this daemon has no password and no paired clients, so it answers only to loopback names; host ${host} is not one. pair a client with cmx2 pair or set CMX2_SERVER_PASSWORD` } },
				{ status: 403 },
			);
		}
		return undefined;
	}

	/** writes to a subscriber, after the deltas it holds for a batch (so order holds); a live stream that goes over the cap is held back (a3) */
	function send(sub: Subscriber, text: string, seq?: number) {
		if (sub.pending?.size) flushPending(sub);
		put(sub, text, seq);
	}

	function put(sub: Subscriber, text: string, seq?: number) {
		if (sub.closed) return;
		if (sub.lagging) return withhold(sub, text);
		sub.sink.write(text);
		if (seq !== undefined) sub.seq = seq;
		if (sub.live && sub.sink.backlog() > streamCap) lag(sub);
	}

	/**
	 * a streamed-text delta to every live stream. the first DELTA_FREE_PER_TURN deltas for a part in one turn
	 * of the event loop go out a frame each, as they come (a reply streaming at reading speed, boxbox v2
	 * probe a1's 40 glyphs); past that it is a burst (a chunk from the provider holding thousands), and the
	 * rest of the turn's deltas for the part are merged into frames of at most DELTA_FRAME_BYTES, flushed
	 * when the turn ends, when the batch is full, and before any other event, so order holds.
	 */
	function publishDelta(directory: string, d: Delta) {
		const key = `${d.sessionID}\0${d.messageID}\0${d.partID}\0${d.field}`;
		if (burst && (burst.key !== key || burst.directory !== directory)) {
			flushBurst();
			burst = undefined;
		}
		if (!burst) {
			burst = { key, directory, count: 0 };
			const mine = burst;
			setImmediate(() => {
				if (burst !== mine) return;
				flushBurst();
				burst = undefined;
			});
		}
		burst.count++;
		const held = burst.held;
		if (!held && burst.count <= DELTA_FREE_PER_TURN) return fanDelta(directory, d);
		if (held && held.offset + held.delta.length === d.offset) burst.held = { ...held, delta: held.delta + d.delta };
		else {
			flushBurst();
			burst.held = { ...d };
		}
		if (Buffer.byteLength(burst.held!.delta) >= DELTA_FRAME_BYTES - 2048) flushBurst();
	}

	/** sends the merged deltas held for this turn's burst, if any */
	function flushBurst() {
		const held = burst?.held;
		if (!burst || !held) return;
		burst.held = undefined;
		fanDelta(burst.directory, held);
	}

	function fanDelta(directory: string, d: Delta) {
		for (const s of subscribers) {
			if (!s.live || !reaches(s, directory, "message.part.delta")) continue;
			if (s.switches?.coalesce) {
				queueDelta(s, directory, d);
				continue;
			}
			// each stream builds its own delta frames, as before: shared, the fan-out of a burst ran faster than the judge's
			// pacing was tuned for, and a22's 30 readers were cut more often on a loaded machine (7 of 14 runs, against 2 of 13
			// on main); the burst is where the time goes, so its pacing stays as it was
			for (const f of deltaFrames(s, d, directory)) send(s, f);
		}
	}

	/**
	 * a btw's answer text to every live stream: a frame each, or with coalesce one per btw per batch. a btw's answer is
	 * capped well under a frame (BTW_MAX_CHARS), so no split is needed
	 */
	function publishBtwDelta(directory: string, d: BtwDelta) {
		flushBurst();
		for (const s of subscribers) {
			if (!s.live || !reaches(s, directory, "btw.delta")) continue;
			if (!s.switches?.coalesce) {
				send(s, unloggedFrame(s, "btw.delta", d, directory));
				continue;
			}
			const key = `btw\0${directory}\0${d.sessionID}\0${d.btwID}`;
			const held = s.pending?.get(key);
			const bytes = Buffer.byteLength(d.delta);
			if (held?.btw) {
				held.btw = { ...held.btw, delta: held.btw.delta + d.delta };
				held.bytes += bytes;
			} else (s.pending ??= new Map()).set(key, { directory, d: { sessionID: d.sessionID, messageID: "", partID: "", field: "", delta: "", offset: 0 }, bytes, btw: { ...d } });
			if (s.pending!.get(key)!.bytes >= DELTA_FRAME_BYTES - 2048) {
				flushPending(s);
				continue;
			}
			s.pendingTimer ??= setTimeout(() => {
				s.pendingTimer = undefined;
				flushPending(s);
			}, s.switches.coalesce);
		}
	}

	/**
	 * coalesce: a delta joins its part's batch when it continues it, else the batches go out first. the batch goes when its
	 * window ends, when it grows to a frame's worth, and before any other frame to the stream (send), so order holds
	 */
	function queueDelta(sub: Subscriber, directory: string, d: Delta) {
		const key = `${directory}\0${d.sessionID}\0${d.messageID}\0${d.partID}\0${d.field}`;
		const held = sub.pending?.get(key);
		// the batch's size runs on with each delta, so a batch of n deltas costs n, not n squared
		const bytes = Buffer.byteLength(d.delta);
		if (held && held.d.offset + held.d.delta.length === d.offset) {
			held.d = { ...held.d, delta: held.d.delta + d.delta };
			held.bytes += bytes;
		} else {
			if (held) flushPending(sub);
			(sub.pending ??= new Map()).set(key, { directory, d: { ...d }, bytes });
		}
		if (sub.pending!.get(key)!.bytes >= DELTA_FRAME_BYTES - 2048) return flushPending(sub);
		sub.pendingTimer ??= setTimeout(() => {
			sub.pendingTimer = undefined;
			flushPending(sub);
		}, sub.switches!.coalesce);
	}

	/** sends a stream's held deltas, each part's as one delta (split at the frame cap); a stream no longer live drops them, as its catch-up resends the text */
	function flushPending(sub: Subscriber) {
		const pending = sub.pending;
		if (sub.pendingTimer) clearTimeout(sub.pendingTimer);
		sub.pendingTimer = undefined;
		if (!pending?.size) return;
		sub.pending = undefined;
		if (!sub.live) return;
		for (const { directory, d, btw } of pending.values()) {
			if (btw) put(sub, unloggedFrame(sub, "btw.delta", btw, directory));
			else for (const f of deltaFrames(sub, d, directory)) put(sub, f);
		}
	}

	/** one delta as frames of at most DELTA_FRAME_BYTES, split between utf-16 surrogate pairs, offsets moved along */
	function deltaFrames(sub: Subscriber, d: Delta, directory: string): string[] {
		const frame = unloggedFrame(sub, "message.part.delta", d, directory);
		if (Buffer.byteLength(frame) <= DELTA_FRAME_BYTES || d.delta.length < 2) return [frame];
		let cut = d.delta.length >> 1;
		const c = d.delta.charCodeAt(cut - 1);
		if (c >= 0xd800 && c <= 0xdbff) cut++;
		return [...deltaFrames(sub, { ...d, delta: d.delta.slice(0, cut) }, directory), ...deltaFrames(sub, { ...d, delta: d.delta.slice(cut), offset: d.offset + cut }, directory)];
	}

	/**
	 * a live stream over the 1 MB cap (a3): nothing more is written to it, so it costs the cap and one frame
	 * at most. a peer that is reading (a big frame, a burst) drains and is caught up from the log in place,
	 * the same replay a resume gets, with any part still streaming resent whole. a peer that takes nothing
	 * for STREAM_STALL_MS while the loop could have served it is closed and resumes from its last id, and so
	 * is one far behind that takes nothing for a moment (withhold, judge).
	 */
	function lag(sub: Subscriber) {
		const taken = sub.sink.taken();
		const hold = sub.hold;
		// a hold soon after the last goes on with its account unless the peer has read since: one that reads nothing
		// can still drain a hold into its kernel's receive buffer as that grows, so a drain is not proof of reading
		if (!hold || taken - hold.taken >= readProof || Date.now() - hold.at > HOLD_MEMORY_MS) holdFrom(sub, taken);
		else hold.silent = 0;
		sub.lagging = stallClock(
			sub,
			streamCap / 4,
			"",
			(caughtUp) => {
				if (!caughtUp) return;
				sub.lagging = undefined;
				if (sub.hold) sub.hold.at = Date.now();
				sub.live = false;
				void catchUp(sub, sub.seq);
			},
			(silent) => {
				if (!sub.hold) return;
				sub.hold.silent = silent;
				observe(sub);
				judge(sub);
			},
		);
	}

	/**
	 * watches a stream that is behind until its backlog is down to `low`, or its peer has taken nothing for
	 * STREAM_STALL_MS and it is closed; `done` says which, once, and `beat` hears the silence so far at every look.
	 * judged after the loop's i/o turn, so socket writes that were due have run; a loop that was busy counts as one
	 * beat, not as the peer's silence, as the peer could not be served meanwhile.
	 */
	function stallClock(sub: Subscriber, low: number, where: string, done: (caughtUp: boolean) => void, beat?: (silent: number) => void): ReturnType<typeof setInterval> {
		let taken = sub.sink.taken();
		let silent = 0;
		let last = Date.now();
		const timer = setInterval(
			() =>
				setImmediate(() => {
					if (sub.closed) {
						clearInterval(timer);
						return done(false);
					}
					const now = Date.now();
					const gap = Math.min(now - last, 2 * LAG_BEAT_MS);
					last = now;
					const backlog = sub.sink.backlog();
					if (sub.sink.taken() > taken) {
						taken = sub.sink.taken();
						silent = 0;
					} else silent += gap;
					beat?.(silent);
					if (sub.closed) {
						clearInterval(timer);
						return done(false);
					}
					if (backlog <= low) {
						clearInterval(timer);
						done(true);
					} else if (silent >= STREAM_STALL_MS) {
						clearInterval(timer);
						sub.close(`fell ${Math.round(backlog / 1024)} KB behind${where} and took nothing for ${STREAM_STALL_MS} ms`);
						done(false);
					}
				}),
			LAG_BEAT_MS,
		);
		return timer;
	}

	/** starts a held-back stream's account afresh from what its peer has taken */
	function holdFrom(sub: Subscriber, taken: number) {
		const now = Date.now();
		sub.hold = { taken, withheld: 0, biggest: 0, silent: 0, at: now, seen: taken, unsent: sub.sink.unsent?.(), quietSince: now };
	}

	/**
	 * looks at a held stream's peer: it took something if the queue moved, or if its socket's kernel holds less than at
	 * the last look or nothing at all (then it is waiting on the daemon). the kernel is read without the loop, so the
	 * looks taken while a burst holds the loop (one per frame withheld) see a reader drain it and a peer that does
	 * not read leave it full; the wall clock since the last movement is the peer's quiet
	 */
	function observe(sub: Subscriber) {
		const hold = sub.hold;
		if (!hold) return;
		const taken = sub.sink.taken();
		const unsent = sub.sink.unsent?.();
		let moved = taken > hold.seen;
		if (unsent !== undefined) {
			if (unsent === 0 || (hold.unsent !== undefined && unsent < hold.unsent)) moved = true;
			hold.unsent = unsent;
		}
		if (taken > hold.seen) hold.seen = taken;
		if (moved) hold.quietSince = Date.now();
	}

	/**
	 * a frame for a stream held back at the cap is not written (catch-up reads it from the log), but it is counted
	 * against the stream (judge). a peer that takes more than its kernel could have (readProof) is reading, and its
	 * account starts again.
	 */
	function withhold(sub: Subscriber, text: string) {
		if (!sub.hold) return;
		const taken = sub.sink.taken();
		if (taken - sub.hold.taken >= readProof) holdFrom(sub, taken);
		const hold = sub.hold;
		const size = Buffer.byteLength(text);
		hold.withheld += size;
		hold.biggest = Math.max(hold.biggest, size);
		hold.at = Date.now();
		observe(sub);
		judge(sub);
	}

	/**
	 * closes a held stream owed more than OWED_CAPS caps of frames whose peer has taken nothing for OWED_SILENT_MS. on
	 * the public socket the quiet is wall time since the peer last took anything (observe), carried across a hold that
	 * comes back and the catch-up after it: a paused bun peer's kernel took everything held for about 280 ms of a burst
	 * (its receive buffer grew to 2.1 MB) and probe a3 read again 66 ms after it stopped, while the stall clock's quiet,
	 * counted from its first beat after the burst and started again at each hold, missed by a few ms. where the kernel
	 * cannot be read (a stream that crossed the hop) the stall clock's quiet stands in. the biggest frame is owed whole
	 * and not counted, because one frame can be bigger than the cap (the finished part's, twice over at a step's end)
	 */
	function judge(sub: Subscriber) {
		const hold = sub.hold;
		if (!hold || sub.closed || hold.withheld - hold.biggest <= OWED_CAPS * streamCap) return;
		// in wall time where the kernel can be read (it shows a reader while the loop is held); else the stall clock's
		const quiet = hold.unsent !== undefined ? Date.now() - hold.quietSince : hold.silent;
		if (quiet < OWED_SILENT_MS) return;
		sub.close(`fell ${Math.round(sub.sink.backlog() / 1024)} KB behind and took nothing while ${Math.round(hold.withheld / 1024)} KB more was published`);
	}

	/**
	 * replays every logged event after `after` from the store, in pages, then goes live: the last page is
	 * read and the stream switched to live in one synchronous step, so nothing published in between is
	 * missed or sent twice. then each part still streaming is sent once in full, and deltas continue.
	 * the replay is paced frame by frame: over the cap it waits for the peer (a page of finished parts can
	 * be tens of MB), and only a peer that takes nothing for STREAM_STALL_MS meanwhile is closed (a3).
	 */
	async function catchUp(sub: Subscriber, after: number) {
		// deltas held for a batch are in the text resent at the end
		flushPending(sub);
		const supersession = sub.switches?.compact ? await supersessionAfter(sub, after) : undefined;
		let last = after;
		for (;;) {
			if (sub.closed) return;
			// a replay held up past the window: pruning took rows after the cursor, so say so, as an expired cursor does,
			// and go live from the head (the reset and the switch to live are one synchronous step: no gap)
			if (store.eventsPrunedThrough() > last) {
				const at = store.eventHead();
				sub.sink.write(unloggedFrame(sub, "stream.reset", { reason: "expired", seq: at, epoch }, null, `${epoch}:${at}`));
				last = sub.seq = at;
				break;
			}
			const rows = store.eventsAfter(last, { directory: sub.directory, limit: REPLAY_PAGE });
			let waited = false;
			for (const r of rows) {
				// a type the stream did not ask for, or a state a later event in the replay carries whole (compact)
				if (!wants(sub.switches, r.type) || supersession?.skip(r.seq)) {
					last = sub.seq = r.seq;
					continue;
				}
				if (sub.sink.backlog() > streamCap) {
					// a catch-up after a hold goes on with the hold's account; a fresh resume has none and only the quiet rule
					const judged = sub.hold && ((silent: number) => ((sub.hold!.silent = silent), observe(sub), judge(sub)));
					await new Promise<void>((ok) => stallClock(sub, streamCap, " in a replay", () => ok(), judged || undefined));
					if (sub.closed) return;
					waited = true;
				}
				sub.sink.write(loggedFrame(sub, r));
				last = sub.seq = r.seq;
			}
			// a page cut by a wait may have missed what was published meanwhile: read on rather than go live
			if (rows.length < REPLAY_PAGE && !waited) break;
			await new Promise((ok) => setImmediate(ok));
		}
		// deltas merged this turn are already in the text resent below; the streams that were live get them first
		flushBurst();
		sub.live = true;
		for (const [sessionID, f] of inflight) {
			if (!reaches(sub, f.directory, "message.part.updated")) continue;
			for (const part of streamingParts(sessionID, f)) send(sub, unloggedFrame(sub, "message.part.updated", { sessionID, part }, f.directory));
		}
		// a running btw's answer so far is not in the log either: the resumed stream gets the btw whole, then its deltas
		for (const b of btws.streaming()) if (reaches(sub, b.directory, "btw.updated")) send(sub, unloggedFrame(sub, "btw.updated", { sessionID: b.sessionID, btw: b.btw }, b.directory));
		// a running shell's latest tail is not in the log: the resumed stream gets it here, as a live one already has
		for (const run of progressing.values()) {
			if (run.tail && reaches(sub, run.directory, "message.part.updated")) send(sub, unloggedFrame(sub, "message.part.updated", { sessionID: run.session, part: JSON.parse(run.tail) }, run.directory));
		}
	}

	/**
	 * compact: the last seq of each state key among the rows a replay from `after` will read, from a pass over them
	 * (keys only, in pages, yielding between them). rows published after the pass are replayed whole
	 */
	async function supersessionAfter(sub: Subscriber, after: number): Promise<Supersession> {
		const s = new Supersession();
		let last = after;
		for (;;) {
			const rows = store.eventsAfter(last, { directory: sub.directory, limit: REPLAY_PAGE });
			for (const r of rows) s.note(r.seq, r.type, r.properties);
			if (rows.length < REPLAY_PAGE || sub.closed) return s;
			last = rows.at(-1)!.seq;
			await new Promise((ok) => setImmediate(ok));
		}
	}

	const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" };
	/** a gzip stream says so; a stream without the switch keeps today's headers */
	const streamHeaders = (s: StreamSwitches): Record<string, string> => (s.gzip ? { ...SSE_HEADERS, "content-encoding": "gzip", vary: "accept-encoding" } : SSE_HEADERS);

	/** a cursor from a client: where to replay from, or why it cannot be replayed */
	function resolveCursor(raw: string | undefined): { after?: number; reset?: "expired" | "epoch" | "invalid" } {
		if (raw === undefined || raw === "") return {};
		const m = raw.trim().match(/^([0-9a-z]+):(\d+)$/);
		if (!m) return { reset: "invalid" };
		if (m[1] !== epoch) return { reset: "epoch" };
		const n = Number(m[2]);
		if (!Number.isSafeInteger(n) || n > store.eventHead()) return { reset: "invalid" };
		if (n < store.eventsPrunedThrough()) return { reset: "expired" };
		return { after: n };
	}

	/** an event stream. without a cursor it starts live; with one (`Last-Event-ID`, else `?after=`) it catches up from the log first */
	function openStream(directory: string | undefined, raw: string | undefined, out: RawSink, switches?: StreamSwitches) {
		const sink = switches?.gzip ? gzipSink(out) : plainSink(out);
		const sub: Subscriber = {
			directory,
			sink,
			...(switches ? { switches } : {}),
			live: false,
			closed: false,
			seq: store.eventHead(),
			close: (why) => {
				if (sub.closed) return;
				sub.closed = true;
				subscribers.delete(sub);
				clearInterval(timer);
				clearInterval(sub.lagging);
				clearTimeout(sub.pendingTimer);
				if (why) {
					console.error(`cmx2: closed an event stream (${directory ?? "global"}): it ${why}; the client resumes from its last id`);
					sink.destroy();
				} else sink.end();
			},
		};
		subscribers.add(sub);
		// a stream with types= gets its heartbeats numbered: the id of the last logged event it has passed, sent or filtered
		// out, so its cursor moves on through events it never asked for and a resume does not expire for them. a live stream
		// not held back has passed everything up to the head; one replaying or held has passed what its seq says
		const heartbeat = () => {
			const id = switches?.types ? `${epoch}:${sub.live && !sub.lagging ? head : sub.seq}` : undefined;
			send(sub, unloggedFrame(sub, "server.heartbeat", {}, null, id));
		};
		const timer = setInterval(heartbeat, heartbeatMs);
		const c = resolveCursor(raw);
		if (c.reset) {
			// the cursor cannot be replayed: say why, point the stream at the head, and let the client reconcile from reads (a2)
			const at = store.eventHead();
			send(sub, unloggedFrame(sub, "stream.reset", { reason: c.reset, seq: at, epoch }, null, `${epoch}:${at}`));
		}
		if (wants(switches, "server.connected")) send(sub, unloggedFrame(sub, "server.connected", { version: VERSION }, null));
		if (c.after === undefined) {
			sub.live = true;
			return sub;
		}
		// what the stream has passed so far, until the replay moves it on
		sub.seq = c.after;
		void catchUp(sub, c.after);
		return sub;
	}

	/** the assistant message a session is streaming right now, as a read returns it, or nothing */
	function streamingMessage(sessionID: string): { info: Record<string, unknown>; parts: unknown[] } | undefined {
		const f = inflight.get(sessionID);
		if (!f || store.message(f.info.id as string)) return undefined;
		return { info: f.info, parts: streamingParts(sessionID, f) };
	}

	/**
	 * a started part as clients see it: its type, the text so far, marked streaming, with when it started; once its
	 * block has ended it is final (the whole text, `time {start, end}`, no streaming flag), as the step's end will say again
	 */
	function streamingPart(sessionID: string, messageID: string, id: string, p: StreamingPart) {
		if (p.end !== undefined) return { id, sessionID, messageID, type: p.type, text: p.text, time: { start: p.start, end: p.end } };
		return { id, sessionID, messageID, type: p.type, text: p.text, streaming: true, time: { start: p.start } };
	}

	/**
	 * every part the message being streamed has started, in content order. a tool call is first published
	 * when its step's message ends, in the same synchronous step that drops this state, so no tool part
	 * exists for a message while it streams.
	 */
	function streamingParts(sessionID: string, f: Inflight) {
		return [...f.parts.entries()].sort((a, b) => a[1].index - b[1].index).map(([id, p]) => streamingPart(sessionID, f.info.id as string, id, p));
	}

	/**
	 * an event stream from the listener: written to the public socket by the front itself, or to a node response
	 * behind the hop when it comes later on a kept-alive connection; either way `writableLength` is the backlog
	 */
	function streamRequest(req: Request, res: StreamResponse): boolean {
		const url = new URL(req.url);
		if (req.method !== "GET" || (url.pathname !== "/event" && url.pathname !== "/global/event") || refuse(req) || !authorized(req)) return false;
		const named = url.pathname === "/event" ? rawDirectoryOf(req, url) : undefined;
		if (named === undefined) attach(url.pathname === "/event" ? real(process.cwd()) : undefined);
		else {
			// a stream that names a directory opens once its path is resolved (async), so a slow folder holds only this stream
			let gone = false;
			res.on("close", () => (gone = true));
			void realAsync(named).then((directory) => {
				if (!gone) attach(directory);
			});
		}
		return true;

		function attach(directory: string | undefined) {
		const switches = switchesOf(url, req.headers);
		res.writeHead(200, streamHeaders(switches));
		const sub = openStream(directory, req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? undefined, {
			write: (t) => void res.write(t),
			backlog: () => res.writableLength,
			unsent: res.kernelUnsent ? () => res.kernelUnsent?.() : undefined,
			end: () => res.end(),
			// a stream cut for falling behind: the public connection goes at once, not after the hop's buffers drain
			destroy: () => {
				server.cut(res.socket?.remotePort);
				res.destroy();
			},
		}, switches);
		res.on("close", () => sub.close());
		}
	}

	/** the same stream for an in-process caller (tests pass the handler as fetch); there is no socket to measure */
	function sse(req: Request, url: URL, directory: string | undefined): Response {
		const enc = new TextEncoder();
		let sub: Subscriber | undefined;
		const switches = switchesOf(url, req.headers);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				sub = openStream(directory, req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? undefined, {
					write: (t) => {
						try {
							controller.enqueue(typeof t === "string" ? enc.encode(t) : t);
						} catch {
							sub?.close();
						}
					},
					backlog: () => 0,
					end: () => {
						try {
							controller.close();
						} catch {}
					},
					destroy: () => {
						try {
							controller.error(new Error("closed"));
						} catch {}
					},
				}, switches);
				req.signal.addEventListener("abort", () => sub?.close());
			},
			cancel: () => sub?.close(),
		});
		return new Response(stream, { headers: streamHeaders(switches) });
	}

	// ---------- processes ----------

	function procDirectory(p: ProcInfo): string {
		const owner = p.sessionID ? store.session(p.sessionID) : undefined;
		return owner?.directory ?? p.cwd;
	}

	function procJson(p: ProcInfo) {
		return {
			id: p.id,
			sessionID: p.sessionID,
			pid: p.pid,
			command: p.command,
			cwd: p.cwd,
			title: p.title,
			kind: p.tty ? ("pty" as const) : ("job" as const),
			status: p.status,
			exitCode: p.exitCode,
			ports: p.ports,
			serve: p.serve,
			notify: p.armed,
			origin: p.origin,
			startedAt: p.startedAt,
			...(p.endedAt ? { endedAt: p.endedAt } : {}),
			...(p.keep ? { keep: p.keep } : {}),
			...(p.detached ? { detached: true } : {}),
			...(p.adopted ? { adopted: true } : {}),
		};
	}

	/** the process registry's events: pty events in cmx's shape for terminals, process events for everything, notices to the owning sessions */
	function onProc(e: ProcEvent) {
		const dir = procDirectory(e.info);
		if (e.type === "proc.notify") {
			publish(dir, "process.notify", { process: procJson(e.info), reason: e.reason, detail: e.detail });
			const sid = e.info.sessionID;
			if (sid && actors.isChild(sid)) {
				// a subagent's jobs report through its mailbox, so the running-turn cap holds for their wake-ups too
				const who = e.info.origin === "user" ? "started by the user" : "started by you";
				try {
					actors.post(store.agents.get(sid)!, { kind: "job", from: null, body: `job ${e.info.id}: ${e.detail}\n(${who}: ${e.info.command.length > 120 ? `${e.info.command.slice(0, 117)}...` : e.info.command})`, wake: true, system: true });
				} catch (err) {
					console.error(`cmx2: job ${e.info.id} could not reach agent ${sid}: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			if (sid) {
				void admit(sid, (s) => {
					const who = e.info.origin === "user" ? "started by the user" : "started by you";
					const r = s.notice(`job ${e.info.id}`, `${e.detail}\n(${who}: ${e.info.command.length > 120 ? `${e.info.command.slice(0, 117)}...` : e.info.command})`);
					if (s.state !== "busy") locks.release(sid);
					return r;
				}).catch((err) => console.error(`cmx2: job ${e.info.id} could not reach session ${sid}: ${err instanceof Error ? err.message : String(err)}`));
			}
			return;
		}
		const kind = e.type.slice("proc.".length) as "started" | "updated" | "exited" | "deleted";
		publish(dir, `process.${kind}`, { process: procJson(e.info) });
		if (e.info.tty) {
			if (kind === "started") publish(dir, "pty.created", { info: ptyJson(e.info) });
			else if (kind === "updated") publish(dir, "pty.updated", { info: ptyJson(e.info) });
			else if (kind === "exited") {
				publish(dir, "pty.exited", { id: e.info.id, exitCode: e.info.exitCode ?? 0 });
				terminals.forget(e.info.id, 1000, "the terminal exited", true);
			} else if (kind === "deleted") {
				publish(dir, "pty.deleted", { id: e.info.id });
				terminals.forget(e.info.id, 1000, "the terminal was closed");
			}
		}
	}

	// ---------- sessions ----------

	/** a session row as clients see it. `states`, when given, holds the session_state rows of a whole list (read in one query) */
	function info(row: StoredSession, states?: Map<string, SessionStateInfo>) {
		const live = sessions.get(row.id);
		const slash = row.model.indexOf("/");
		const summary = row.summary ? JSON.parse(row.summary) : undefined;
		const effort = live?.standingEffort ?? row.effort ?? undefined;
		return {
			id: row.id,
			slug: row.slug ?? row.id.slice(4, 12),
			projectID: row.project_id ?? row.directory,
			directory: row.directory,
			...(row.parent_id ? { parentID: row.parent_id } : {}),
			...(row.forked_from ? { forkedFrom: { sessionID: row.forked_from, ...(row.forked_at_message ? { messageID: row.forked_at_message } : {}) } } : {}),
			title: row.title,
			version: row.version ?? VERSION,
			time: { created: row.created_at, updated: row.updated_at ?? row.created_at, ...(row.archived_at ? { archived: row.archived_at } : {}) },
			...(slash > 0 ? { model: { providerID: row.model.slice(0, slash), id: row.model.slice(slash + 1) } } : {}),
			// a10: every session carries its diff summary; one that changed nothing says so with zeros
			...(summary ? { summary } : row.source === "cmx" ? {} : { summary: { files: 0, additions: 0, deletions: 0 } }),
			source: (row.source === "cmx" ? "cmx" : "cmx2") as "cmx" | "cmx2",
			...(effort ? { effort } : {}),
			...(() => {
				// imported history is a record, not a work tree; its directory may be gone or on another branch
				// git in a directory not reached yet would hold the main thread on its prompt; the probe runs instead and the next read has it
				const v = row.source === "cmx" ? undefined : reach.ready(row.directory) ? vcs.of(row.directory) : void reach.wait(row.directory);
				return v ? { vcs: v } : {};
			})(),
			cost: row.cost ?? 0,
			tokens: { input: row.tokens_input ?? 0, output: row.tokens_output ?? 0, cache: { read: row.tokens_cache_read ?? 0, write: row.tokens_cache_write ?? 0 } },
			...(() => {
				// context fill: the live session's own count, else what the store kept at its last step (a10)
				const st = row.source === "cmx" ? {} : states ? (states.get(row.id) ?? {}) : store.sessionState(row.id);
				const context = live ? live.contextFill : st.context;
				const revert = st.revert ? { messageID: st.revert.messageID, ...(st.revert.partID ? { partID: st.revert.partID } : {}), ...(st.revert.snapshot ? { snapshot: st.revert.snapshot } : {}), ...(st.revert.diff ? { diff: st.revert.diff } : {}) } : undefined;
				return { ...(context ? { context } : {}), ...(revert ? { revert } : {}) };
			})(),
			...(live?.state === "busy" ? { status: { type: "busy" as const, queued: live.queued } } : (() => {
				const parked = actors.parkedOf(row.id);
				const queued = live?.queued ?? 0;
				return parked || queued ? { status: { type: "idle" as const, ...(parked ? { parked } : {}), ...(queued ? { queued } : {}) } } : {};
			})()),
			// protocol 14a: on every rest answer; a session event carries it only to a rev=1 stream (see publish)
			transcriptRev: row.transcript_rev ?? 0,
		};
	}

	function row(id: string): StoredSession {
		const r = store.session(id);
		if (!r) throw notFound(`no session ${id}`);
		return r;
	}

	/**
	 * a landed message's writes (projection rows, its logged events, the session touch) in one transaction.
	 * its events reach subscribers only after the commit, so no client holds a seq a rollback could hand out
	 * again. a throw part way still commits what was written before it, as separate writes did; the error
	 * goes on after the commit and the sends. a throw also moves the session's transcript revision before the commit:
	 * rows written before it commit without the events that would have counted them, so the revision says a read may
	 * differ (protocol 14a; at worst a move with nothing changed)
	 */
	function landed(fn: () => void, sessionID?: string) {
		let failed: { e: unknown } | undefined;
		const before = head;
		const held: Array<() => void> = [];
		holding = held;
		try {
			store.db.transaction(() => {
				try {
					fn();
				} catch (e) {
					failed = { e };
					if (sessionID) store.bumpTranscriptRev(sessionID);
				}
			})();
		} catch (e) {
			// the commit failed and rolled back: none of its events reached anyone, and their seqs are free again
			holding = undefined;
			head = before;
			throw e;
		}
		holding = undefined;
		// committed: clients hear the events now, in the order they were logged
		for (const send of held) send();
		if (failed) throw failed.e;
	}

	/** activity on a session: updated_at moves and clients hear it, so the list orders by what was touched last */
	function touch(id: string) {
		store.touchSession(id);
		sessionUpdates.touch(id);
	}

	const titles = new Titles({
		store,
		configFor: (directory) => configFor(directory),
		onTitle: (id, title, model, cost) => {
			const live = sessions.get(id);
			if (live) live.title = title;
			publishSession("session.updated", id);
			console.error(`cmx2: titled ${id} "${title}" (${model}, cost ${cost.toFixed(5)})`);
		},
	});

	/** the directory whose git a session row needs and does not have fresh; git runs async, see loadVcs */
	function vcsWait(r: StoredSession): string | undefined {
		return r.source !== "cmx" && reach.ready(r.directory) && !vcs.fresh(r.directory) ? r.directory : undefined;
	}

	/** git for these rows' directories, run async and in parallel, so info() answers them without blocking */
	async function loadVcs(rows: StoredSession[]) {
		const dirs = new Set<string>();
		for (const r of rows) {
			const d = vcsWait(r);
			if (d) dirs.add(d);
		}
		await Promise.all([...dirs].map((d) => vcs.load(d)));
	}

	/** rows as clients see them, with git loaded off the loop and session state read in one query */
	/**
	 * rows as clients see them, for a read stamped with x-cmx2-seq (a2): git is loaded off the loop for the rows
	 * read now, then the rows are read again and built in one synchronous step with the stamp, so an event
	 * published while git ran is either in the body or after the stamp. a directory that turns up only in the
	 * second read runs git inline.
	 */
	async function readInfos<T extends StoredSession[]>(read: () => T): Promise<() => { rows: T; items: ReturnType<typeof info>[] }> {
		await loadVcs(read());
		return () => {
			const rows = read();
			const states = store.sessionStates(rows.filter((r) => r.source !== "cmx").map((r) => r.id));
			return { rows, items: rows.map((r) => info(r, states)) };
		};
	}

	/** one session as clients see it, git loaded off the loop */
	async function infoOf(r: StoredSession) {
		await loadVcs([r]);
		return info(store.session(r.id) ?? r);
	}

	/** git for a directory a new session is about to be made in, so its session.created goes out at once */
	async function loadVcsDir(directory: string) {
		if (reach.ready(directory) && !vcs.fresh(directory)) await vcs.load(directory);
	}

	const sessionUpdates = new SessionUpdates({
		waitsOn: (id) => {
			const r = store.session(id);
			return r ? vcsWait(r) : null;
		},
		load: (dir) => vcs.load(dir),
		emit: (type, id) => {
			const r = store.session(id);
			if (!r) return;
			// the revision rides as the last field of info to a rev=1 stream only; every other stream gets today's info
			const { transcriptRev, ...rest } = info(r);
			publish(r.directory, type, { sessionID: id, info: rest }, { rev: transcriptRev });
		},
	});

	/** settles when the event has gone out (it may wait for git); most callers do not wait */
	function publishSession(type: "session.created" | "session.updated", id: string): Promise<void> {
		return sessionUpdates.publish(type, id);
	}

	// ---------- snapshots, revert, fork, diff ----------

	const snapshots = new Snapshots({ dataDir: data, log: (line) => console.error(`cmx2: snapshots: ${line}`) });

	/** each session's snapshot work in flight; reads of snapshots wait for it, so a diff asked for after a turn settles includes that turn */
	const snapping = new Map<string, Promise<void>>();

	function turnSnapshot(id: string, directory: string, e: TurnEvent): Promise<void> {
		const run = (snapping.get(id) ?? Promise.resolve()).then(() => snapshotTurn(id, directory, e));
		snapping.set(id, run);
		void run.finally(() => {
			if (snapping.get(id) === run) snapping.delete(id);
		});
		return run;
	}

	/** snapshot work for a session settled, bounded so a stuck git never holds a route */
	async function snapshotsSettled(id: string) {
		const p = snapping.get(id);
		if (p) await Promise.race([p, Bun.sleep(30_000)]);
	}

	/** the work tree before each turn and after it; a settled turn records the files it changed and the session's diff summary moves */
	async function snapshotTurn(id: string, directory: string, e: TurnEvent) {
		if (stopped) return;
		try {
			if (e.type === "start") {
				const before = await snapshots.track(directory);
				if (before) store.putTurnSnapshot({ session_id: id, from_seq: e.from, before, at: Date.now() });
				return;
			}
			const t = store.turnSnapshots(id).find((x) => x.from_seq === e.from);
			if (!t) return;
			const after = await snapshots.track(directory);
			if (!after || stopped) return;
			const files = await snapshots.changed(directory, t.before, after);
			if (stopped) return;
			store.putTurnSnapshot({ ...t, to_seq: e.to, after, files: JSON.stringify(files) });
			if (files.length || store.session(id)?.summary) {
				const d = await sessionDiff(id, directory, undefined, false);
				store.setSessionSummary(id, summaryOf(d));
				publishSession("session.updated", id);
			}
		} catch (err) {
			console.error(`cmx2: snapshot for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function summaryOf(d: FileDiff[]) {
		return { files: d.length, additions: d.reduce((n, f) => n + f.additions, 0), deletions: d.reduce((n, f) => n + f.deletions, 0) };
	}

	function filesOf(t: { files?: string | null }): string[] {
		try {
			return t.files ? (JSON.parse(t.files) as string[]) : [];
		} catch {
			return [];
		}
	}

	/** what the session changed: the files its turns touched, from before its first turn to after its last (or one turn's, by message) */
	async function sessionDiff(id: string, directory: string, messageID?: string, settled = true): Promise<FileDiff[]> {
		if (settled) await snapshotsSettled(id);
		const turns = store.turnSnapshots(id).filter((t) => t.after);
		if (!turns.length) return [];
		let pick = turns;
		if (messageID) {
			const m = store.message(messageID);
			if (!m || m.session_id !== id) throw notFound(`no message ${messageID} in session ${id}`);
			const seq = Math.floor(m.seq);
			const t = turns.findLast((x) => x.from_seq < seq && (x.to_seq ?? Number.POSITIVE_INFINITY) >= seq);
			if (!t) return [];
			pick = [t];
		}
		const touched = new Set(pick.flatMap(filesOf));
		if (!touched.size) return [];
		const d = await snapshots.diff(directory, pick[0]!.before, pick.at(-1)!.after!);
		return d.filter((f) => touched.has(f.file));
	}

	/**
	 * rewinds to just before a message: the files the session changed from that turn on go back to how they
	 * were, and the message and everything after it is parked. the next send makes it permanent; unrevert
	 * puts the files and the messages back. nothing is deleted (rule 15).
	 */
	async function revertTo(id: string, messageID: string, partID?: string) {
		const stored = row(id);
		if (stored.source === "cmx") throw new HttpError(409, "ConflictError", `session ${id} is history imported from cmx; it is browse only`);
		if (sessions.get(id)?.state === "busy") throw new HttpError(409, "BusyError", `session ${id} is running a turn; abort it before rewinding`, { sessionID: id });
		const m = store.message(messageID);
		if (!m || m.session_id !== id || m.reverted) throw notFound(`no message ${messageID} in session ${id}`);
		const seq = Math.floor(m.seq);
		const dir = stored.directory;
		await snapshotsSettled(id);
		const armed = store.sessionState(id).revert;
		// a second rewind starts from the files as they were before the first
		if (armed?.snapshot && armed.files.length) await snapshots.restore(dir, armed.snapshot, armed.files);
		const turns = store.turnSnapshots(id);
		const from = turns.findLastIndex((t) => t.from_seq < seq);
		const files = [...new Set(from < 0 ? [] : turns.slice(from).flatMap(filesOf))];
		let snapshot: string | undefined;
		let diff: { files: number; additions: number; deletions: number } | undefined;
		if (from >= 0 && files.length) {
			snapshot = await snapshots.track(dir);
			if (snapshot) {
				const set = new Set(files);
				diff = summaryOf((await snapshots.diff(dir, turns[from]!.before, snapshot)).filter((f) => set.has(f.file)));
			}
			await snapshots.restore(dir, turns[from]!.before, files);
			vcs.forget(dir);
			for (const f of files) publish(dir, "file.edited", { sessionID: id, file: join(dir, f) });
		}
		armRevert(id, { messageID, ...(partID ? { partID } : {}), seq, ...(snapshot ? { snapshot } : {}), files, ...(diff ? { diff } : {}) });
		await loadVcs([row(id)]);
		publishSession("session.updated", id);
		return info(row(id));
	}

	async function unrevert(id: string) {
		const stored = row(id);
		await snapshotsSettled(id);
		const armed = store.sessionState(id).revert;
		if (!armed) return infoOf(stored);
		if (sessions.get(id)?.state === "busy") throw new HttpError(409, "BusyError", `session ${id} is running a turn`, { sessionID: id });
		if (armed.snapshot && armed.files.length) {
			await snapshots.restore(stored.directory, armed.snapshot, armed.files);
			vcs.forget(stored.directory);
			for (const f of armed.files) publish(stored.directory, "file.edited", { sessionID: id, file: join(stored.directory, f) });
		}
		armRevert(id, null);
		await loadVcs([row(id)]);
		publishSession("session.updated", id);
		return info(row(id));
	}

	/** a revert armed or undone moves the transcript revision in the transaction that writes it (protocol 14a); session.updated says so */
	function armRevert(id: string, revert: SessionRevert | null) {
		store.db.transaction(() => {
			store.setRevert(id, revert);
			store.bumpTranscriptRev(id);
		})();
	}

	/** a send to a session with an armed revert makes it permanent: the parked messages leave the context and every list */
	async function commitRevert(id: string) {
		const armed = store.sessionState(id).revert;
		if (!armed) return;
		const s = await open(id);
		if (s.state === "busy") return;
		// the parked messages' message.removed go out from the revert line's landing (onMessage), in its transaction
		s.revert(armed.seq);
		store.setRevert(id, null);
		publishSession("session.updated", id);
	}

	/** a new session holding this one's transcript up to (not including) a message; the fork reads the same cached prefix */
	async function fork(id: string, messageID?: string) {
		const stored = row(id);
		if (stored.source === "cmx" || !stored.session_file || !existsSync(stored.session_file)) throw new HttpError(409, "ConflictError", `session ${id} has no transcript here to fork (history imported from cmx is browse only)`);
		let cut = Number.POSITIVE_INFINITY;
		if (messageID) {
			const m = store.message(messageID);
			if (!m || m.session_id !== id) throw notFound(`no message ${messageID} in session ${id}`);
			cut = Math.floor(m.seq);
		}
		const newId = `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
		const file = join(data, "sessions", `${newId}.jsonl`);
		const lines: string[] = [];
		let n = 0;
		for (const line of readFileSync(stored.session_file, "utf8").split("\n")) {
			if (!line) continue;
			let r: any;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (r.type === "header") {
				lines.push(JSON.stringify({ ...r, id: newId, created: Date.now(), forkedFrom: id }));
				continue;
			}
			if (r.type !== "message") continue;
			if (++n >= cut) break;
			lines.push(line);
		}
		mkdirSync(join(data, "sessions"), { recursive: true });
		writeFileSync(file, `${lines.join("\n")}\n`);
		const base = stored.title.replace(/ \(fork #\d+\)$/, "");
		const taken = (store.db.query("select count(*) as n from session where title like ? escape '\\'").get(`${base.replace(/[\\%_]/g, (c) => `\\${c}`)} (fork #%`) as { n: number }).n;
		const now = Date.now();
		store.putSession({
			id: newId,
			directory: stored.directory,
			title: `${base} (fork #${taken + 1})`,
			model: sessions.get(id)?.modelRef ?? stored.model,
			session_file: file,
			created_at: now,
			effort: stored.effort ?? null,
			nudge: stored.nudge ?? null,
			turn_mode: stored.turn_mode ?? null,
			cache_ttl: stored.cache_ttl ?? null,
			project_id: stored.project_id ?? projectFor(stored.directory),
			version: VERSION,
			// lineage in the parent's ids: the fork's own copies are renumbered under its id (msg_<fork>_00001...)
			forked_from: id,
			forked_at_message: messageID ?? null,
		});
		const pre = store.prefix(id);
		if (pre) store.putPrefix(newId, pre.hash, pre.bytes);
		const notes = join(data, "notes", `${id}.md`);
		if (existsSync(notes)) {
			mkdirSync(join(data, "notes"), { recursive: true });
			copyFileSync(notes, join(data, "notes", `${newId}.md`));
		}
		projectTranscript(store, newId, file, stored.directory);
		await loadVcsDir(stored.directory);
		publishSession("session.created", newId);
		publishSession("session.updated", newId);
		return info(row(newId));
	}

	/**
	 * a root context this large is worth keeping across a wait: a 5 minute entry rewritten after every pause costs more than
	 * the 1h write premium. helpers do not switch on size: they rarely wait more than 5 minutes between steps, a parked
	 * helper is warmed at 5m, and the switch rewrites the whole prefix at twice the input price
	 */
	const LONG_TTL_CONTEXT = 100_000;
	/**
	 * why a session without an explicit `cache_ttl` should mark its requests 1h (DECISIONS D23): it has a helper that is not closed
	 * (its report may take longer than 5 minutes), a background job that will notify it, or, for a session with no parent,
	 * its context passed 100k tokens
	 */
	function longTtlReason(id: string): string | undefined {
		if (store.agents.children(id).some((a) => a.state !== "closed")) return "it has a helper that is not closed";
		if (liveJobsOf(id) > 0) return "a background job will notify it";
		if (!store.session(id)?.parent_id && (sessions.get(id)?.contextFill.used ?? 0) > LONG_TTL_CONTEXT) return "its context passed 100k tokens";
		return undefined;
	}

	/**
	 * eval only (packages/eval/src/m9.ts, arm c): CMX2_EXCLUDE_TOOLS=spawn,message,wait,agents takes those tools away from
	 * every root session, so the main model runs alone. helpers never read it. it is not a setting: nothing documents it
	 * for users and no config key reaches it.
	 */
	const evalExclude = (process.env.CMX2_EXCLUDE_TOOLS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	function hooks(id: string, directory: string, child = !!store.session(id)?.parent_id) {
		const project = projectOf(directory);
		const checkoutTools = worktreeTools({
			create: (input) => createWorktree(directory, input, true),
			merge: (dir, message) => mergeWorktree(real(resolve(directory, dir)), message, id),
			discard: (dir) => discardWorktree(real(resolve(directory, dir)), id),
		});
		// review is declared, never inferred: the agent in a checkout says when its work is ready. a subagent reports to its spawner instead
		const review = !child && inCheckout(directory)
			? [
					requestReviewTool((note) => {
						const w = worktrees.locate(directory);
						const n = note?.trim();
						publish(w.directory, "worktree.review.requested", { name: w.name, ...(w.branch ? { branch: w.branch } : {}), ...(n ? { note: n } : {}), sessionID: id });
						console.error(`cmx2: review requested for ${w.branch ?? w.name} by ${id}${n ? `: ${n}` : ""}`);
						return { name: w.name, ...(w.branch ? { branch: w.branch } : {}) };
					}),
				]
			: [];
		return {

			onEvent: (e: EngineEvent) => {
				if (e.type === "message.part.started") {
					// a text or reasoning part begins: announced as a logged update before its first delta, so a client knows its type and place
					const p = e.properties as { seq: number; index: number; type: "text" | "reasoning"; start: number };
					const messageID = messageId(id, p.seq);
					const partID = partId(id, p.seq, p.index);
					const f = inflight.get(id);
					if (!f || f.info.id !== messageID || f.parts.has(partID)) return;
					const part: StreamingPart = { index: p.index, type: p.type, text: "", start: p.start };
					f.parts.set(partID, part);
					publish(directory, "message.part.updated", { sessionID: id, part: streamingPart(id, messageID, partID, part) });
					return;
				}
				if (e.type === "message.part.delta") {
					const p = e.properties as { seq: number; index: number; field: string; delta: string };
					const messageID = messageId(id, p.seq);
					const partID = partId(id, p.seq, p.index);
					// a delta goes only to a part that was announced; the text so far is kept for reads and resumes, and offset is where this delta lands, in utf-16 units (a1)
					const f = inflight.get(id);
					const part = f && f.info.id === messageID ? f.parts.get(partID) : undefined;
					if (!part || part.end !== undefined) return;
					const offset = part.text.length;
					part.text += p.delta;
					publish(directory, "message.part.delta", { sessionID: id, messageID, partID, field: p.field, delta: p.delta, offset });
					return;
				}
				if (e.type === "message.part.ended") {
					// a part's block ended: its final goes out now, logged, with the provider's whole text and when it ended, not at the step's end;
					// the step's end publishes it again, the same text and time.end. reads and resumes serve it final from here on
					const p = e.properties as { seq: number; index: number; end: number; text?: string };
					const messageID = messageId(id, p.seq);
					const partID = partId(id, p.seq, p.index);
					const f = inflight.get(id);
					const part = f && f.info.id === messageID ? f.parts.get(partID) : undefined;
					if (!f || !part || part.end !== undefined) return;
					if (typeof p.text === "string") part.text = p.text;
					part.end = p.end;
					publish(directory, "message.part.updated", { sessionID: id, part: streamingPart(id, messageID, partID, part) });
					return;
				}
				if (e.type === "message.started") {
					// the step is under way: clients see an assistant message without a completed time, as cmx sends it
					const p = e.properties as { seq: number; model: string; agent: string; effort: string };
					const slash = p.model.indexOf("/");
					const at = Date.now();
					const info = { id: messageId(id, p.seq), sessionID: id, role: "assistant", time: { created: at }, ...lastUserId(id), providerID: p.model.slice(0, slash), modelID: p.model.slice(slash + 1), mode: p.agent, agent: p.agent, variant: p.effort, path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
					inflight.set(id, { directory, info, parts: new Map() });
					publish(directory, "message.updated", { sessionID: id, info });
					return;
				}
				if (e.type === "tool.progress") {
					// a running shell's output tail lands on its tool part, at most once a second (a9): kept in memory, not in the
					// database or the log, sent to live streams unnumbered; reads and a resume's seam merge it in (progressTail)
					const p = e.properties as { callID: string; output: string };
					const key = `${id}\n${p.callID}`;
					let run = progressing.get(key);
					if (!run) {
						const part = store.toolPart(id, p.callID);
						if (!part) return;
						run = { session: id, directory, partId: part.id, data: JSON.parse(part.data), n: 0 };
						if (run.data.state?.status !== "running") return;
						progressing.set(key, run);
					}
					// progress numbers the tails: the frames carry no seq, so a client orders a tail against a read's by it
					run.n++;
					const data = { ...run.data, state: { ...run.data.state, metadata: { ...(run.data.state.metadata ?? {}), output: p.output, progress: run.n } } };
					run.tail = JSON.stringify(data);
					progressTail.set(run.partId, run.tail);
					publish(directory, "message.part.updated", { sessionID: id, part: data }, { unlogged: true });
					return;
				}
				if (e.type === "file.edited") {
					vcs.forget(directory);
					publish(directory, "file.edited", e.properties);
					return;
				}
				if (e.type === "session.idle") {
					inflight.delete(id);
					forgetProgress(id);
					vcs.forget(directory);
					// the closes and their events (and the revisions they move) commit as one
					landed(() => {
						for (const mid of closeOpenSteps(store, id, Date.now())) {
							const m = store.message(mid);
							if (m) publish(directory, "message.updated", { sessionID: id, info: JSON.parse(m.info) });
						}
					}, id);
				}
				if (e.type === "session.compacted") {
					// boxbox finds the pit stop's kept tail by message id
					const p = e.properties as { tailFrom: number };
					publish(directory, "session.compacted", { ...e.properties, tailStartID: messageId(id, p.tailFrom) });
					const live = sessions.get(id);
					if (live) {
						const c = live.contextFill;
						store.setSessionContext(id, c.used, c.limit, c.compactAt);
					}
					publishSession("session.updated", id);
					return;
				}
				if (e.type === "session.model") store.setSessionModel(id, (e.properties as { model: string }).model);
				if (e.type === "session.effort") store.setSessionEffort(id, (e.properties as { effort: Effort }).effort);
				// a refresh is paid for like a step: kept with its cost, and added to the session's totals
				if (e.type === "session.warmed") store.recordRefresh(id, e.properties as unknown as RefreshUsage);
				if (e.type === "session.status") {
					// idle carries what the session is parked on; boxbox keeps reading any non-idle type as busy
					const st = (e.properties as { status?: { type?: string } }).status;
					publish(directory, "session.status", { sessionID: id, status: st?.type === "retry" ? st : statusOf(id) });
					return;
				}
				publish(directory, e.type as EventType, e.properties);
				if (e.type === "session.idle") {
					publishSession("session.updated", id);
					lastUsed.set(id, Date.now());
					queueMicrotask(evictIdle);
				}
			},
			onStep: (step: StepRow) => {
				store.putStep(step as unknown as Record<string, unknown>);
				actors.onStep(id, step);
				const live = sessions.get(id);
				if (live) {
					const c = live.contextFill;
					store.setSessionContext(id, c.used, c.limit, c.compactAt);
				}
			},
			extraTools: [...agentTools(actors, id), ...review, ...(opts.extraTools?.() ?? [])],
			excludeTools: child ? actors.excludedTools(id) : [...actors.excludedTools(id), ...evalExclude],
			inbox: () => actors.inbox(id),
			onMailDelivered: (mailID: string, seq: number) => actors.onMailDelivered(id, mailID, seq),
			onTurn: (e: TurnEvent) => {
				actors.onTurn(id, e);
				void turnSnapshot(id, directory, e);
			},
			recall: async (query: string, limit: number) => {
				// sessions recorded before the index existed are indexed from their transcript on first use
				const r = store.session(id);
				if (r?.session_file && store.recallCount(id) === 0) projectTranscript(store, id, r.session_file, directory, { all: true });
				const found = store.recallSearch(id, query, limit);
				return {
					matches: found.matches,
					hits: found.hits.map((d) => ({ messageID: d.message_id, seq: d.seq, role: d.role, kind: d.kind, at: d.at, text: d.text, ...(d.tool ? { tool: d.tool } : {}), ...(d.call_id ? { callID: d.call_id } : {}) })),
				};
			},
			appendix: (): Array<[string, string | undefined]> => {
				return [
					// without spawn there is nobody to route to (eval arm c); the table would only invite a call that cannot be made
					["routing", !child && evalExclude.includes("spawn") ? undefined : actors.routingText(id)],
					["agents", actors.helpersText(id)],
				];
			},
			// the main session's model and effort are the user's dial; only helpers escalate on failure signals (and come back down)
			roster: () => actors.rosterText(id),
			escalate: child ? (model: string, from: Effort) => routing.escalate(model, from) as Effort | undefined : undefined,
			allowed: (model: string, effort: Effort) => routing.allowed(model, effort),
			warm: (ttl: "5m" | "1h") => actors.warmFor(id, ttl),
			autoCacheTtl: (): "5m" | "1h" => {
				const why = longTtlReason(id);
				if (!why) return "5m";
				// the switch is kept on the session row: an evicted or restarted session reopens at 1h as if it had asked for it, so it never switches back
				if (!store.session(id)?.cache_ttl) {
					store.setSessionCacheTtl(id, "1h");
					console.error(`cmx2: ${id} marks its prompt cache 1h from here on: ${why}`);
				}
				return "1h";
			},
			onPrefix: (hash: string, bytes: string) => store.putPrefix(id, hash, bytes),
			onMessage: (seq: number, message: unknown) => landed(() => {
				// a queued prompt had a provisional id while it waited; now it has its place in the transcript
				const provisional = (message as { id?: unknown })?.id;
				if (typeof provisional === "string") publish(directory, "message.removed", { sessionID: id, messageID: provisional });
				// the streamed message has landed; from here the projection holds it
				if ((message as { role?: string }).role === "assistant" && inflight.get(id)?.info.id === messageId(id, seq)) inflight.delete(id);
				// a revert made permanent: the messages it parks leave every list, each said with message.removed in this transaction
				const from = (message as { role?: string; from?: unknown }).role === "revert" ? (message as { from?: unknown }).from : undefined;
				const parked = typeof from === "number" ? (store.db.query("select id from message where session_id = ? and seq >= ? and reverted = 0").all(id, from) as Array<{ id: string }>) : [];
				const touched = projectMessage(store, { sessionId: id, cwd: directory, seq, completedAt: Date.now() }, message);
				const promoted = (message as { role?: string; btw?: unknown }).role === "user" ? (message as { btw?: unknown }).btw : undefined;
				if (typeof promoted === "string" && touched.message) btws.landed(promoted, touched.message);
				for (const p of parked) publish(directory, "message.removed", { sessionID: id, messageID: p.id });
				if (touched.message) {
					const m = store.message(touched.message);
					if (m) publish(directory, "message.updated", { sessionID: id, info: JSON.parse(m.info) });
				}
				for (const pid of touched.parts) {
					forgetProgress(id, pid);
					const p = store.part(pid);
					if (p) publish(directory, "message.part.updated", { sessionID: id, part: JSON.parse(p.data) });
				}
				if (touched.also) {
					const m = store.message(touched.also.message);
					if (m) publish(directory, "message.updated", { sessionID: id, info: JSON.parse(m.info) });
					for (const pid of touched.also.parts) {
						forgetProgress(id, pid);
						const p = store.part(pid);
						if (p) publish(directory, "message.part.updated", { sessionID: id, part: JSON.parse(p.data) });
					}
				}
				touch(id);
			}, id),
			procs: procs.host(id, directory, child ? subagentEnv() : undefined),
			child,
			skills: skillsOf(directory),
			lsp,
			dynamicTools: () => {
				try {
					return [...checkoutTools, ...mcp.toolsFor(Object.keys(configFor(directory).mcp ?? {}))];
				} catch {
					return [...checkoutTools, ...mcp.toolsFor(Object.keys(config.mcp ?? {}))];
				}
			},
			ledger: () => procs.ledger(id),
			beforeTurn: () => locks.acquire(id),
			afterTurn: () => locks.release(id),
			askPermission: (ask: Parameters<Asks["permission"]>[2], signal?: AbortSignal) => asks.permission(id, directory, ask, signal),
			savedRules: () => [...(store.rules([project, id]) as PermissionRule[]), ...reportRules(id)],
			// a helper asks the agent that started it; only the root (or a session outside any tree) asks the user
			askQuestion: (ask: Parameters<Asks["question"]>[2], signal?: AbortSignal) => (child && actors.isChild(id) ? actors.ask(id, ask.questions, signal) : asks.question(id, directory, ask, signal)),
		};
	}

	const asks = new Asks(store, (d, t, p) => {
		publish(d, t as EventType, p);
		// an ask or its answer is activity: the session moves to the top of every device's list
		if (typeof p.sessionID === "string") touch(p.sessionID);
	}, (req) => {
		const directory = store.session(req.session_id)?.directory ?? req.directory;
		const rules = [...rulesFromConfig(configFor(directory).permission), ...(store.rules([projectOf(directory), req.session_id]) as PermissionRule[])];
		return req.patterns.every((p) => evaluate(rules, req.permission, p).action === "allow");
	});

	const opening = new Map<string, Promise<EngineSession>>();

	/**
	 * the live session, opened from its transcript when it is not in memory. live sessions are a hot
	 * cache: when another daemon process ran a turn since this one last touched the transcript, the
	 * stale copy is dropped and the session reopens from disk.
	 */
	async function open(id: string): Promise<EngineSession> {
		const live = sessions.get(id);
		if (live && !(live.state === "idle" && live.staleOnDisk)) {
			lastUsed.set(id, Date.now());
			return live;
		}
		if (live) {
			live.dispose();
			sessions.delete(id);
		}
		const pending = opening.get(id);
		if (pending) return pending;
		const r = row(id);
		if (r.source === "cmx") throw new HttpError(409, "ConflictError", `session ${id} is history imported from cmx; it is browse only. start a new session to continue the work`);
		const p = reachFor(r.directory, id)
			.then(() =>
				EngineSession.create({
			id,
			cwd: r.directory,
			config: configFor(r.directory),
			dataDir: data,
			title: r.title,
			model: r.model,
			effort: (r.effort as Effort | null) ?? undefined,
			nudge: r.nudge === null || r.nudge === undefined ? undefined : r.nudge === 1,
			turnMessages: (r.turn_mode as "system" | "user-part" | null) ?? undefined,
			cacheTtl: (r.cache_ttl as "5m" | "1h" | null) ?? undefined,
			resume: { recordedPrefix: store.prefix(id)?.bytes },
			...hooks(id, r.directory),
				}),
			)
			.then((s) => {
				// an evicted session reopens idle since when it went idle, not since it was reloaded
				const was = idleSince.get(id);
				if (was !== undefined && s.state === "idle") s.stateSince = was;
				idleSince.delete(id);
				sessions.set(id, s);
				lastUsed.set(id, Date.now());
				const fault = faults.get(id);
				if (fault) {
					s.failNextTurn(fault);
					faults.delete(id);
				}
				if (r.session_file) projectTranscript(store, id, r.session_file, r.directory);
				publish(r.directory, "session.resumed", { sessionID: id });
				return s;
			})
			.finally(() => opening.delete(id));
		opening.set(id, p);
		return p;
	}

	/**
	 * starts a turn (or lands a steer/queue that would start one) under the run lock. the lock is
	 * taken before the session is opened, so the copy that runs is never older than the transcript.
	 */
	async function admit<T>(id: string, start: (s: EngineSession) => T): Promise<T> {
		const live = sessions.get(id);
		if (live?.state === "busy") {
			try {
				return start(live);
			} catch (e) {
				if (e instanceof BusyError) throw new HttpError(409, "BusyError", e.message, { sessionID: id });
				throw e;
			}
		}
		try {
			locks.acquire(id);
		} catch (e) {
			if (e instanceof RunLockHeld) throw new HttpError(409, "BusyError", e.message, { sessionID: id, holder: e.holder });
			throw e;
		}
		let s: EngineSession | undefined;
		try {
			s = await open(id);
			return start(s);
		} catch (e) {
			if (s?.state !== "busy") locks.release(id);
			if (e instanceof BusyError) throw new HttpError(409, "BusyError", e.message, { sessionID: id });
			throw e;
		}
	}

	/** a subagent's session: a real session with its parent, created idle; its first turn starts from the mailbox */
	async function createChild(spec: Parameters<Host["createSession"]>[0]) {
		await reachFor(spec.directory);
		let s: EngineSession;
		try {
			s = await EngineSession.create({
				id: spec.id,
				cwd: spec.directory,
				config: configFor(spec.directory),
				dataDir: data,
				title: spec.title,
				model: spec.model,
				effort: spec.effort,
				systemExtra: spec.systemExtra,
				...(spec.cacheTtl ? { cacheTtl: spec.cacheTtl } : {}),
				...hooks(spec.id, spec.directory, true),
				excludeTools: spec.excludeTools,
			});
		} catch (e) {
			if (e instanceof ModelError) throw new ActorError("BadRequestError", 400, e.message);
			throw e;
		}
		sessions.set(s.id, s);
		lastUsed.set(s.id, Date.now());
		store.putSession({
			id: s.id,
			directory: spec.directory,
			title: spec.title,
			model: s.modelRef,
			session_file: s.transcriptPath,
			created_at: s.createdAt,
			effort: s.effort,
			nudge: s.nudge ? 1 : 0,
			turn_mode: s.turnMode,
			cache_ttl: spec.cacheTtl ?? null,
			parent_id: spec.parentID,
			project_id: projectOf(spec.directory),
			version: VERSION,
		});
		await loadVcsDir(spec.directory);
		publishSession("session.created", s.id);
		publishSession("session.updated", s.id);
	}

	/** running shells' output tails, by session and call id; reads merge `progressTail` (part id to the part's json) over the stored row */
	const progressing = new Map<string, { session: string; directory: string; partId: string; data: any; n: number; tail?: string }>();
	const progressTail = new Map<string, string>();
	/** a tool part landed (its result replaces the running state), or the session went idle: its tail is dropped */
	function forgetProgress(session: string, partId?: string) {
		for (const [key, run] of progressing) {
			if (run.session !== session || (partId !== undefined && run.partId !== partId)) continue;
			progressing.delete(key);
			progressTail.delete(run.partId);
		}
	}

	/**
	 * the residency lru: idle sessions beyond MAX_RESIDENT are dropped from memory, least recently used
	 * first, and so is any idle session unused for IDLE_EVICT_MS (the minute sweep). their transcripts are
	 * the truth; the next message reopens them. a session warming its cache stays loaded until the warming stops,
	 * with one exception: roots are warmed for hours (D28), so when the idle non-warming sessions kept plus the warming
	 * roots pass MAX_RESIDENT, a root whose warming is only timers (no refresh, summary or btw on the wire) goes, oldest
	 * first. it stops warming, and its next return pays a rewrite. helpers, and the idle sweep, never evict a warming session.
	 */
	function evictIdle() {
		// (a session with prompts waiting stays: its queue lives in memory, and dropping it would lose them)
		const settled = (s: EngineSession) => s.state === "idle" && !opening.has(s.id) && s.queued === 0;
		const idle = [...sessions.values()].filter((s) => settled(s) && !s.warming);
		idle.sort((a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0));
		const stale = Date.now() - idleEvictMs;
		const over = Math.max(0, idle.length - MAX_RESIDENT);
		const drop = (s: EngineSession) => {
			idleSince.delete(s.id);
			idleSince.set(s.id, s.stateSince);
			for (const id of idleSince.keys()) {
				if (idleSince.size <= idleSinceMax) break;
				idleSince.delete(id);
			}
			s.dispose();
			sessions.delete(s.id);
			lastUsed.delete(s.id);
		};
		let kept = 0;
		for (const [i, s] of idle.entries()) {
			if (i >= over && (lastUsed.get(s.id) ?? 0) > stale) {
				kept++;
				continue;
			}
			drop(s);
		}
		// warming helpers never counted toward the cap and still do not; warming roots do
		const warmRoots = [...sessions.values()].filter((s) => settled(s) && s.warming && !store.session(s.id)?.parent_id);
		let extra = kept + warmRoots.length - MAX_RESIDENT;
		if (extra <= 0) return;
		const roots = warmRoots.filter((s) => s.warmingOnTimers);
		roots.sort((a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0));
		for (const s of roots) {
			if (extra-- <= 0) break;
			drop(s);
		}
	}

	function listQuery(url: URL, directory: string | undefined, q: Record<string, string>): Omit<SessionQuery, "limit"> {
		return {
			...(directory && q.scope === "project" ? { project: projectOf(directory) } : directory ? { directory } : {}),
			...(q.roots === "true" ? { roots: true } : {}),
			...(q.search ? { search: q.search } : {}),
			...(q.start ? { start: intParam(q.start, "start", { min: 0, fallback: 0 }) } : {}),
		};
	}

	const resize: Resize =
		opts.resize ??
		(async (bytes, mime) => {
			const r = await resizeImage(bytes, mime);
			return r.ok ? { data: r.data, mime: r.mime } : { placeholder: r.placeholder };
		});
	const catalog = new Catalog(configDir);
	/** skills per directory and the daemon's language servers, shared by sessions so a reload can flush them */
	const skills = new Map<string, Skills>();
	const lsp = new LspPool();
	/** the profile's mcp servers, one connection each for every session; they connect in the background */
	const mcp = new McpPool({
		dataDir: data,
		version: VERSION,
		cwd: real(process.env.HOME ?? process.cwd()),
		onChange: (st) => publish("global", "mcp.status", { name: st.name, status: st.status, transport: st.transport, tools: st.tools, ...(st.error ? { error: scrubText(st.error) } : {}) }),
		log: (line) => console.error(line),
	});
	mcp.configure(config.mcp);
	function skillsOf(directory: string): Skills {
		let k = skills.get(directory);
		if (!k) {
			k = new Skills(() => defaultSkillDirs(directory, configDir()));
			skills.set(directory, k);
		}
		return k;
	}
	let queuedSeq = 0;

	/** a prompt's parts read from disk; the session's directory is reached first, so a file part never reads it before that */
	async function blocks(b: { text?: string; parts?: PartInput[] }, directory: string, sessionID?: string): Promise<UserBlock[]> {
		await reachFor(directory, sessionID);
		return blocksOf(b, directory, resize);
	}

	/** an id for a prompt that waits behind a running turn; it keeps this id when it lands, so unsend can name it */
	function queuedId(sessionID: string): string {
		return `msg_${sessionID.replace(/^ses_/, "")}_q${Date.now().toString(36)}${(++queuedSeq).toString(36)}`;
	}

	/**
	 * a waiting prompt as a message with its parts, the shape the stream announces it in and the queue read
	 * returns it in (a19): what was typed, the client id, a steer marked as one (a20), and the model,
	 * effort and agent it asked for, which apply when it runs (a18)
	 */
	function provisional(sessionID: string, q: ReturnType<EngineSession["queuedPrompts"]>[number]) {
		const { id } = q;
		const slash = q.model ? q.model.indexOf("/") : -1;
		const info = {
			id,
			sessionID,
			role: "user",
			time: { created: q.created },
			queued: true,
			...(q.clientID ? { clientID: q.clientID } : {}),
			...(q.steer ? { steer: true } : {}),
			...(q.btw ? { btw: q.btw } : {}),
			...(q.agent ? { agent: q.agent } : {}),
			...(q.model && slash > 0 ? { model: { providerID: q.model.slice(0, slash), modelID: q.model.slice(slash + 1) } } : {}),
			...(q.effort ? { variant: q.effort } : {}),
		};
		const content: UserBlock[] = typeof q.content === "string" ? [{ type: "text", text: q.content }] : q.content;
		const parts = content.map((b, i) => {
			const pid = `prt_${id.replace(/^msg_/, "")}_${i}`;
			return b.type === "image"
				? { id: pid, sessionID, messageID: id, type: "file", mime: b.mimeType, filename: (b as { filename?: string }).filename ?? "image", url: `data:${b.mimeType};base64,${b.data}` }
				: b.document
					? documentPart(pid, sessionID, id, b.document)
					: { id: pid, sessionID, messageID: id, type: "text", text: b.text, ...(b.synthetic ? { synthetic: true } : {}) };
		});
		return { info, parts };
	}

	/** tells clients about a prompt that is waiting, before the model has it (cmx shows queued messages at once) */
	function publishQueued(directory: string, sessionID: string, q: ReturnType<EngineSession["queuedPrompts"]>[number]) {
		const { info, parts } = provisional(sessionID, q);
		publish(directory, "message.updated", { sessionID, info });
		for (const part of parts) publish(directory, "message.part.updated", { sessionID, part });
	}

	/**
	 * prompts accepted while their session's directory has not answered (a privacy prompt, a hung mount): the
	 * send answers 202 at once as a queued prompt, and the prompt runs once the directory is reached, in the
	 * order sent. until then it can be read back and taken back like any queued prompt.
	 */
	const deferred = new Map<string, { chain: Promise<void>; waiting: Array<ReturnType<EngineSession["queuedPrompts"]>[number]> }>();

	function deferPrompt(id: string, directory: string, q: ReturnType<EngineSession["queuedPrompts"]>[number], run: () => Promise<unknown>) {
		const d = deferred.get(id) ?? { chain: Promise.resolve(), waiting: [] };
		d.waiting.push(q);
		deferred.set(id, d);
		publishQueued(directory, id, q);
		const step = d.chain.then(async () => {
			await reachFor(directory, id);
			const at = d.waiting.indexOf(q);
			// taken back while it waited
			if (at < 0) return;
			d.waiting.splice(at, 1);
			try {
				await run();
			} catch (e) {
				// the send was answered already: the failure goes out as a turn's does
				const err = e instanceof HttpError ? e : e instanceof ActorError ? new HttpError(e.status, e.name, e.message) : new HttpError(500, "EngineError", e instanceof Error ? e.message : String(e));
				console.error(`cmx2: a prompt for ${id} that waited for ${directory} failed: ${err.message}`);
				publish(directory, "message.removed", { sessionID: id, messageID: q.id });
				publish(directory, "session.error", { sessionID: id, error: { name: err.name, data: { message: err.message } } });
				publishStatus(id);
			}
		});
		d.chain = step;
		void step.finally(() => {
			if (deferred.get(id)?.chain === step) deferred.delete(id);
		});
	}

	/** a deferred prompt taken back before it ran */
	function undefer(id: string, messageID: string): boolean {
		const d = deferred.get(id);
		const at = d?.waiting.findIndex((q) => q.id === messageID) ?? -1;
		if (!d || at < 0) return false;
		d.waiting.splice(at, 1);
		return true;
	}

	/**
	 * a session's end: the turn stops, its processes are reaped (keep'd ones stay), and it is archived.
	 * nothing is deleted (rule 15): the rows and the transcript stay, listings leave it out.
	 */
	async function archive(id: string) {
		const stored = row(id);
		await actors.onSessionEnded(id).catch((e) => console.error(`cmx2: closing the agents of ${id}: ${e instanceof Error ? e.message : String(e)}`));
		btws.stopSession(id);
		const s = sessions.get(id);
		if (s) {
			await s.abort(idleWaitMs).catch(() => {});
			s.dispose();
			sessions.delete(id);
		}
		asks.dropSession(id, "session_ended");
		locks.release(id);
		const reaped = await procs.reapSession(id);
		store.archiveSession(id);
		idleSince.delete(id);
		publish(stored.directory, "session.deleted", { sessionID: id, info: await infoOf(row(id)) });
		if (reaped.killed.length || reaped.kept.length) console.error(`cmx2: session ${id} ended: stopped ${reaped.killed.length} process(es), kept ${reaped.kept.map((k) => k.keep).join(", ") || "none"}`);
		return true;
	}

	/** skills visible from a directory; they list as `/` commands */
	function skillsFor(directory: string) {
		const k = skillsOf(directory);
		return k.list().map((info) => ({ ...info, body: () => k.body(info) }));
	}

	function skillText(k: { name: string; dir: string; body: () => string }): string {
		return `<skill name="${k.name}" dir="${k.dir}">\n${k.body()}\n</skill>`;
	}

	/** placeholders cmx lists for a template: $1 … $n in order, then $ARGUMENTS */
	function hints(template: string): string[] {
		const nums = [...new Set([...template.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b).map((n) => `$${n}`);
		return template.includes("$ARGUMENTS") ? [...nums, "$ARGUMENTS"] : nums;
	}

	/** the variant clients send is cmx2's effort when it names one */
	function effortOf(b: { effort?: Effort; variant?: string }): Effort | undefined {
		if (b.effort) return b.effort;
		return b.variant && ["low", "medium", "high", "xhigh", "max"].includes(b.variant) ? (b.variant as Effort) : undefined;
	}

	/**
	 * cmx's blocking answer, streamed: the status and headers go out at once and the assistant message
	 * follows when the turn settles, so a proxy's header timeout (node's fetch gives up after 300 s)
	 * never fires on a long turn.
	 */
	function settled(id: string, s: EngineSession, turn: Promise<void>): Response {
		const body = new ReadableStream({
			async start(controller) {
				controller.enqueue(new TextEncoder().encode(" "));
				await turn;
				await s.idle();
				controller.enqueue(new TextEncoder().encode(JSON.stringify(lastAssistant(id))));
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
	}

	function lastUserId(sessionID: string): { parentID?: string } {
		const r = store.db.query("select id from message where session_id = ? and role = 'user' order by seq desc limit 1").get(sessionID) as { id: string } | null;
		return r ? { parentID: r.id } : {};
	}

	/** the newest assistant message with its parts, as cmx's blocking prompt returns it */
	function lastAssistant(id: string) {
		const r = store.db.query("select id from message where session_id = ? and role = 'assistant' order by seq desc limit 1").get(id) as { id: string } | null;
		if (!r) return null;
		const m = store.message(r.id)!;
		const parts = store.db.query("select data from part where message_id = ? order by seq").all(r.id) as Array<{ data: string }>;
		return { info: JSON.parse(m.info), parts: parts.map((p) => JSON.parse(p.data)) };
	}

	/**
	 * cmx's prompt: runs a turn with the picked model, effort and agent. idle sessions start the turn;
	 * a busy one queues the prompt behind the running turn under an id clients can unsend.
	 */
	/**
	 * a send: idle sessions start the turn with the picked model, effort and agent; a busy one takes it as
	 * a queued prompt (or a steer) under a provisional id clients can unsend. either way the caller learns
	 * the message's id at once (a11) and the client id rides the message and its events (a4).
	 */
	async function promptTurn(
		id: string,
		content: UserBlock[],
		b: { model?: { providerID: string; modelID: string }; variant?: string; effort?: Effort; agent?: string },
		opts: { ask?: RequestAsk; clientID?: string; busy?: "queue" | "steer"; messageID?: string; btw?: string } = {},
	) {
		const stored = row(id);
		await reachFor(stored.directory, id);
		const agentDef = b.agent ? catalog.agent(stored.directory, b.agent) : undefined;
		if (b.agent && !agentDef) throw badRequest(`no agent named ${b.agent} in ${stored.directory}; GET /agent lists them`);
		const modelRef = b.model ? `${b.model.providerID}/${b.model.modelID}` : agentDef?.model;
		const target = modelRef ?? sessions.get(id)?.modelRef ?? stored.model;
		if (modelRef && blacklisted(configFor(stored.directory), modelRef)) throw badRequest(`${modelRef} is on the blacklist in your profile (providers.<id>.blacklist); pick another model`);
		const effort = effortOf(b) ?? variantEffort(configFor(stored.directory), target, b.variant);
		if (effort && !routing.allowed(target, effort)) throw effortRefused(target, effort);
		const clientID = opts.clientID;
		await commitRevert(id);
		return admit(id, async (s) => {
			if (s.state === "busy") {
				// the choice stays on the waiting prompt and applies when it runs (a18). the running turn keeps its model, so a steer cannot ask for another
				if (modelRef && opts.busy === "steer" && modelRef !== s.modelRef) {
					const why = b.model ? `it asked for ${modelRef}` : `agent ${b.agent} runs on ${modelRef}`;
					throw badRequest(`a steer lands in the turn that is running, which keeps ${s.modelRef}, and ${why}; queue it instead (POST /session/${id}/queue) to run after the turn on ${modelRef}`);
				}
				if (modelRef && modelRef !== s.modelRef) {
					try {
						await resolveModel(configFor(stored.directory), modelRef);
					} catch (e) {
						if (e instanceof ModelError) throw badRequest(e.message);
						throw e;
					}
				}
				const qid = opts.messageID ?? queuedId(id);
				const pick = { ...(b.agent ? { agent: b.agent } : {}), ...(effort ? { effort } : {}), ...(opts.btw ? { btw: opts.btw } : {}) };
				const result = opts.busy === "steer" ? await s.steer(content, { id: qid, clientID, ...pick }) : await s.queue(content, { id: qid, clientID, ...pick, ...(modelRef ? { model: modelRef } : {}) });
				const waiting = s.queuedPrompts().find((x) => x.id === qid);
				publishQueued(stored.directory, id, waiting ?? { id: qid, content, created: Date.now(), ...(clientID ? { clientID } : {}), ...(opts.busy === "steer" ? { steer: true } : {}), ...pick });
				return { s, started: false, result, messageID: qid, ...(waiting?.model ? { model: waiting.model } : {}), ...(waiting?.effort ? { effort: waiting.effort } : {}), ...(waiting?.agent ? { agent: waiting.agent } : {}) };
			}
			if (modelRef) {
				try {
					if (await s.setModel(modelRef)) store.setSessionModel(id, s.modelRef);
				} catch (e) {
					if (e instanceof ModelError) throw badRequest(e.message);
					throw e;
				}
			}
			// a prompt that waited for its directory under a provisional id lands with it, so the id is swapped the way a queued one's is
			const turn = s.prompt(content, { effort, ask: opts.ask, ...(b.agent ? { agent: b.agent } : {}), ...(clientID ? { clientID } : {}), ...(opts.messageID ? { id: opts.messageID } : {}), ...(opts.btw ? { btw: opts.btw } : {}) });
			// the first message names an unnamed session; the request runs beside the turn, never in it
			void titles.maybe(
				id,
				content
					.filter((c) => c.type === "text" && !c.synthetic)
					.map((c) => (c as { text: string }).text)
					.join("\n"),
			);
			return { s, started: true, result: "started" as const, turn, messageID: messageId(id, s.lastPromptSeq) };
		});
	}

	/** requests with a client id that are still running, so a repeat waits for the first answer instead of acting */
	const clientRuns = new Map<string, Promise<void>>();

	/**
	 * a request that acts at most once per client id (a4): the first acts and its answer is kept for 24
	 * hours; a repeat gets that answer, byte for byte, and does nothing. a streamed answer (a blocking send)
	 * is teed: the caller streams it while the copy is kept.
	 */
	async function once(clientID: string | undefined, route: string, sessionID: string | null, act: () => Promise<Response>): Promise<Response> {
		if (clientID === undefined) return act();
		if (!/^[\w.:-]{1,128}$/.test(clientID)) throw badRequest("clientID must be 1 to 128 letters, digits, dots, colons, dashes or underscores (a uuid fits)");
		const since = Date.now() - CLIENT_ID_MS;
		for (let attempt = 0; attempt < 2; attempt++) {
			const prior = store.clientAction(clientID, since);
			if (prior) {
				if (prior.route !== route || prior.session_id !== sessionID) {
					throw new HttpError(409, "ConflictError", `clientID ${clientID} was already used for ${prior.route}${prior.session_id ? ` on ${prior.session_id}` : ""}; send a new one for a new action`, { clientID });
				}
				if (prior.status === null) await clientRuns.get(clientID);
				const done = store.clientAction(clientID, since);
				if (done?.status == null) throw new HttpError(409, "ConflictError", `the first request with clientID ${clientID} was cut off by a daemon restart; what it did is in the session`, { clientID });
				return new Response(done.body, { status: done.status, headers: { "content-type": "application/json", "x-cmx2-repeat": "true" } });
			}
			if (store.claimClientAction({ client_id: clientID, route, session_id: sessionID, created_at: Date.now() }, since)) break;
		}
		let finish!: () => void;
		clientRuns.set(clientID, new Promise<void>((ok) => (finish = ok)));
		const keep = (status: number, body: string) => {
			store.finishClientAction(clientID, status, body);
			clientRuns.delete(clientID);
			finish();
		};
		let res: Response;
		try {
			res = await act();
		} catch (e) {
			const err = e instanceof HttpError ? e : e instanceof ActorError ? new HttpError(e.status, e.name, e.message, e.data) : new HttpError(500, "UnknownError", e instanceof Error ? e.message : String(e));
			keep(err.status, JSON.stringify({ name: err.name, data: { message: err.message, ...err.extra } }));
			throw err;
		}
		if (!res.body) {
			keep(res.status, "");
			return res;
		}
		const [mine, theirs] = res.body.tee();
		void new Response(theirs)
			.text()
			// kept as sent, the blocking send's leading space included, so a repeat is the same bytes
			.then((t) => keep(res.status, t))
			.catch(() => keep(res.status, ""));
		return new Response(mine, { status: res.status, headers: res.headers });
	}

	/** who is replying to an ask, for the settled answer a later reply gets: the body's name, else the client's */
	function settlerOf(req: Request, b: { by?: string; clientID?: string }) {
		const by = b.by ?? req.headers.get("x-cmx2-client") ?? req.headers.get("user-agent")?.split(/[\s/]/)[0] ?? "a client";
		return { by: by.slice(0, 80), ...(b.clientID ? { clientID: b.clientID } : {}) };
	}

	/** a reply that did not act, as the contract says (a6): unknown is 404, already settled is 409 with who and when */
	function replyRefused(kind: "permission" | "question", id: string, o: Exclude<ReplyOutcome, { ok: true }>): HttpError {
		if (o.kind === "unknown") return notFound(`no ${kind} ask ${id}`);
		const when = o.settledAt ? new Date(o.settledAt).toISOString() : "earlier";
		const what = kind === "permission" ? `answered ${o.reply}` : o.state === "replied" ? "answered" : o.state ?? "settled";
		return new HttpError(409, "ConflictError", `that ${kind} was already ${what}${o.by ? ` by ${o.by}` : ""} at ${when}`, {
			...(kind === "permission" ? { reply: o.reply } : o.state === "replied" ? { answers: o.answers } : { state: o.state }),
			settledAt: o.settledAt,
			by: o.by,
		});
	}

	function effortRefused(model: string, effort: string): HttpError {
		return new HttpError(400, "EffortNotAllowedError", `${model} does not run at ${effort}; it allows ${routing.allowedEfforts(model).join(", ")} (routing.jsonc never)`, { model, effort });
	}

	function askOf(b: { tool_choice?: "required" | { name: string }; format?: { schema: Record<string, unknown>; name?: string } }): RequestAsk | undefined {
		const ask: RequestAsk = {};
		if (b.tool_choice !== undefined) ask.toolChoice = b.tool_choice === "required" ? "required" : { name: b.tool_choice.name };
		if (b.format !== undefined) ask.format = { schema: b.format.schema, ...(b.format.name ? { name: b.format.name } : {}) };
		return ask.toolChoice || ask.format ? ask : undefined;
	}

	// ---------- config ----------

	async function doReload() {
		const before = JSON.stringify(config);
		let next: Config;
		try {
			next = reload();
			checkProfileKeys(next);
		} catch (e) {
			if (e instanceof ConfigError) throw badRequest(`${e.message}. the running config is unchanged`);
			throw e;
		}
		const changed = Object.keys(next).filter((k) => k !== "sources" && JSON.stringify((next as any)[k]) !== JSON.stringify((config as any)[k]));
		config = next;
		// skills, agents, commands, models and language servers are read again on next use
		catalog.flush();
		routing.flush();
		for (const k of skills.values()) k.flush();
		lsp.flush();
		const dirs = [...instances.keys()];
		instances.clear();
		for (const s of sessions.values()) s.reconfigure(configFor(s.cwd));
		for (const d of dirs) publish(d, "config.updated", { directory: d, changed });
		publish("global", "config.updated", { directory: "global", changed });
		if (before !== JSON.stringify(config)) console.error(`cmx2: config reloaded (${changed.join(", ") || "no top-level change"})`);
		// mcp servers are closed and dialled again; the answer waits for them (up to 15 s) so it can say how they came back
		const servers = await mcp.reconnect(config.mcp);
		return { instances: dirs.length, changed, flushed: ["skills", "agents", "commands", "models", "lsp", "routing", "mcp"], mcp: servers };
	}

	let watcher: ReturnType<typeof watch> | undefined;
	if (opts.watchConfig && existsSync(configDir())) {
		let t: ReturnType<typeof setTimeout> | undefined;
		watcher = watch(configDir(), () => {
			clearTimeout(t);
			t = setTimeout(() => {
				doReload().catch((e) => console.error(`cmx2: config not reloaded: ${e instanceof Error ? e.message : String(e)}`));
			}, 300);
		});
	}

	// ---------- routes ----------

	async function route(req: Request, url: URL): Promise<Response> {
		const p = url.pathname;
		const m = (re: RegExp) => p.match(re);
		const method = req.method;
		// a read names the event its state reflects (a2). the body and the cursor are taken in the same synchronous
		// step as the publish that would change them, so a client applies exactly the events after it
		const json = (v: unknown, status = 200, headers?: Record<string, string>) => Response.json(v, { status, headers: method === "GET" ? { ...headers, "x-cmx2-seq": cursor() } : headers });
		/** json() for a body already serialised: the same headers Response.json sets */
		const jsonText = (body: string, status = 200, headers?: Record<string, string>) => new Response(body, { status, headers: { "content-type": JSON_TYPE, ...(method === "GET" ? { ...headers, "x-cmx2-seq": cursor() } : headers) } });

		if (p === "/global/health") return json({ healthy: true, version: VERSION, name: "cmx2", contract: CONTRACT_VERSION, pid: process.pid });
		if (p === "/global/event") return sse(req, url, undefined);
		if (p === "/event") return sse(req, url, (await directoryOf(req, url)) ?? real(process.cwd()));
		if (p === "/global/fs" && method === "GET") {
			const q = queryOf(url, "browse");
			return json(await browse(q.path, q.hidden === "true"));
		}
		if (p === "/global/reload" && method === "POST") return json(await doReload());
		if (p === "/mcp" && method === "GET") return json(mcp.status().map((st) => (st.error ? { ...st, error: scrubText(st.error) } : st)));
		if (p === "/global/restart" && method === "POST") {
			setTimeout(async () => {
				await stop();
				(opts.onRestart ?? (() => process.exit(0)))();
			}, 200);
			return json(true);
		}
		if (p === "/global/memory" && method === "GET") {
			// gc=true collects first, so a measurement compares live memory rather than garbage not yet swept
			if (queryOf(url, "memory").gc === "true") Bun.gc(true);
			const mu = process.memoryUsage();
			return json({ rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external: mu.external, live_sessions: sessions.size, uptime_s: Math.round(process.uptime()), contract_violations: violations });
		}
		if (p === "/global/system" && method === "GET") return json(await machine());
		if (p === "/command" && method === "GET") {
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			await reachFor(dir);
			const cmds = catalog.commandsFor(dir).map((c) => ({
				name: c.name,
				...(c.description ? { description: c.description } : {}),
				...(c.agent ? { agent: c.agent } : {}),
				...(c.model ? { model: c.model } : {}),
				source: "command" as const,
				template: c.body,
				hints: hints(c.body),
			}));
			const taken = new Set(cmds.map((c) => c.name));
			const skills = skillsFor(dir)
				.filter((k) => !taken.has(k.name))
				.map((k) => ({ name: k.name, description: k.description, source: "skill" as const, template: k.path, hints: [] as string[] }));
			return json([...cmds, ...skills]);
		}
		if (p === "/find/file" && method === "GET") {
			const q = queryOf(url, "findFile");
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			const limit = intParam(q.limit, "limit", { min: 1, max: 200, fallback: 10 });
			const found = await findFiles(dir, { query: q.query ?? "", limit, ...(q.type ? { type: q.type as "file" | "directory" } : {}), ...(q.dirs === "false" ? { dirs: false } : {}) });
			return json(found.paths, 200, found.truncated ? { "x-truncated": "true" } : undefined);
		}
		if (p === "/find/text" && method === "GET") {
			const q = queryOf(url, "findText");
			if (!q.pattern) throw badRequest("pattern is required: a ripgrep regex, or a plain string with literal=true");
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			const limit = intParam(q.limit, "limit", { min: 1, max: 1000, fallback: 100 });
			try {
				const r = await findText(dir, { pattern: q.pattern, limit, ...(q.literal === "true" ? { literal: true } : {}), ...(q.glob ? { glob: q.glob } : {}) });
				return json(r.matches, 200, r.truncated ? { "x-truncated": "true" } : undefined);
			} catch (e) {
				throw badRequest(`ripgrep refused that pattern: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (p === "/file/content" && (method === "GET" || method === "HEAD")) {
			const q = queryOf(url, "fileContent");
			// no instance is made for the directory: a read of a path never loads a project's config
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			const max = intParam(q.max, "max", { min: 1, max: CONTENT_MAX, fallback: CONTENT_MAX });
			const f = await readContent(dir, q.path ?? "", max, req.headers.get("if-none-match"));
			const headers = { etag: f.etag, "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
			if ("notModified" in f) return new Response(null, { status: 304, headers });
			// HEAD is answered as GET without the body, so a client can ask what a file is without taking it
			return new Response(method === "HEAD" ? null : f.bytes, { headers: { ...headers, "content-type": f.type, "content-length": String(f.bytes.length) } });
		}
		if (p === "/file/status" && method === "GET") {
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			await reachFor(dir);
			const st = fileStatus(dir);
			if (!st) throw badRequest(`${dir} is not in a git work tree`);
			return json(st);
		}
		if (p === "/agent" && method === "GET") {
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			await reachFor(dir);
			return json(
				catalog.agentsFor(dir).map((a) => {
					const slash = a.model?.indexOf("/") ?? -1;
					return {
						name: a.name,
						...(a.description ? { description: a.description } : {}),
						mode: a.mode ?? "all",
						native: a.path === "(built in)",
						...(a.hidden ? { hidden: true } : {}),
						...(a.model && slash > 0 ? { model: { providerID: a.model.slice(0, slash), modelID: a.model.slice(slash + 1) } } : {}),
						permission: [],
						options: {},
					};
				}),
			);
		}
		if (p === "/config/providers" && method === "GET") {
			const dir = await directoryOf(req, url);
			if (dir) await reachFor(dir);
			const c = dir ? configFor(dir) : config;
			const models = (await catalog.modelsFor(c)).filter((m) => !blacklisted(c, `${m.provider}/${m.id}`));
			return json(providersJson(models, c, (ref) => variantsFor(c, ref), (ref, effort) => routing.allowed(ref, effort as Effort)));
		}
		if (p === "/config" && method === "GET") {
			const dir = await directoryOf(req, url);
			if (dir) await reachFor(dir);
			return json(redactConfig(dir ? configFor(dir) : config));
		}
		if (p === "/config" && method === "PATCH") {
			const patch = await bodyOf(req, "patchConfig");
			try {
				const r = patchProfile(configDir(), patch, () => checkProfileKeys(reload()));
				await doReload();
				return json({ path: r.path.split("/").pop(), changed: r.changed, config: redactConfig(config) });
			} catch (e) {
				if (e instanceof ConfigError) throw badRequest(e.message);
				throw e;
			}
		}
		if (p === "/pty" && method === "GET") {
			return json(procs.list().filter((x) => x.tty && !(x.origin === "user" && x.status === "exited")).map(ptyJson));
		}
		if (p === "/pty/shells" && method === "GET") return json(shells());
		if (p === "/pty" && method === "POST") {
			const b = await bodyOf<{ command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string>; origin?: "tui" | "model" }>(req, "createPty");
			const cwd = b.cwd ? await realAsync(resolve(b.cwd)) : ((await directoryOf(req, url)) ?? real(process.env.HOME ?? process.cwd()));
			await reachFor(cwd);
			if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) throw badRequest(`directory ${cwd} does not exist`);
			const command = b.command ? [b.command, ...(b.args ?? []).map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(" ") : "";
			const info = procs.spawn({
				command,
				cwd,
				tty: true,
				cols: 80,
				rows: 24,
				env: { TERM: "xterm-256color", CMX2_TERMINAL: "1", ...b.env },
				...(b.title ? { title: b.title } : {}),
				sessionID: null,
				origin: b.origin === "model" ? "model" : "user",
			});
			terminals.track(info.id);
			return json(ptyJson(info));
		}
		let pr: RegExpMatchArray | null;
		if ((pr = m(/^\/pty\/([^/]+)$/))) {
			const id = pr[1]!;
			if (method === "GET") {
				const info = procs.get(id);
				if (!info?.tty) throw notFound(`no terminal ${id}`);
				return json(ptyJson(info));
			}
			if (method === "PUT") {
				const b = await bodyOf<{ title?: string; size?: { rows: number; cols: number } }>(req, "updatePty");
				if (!procs.get(id)?.tty) throw notFound(`no terminal ${id}`);
				return json(ptyJson(procs.update(id, { ...(b.title ? { title: b.title } : {}), ...(b.size ? { size: { cols: b.size.cols, rows: b.size.rows } } : {}) })));
			}
			if (method === "DELETE") {
				if (procs.get(id)) await procs.remove(id);
				return json(true);
			}
		}
		if ((pr = m(/^\/session\/([^/]+)\/procs$/)) && method === "POST") {
			const id = pr[1]!;
			const stored = row(id);
			if (stored.archived_at) throw new HttpError(409, "ConflictError", `session ${id} has ended; start a new one`);
			const b = await bodyOf<{ command: string; tty?: boolean; title?: string; keep?: string; detach?: boolean; serve?: boolean; notify?: { on_exit?: boolean; on_pattern?: string; on_port?: number } }>(req, "startProc");
			const info = procs.spawn({ ...b, cwd: stored.directory, sessionID: id, origin: "user" });
			return json(procJson(info), 201);
		}
		if ((pr = m(/^\/session\/([^/]+)\/procs$/)) && method === "GET") {
			row(pr[1]!);
			await procs.refreshPorts(pr[1]!);
			return json(procs.list({ sessionID: pr[1]! }).map(procJson));
		}
		if (p === "/proc" && method === "GET") return json(procs.list().map(procJson));
		if (p === "/proc/sweep" && method === "GET") return json(swept);
		if ((pr = m(/^\/proc\/([^/]+)\/kill$/)) && method === "POST") {
			if (!procs.get(pr[1]!)) throw notFound(`no process ${pr[1]}`);
			await procs.kill(pr[1]!);
			return json(procJson(procs.get(pr[1]!)!));
		}
		if (p === "/project" && method === "GET") {
			const withList = queryOf(url, "projects").worktrees === "true";
			const read = () => {
				const rows = store.projects();
				const known = new Set(rows.map((r) => r.project));
				// a repository with checkouts is a project even before a session runs in it
				return { rows, extra: worktrees.projects().filter((x) => !known.has(x)) };
			};
			// checkouts read off the loop first; then the projects are read again and answered with the stamp in one step (a2)
			let all = read();
			let wanted = [...all.rows.map((r) => r.project), ...all.extra];
			// a project that turns up only in the re-read, or whose unknown answer expired meanwhile, is read off the loop too
			for (let i = 0; i < 3 && wanted.length; i++) {
				await Promise.all(wanted.map((x) => projectLists.of(x)));
				all = read();
				wanted = [...all.rows.map((r) => r.project), ...all.extra].filter((x) => !projectLists.peek(x));
			}
			const { rows, extra } = all;
			return json([...rows.map((r) => projectRow(r.project, { created: r.created, updated: r.updated }, withList, projectLists.peek(r.project))), ...extra.map((x) => projectRow(x, undefined, withList, projectLists.peek(x)))]);
		}
		if (p === "/experimental/worktree" && method === "POST") {
			const b = await bodyOf<{ name?: string; from?: string; startCommand?: string; wait?: boolean }>(req, "createWorktree");
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			await reachFor(dir);
			return json(await createWorktree(dir, b, b.wait === true));
		}
		if (p === "/experimental/worktree" && method === "GET") {
			const dir = (await directoryOf(req, url)) ?? real(process.cwd());
			await reachFor(dir);
			return json(worktrees.list(dir));
		}
		if (p === "/experimental/worktree/diff" && method === "GET") {
			const q = queryOf(url, "worktreeDiff");
			const dir = q.directory ? await realAsync(resolve(q.directory)) : (await directoryOf(req, url));
			if (!dir) throw badRequest("directory is required: the checkout to diff");
			await reachFor(dir);
			return json(worktrees.diff(dir));
		}
		if (p === "/experimental/worktree/merge" && method === "POST") {
			const b = await bodyOf<{ directory?: string; message?: string }>(req, "mergeWorktree");
			const dir = b.directory ? await realAsync(resolve(b.directory)) : (await directoryOf(req, url));
			if (!dir) throw badRequest("directory is required: the checkout to merge");
			await reachFor(dir);
			return json(await mergeWorktree(dir, b.message));
		}
		if (p === "/experimental/worktree/discard" && method === "POST") {
			const b = await bodyOf<{ directory?: string }>(req, "discardWorktree");
			const dir = b.directory ? await realAsync(resolve(b.directory)) : (await directoryOf(req, url));
			if (!dir) throw badRequest("directory is required: the checkout to discard");
			await reachFor(dir);
			return json(await discardWorktree(dir));
		}


		if (p === "/session/status" && method === "GET") {
			const directory = await directoryOf(req, url);
			const out: Record<string, unknown> = {};
			for (const s of sessions.values()) if (s.state === "busy" && (!directory || s.cwd === directory)) out[s.id] = s.retryStatus ? { ...s.retryStatus, since: s.stateSince } : { type: "busy", queued: s.queued, since: s.stateSince };
			// a session whose turn waits for its directory to answer reads as busy, with why
			for (const [id, w] of reaching) if (!out[id] && reach.slow(w.directory) && (!directory || w.directory === directory)) out[id] = statusOf(id);
			// parked sessions, and idle ones with prompts an abort left waiting, only on request: boxbox v1 reads any entry in this map as busy (and may flush it)
			if (queryOf(url, "sessionStatus").parked === "true") {
				const idleQueued = [...sessions.values()].filter((s) => s.state !== "busy" && s.queued > 0).map((s) => s.id);
				for (const id of [...actors.parkedSessions(), ...idleQueued]) {
					if (out[id]) continue;
					const r = store.session(id);
					if (r && (!directory || r.directory === directory)) out[id] = statusOf(id);
				}
			}
			return json(out);
		}
		if (p === "/session" && method === "GET") {
			const q = queryOf(url, "listSessions");
			const limit = intParam(q.limit, "limit", { min: 1, max: 1000, fallback: 100 });
			// `<updated_at>:<id>` continues exactly after a row; a bare `<updated_at>` (version 5) pages strictly older than it
			const keyed = q.before?.match(/^(\d+):(.+)$/);
			const before = keyed ? { time: Number(keyed[1]), id: keyed[2]! } : q.before ? intParam(q.before, "before", { min: 0, fallback: 0 }) : undefined;
			const dir = await directoryOf(req, url);
			// a project-scoped list for a directory is how a client opens a repository (boxbox v1's "open a repo"); it stays a project
			if (dir && q.scope === "project") await reachFor(dir);
			if (dir && q.scope === "project" && existsSync(dir) && store.openProject(projectOf(dir))) publishProject(projectOf(dir));
			const filters = listQuery(url, dir, q);
			const build = await readInfos(() => store.sessionsByUpdated({ limit, before, ...filters }));
			const { rows, items } = build();
			const last = rows.at(-1);
			return json(items, 200, rows.length === limit && last ? { "x-next-cursor": `${last.updated_at ?? last.created_at}:${last.id}` } : undefined);
		}
		if (p === "/api/session" && method === "GET") {
			const q = queryOf(url, "pageSessions");
			const limit = intParam(q.limit, "limit", { min: 1, max: 200, fallback: 50 });
			let filters: Omit<SessionQuery, "limit">;
			let order: "asc" | "desc";
			let after: { time: number; id: string } | undefined;
			let direction: "next" | "previous" = "next";
			if (q.cursor) {
				const extra = Object.keys(q).filter((k) => k !== "cursor" && k !== "limit");
				if (extra.length || rawDirectoryOf(req, url)) throw badRequest(`a cursor carries its own filters; send only cursor and limit (got ${extra.join(", ") || "a directory"})`);
				const c = decodeCursor(q.cursor);
				if (!c) throw badRequest("that cursor is not one this daemon issued");
				({ order, direction } = c);
				after = { time: c.time, id: c.id };
				filters = { directory: c.directory, project: c.project, roots: c.roots, search: c.search, start: c.start };
			} else {
				order = q.order === "asc" ? "asc" : "desc";
				const dir = await directoryOf(req, url);
				if (dir && q.scope === "project") await reachFor(dir);
				filters = listQuery(url, dir, q);
			}
			const build = await readInfos(() => store.sessionsByCreated({ limit, ...filters, order, after, direction }));
			const { rows, items } = build();
			const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
			const first = rows[0];
			const last = rows.at(-1);
			return json({
				items,
				cursor: {
					...(first ? { previous: encodeCursor({ id: first.id, time: first.created_at, order, direction: "previous", ...clean }) } : {}),
					...(last ? { next: encodeCursor({ id: last.id, time: last.created_at, order, direction: "next", ...clean }) } : {}),
				},
			});
		}
		if (p === "/session" && method === "POST") {
			const b = await bodyOf<any>(req, "createSession");
			// the directory may sit behind a privacy prompt or on a hung mount: its first touch is async, and this request waits for it alone
			const given = b.directory ? resolve(b.directory) : rawDirectoryOf(req, url);
			const directory = given ? await realAsync(given) : real(process.cwd());
			await reachFor(directory);
			if (!(await stat(directory).catch(() => undefined))?.isDirectory()) throw badRequest(`directory ${directory} does not exist`);
			const id = `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
			if (b.model && blacklisted(configFor(directory), b.model)) throw badRequest(`${b.model} is on the blacklist in your profile (providers.<id>.blacklist); pick another model`);
			if (b.effort) {
				const model = b.model ?? configFor(directory).model;
				if (!routing.allowed(model, b.effort)) throw effortRefused(model, b.effort);
			}
			// a session the user starts ends its system prompt with their notes; a helper's (createChild) does not
			const notes = userNotes();
			let s: EngineSession;
			try {
				s = await EngineSession.create({
					id,
					cwd: directory,
					config: configFor(directory),
					dataDir: data,
					title: b.title,
					model: b.model,
					effort: b.effort,
					nudge: b.nudge,
					turnMessages: b.turn_messages,
					cacheTtl: b.cache_ttl,
					...(notes ? { systemExtra: notes } : {}),
					...hooks(id, directory),
				});
			} catch (e) {
				if (e instanceof ModelError) throw badRequest(e.message);
				throw e;
			}
			sessions.set(s.id, s);
			store.putSession({
				id: s.id,
				directory,
				title: s.title === "untitled" ? defaultTitle(s.createdAt) : s.title,
				model: s.modelRef,
				session_file: s.transcriptPath,
				created_at: s.createdAt,
				effort: s.effort,
				nudge: s.nudge ? 1 : 0,
				turn_mode: s.turnMode,
				cache_ttl: b.cache_ttl ?? null,
				project_id: projectOf(directory),
				version: VERSION,
			});
			await loadVcsDir(directory);
			publishSession("session.created", s.id);
			publishSession("session.updated", s.id);
			return json(info(row(s.id)), 201);
		}

		let r = m(/^\/session\/([^/]+)$/);
		if (r && method === "GET") {
			await loadVcs([row(r[1]!)]);
			return json(info(row(r[1]!)));
		}
		if (r && method === "PATCH") {
			const b = await bodyOf<{ title?: string; time?: { archived?: number } }>(req, "updateSession");
			row(r[1]!);
			if (b.title !== undefined) {
				if (!store.setSessionTitle(r[1]!, b.title)) throw new HttpError(409, "ConflictError", `session ${r[1]} is history imported from cmx; it is read only here`);
				const live = sessions.get(r[1]!);
				if (live) live.title = b.title;
			}
			if (b.time?.archived) await archive(r[1]!);
			await loadVcs([row(r[1]!)]);
			// the reply follows its event, even when an earlier update for this session is still waiting on git
			await publishSession("session.updated", r[1]!);
			return json(info(row(r[1]!)));
		}
		if (r && method === "DELETE") {
			// rule 15: a deleted thread is archived. its rows and transcript stay; listings leave it out
			return json(await archive(r[1]!));
		}
		if ((r = m(/^\/session\/([^/]+)\/(prompt|prompt_async)$/)) && method === "POST") {
			const [id, kind] = [r[1]!, r[2]!];
			const b = await bodyOf<any>(req, kind === "prompt" ? "prompt" : "promptAsync");
			return once(b.clientID, kind, id, async () => {
				const stored = row(id);
				if (stored.source !== "cmx" && (!reach.ready(stored.directory) || deferred.has(id))) {
					// the directory has not answered: the prompt is accepted now and runs once it does (the status says why it waits)
					const messageID = queuedId(id);
					const text = (b.parts as PartInput[] | undefined)?.filter((x) => x.type === "text" && typeof x.text === "string").map((x) => ({ type: "text" as const, text: x.text!, ...(x.synthetic ? { synthetic: true } : {}) })) ?? (typeof b.text === "string" ? [{ type: "text" as const, text: b.text }] : []);
					const effort = effortOf(b);
					const model = b.model ? `${b.model.providerID}/${b.model.modelID}` : undefined;
					deferPrompt(id, stored.directory, { id: messageID, content: text, created: Date.now(), ...(b.clientID ? { clientID: b.clientID } : {}), ...(b.agent ? { agent: b.agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, async () => {
						const content = await blocks(b, stored.directory, id);
						const t = await promptTurn(id, content, b, { ask: askOf(b), clientID: b.clientID, messageID });
						store.setSessionEffort(id, t.s.standingEffort);
					});
					if (kind === "prompt_async") return json({ messageID, queued: true }, 202);
					return json({ accepted: true, effort: effort ?? stored.effort ?? config.effort, messageID, queued: messageID }, 202);
				}
				const content = await blocks(b, stored.directory, id);
				const t = await promptTurn(id, content, b, { ask: askOf(b), clientID: b.clientID });
				store.setSessionEffort(id, t.s.standingEffort);
				if (kind === "prompt_async") return json({ messageID: t.messageID, queued: !t.started }, 202);
				return json({ accepted: true, effort: t.s.effort, messageID: t.messageID, ...(t.started ? {} : { queued: t.messageID }) }, 202);
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/message$/)) && method === "POST") {
			// cmx's blocking send: the response is the assistant message once the turn settles
			const id = r[1]!;
			const b = await bodyOf<any>(req, "sendMessage");
			return once(b.clientID, "message", id, async () => {
				const content = await blocks(b, row(id).directory, id);
				const t = await promptTurn(id, content, b, { clientID: b.clientID });
				store.setSessionEffort(id, t.s.standingEffort);
				if (!t.started) return json({ queued: true, messageID: t.messageID }, 202);
				return settled(id, t.s, t.turn ?? Promise.resolve());
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/btw$/)) && method === "POST") {
			const id = r[1]!;
			const b = await bodyOf<{ text: string; clientID?: string }>(req, "askBtw");
			return once(b.clientID, "btw", id, async () => {
				row(id);
				return json(await btws.ask(id, b.text));
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/btw$/)) && method === "GET") {
			row(r[1]!);
			return json(btws.list(r[1]!));
		}
		if ((r = m(/^\/session\/([^/]+)\/btw\/([^/]+)\/(dismiss|promote)$/)) && method === "POST") {
			const [id, bid, verb] = [r[1]!, r[2]!, r[3]!];
			row(id);
			try {
				return json(verb === "dismiss" ? btws.dismiss(id, bid) : await btws.promote(id, bid));
			} catch (e) {
				if (e instanceof BtwError) throw new HttpError(e.status, e.name, e.message, { sessionID: id, btwID: bid });
				throw e;
			}
		}
		if ((r = m(/^\/session\/([^/]+)\/(steer|queue)$/)) && method === "POST") {
			const [id, kind] = [r[1]!, r[2]! as "steer" | "queue"];
			const b = await bodyOf<any>(req, kind);
			return once(b.clientID, kind, id, async () => {
				const content = await blocks(b, row(id).directory, id);
				const t = await promptTurn(id, content, b, { clientID: b.clientID, busy: kind });
				const kept = t as { model?: string; effort?: string; agent?: string };
				return json({ result: t.result, messageID: t.messageID, ...(kept.model ? { model: kept.model } : {}), ...(kept.effort ? { effort: kept.effort } : {}), ...(kept.agent ? { agent: kept.agent } : {}) }, 202);
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/shell$/)) && method === "POST") {
			// a `!` line: runs in the session's directory now, and the model reads it on its next request
			const id = r[1]!;
			const b = await bodyOf<{ command: string; clientID?: string }>(req, "shell");
			return once(b.clientID, "shell", id, async () => {
				const stored = row(id);
				if (stored.source === "cmx") throw new HttpError(409, "ConflictError", `session ${id} is history imported from cmx; it is browse only`);
				await reachFor(stored.directory, id);
				await commitRevert(id);
				const startedAt = Date.now();
				const out = await runCommand({ cwd: stored.directory, spillDir: join(data, "tool-output"), procs: procs.host(id, stored.directory) }, b.command, SHELL_LINE_TIMEOUT_S);
				await admit(id, (s) => {
					s.recordShell({ command: b.command, cwd: stored.directory, output: out.output, exitCode: out.exit_code, timedOut: out.timed_out, startedAt, ...(b.clientID ? { clientID: b.clientID } : {}) });
					if (s.state !== "busy") locks.release(id);
				});
				return json(lastAssistant(id));
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/command$/)) && method === "POST") {
			const id = r[1]!;
			const b = await bodyOf<{ command: string; arguments?: string; agent?: string; model?: string; variant?: string; parts?: PartInput[]; clientID?: string }>(req, "runCommand");
			return once(b.clientID, "command", id, async () => {
				const stored = row(id);
				await reachFor(stored.directory, id);
				const name = b.command.replace(/^\//, "");
				const args = b.arguments ?? "";
				const cmd = catalog.commandsFor(stored.directory).find((c) => c.name === name);
				const skill = cmd ? undefined : skillsFor(stored.directory).find((k) => k.name === name);
				if (!cmd && !skill) throw notFound(`no command named ${name}; GET /command lists them`);
				const content: UserBlock[] = cmd
					? [{ type: "text", text: expandTemplate(cmd.body, args) }]
					: [{ type: "text", text: `/${name}${args ? ` ${args}` : ""}` }, { type: "text", text: skillText(skill!), synthetic: true }];
				const extra = b.parts?.length ? (await blocks({ parts: b.parts }, stored.directory).catch(() => [])) : [];
				const modelStr = b.model ?? cmd?.model;
				const slash = modelStr?.indexOf("/") ?? -1;
				const t = await promptTurn(
					id,
					[...content, ...extra],
					{
						...(modelStr && slash > 0 ? { model: { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) } } : {}),
						...(b.variant ? { variant: b.variant } : {}),
						...((b.agent ?? cmd?.agent) ? { agent: b.agent ?? cmd?.agent } : {}),
					},
					{ clientID: b.clientID },
				);
				publish(stored.directory, "command.executed", { sessionID: id, name, arguments: args, ...(b.clientID ? { clientID: b.clientID } : {}) });
				if (!t.started) return json({ queued: true, messageID: t.messageID }, 202);
				return settled(id, t.s, t.turn ?? Promise.resolve());
			});
		}
		if ((r = m(/^\/session\/([^/]+)\/queue$/)) && method === "GET") {
			// what waits behind the running turn, or was left by an abort, in the order admitted: the stream's provisional messages, readable (a19)
			const id = r[1]!;
			row(id);
			const live = sessions.get(id);
			return json([...(live?.queuedPrompts() ?? []), ...(deferred.get(id)?.waiting ?? [])].map((q) => provisional(id, q)));
		}
		if ((r = m(/^\/session\/([^/]+)\/message\/([^/]+)$/)) && method === "DELETE") {
			// unsend: only a prompt still waiting behind the running turn can be taken back
			const [id, msg] = [r[1]!, r[2]!];
			const stored = row(id);
			const live = sessions.get(id);
			if (live?.unqueue(msg) || undefer(id, msg)) {
				publish(stored.directory, "message.removed", { sessionID: id, messageID: msg });
				return json(true);
			}
			if (store.message(msg)) throw new HttpError(409, "BusyError", `message ${msg} already went to the model; only a queued prompt can be taken back`, { sessionID: id });
			throw notFound(`no queued message ${msg} in session ${id}`);
		}
		if ((r = m(/^\/session\/([^/]+)\/loop$/)) && method === "POST") {
			const id = r[1]!;
			row(id);
			const live = sessions.get(id);
			const busy = () => new HttpError(409, "BusyError", `session ${id} is running a turn; abort it to run what waits now, or leave it to run after the turn`, { sessionID: id });
			if (live?.state === "busy") throw busy();
			let ran = 0;
			if (live) {
				ran = await admit(id, async (s) => {
					try {
						const n = await s.drainQueue();
						if (!n && s.state !== "busy") locks.release(id);
						return n;
					} catch (e) {
						if (s.state !== "busy") locks.release(id);
						throw e;
					}
				});
				// a turn started between the check and the drain: nothing ran, and the caller should know why
				if (!ran && sessions.get(id)?.state === "busy") throw busy();
			}
			return json({ ran });
		}
		if ((r = m(/^\/session\/([^/]+)\/summarize$/)) && method === "POST") {
			const id = r[1]!;
			const b = await bodyOf<{ providerID?: string; modelID?: string }>(req, "summarize");
			const stored = row(id);
			if (stored.source === "cmx") throw new HttpError(409, "ConflictError", `session ${id} is history imported from cmx; it is browse only`);
			await admit(id, async (s) => {
				try {
					const ref = b.providerID && b.modelID ? `${b.providerID}/${b.modelID}` : undefined;
					const switched = ref
						? await s.setModel(ref).catch((e) => {
								if (e instanceof ModelError) throw badRequest(e.message);
								throw e;
							})
						: false;
					if (switched) store.setSessionModel(id, s.modelRef);
					await s.compact().catch((e) => {
						throw new HttpError(500, "CompactionError", `the compaction did not happen: ${e instanceof Error ? e.message : String(e)}. the session is unchanged`);
					});
				} finally {
					if (s.state !== "busy") locks.release(id);
				}
			});
			return json(true);
		}
		if ((r = m(/^\/session\/([^/]+)\/revert$/)) && method === "POST") {
			const b = await bodyOf<{ messageID: string; partID?: string }>(req, "revert");
			return json(await revertTo(r[1]!, b.messageID, b.partID));
		}
		if ((r = m(/^\/session\/([^/]+)\/unrevert$/)) && method === "POST") return json(await unrevert(r[1]!));
		if ((r = m(/^\/session\/([^/]+)\/fork$/)) && method === "POST") {
			// a client that gave up waiting on a long copy and asks again gets the first fork, not a second one
			const id = r[1]!;
			const b = await bodyOf<{ messageID?: string; clientID?: string }>(req, "fork");
			return once(b.clientID, "fork", id, async () => json(await fork(id, b.messageID)));
		}
		if ((r = m(/^\/session\/([^/]+)\/diff$/)) && method === "GET") {
			const stored = row(r[1]!);
			const q = queryOf(url, "sessionDiff");
			return json(await sessionDiff(stored.id, stored.directory, q.messageID));
		}
		if ((r = m(/^\/session\/([^/]+)\/share$/)) && (method === "POST" || method === "DELETE")) {
			row(r[1]!);
			throw new HttpError(501, "NotSupportedError", "cmx2 does not share sessions; they stay on this machine");
		}
		if ((r = m(/^\/session\/([^/]+)\/children$/)) && method === "GET") {
			row(r[1]!);
			const build = await readInfos(() => store.children(r![1]!));
			return json(build().items);
		}
		if ((r = m(/^\/session\/([^/]+)\/agents$/)) && method === "GET") {
			row(r[1]!);
			const q = queryOf(url, "roster");
			return json(actors.roster(r[1]!, q.path_prefix));
		}
		if ((r = m(/^\/session\/([^/]+)\/agents$/)) && method === "POST") {
			const b = await bodyOf<SpawnInput>(req, "spawnAgent");
			if (row(r[1]!).archived_at) throw new HttpError(409, "ConflictError", `session ${r[1]} has ended; start a new one`);
			return json({ agents: await actors.spawn(r[1]!, b) }, 201);
		}
		if ((r = m(/^\/session\/([^/]+)\/agents\/message$/)) && method === "POST") {
			const b = await bodyOf<{ to: string; body: string; wake?: boolean; correlation_id?: string; files?: string[] }>(req, "messageAgent");
			row(r[1]!);
			return json(await actors.message(r[1]!, b), 202);
		}
		if ((r = m(/^\/session\/([^/]+)\/agents\/wait$/)) && method === "POST") {
			const b = await bodyOf<{ timeout_ms?: number; correlation_id?: string }>(req, "waitAgents");
			row(r[1]!);
			return json(await actors.wait(r[1]!, b, req.signal));
		}
		if ((r = m(/^\/session\/([^/]+)\/agents\/interrupt$/)) && method === "POST") {
			const b = await bodyOf<{ target: string }>(req, "interruptAgent");
			row(r[1]!);
			return json(await actors.interrupt(r[1]!, b.target));
		}
		if ((r = m(/^\/session\/([^/]+)\/agents\/close$/)) && method === "POST") {
			const b = await bodyOf<{ target: string }>(req, "closeAgent");
			row(r[1]!);
			return json(await actors.close(r[1]!, b.target));
		}
		if ((r = m(/^\/session\/([^/]+)\/agents\/metrics$/)) && method === "GET") {
			row(r[1]!);
			return json(actors.metrics(r[1]!));
		}
		if ((r = m(/^\/session\/([^/]+)\/mailbox$/)) && method === "GET") {
			row(r[1]!);
			return json(
				actors.pendingMail(r[1]!).map((mm) => ({ id: mm.id, seq: mm.seq, kind: mm.kind, from: mm.from_path, fromID: mm.from_id, body: mm.body, wake: mm.wake === 1, system: mm.system === 1, correlation_id: mm.correlation_id, meta: JSON.parse(mm.meta), createdAt: mm.created_at })),
			);
		}
		if ((r = m(/^\/session\/([^/]+)\/effort$/)) && method === "POST") {
			const { effort } = await bodyOf<{ effort: Effort }>(req, "setEffort");
			const model = sessions.get(r[1]!)?.modelRef ?? row(r[1]!).model;
			if (!routing.allowed(model, effort)) throw effortRefused(model, effort);
			const s = await open(r[1]!);
			const result = s.setEffort(effort);
			store.setSessionEffort(s.id, effort);
			return json({ result, effort });
		}
		if ((r = m(/^\/session\/([^/]+)\/abort$/)) && method === "POST") {
			const id = r[1]!;
			const s = sessions.get(id);
			row(id);
			if (s) {
				const wasBusy = s.state === "busy";
				// a person stopping a subagent: its spawner hears it; the root's children keep running and the root hears who is out
				if (wasBusy && actors.isChild(id)) actors.userInterrupt(id);
				// a turn that does not go idle in time (a tool that ignores the signal) is ended: a helper is marked
				// interrupted, a root leaves memory, and either reopens from its transcript on the next message
				if (!(await s.abort(idleWaitMs))) {
					console.error(`cmx2: ${id} did not stop within ${idleWaitMs} ms; its session is ended`);
					await actors.forceInterrupted(id, "user");
					evictStuck(id, s);
				}
				if (wasBusy && !actors.isChild(id)) actors.onUserAbort(id);
			}
			// asks the stopped turn left open are rejected, each with its event, so no surface keeps a dead card (a6)
			asks.dropSession(id, "abort");
			return json(true);
		}
		if ((r = m(/^\/session\/([^/]+)\/message$/)) && method === "GET") {
			const id = r[1]!;
			const stored = row(id);
			if (stored.source !== "cmx" && stored.session_file && !sessions.has(id)) projectTranscript(store, id, stored.session_file, stored.directory);
			const q = queryOf(url, "messages");
			const limit = q.limit ? intParam(q.limit, "limit", { min: 0, fallback: 0 }) : 0;
			const before = q.before ? intParam(q.before, "before", { min: 0, fallback: 0 }) : undefined;
			if (before !== undefined && !limit) throw badRequest("before needs a limit");
			// the newest page ends with the message being streamed, its text so far marked streaming (a5)
			const live = before === undefined ? streamingMessage(id) : undefined;
			const page = live && limit === 1 ? { rows: [], next: store.lastMessageSeq(id) ? store.lastMessageSeq(id) + 1 : null } : store.messages(id, { limit: (live && limit ? limit - 1 : limit) || undefined, before });
			// a running shell's latest tail (in memory, never stored) stands in for its stored part
			const items = messagesJson(page.rows, store.archived(id), (pid) => progressTail.get(pid));
			if (live) items.push(JSON.stringify(live));
			// the revision the body reflects, read in the same synchronous step as the body and x-cmx2-seq (protocol 14a)
			const rev = { "x-cmx2-rev": String(store.transcriptRev(id)) };
			return jsonText(`[${items.join(",")}]`, 200, page.next !== null ? { "x-next-cursor": String(page.next), ...rev } : rev);
		}
		if ((r = m(/^\/session\/([^/]+)\/message\/([^/]+)$/)) && method === "GET") {
			const [id, mid] = [r[1]!, r[2]!];
			const stored = row(id);
			const live = streamingMessage(id);
			if (live && live.info.id === mid) return json(live, 200, { "x-cmx2-rev": String(store.transcriptRev(id)) });
			if (stored.source !== "cmx" && stored.session_file && !sessions.has(id)) projectTranscript(store, id, stored.session_file, stored.directory);
			const one = store.messageWithParts(id, mid);
			if (!one) throw notFound(`no message ${mid} in session ${id}`);
			return jsonText(messagesJson([one], store.archived(id), (pid) => progressTail.get(pid))[0]!, 200, { "x-cmx2-rev": String(store.transcriptRev(id)) });
		}
		if ((r = m(/^\/session\/([^/]+)\/steps$/)) && method === "GET") return json(store.steps(row(r[1]!).id));
		if ((r = m(/^\/session\/([^/]+)\/requests$/)) && method === "GET") return json((await open(r[1]!)).requests);
		if ((r = m(/^\/session\/([^/]+)\/messages$/)) && method === "GET") return json((await open(r[1]!)).messages);
		if ((r = m(/^\/session\/([^/]+)\/prefix$/)) && method === "GET") {
			const pre = store.prefix(r[1]!);
			if (!pre) throw notFound(`no recorded prefix for ${r[1]} yet; it is recorded on the first model request`);
			return json(pre);
		}

		if (p === "/permission" && method === "GET") return json(store.pendingPermissions({ directory: (await directoryOf(req, url)) }).map(permissionJson));
		if ((r = m(/^\/permission\/([^/]+)\/reply$/)) && method === "POST") {
			const rid = r[1]!;
			const b = await bodyOf<{ reply: "once" | "always" | "reject"; message?: string; cascade?: boolean; by?: string; clientID?: string }>(req, "replyPermission");
			return once(b.clientID, "permission.reply", rid, async () => {
				const o = asks.replyPermission(rid, b.reply, {
					...settlerOf(req, b),
					...(b.message ? { message: b.message } : {}),
					...(b.cascade ? { cascade: true } : {}),
					saveRule: (ask) => {
						const scope = projectOf(store.session(ask.session_id)?.directory ?? ask.directory);
						for (const pattern of ask.always) store.putRule({ scope, permission: ask.permission, pattern, action: "allow" });
					},
				});
				if (!o.ok) throw replyRefused("permission", rid, o);
				return json(true);
			});
		}
		if (p === "/question" && method === "GET") return json(store.pendingQuestions({ directory: (await directoryOf(req, url)) }).map(questionJson));
		if ((r = m(/^\/question\/([^/]+)\/reply$/)) && method === "POST") {
			const rid = r[1]!;
			const b = await bodyOf<{ answers: string[][]; by?: string; clientID?: string }>(req, "replyQuestion");
			return once(b.clientID, "question.reply", rid, async () => {
				const o = asks.replyQuestion(rid, b.answers, settlerOf(req, b));
				if (!o.ok) throw replyRefused("question", rid, o);
				return json(true);
			});
		}
		if ((r = m(/^\/question\/([^/]+)\/reject$/)) && method === "POST") {
			const rid = r[1]!;
			const b = await bodyOf<{ by?: string; clientID?: string }>(req, "rejectQuestion");
			return once(b.clientID, "question.reject", rid, async () => {
				const o = asks.rejectQuestion(rid, settlerOf(req, b));
				if (!o.ok) throw replyRefused("question", rid, o);
				return json(true);
			});
		}

		throw notFound(`no route for ${method} ${p}`);
	}

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const refused = refuse(req);
		if (refused) return refused;
		// the pairing exchange is the one route that needs no credential: the one-time token is the credential
		if (url.pathname === "/pair" && req.method === "POST") return pair(req);
		if (!authorized(req)) return unauthorized();
		try {
			return await route(req, url);
		} catch (e) {
			if (e instanceof HttpError) return errorResponse(e);
			if (e instanceof ActorError) return errorResponse(new HttpError(e.status, e.name, e.message, e.data));
			if (e instanceof WorktreeError) return errorResponse(new HttpError(e.status, e.name, e.message, e.data));
			console.error(e);
			return Response.json({ name: "UnknownError", data: { message: e instanceof Error ? e.message : String(e) } }, { status: 500 });
		}
	}

	function unauthorized(): Response {
		return Response.json(
			{ name: "UnauthorizedError", data: { message: opts.password ? "this daemon needs basic auth (user cmx2, password from CMX2_SERVER_PASSWORD) or a paired bearer credential" : "this daemon needs a paired credential: run cmx2 pair on the host and trade the token at POST /pair" } },
			{ status: 401, headers: { "www-authenticate": 'Basic realm="cmx2"' } },
		);
	}

	/** `POST /pair`: a one-time token from `cmx2 pair` for a bearer credential, answered once */
	async function pair(req: Request): Promise<Response> {
		try {
			const b = await bodyOf<{ token: string; name?: string }>(req, "pair");
			const r = pairing.exchange(b.token.trim(), b.name);
			console.error(`cmx2: paired ${r.name} (${r.id}); cmx2 pair --revoke ${r.id} cuts it off`);
			return Response.json({ id: r.id, name: r.name, credential: r.credential, scheme: "Bearer", version: VERSION, contract: CONTRACT_VERSION });
		} catch (e) {
			if (e instanceof PairError) return errorResponse(new HttpError(401, "UnauthorizedError", e.message));
			if (e instanceof HttpError) return errorResponse(e);
			throw e;
		}
	}

	const server = listen<TermSocketData>({
		port: opts.port,
		hostname: opts.hostname,
		fetch: handle,
		// decided on the headers, before a body is read: an unauthenticated peer cannot make the daemon buffer one
		precheck: (req) => {
			const refused = refuse(req);
			if (refused) return { response: refused };
			const pairing = new URL(req.url).pathname === "/pair" && req.method === "POST";
			if (pairing) return { maxBody: PAIR_BODY_BYTES };
			if (!authorized(req)) return { response: unauthorized() };
			return { maxBody: MAX_BODY_BYTES };
		},
		stream: streamRequest,
		upgrade(req, srv) {
			const url = new URL(req.url);
			const connect = url.pathname.match(/^\/pty\/([^/]+)\/connect$/);
			if (connect && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const refused = refuse(req);
				if (refused) return refused;
				if (!authorized(req)) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="cmx2"' } });
				if (!procs.get(connect[1]!)?.tty) return errorResponse(notFound(`no terminal ${connect[1]}`));
				if (srv.upgrade(req, { data: { ptyID: connect[1]!, cursor: Terminals.cursorOf(url.searchParams.get("cursor")) } })) return undefined;
				return errorResponse(badRequest("the terminal connection needs a websocket upgrade"));
			}
			return handle(req);
		},
		websocket: {
			perMessageDeflate: false,
			open: (ws) => terminals.open(ws),
			message: (ws, msg) => terminals.message(ws, msg),
			close: (ws) => terminals.close(ws),
			drain: (ws) => terminals.drain(ws),
		},
	});

	// agents that were mid-turn when the last daemon stopped are interrupted and their spawners told; waiting mail gets its turns
	/**
	 * an answer a crash cut off (a13): its message was announced at the first token and logged, but the
	 * transcript never got it, so no row exists and the next message would take its id. before anything
	 * runs, each such message is written to the transcript at the position it was announced at, as an
	 * aborted answer whose content is the parts the log announced, each empty (the streamed text was never
	 * logged), projected, and published once more with its parts, so the log's last word on the message and
	 * on each part is what a read serves.
	 */
	function closeCutOff() {
		const announced = store.db
			.query(
				"select properties from event_log where type = 'message.updated' and json_extract(properties, '$.info.role') = 'assistant' order by seq",
			)
			.all() as Array<{ properties: string }>;
		const last = new Map<string, Record<string, any>>();
		for (const r of announced) {
			const info = JSON.parse(r.properties).info;
			last.set(info.id, info);
		}
		for (const info of last.values()) {
			if (info.time?.completed !== undefined || store.message(info.id)) continue;
			const stored = store.session(info.sessionID);
			if (!stored?.session_file || !existsSync(stored.session_file)) continue;
			try {
				locks.acquire(info.sessionID);
			} catch {
				continue;
			}
			try {
				const t = new Transcript(stored.session_file);
				const seq = t.load().messages.length + 1;
				if (messageId(info.sessionID, seq) !== info.id) continue;
				t.count = seq - 1;
				const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				// every part the log announced for it: one whose block had ended keeps what its final said (its whole text, its end), one
				// still streaming closes empty at the time the message does, so the log's last word on each part is the stored one
				const closedAt = Date.now();
				const announcedParts = new Map<number, { type: string; start?: number; end?: number; text: string }>();
				for (const r of store.db.query("select properties from event_log where type = 'message.part.updated' and json_extract(properties, '$.part.messageID') = ? order by seq").all(info.id) as Array<{ properties: string }>) {
					const part = JSON.parse(r.properties).part;
					if (part.type !== "text" && part.type !== "reasoning") continue;
					const ended = !part.streaming && typeof part.time?.end === "number";
					announcedParts.set(Number(String(part.id).slice(String(part.id).lastIndexOf("_") + 1)), { type: part.type, start: part.time?.start, ...(ended ? { end: part.time.end, text: String(part.text ?? "") } : { text: "" }) });
				}
				const content: Array<Record<string, unknown>> = [];
				const partTimes: Record<number, { start: number; end: number }> = {};
				for (let i = 0; i <= Math.max(-1, ...announcedParts.keys()); i++) {
					const a = announcedParts.get(i);
					content.push(a?.type === "reasoning" ? { type: "thinking", thinking: a.text } : { type: "text", text: a?.text ?? "" });
					if (typeof a?.start === "number") partTimes[i] = { start: a.start, end: a.end ?? closedAt };
				}
				const message = {
					role: "assistant",
					content,
					...(Object.keys(partTimes).length ? { partTimes } : {}),
					provider: info.providerID,
					model: info.modelID,
					...(info.variant ? { thinkingLevel: info.variant } : {}),
					usage: zero,
					stopReason: "aborted",
					errorMessage: "the daemon stopped before this answer finished",
					timestamp: info.time?.created ?? Date.now(),
				};
				t.append(message);
				landed(() => {
					const touched = projectMessage(store, { sessionId: info.sessionID, cwd: stored.directory, seq, completedAt: closedAt }, message);
					const m = touched.message ? store.message(touched.message) : undefined;
					if (m) publish(stored.directory, "message.updated", { sessionID: info.sessionID, info: JSON.parse(m.info) });
					for (const pid of touched.parts) {
						const part = store.part(pid);
						if (part) publish(stored.directory, "message.part.updated", { sessionID: info.sessionID, part: JSON.parse(part.data) });
					}
				}, info.sessionID);
				console.error(`cmx2: closed ${info.id} in ${info.sessionID}: the daemon stopped before that answer finished`);
			} catch (e) {
				console.error(`cmx2: could not close the cut-off answer ${info.id}: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				locks.release(info.sessionID);
			}
		}
	}

	/**
	 * the transcripts a read would answer differently from the rows, healed before anything runs, so the revision on the
	 * list already says so (protocol 14a): a transcript written after the session was last touched (a crash between the
	 * engine's line and the landing's commit), or rows whose path.cwd is not the session's directory any more (a checkout
	 * merged and its sessions moved). a heal that changed nothing leaves the revision where it was; one that moved it
	 * says so with session.updated
	 */
	function healTranscripts(): Promise<{ checked: number; replayed: number; moved: number }> {
		const rows = store.db
			.query(
				`select s.id, s.session_file, s.directory, s.updated_at, (select json_extract(m.info, '$.path.cwd') from message m where m.session_id = s.id and m.role = 'assistant' and coalesce(json_extract(m.info, '$.mode'), '') != 'shell' order by m.seq desc limit 1) as cwd
				 from main.session s where s.source = 'cmx2' and s.session_file is not null`,
			)
			.all() as Array<{ id: string; session_file: string; directory: string; updated_at: number | null; cwd: string | null }>;
		const out = { checked: 0, replayed: 0, moved: 0 };
		// off the start path, a page at a time: the daemon answers while it runs
		return (async () => {
			for (let i = 0; i < rows.length; i++) {
				if (stopped) break;
				if (i % HEAL_PAGE === HEAL_PAGE - 1) await new Promise((ok) => setImmediate(ok));
				const r = rows[i]!;
				if (sessions.has(r.id)) continue;
				out.checked++;
				let mtime: number;
				try {
					mtime = statSync(r.session_file).mtimeMs;
				} catch {
					continue;
				}
				// file times carry a fraction of a millisecond and touch() stamps whole ones in the same millisecond as the
				// engine's append: whole milliseconds compare, so a transcript the rows caught up with is left alone
				// (a shell reply's rows name the shell's folder, so those are not asked about it)
				if (Math.floor(mtime) <= (r.updated_at ?? 0) && (r.cwd === null || r.cwd === r.directory)) continue;
				const before = store.transcriptRev(r.id);
				out.replayed++;
				try {
					projectTranscript(store, r.id, r.session_file, r.directory);
				} catch (e) {
					console.error(`cmx2: healing ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
					continue;
				}
				if (store.transcriptRev(r.id) !== before) {
					out.moved++;
					console.error(`cmx2: healed ${r.id}: its transcript had what its rows did not`);
					publishSession("session.updated", r.id);
				}
			}
			return out;
		})();
	}

	/** the start's heal, for tests: settles when every session was looked at */
	const healing = Promise.withResolvers<{ checked: number; replayed: number; moved: number }>();
	const healed = healing.promise;
	queueMicrotask(() => {
		try {
			closeCutOff();
		} catch (e) {
			console.error(`cmx2: closing cut-off answers failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		try {
			const n = btws.heal();
			if (n) console.error(`cmx2: ${n} btw(s) left running by the last daemon recorded as errors`);
		} catch (e) {
			console.error(`cmx2: closing cut-off btws failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		void healTranscripts()
			.catch((e) => {
				console.error(`cmx2: healing transcripts failed: ${e instanceof Error ? e.message : String(e)}`);
				return { checked: 0, replayed: 0, moved: 0 };
			})
			.then(healing.resolve);
		try {
			const r = actors.reconcile();
			if (r.interrupted.length || r.woken.length) console.error(`cmx2: agents after restart: interrupted ${r.interrupted.join(", ") || "none"}; woke ${r.woken.join(", ") || "none"}`);
		} catch (e) {
			console.error(`cmx2: agent reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	});

	// the replay window and the client-id window are kept by pruning; sessions and messages are never touched (rule 15)
	const prune = () => {
		try {
			store.pruneEvents(eventWindow);
			store.pruneClientActions(Date.now() - CLIENT_ID_MS);
		} catch (e) {
			console.error(`cmx2: pruning the event log failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	prune();
	const pruneTimer = setInterval(prune, 60_000);
	pruneTimer.unref?.();
	const evictTimer = setInterval(evictIdle, opts.idleSweepMs ?? 60_000);
	evictTimer.unref?.();

	let stopped = false;
	async function stop() {
		if (stopped) return;
		stopped = true;
		clearInterval(pruneTimer);
		clearInterval(evictTimer);
		watcher?.close();
		await btws.stopAll();
		// at once, so stuck turns cost one wait between them, not one each
		await Promise.all(
			[...sessions.values()].map(async (s) => {
				await s.abort(idleWaitMs).catch(() => {});
				s.dispose();
			}),
		);
		sessions.clear();
		locks.releaseAll();
		lsp.flush();
		await mcp.close();
		// snapshots a settled turn is still writing get a moment, then their git is stopped
		await snapshots.close();
		const stoppedProcs = await procs.stopAll();
		if (stoppedProcs.killed.length || stoppedProcs.left.length) console.error(`cmx2: stopped ${stoppedProcs.killed.length} process(es) on shutdown; left running: ${stoppedProcs.left.map((p) => `${p.keep ?? "detached"} pid ${p.pid}`).join(", ") || "none"}`);
		// streams get the goodbye frame and a moment to flush it before their sockets close
		publish("global", "global.disposed", {});
		await Bun.sleep(100);
		for (const s of [...subscribers]) s.close();
		await Bun.sleep(50);
		await server.stop();
		store.close();
	}
	return { server, stop, store, sessions, procs, actors, routing, handle, violations: () => violations, healed: () => healed, idleSince: idleSince as ReadonlyMap<string, number> };
}
