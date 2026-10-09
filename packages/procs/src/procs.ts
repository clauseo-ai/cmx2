import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcHost, ProcNotify, ProcRead, ProcSpawn, ProcSummary } from "@cmx2/tools";
import { incompleteTail, OutputBuffer } from "./buffer.ts";

/**
 * every process cmx2 starts, owned by a session (or by nobody, for a terminal a person opened), with
 * its output retained head and tail, notifications for background jobs, and a journal on disk so a
 * daemon that crashed leaves nothing running that the next daemon does not know about.
 */

export interface ProcInfo extends ProcSummary {
	sessionID: string | null;
	endedAt?: number;
	/** the signal that ended it, when one did */
	signal?: string;
	notify?: ProcNotify;
	/** taken over from a previous daemon: still running, its earlier output is gone */
	adopted?: boolean;
}

export type ProcEvent =
	| { type: "proc.started" | "proc.updated" | "proc.exited" | "proc.deleted"; info: ProcInfo }
	| { type: "proc.notify"; info: ProcInfo; reason: "exit" | "pattern" | "port"; detail: string };

export interface ProcsOptions {
	dataDir: string;
	onEvent?: (e: ProcEvent) => void;
	/** defaults to this process */
	daemonPid?: number;
	/** bytes of output kept from the start of each process */
	headBytes?: number;
	/** bytes of output kept from the end of each process */
	tailBytes?: number;
	/** exited processes kept readable before the oldest is forgotten */
	keepExited?: number;
	/** ms between sigterm and sigkill */
	killGrace?: number;
}

export type SpawnOptions = ProcSpawn & {
	sessionID: string | null;
	origin: "model" | "user";
	/** run exactly this argv instead of a shell line */
	argv?: string[];
};

export interface SweepEntry {
	id: string;
	pid: number;
	command: string;
	sessionID: string | null;
	keep?: string;
	detached?: boolean;
	/** the daemon that started it */
	daemonPid: number;
}

export interface SweepResult {
	/** orphans of a dead daemon that were still running and are now stopped */
	killed: SweepEntry[];
	/** keep'd or detached processes of a dead daemon, now in this registry */
	adopted: SweepEntry[];
	/** journaled processes that had already exited */
	gone: SweepEntry[];
	/** journals of dead daemons that were read */
	journals: number;
}

interface JournalEntry {
	id: string;
	pid: number;
	pgid: number;
	/** `ps -o lstart` at spawn: a pid that was reused has a different start */
	lstart: string;
	command: string;
	cwd: string;
	title: string;
	tty: boolean;
	origin: "model" | "user";
	sessionID: string | null;
	keep?: string;
	detached?: boolean;
	startedAt: number;
}

interface Journal {
	daemonPid: number;
	daemonLstart: string;
	updatedAt: number;
	procs: JournalEntry[];
}

type Child = ReturnType<typeof Bun.spawn>;

interface Entry {
	info: ProcInfo;
	pgid: number;
	lstart: string;
	child?: Child;
	buffer: OutputBuffer;
	subscribers: Set<(chunk: Uint8Array, cursor: number) => void>;
	waiters: Set<() => void>;
	lastDataAt: number;
	/** the unterminated last line, for on_pattern */
	partial: string;
	pattern?: RegExp;
	decoder: TextDecoder;
	portTimer?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	liveTimer?: ReturnType<typeof setInterval>;
}

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;
const READ_LIMIT = 64 * 1024;
const SETTLE_MS = 150;
const PORT_PROBE_MS = 250;
const PATTERN_LINE_MAX = 8192;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g;

/** processes listening on a tcp port, with their process group, from lsof and ps */
export function listenersOf(port: number): Array<{ pid: number; pgid: number; command: string }> {
	const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8", timeout: 5000 });
	const out: Array<{ pid: number; pgid: number; command: string }> = [];
	let pid = 0;
	for (const line of (r.stdout ?? "").split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("c") && pid) {
			const pg = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
			out.push({ pid, pgid: Number((pg.stdout ?? "").trim()) || 0, command: line.slice(1) });
		}
	}
	return out;
}

export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/** start time of a live pid as ps prints it, or undefined when there is no such process */
export function startOf(pid: number): string | undefined {
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
	const s = r.status === 0 ? r.stdout.trim() : "";
	return s || undefined;
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}

function signalGroup(pgid: number, pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(-pgid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

function portOpen(port: number, host: string): Promise<boolean> {
	return new Promise((done) => {
		const s = createConnection({ port, host });
		const finish = (ok: boolean) => {
			s.removeAllListeners();
			s.destroy();
			done(ok);
		};
		s.setTimeout(500, () => finish(false));
		s.once("connect", () => finish(true));
		s.once("error", () => finish(false));
	});
}

function randomId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function summaryOf(info: ProcInfo): ProcSummary {
	const { sessionID: _s, endedAt: _e, signal: _g, notify: _n, adopted: _a, ...summary } = info;
	return summary;
}

export class Procs {
	private readonly entries = new Map<string, Entry>();
	private readonly daemonPid: number;
	private readonly daemonLstart: string;
	private readonly journalDir: string;
	private readonly head: number;
	private readonly tail: number;
	private readonly keepExited: number;
	private readonly grace: number;
	private stopped = false;

	constructor(private readonly opts: ProcsOptions) {
		this.daemonPid = opts.daemonPid ?? process.pid;
		this.daemonLstart = startOf(this.daemonPid) ?? "";
		// one journal per daemon: two daemons sharing a data dir never rewrite each other's file
		this.journalDir = join(opts.dataDir, "procs");
		mkdirSync(this.journalDir, { recursive: true });
		this.head = opts.headBytes ?? HEAD;
		this.tail = opts.tailBytes ?? TAIL;
		this.keepExited = opts.keepExited ?? 32;
		this.grace = opts.killGrace ?? 2000;
	}

	private emit(e: ProcEvent) {
		try {
			this.opts.onEvent?.(e);
		} catch (err) {
			console.error(`cmx2: a process event handler threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private need(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`no process ${id}`);
		return e;
	}

	// ---------- spawn ----------

	spawn(opts: SpawnOptions): ProcInfo {
		if (this.stopped) throw new Error("the process registry is shut down");
		const tty = opts.tty === true;
		const cwd = resolve(opts.cwd ?? (opts.sessionID ? process.cwd() : homedir()));
		if (!existsSync(cwd)) throw new Error(`working directory ${cwd} does not exist`);
		const shell = process.env.SHELL || "/bin/bash";
		// a person's terminal is their login shell; a model's command is plain bash, the same as the shell tool
		const argv =
			opts.argv ?? (opts.command.trim() === "" ? [shell, "-l"] : opts.origin === "user" && tty ? [shell, "-lc", opts.command] : ["bash", "-c", opts.command]);
		const env: Record<string, string | undefined> = tty
			? { ...process.env, TERM: "xterm-256color", ...opts.env }
			: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", ...opts.env };
		const id = randomId(tty ? "pty" : "job");
		const buffer = new OutputBuffer(this.head, this.tail);
		const info: ProcInfo = {
			id,
			pid: 0,
			command: opts.command.trim() === "" ? argv.join(" ") : opts.command,
			cwd,
			title: opts.title ?? (opts.command.trim() || shell.split("/").pop() || "shell"),
			tty,
			status: "running",
			exitCode: null,
			cursor: 0,
			ports: [],
			...(opts.keep ? { keep: opts.keep } : {}),
			...(opts.detach ? { detached: true } : {}),
			origin: opts.origin,
			startedAt: Date.now(),
			sessionID: opts.sessionID,
			...(opts.notify && Object.keys(opts.notify).length ? { notify: opts.notify } : {}),
		};
		let pattern: RegExp | undefined;
		if (opts.notify?.on_pattern) {
			try {
				pattern = new RegExp(opts.notify.on_pattern);
			} catch (e) {
				throw new Error(`on_pattern is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const entry: Entry = {
			info,
			pgid: 0,
			lstart: "",
			buffer,
			subscribers: new Set(),
			waiters: new Set(),
			lastDataAt: 0,
			partial: "",
			pattern,
			decoder: new TextDecoder(),
		};
		const onData = (bytes: Uint8Array) => this.onData(entry, bytes);
		let child: Child;
		if (tty) {
			child = Bun.spawn(argv, {
				cwd,
				env,
				terminal: { cols: opts.cols ?? 80, rows: opts.rows ?? 24, data: (_t: unknown, bytes: Uint8Array) => onData(bytes) },
			} as never);
		} else {
			// no stdin: a job that wants input is a pty. its own process group, so a kill takes its children
			child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
		}
		entry.child = child;
		info.pid = child.pid;
		// pty children lead their own session; piped children were started detached: either way pgid = pid
		entry.pgid = child.pid;
		entry.lstart = startOf(child.pid) ?? "";
		this.entries.set(id, entry);
		const pumps: Promise<void>[] = [];
		if (!tty) {
			for (const s of [child.stdout, child.stderr] as ReadableStream<Uint8Array>[]) pumps.push(this.pump(s, onData));
		}
		void this.watchExit(entry, child, pumps);
		if (opts.notify?.on_port) this.probePort(entry, opts.notify.on_port);
		this.writeJournal();
		this.emit({ type: "proc.started", info: { ...info } });
		return { ...info };
	}

	private async pump(s: ReadableStream<Uint8Array>, onData: (b: Uint8Array) => void) {
		const reader = s.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) onData(value);
			}
		} catch {}
	}

	private onData(e: Entry, bytes: Uint8Array) {
		e.buffer.write(bytes);
		e.info.cursor = e.buffer.total;
		e.lastDataAt = performance.now();
		for (const fn of e.subscribers) {
			try {
				fn(bytes, e.buffer.total);
			} catch {}
		}
		if (e.pattern) this.scanLines(e, e.decoder.decode(bytes, { stream: true }));
		this.wake(e);
	}

	private scanLines(e: Entry, text: string, final = false) {
		const lines = (e.partial + text).split("\n");
		e.partial = final ? "" : (lines.pop() ?? "");
		if (e.partial.length > PATTERN_LINE_MAX) e.partial = e.partial.slice(-PATTERN_LINE_MAX);
		for (const raw of lines) {
			const line = stripAnsi(raw).replace(/\r/g, "");
			if (line && e.pattern!.test(line)) this.emit({ type: "proc.notify", info: { ...e.info }, reason: "pattern", detail: line.slice(0, 1000) });
		}
	}

	private wake(e: Entry) {
		const ws = [...e.waiters];
		e.waiters.clear();
		for (const w of ws) w();
	}

	private async watchExit(e: Entry, child: Child, pumps: Promise<void>[]) {
		await child.exited;
		await Promise.all(pumps);
		// a pty can still hold bytes the child wrote just before it exited
		if (e.info.tty) await Bun.sleep(30);
		try {
			(child as unknown as { terminal?: { close(): void } }).terminal?.close();
		} catch {}
		this.markExited(e, child.exitCode, child.signalCode ?? undefined);
	}

	private markExited(e: Entry, code: number | null, signal?: string) {
		if (e.info.status === "exited") return;
		if (e.pattern) this.scanLines(e, e.decoder.decode(), true);
		clearTimeout(e.portTimer);
		clearTimeout(e.killTimer);
		clearInterval(e.liveTimer);
		e.info.status = "exited";
		e.info.exitCode = code;
		e.info.endedAt = Date.now();
		e.info.ports = [];
		if (signal) e.info.signal = signal;
		e.child = undefined;
		this.wake(e);
		this.writeJournal();
		this.emit({ type: "proc.exited", info: { ...e.info } });
		if (e.info.notify?.on_exit) this.emit({ type: "proc.notify", info: { ...e.info }, reason: "exit", detail: this.exitDetail(e) });
		this.forgetOldExited();
	}

	/** how it ended plus the last lines of output, so a separate read is rarely needed */
	private exitDetail(e: Entry): string {
		const how = e.info.signal ? `killed by ${e.info.signal}` : `exited with code ${e.info.exitCode}`;
		const from = Math.max(0, e.buffer.total - 2048);
		const s = e.buffer.read(from, 2048);
		const lines = stripAnsi(new TextDecoder().decode(s.bytes)).replace(/\r/g, "").trimEnd().split("\n").slice(-10);
		const tail = lines.join("\n").trim();
		return tail ? `${how}; last output:\n${tail}` : `${how}; no output`;
	}

	private forgetOldExited() {
		const exited = [...this.entries.values()].filter((e) => e.info.status === "exited").sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
		for (const e of exited.slice(0, Math.max(0, exited.length - this.keepExited))) this.entries.delete(e.info.id);
	}

	private probePort(e: Entry, port: number) {
		const tick = async () => {
			if (e.info.status !== "running" || this.stopped) return;
			if ((await portOpen(port, "127.0.0.1")) || (await portOpen(port, "::1"))) {
				if (e.info.status !== "running") return;
				// whose port is it: a port another process already held is news, not the job coming up
				const owners = listenersOf(port);
				const mine = owners.filter((o) => o.pgid === e.info.pid);
				if (owners.length === 0 || mine.length > 0) {
					if (!e.info.ports.includes(port)) e.info.ports = [...e.info.ports, port].sort((a, b) => a - b);
					this.emit({ type: "proc.notify", info: { ...e.info }, reason: "port", detail: `port ${port} is accepting connections${mine[0] ? ` (pid ${mine[0].pid}, this job)` : ""}` });
				} else {
					const o = owners[0]!;
					this.emit({ type: "proc.notify", info: { ...e.info }, reason: "port", detail: `port ${port} answers, but another process holds it (pid ${o.pid}, ${o.command}); this job has not bound it and may fail to start on that port` });
				}
				return;
			}
			e.portTimer = setTimeout(tick, PORT_PROBE_MS);
			e.portTimer.unref?.();
		};
		e.portTimer = setTimeout(tick, PORT_PROBE_MS);
		e.portTimer.unref?.();
	}

	// ---------- io ----------

	/** bytes from `cursor` as text, stopping before a split utf-8 character */
	snapshot(id: string, cursor = 0, limit = READ_LIMIT): ProcRead {
		const e = this.need(id);
		const s = e.buffer.read(cursor, limit);
		let bytes = s.bytes;
		const cut = incompleteTail(bytes);
		if (cut && s.start + bytes.length === e.buffer.total && e.info.status === "running") bytes = bytes.subarray(0, bytes.length - cut);
		return {
			data: new TextDecoder().decode(bytes),
			cursor: s.start + bytes.length,
			start: s.start,
			dropped: s.dropped,
			status: e.info.status,
			exitCode: e.info.exitCode,
		};
	}

	/**
	 * output from `cursor` (default 0, the retained head). with `wait_ms`, waits for output past the
	 * cursor and returns once it has been quiet for a moment, the process exited, or the wait ran out.
	 */
	async read(id: string, opts: { cursor?: number; limit?: number; wait_ms?: number } = {}): Promise<ProcRead> {
		const e = this.need(id);
		const cursor = opts.cursor ?? 0;
		const wait = Math.max(0, opts.wait_ms ?? 0);
		if (wait > 0) {
			const deadline = performance.now() + wait;
			for (;;) {
				const now = performance.now();
				if (e.info.status !== "running" || now >= deadline) break;
				const fresh = e.buffer.total > cursor;
				if (fresh && now - e.lastDataAt >= SETTLE_MS) break;
				const until = fresh ? Math.min(deadline, e.lastDataAt + SETTLE_MS) : deadline;
				await new Promise<void>((done) => {
					const t = setTimeout(() => {
						e.waiters.delete(wake);
						done();
					}, Math.max(1, until - now));
					const wake = () => {
						clearTimeout(t);
						done();
					};
					e.waiters.add(wake);
				});
			}
		}
		return this.snapshot(id, cursor, opts.limit ?? READ_LIMIT);
	}

	/** replays retained output from `cursor`, then streams live bytes; returns the unsubscribe */
	attach(id: string, cursor: number, fn: (chunk: Uint8Array, cursor: number) => void): () => void {
		const e = this.need(id);
		let at = Math.max(0, cursor);
		while (at < e.buffer.total) {
			const s = e.buffer.read(at, READ_LIMIT);
			if (s.bytes.length === 0) break;
			fn(s.bytes, s.start + s.bytes.length);
			at = s.start + s.bytes.length;
		}
		return this.subscribe(id, fn);
	}

	subscribe(id: string, fn: (chunk: Uint8Array, cursor: number) => void): () => void {
		const e = this.need(id);
		e.subscribers.add(fn);
		return () => e.subscribers.delete(fn);
	}

	write(id: string, data: string) {
		const e = this.need(id);
		if (e.info.status !== "running") throw new Error(`process ${id} has exited (code ${e.info.exitCode}); nothing reads its input`);
		if (!e.info.tty) throw new Error(`process ${id} was started without a terminal and has no input; start it with tty for interactive use`);
		const term = (e.child as unknown as { terminal?: { write(d: string): void } } | undefined)?.terminal;
		if (!term) throw new Error(`process ${id} was taken over from a previous daemon; its terminal is gone`);
		term.write(data);
	}

	resize(id: string, cols: number, rows: number) {
		const e = this.need(id);
		if (!e.info.tty || e.info.status !== "running") return;
		const c = Math.max(1, Math.floor(cols));
		const r = Math.max(1, Math.floor(rows));
		(e.child as unknown as { terminal?: { resize(c: number, r: number): void } } | undefined)?.terminal?.resize(c, r);
	}

	update(id: string, patch: { title?: string; size?: { cols: number; rows: number }; keep?: string | null }): ProcInfo {
		const e = this.need(id);
		if (patch.title !== undefined && patch.title.trim()) e.info.title = patch.title.trim();
		if (patch.size) this.resize(id, patch.size.cols, patch.size.rows);
		if (patch.keep !== undefined) {
			if (patch.keep) e.info.keep = patch.keep;
			else delete e.info.keep;
			this.writeJournal();
		}
		this.emit({ type: "proc.updated", info: { ...e.info } });
		return { ...e.info };
	}

	/** sigterm to the whole group, sigkill after the grace; resolves when it has exited */
	kill(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		const e = this.need(id);
		if (e.info.status !== "running") return Promise.resolve();
		const exited = new Promise<void>((done) => {
			if (e.info.status !== "running") return done();
			const check = () => (e.info.status !== "running" ? done() : e.waiters.add(check));
			e.waiters.add(check);
		});
		signalGroup(e.pgid, e.info.pid, signal);
		if (signal !== "SIGKILL") {
			clearTimeout(e.killTimer);
			e.killTimer = setTimeout(() => {
				if (e.info.status === "running") signalGroup(e.pgid, e.info.pid, "SIGKILL");
			}, this.grace);
			e.killTimer.unref?.();
		}
		return exited;
	}

	/** kills it if running and forgets it */
	async remove(id: string) {
		const e = this.entries.get(id);
		if (!e) return;
		await this.kill(id);
		this.entries.delete(id);
		this.writeJournal();
		this.emit({ type: "proc.deleted", info: { ...e.info } });
	}

	get(id: string): ProcInfo | undefined {
		const e = this.entries.get(id);
		return e ? { ...e.info } : undefined;
	}

	list(filter: { sessionID?: string | null } = {}): ProcInfo[] {
		return [...this.entries.values()]
			.filter((e) => filter.sessionID === undefined || e.info.sessionID === filter.sessionID)
			.map((e) => ({ ...e.info }))
			.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	/** tcp ports the process group listens on, from lsof; also cached on the info for the ledger */
	async ports(id: string): Promise<number[]> {
		const e = this.need(id);
		if (e.info.status !== "running") return [];
		const proc = Bun.spawn(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-g", String(e.pgid), "-Fn"], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const ports = new Set<number>();
		for (const line of out.split("\n")) {
			const m = line.match(/^n.*:(\d+)$/);
			if (m) ports.add(Number(m[1]));
		}
		e.info.ports = [...ports].sort((a, b) => a - b);
		return e.info.ports;
	}

	async refreshPorts(sessionID: string) {
		await Promise.all(this.list({ sessionID }).filter((p) => p.status === "running").map((p) => this.ports(p.id).catch(() => [])));
	}

	// ---------- ownership ----------

	/** session end: everything the session owns stops, except what it kept by name */
	async reapSession(sessionID: string): Promise<{ killed: ProcInfo[]; kept: ProcInfo[] }> {
		const owned = this.list({ sessionID }).filter((p) => p.status === "running");
		const kept = owned.filter((p) => p.keep);
		const doomed = owned.filter((p) => !p.keep);
		await Promise.all(doomed.map((p) => this.kill(p.id)));
		return { killed: doomed.map((p) => this.get(p.id) ?? p), kept };
	}

	/**
	 * what is alive for a session, one line each, oldest first; undefined when nothing is. appended to
	 * the model's turn context, so it is short and the same bytes for the same state.
	 */
	ledger(sessionID: string): string | undefined {
		const live = this.list({ sessionID }).filter((p) => p.status === "running");
		if (!live.length) return undefined;
		const lines = live.map((p) => {
			const cmd = p.command.length > 80 ? `${p.command.slice(0, 77)}...` : p.command;
			const bits = [`${p.id}`, p.tty ? "pty" : "job", `pid ${p.pid}`, ...(p.ports.length ? [`ports ${p.ports.join(",")}`] : []), ...(p.keep ? [`keep ${p.keep}`] : [])];
			return `- ${bits.join(", ")}: ${cmd}`;
		});
		return `processes alive:\n${lines.join("\n")}`;
	}

	/** the session-bound view the tools get: model-origin spawns, only the session's own processes */
	/** a session's view of the registry; `env` is laid over every spawn's own, so a call cannot undo it (a subagent's push guard) */
	host(sessionID: string, cwd: string, env?: Record<string, string>): ProcHost {
		const own = (id: string) => {
			const e = this.entries.get(id);
			if (!e || e.info.sessionID !== sessionID) throw new Error(`no process ${id} in this session`);
			return e;
		};
		return {
			spawn: (o) => summaryOf(this.spawn({ ...o, ...(env ? { env: { ...o.env, ...env } } : {}), cwd: o.cwd ? resolve(cwd, o.cwd) : cwd, sessionID, origin: "model" })),
			write: (id, data) => {
				own(id);
				this.write(id, data);
			},
			read: async (id, o) => {
				own(id);
				return this.read(id, o);
			},
			kill: (id) => {
				own(id);
				void this.kill(id);
			},
			list: () => this.list({ sessionID }).map(summaryOf),
		};
	}

	// ---------- journal ----------

	private journalPath(pid = this.daemonPid): string {
		return join(this.journalDir, `${pid}.json`);
	}

	private writeJournal() {
		const procs: JournalEntry[] = [...this.entries.values()]
			.filter((e) => e.info.status === "running")
			.map((e) => ({
				id: e.info.id,
				pid: e.info.pid,
				pgid: e.pgid,
				lstart: e.lstart,
				command: e.info.command,
				cwd: e.info.cwd,
				title: e.info.title,
				tty: e.info.tty,
				origin: e.info.origin,
				sessionID: e.info.sessionID,
				...(e.info.keep ? { keep: e.info.keep } : {}),
				...(e.info.detached ? { detached: true } : {}),
				startedAt: e.info.startedAt,
			}));
		const path = this.journalPath();
		if (!procs.length) {
			rmSync(path, { force: true });
			return;
		}
		const j: Journal = { daemonPid: this.daemonPid, daemonLstart: this.daemonLstart, updatedAt: Date.now(), procs };
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(j, null, 1));
		renameSync(tmp, path);
	}

	/**
	 * at daemon start: the journals of daemons that are gone. their processes that still run are
	 * stopped, unless they were kept or detached, which join this registry instead. journals of a
	 * daemon that is still alive (another process sharing the data dir) are left alone.
	 */
	sweep(): SweepResult {
		const result: SweepResult = { killed: [], adopted: [], gone: [], journals: 0 };
		const files = existsSync(this.journalDir) ? readdirSync(this.journalDir).filter((f) => /^\d+\.json$/.test(f)) : [];
		for (const f of files) {
			const path = join(this.journalDir, f);
			let j: Journal;
			try {
				j = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				console.error(`cmx2: unreadable process journal ${path}; moved aside`);
				renameSync(path, `${path}.bad`);
				continue;
			}
			if (j.daemonPid === this.daemonPid) continue;
			const owner = startOf(j.daemonPid);
			if (owner && owner === j.daemonLstart) continue;
			result.journals++;
			for (const p of j.procs ?? []) {
				const entry: SweepEntry = { id: p.id, pid: p.pid, command: p.command, sessionID: p.sessionID, ...(p.keep ? { keep: p.keep } : {}), ...(p.detached ? { detached: true } : {}), daemonPid: j.daemonPid };
				const leader = startOf(p.pid);
				const ours = leader ? leader === p.lstart : groupAlive(p.pgid);
				if (!ours) {
					result.gone.push(entry);
					continue;
				}
				if (p.keep || p.detached) {
					this.adopt(p);
					result.adopted.push(entry);
					continue;
				}
				signalGroup(p.pgid, p.pid, "SIGTERM");
				const until = Date.now() + this.grace;
				while (Date.now() < until && (pidAlive(p.pid) || groupAlive(p.pgid))) Bun.sleepSync(25);
				if (pidAlive(p.pid) || groupAlive(p.pgid)) {
					signalGroup(p.pgid, p.pid, "SIGKILL");
					const hard = Date.now() + 1000;
					while (Date.now() < hard && (pidAlive(p.pid) || groupAlive(p.pgid))) Bun.sleepSync(25);
				}
				result.killed.push(entry);
			}
			rmSync(path, { force: true });
		}
		this.writeJournal();
		return result;
	}

	/** a kept or detached process of a dead daemon: listed and killable, its old output is gone */
	private adopt(p: JournalEntry) {
		const info: ProcInfo = {
			id: p.id,
			pid: p.pid,
			command: p.command,
			cwd: p.cwd,
			title: p.title,
			tty: p.tty,
			status: "running",
			exitCode: null,
			cursor: 0,
			ports: [],
			...(p.keep ? { keep: p.keep } : {}),
			...(p.detached ? { detached: true } : {}),
			origin: p.origin,
			startedAt: p.startedAt,
			sessionID: p.sessionID,
			adopted: true,
		};
		const e: Entry = {
			info,
			pgid: p.pgid,
			lstart: p.lstart,
			buffer: new OutputBuffer(this.head, this.tail),
			subscribers: new Set(),
			waiters: new Set(),
			lastDataAt: 0,
			partial: "",
			decoder: new TextDecoder(),
		};
		// not our child, so no exit event arrives: look every few seconds
		e.liveTimer = setInterval(() => {
			if (!pidAlive(p.pid) && !groupAlive(p.pgid)) this.markExited(e, null);
		}, 3000);
		e.liveTimer.unref?.();
		this.entries.set(p.id, e);
	}

	/** daemon shutdown: everything not kept or detached stops; what stays is journaled for the next start */
	async stopAll(): Promise<{ killed: ProcInfo[]; left: ProcInfo[] }> {
		const live = this.list().filter((p) => p.status === "running");
		const left = live.filter((p) => p.keep || p.detached);
		const doomed = live.filter((p) => !p.keep && !p.detached);
		await Promise.all(doomed.map((p) => this.kill(p.id)));
		this.stopped = true;
		for (const e of this.entries.values()) {
			clearTimeout(e.portTimer);
			clearInterval(e.liveTimer);
		}
		this.writeJournal();
		return { killed: doomed.map((p) => this.get(p.id) ?? p), left };
	}

	/** bytes of output held in memory across every process, for the budget check */
	get retainedBytes(): number {
		let n = 0;
		for (const e of this.entries.values()) n += e.buffer.retained;
		return n;
	}
}
