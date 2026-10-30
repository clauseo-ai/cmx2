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
	/** the notify it was started with; what is still armed is `armed` */
	notify?: ProcNotify;
	/** the notifications that can still fire: on_port goes once it fired, everything once the process exited; null when none */
	armed: ProcNotify | null;
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
	/** ms between port sweeps while any job runs (PORT_SWEEP_MS); 0 turns the sweep off */
	portSweepMs?: number;
	/** the lsof the sweep runs (default lsof on PATH); tests point it at a fake */
	lsof?: string;
	/** ms before a sweep's lsof is killed and given up on (5000) */
	lsofTimeoutMs?: number;
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
	serve?: boolean;
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
	/** when its ports were last set, so a sweep that began before does not undo a newer answer */
	portsAt: number;
}

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;
const READ_LIMIT = 64 * 1024;
const SETTLE_MS = 150;
/** how often a group taken over from a command is checked for having exited */
const ADOPTED_POLL_MS = 1000;
/** an on_port watch probes every PORT_PROBE_MS for its first PORT_FAST_MS, then every PORT_SLOW_MS */
export const PORT_PROBE_MS = 250;
export const PORT_FAST_MS = 30_000;
export const PORT_SLOW_MS = 2_000;
/** the wait before the next port probe, this long after the watch began */
export function probeDelay(elapsedMs: number): number {
	return elapsedMs < PORT_FAST_MS ? PORT_PROBE_MS : PORT_SLOW_MS;
}
const PATTERN_LINE_MAX = 8192;
/**
 * how often the listening ports of every running job (not ptys, see `swept`) are looked up while any runs, so `ports` stays fresh and a change
 * goes out as proc.updated without a client asking. one lsof covers all of them (`-g` takes a list of groups). measured on a
 * 12-core mac at a load average over 60: 28 ms of wall time (34 at p95) and 26 ms of cpu with 714 processes, 31 ms and
 * 29 ms with 1,717. so 3 s costs about 1% of one core while any job runs and nothing when none do; a port shows
 * within 3 s of being bound (on_port is the faster path for a session that waits on one). sweeps never overlap: the next one is timed from the end of the last.
 */
export const PORT_SWEEP_MS = 3000;
/** an lsof that takes longer than this is killed and its sweep changes nothing; the next sweep runs as usual */
const SWEEP_LSOF_TIMEOUT_MS = 5000;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * a command's stdout, off the event loop; killed after `ms` (what it printed by then is kept). a command that
 * cannot start (not on PATH, out of descriptors) prints nothing, as spawnSync's error result did
 */
async function outputOf(cmd: string[], ms: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		timer = setTimeout(() => proc.kill(), ms);
		return await new Response(proc.stdout).text();
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

/** processes listening on a tcp port, with their process group, from lsof and ps (spawned async, so the loop never waits on them) */
export async function listenersOf(port: number): Promise<Array<{ pid: number; pgid: number; command: string }>> {
	const out: Array<{ pid: number; pgid: number; command: string }> = [];
	let pid = 0;
	for (const line of (await outputOf(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], 5000)).split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("c") && pid) {
			const pg = await outputOf(["ps", "-o", "pgid=", "-p", String(pid)], 2000);
			out.push({ pid, pgid: Number(pg.trim()) || 0, command: line.slice(1) });
		}
	}
	return out;
}

/**
 * the tcp ports each of these process groups listens on, from one lsof. "missing" when lsof cannot start, "slow" when it
 * did not answer by the timeout (it is sent SIGKILL, and the answer is given up on even if a child it left holds the
 * pipe), so a failed look never reads as "listens on nothing"
 */
export async function listeningPorts(pgids: number[], opts: { timeoutMs?: number; lsof?: string } = {}): Promise<Map<number, Set<number>> | "missing" | "slow"> {
	const out = new Map<number, Set<number>>();
	if (!pgids.length) return out;
	const timeoutMs = opts.timeoutMs ?? SWEEP_LSOF_TIMEOUT_MS;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		// -a ands the tcp filter with the group filter; lsof exits 1 when any listed group has no match, so its code says nothing
		proc = Bun.spawn([opts.lsof ?? "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-g", pgids.join(","), "-Fgn"], { stdout: "pipe", stderr: "ignore" });
	} catch {
		return "missing";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<undefined>((done) => {
		timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
			done(undefined);
		}, timeoutMs);
	});
	const work = (async () => {
		const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
		await proc.exited;
		return text;
	})().catch(() => undefined);
	const text = await Promise.race([work, deadline]);
	clearTimeout(timer);
	if (text === undefined || proc.signalCode) return "slow";
	let pgid = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("g")) pgid = Number(line.slice(1));
		else if (line.startsWith("p")) pgid = 0;
		else if (line.startsWith("n") && pgid) {
			const m = line.match(/:(\d+)$/);
			if (m) {
				let set = out.get(pgid);
				if (!set) out.set(pgid, (set = new Set()));
				set.add(Number(m[1]));
			}
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

/** a copy of what can fire, or null when nothing was asked for */
function armedOf(n: ProcNotify | undefined): ProcNotify | null {
	if (!n) return null;
	const a: ProcNotify = {};
	if (n.on_exit) a.on_exit = true;
	if (n.on_pattern) a.on_pattern = n.on_pattern;
	if (n.on_port !== undefined) a.on_port = n.on_port;
	return Object.keys(a).length ? a : null;
}

function randomId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function summaryOf(info: ProcInfo): ProcSummary {
	const { sessionID: _s, endedAt: _e, signal: _g, notify: _n, armed: _r, adopted: _a, ...summary } = info;
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
	private readonly sweepMs: number;
	/** set from when a sweep is scheduled until it has finished; unset when nothing runs */
	private sweepTimer?: ReturnType<typeof setTimeout>;
	/** lsof could not start: the sweep stays off (said once) */
	private noLsof = false;
	/** an lsof ran past its timeout once already (said once; the sweep goes on) */
	private slowSaid = false;
	/** sweeps run so far, for tests and the budget check */
	sweeps = 0;

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
		this.sweepMs = opts.portSweepMs ?? PORT_SWEEP_MS;
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
			serve: opts.serve === true,
			...(opts.keep ? { keep: opts.keep } : {}),
			...(opts.detach ? { detached: true } : {}),
			origin: opts.origin,
			startedAt: Date.now(),
			sessionID: opts.sessionID,
			...(opts.notify && Object.keys(opts.notify).length ? { notify: opts.notify } : {}),
			armed: armedOf(opts.notify),
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
			portsAt: 0,
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
		this.armSweep();
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
		e.portsAt = performance.now();
		const armed = e.info.armed;
		e.info.armed = null;
		if (signal) e.info.signal = signal;
		e.child = undefined;
		this.wake(e);
		this.writeJournal();
		this.emit({ type: "proc.exited", info: { ...e.info } });
		if (armed?.on_exit) this.emit({ type: "proc.notify", info: { ...e.info }, reason: "exit", detail: this.exitDetail(e) });
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
		// fast while a server is most likely coming up, then slower: a slow server's notice comes up to PORT_SLOW_MS late
		const since = Date.now();
		const next = () => probeDelay(Date.now() - since);
		// a timer callback that throws would take the daemon down with it: a failed probe is logged and the watch ends
		const tick = () =>
			void probe().catch((err: unknown) => console.error(`cmx2: the port ${port} watch for ${e.info.id} failed: ${err instanceof Error ? err.message : String(err)}`));
		const probe = async () => {
			if (e.info.status !== "running" || this.stopped) return;
			if ((await portOpen(port, "127.0.0.1")) || (await portOpen(port, "::1"))) {
				if (e.info.status !== "running") return;
				// whose port is it: a port another process already held is news, not the job coming up
				const owners = await listenersOf(port).catch(() => []);
				// the job may have exited while lsof ran: no port and no notice after its exit
				if (e.info.status !== "running" || this.stopped) return;
				const mine = owners.filter((o) => o.pgid === e.info.pid);
				// the watch is over either way: on_port is no longer armed
				this.disarmPort(e, owners.length === 0 || mine.length > 0 ? port : undefined);
				if (owners.length === 0 || mine.length > 0) {
					this.emit({ type: "proc.notify", info: { ...e.info }, reason: "port", detail: `port ${port} is accepting connections${mine[0] ? ` (pid ${mine[0].pid}, this job)` : ""}` });
				} else {
					const o = owners[0]!;
					this.emit({ type: "proc.notify", info: { ...e.info }, reason: "port", detail: `port ${port} answers, but another process holds it (pid ${o.pid}, ${o.command}); this job has not bound it and may fail to start on that port` });
				}
				return;
			}
			e.portTimer = setTimeout(tick, next());
			e.portTimer.unref?.();
		};
		e.portTimer = setTimeout(tick, PORT_PROBE_MS);
		e.portTimer.unref?.();
	}

	/** on_port fired: it is no longer armed, and the port joins `ports` when it is this job's; one proc.updated says both */
	private disarmPort(e: Entry, port?: number) {
		if (e.info.armed) {
			const { on_port: _p, ...rest } = e.info.armed;
			e.info.armed = Object.keys(rest).length ? rest : null;
		}
		if (port !== undefined && !e.info.ports.includes(port)) {
			e.info.ports = [...e.info.ports, port].sort((a, b) => a - b);
			e.portsAt = performance.now();
		}
		this.emit({ type: "proc.updated", info: { ...e.info } });
	}

	/** sets a running process's ports; a change goes out as proc.updated */
	private setPorts(e: Entry, ports: number[]) {
		if (e.info.status !== "running") return;
		e.portsAt = performance.now();
		if (ports.length === e.info.ports.length && ports.every((p, i) => p === e.info.ports[i])) return;
		e.info.ports = ports;
		this.emit({ type: "proc.updated", info: { ...e.info } });
	}

	/** the sweep covers running jobs only: a pty's shell puts each command it runs in a group of its own, so the
	 * pty's group finds nothing, and an open terminal would keep the sweep going for as long as it stays open */
	private swept(e: Entry): boolean {
		return e.info.status === "running" && !e.info.tty && e.pgid > 0;
	}

	private anyJobRunning(): boolean {
		for (const e of this.entries.values()) if (this.swept(e)) return true;
		return false;
	}

	/** whether a port sweep is scheduled or running: set when a job starts, unset at the first sweep that finds no job running (up to one interval after the last exits) */
	get sweeping(): boolean {
		return this.sweepTimer !== undefined;
	}

	/** schedules the next port sweep when a process runs and none is scheduled */
	private armSweep() {
		if (this.sweepTimer || this.stopped || this.noLsof || this.sweepMs <= 0 || !this.anyJobRunning()) return;
		this.sweepTimer = setTimeout(() => {
			void this.sweepPorts()
				.catch((err: unknown) => console.error(`cmx2: the port sweep failed: ${err instanceof Error ? err.message : String(err)}`))
				.finally(() => {
					this.sweepTimer = undefined;
					this.armSweep();
				});
		}, this.sweepMs);
		this.sweepTimer.unref?.();
	}

	/** one lsof for every running job's process group; each job whose listening ports changed gets a proc.updated */
	async sweepPorts() {
		const live = [...this.entries.values()].filter((e) => this.swept(e));
		if (!live.length || this.stopped) return;
		const began = performance.now();
		const found = await listeningPorts([...new Set(live.map((e) => e.pgid))], { lsof: this.opts.lsof, timeoutMs: this.opts.lsofTimeoutMs });
		this.sweeps++;
		if (found === "missing") {
			this.noLsof = true;
			console.error("cmx2: lsof could not be started, so job ports are looked up only when asked for");
			return;
		}
		if (found === "slow") {
			if (!this.slowSaid) console.error(`cmx2: lsof did not answer within ${this.opts.lsofTimeoutMs ?? SWEEP_LSOF_TIMEOUT_MS} ms and was killed; job ports keep their last value until a sweep answers`);
			this.slowSaid = true;
			return;
		}
		for (const e of live) {
			if (this.stopped || e.portsAt > began) continue;
			this.setPorts(e, [...(found.get(e.pgid) ?? [])].sort((a, b) => a - b));
		}
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
		this.setPorts(e, [...ports].sort((a, b) => a - b));
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
			const bits = [`${p.id}`, p.tty ? "pty" : "job", `pid ${p.pid}`, ...(p.serve ? ["serve"] : []), ...(p.ports.length ? [`ports ${p.ports.join(",")}`] : []), ...(p.keep ? [`keep ${p.keep}`] : [])];
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
			adoptGroup: (o) => {
				const r = this.adoptGroup({ ...o, sessionID, origin: "model" });
				return r && { job: summaryOf(r.info), output: r.output };
			},
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
				...(e.info.serve ? { serve: true } : {}),
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

	/**
	 * a process group a command left running after its shell exited, its output pipes still held: listed,
	 * read and stopped like a job of the session. its output from now on is `output`'s; what it wrote before
	 * is the command's own result. undefined when the group is already empty (nothing is registered).
	 */
	adoptGroup(opts: { pgid: number; command: string; cwd: string; sessionID: string | null; origin: "model" | "user" }): { info: ProcInfo; output: (bytes: Uint8Array) => void } | undefined {
		if (this.stopped || !groupAlive(opts.pgid)) return undefined;
		const id = randomId("job");
		const info: ProcInfo = {
			id,
			pid: opts.pgid,
			command: opts.command,
			cwd: opts.cwd,
			title: opts.command.trim() || "shell",
			tty: false,
			status: "running",
			exitCode: null,
			cursor: 0,
			ports: [],
			serve: false,
			origin: opts.origin,
			startedAt: Date.now(),
			sessionID: opts.sessionID,
			armed: null,
		};
		const e: Entry = {
			info,
			// the leader has exited, so there is no start time to check: the group is what is watched
			pgid: opts.pgid,
			lstart: "",
			buffer: new OutputBuffer(this.head, this.tail),
			subscribers: new Set(),
			waiters: new Set(),
			lastDataAt: 0,
			partial: "",
			decoder: new TextDecoder(),
			portsAt: 0,
		};
		// not our child, so no exit event arrives: look every ADOPTED_POLL_MS
		e.liveTimer = setInterval(() => {
			if (!groupAlive(opts.pgid)) this.markExited(e, null);
		}, ADOPTED_POLL_MS);
		e.liveTimer.unref?.();
		this.entries.set(id, e);
		this.writeJournal();
		this.emit({ type: "proc.started", info: { ...info } });
		this.armSweep();
		return { info: { ...info }, output: (bytes) => this.onData(e, bytes) };
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
			serve: p.serve === true,
			...(p.keep ? { keep: p.keep } : {}),
			...(p.detached ? { detached: true } : {}),
			origin: p.origin,
			startedAt: p.startedAt,
			sessionID: p.sessionID,
			armed: null,
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
			portsAt: 0,
		};
		// not our child, so no exit event arrives: look every few seconds
		e.liveTimer = setInterval(() => {
			if (!pidAlive(p.pid) && !groupAlive(p.pgid)) this.markExited(e, null);
		}, 3000);
		e.liveTimer.unref?.();
		this.entries.set(p.id, e);
		this.armSweep();
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
		clearTimeout(this.sweepTimer);
		this.sweepTimer = undefined;
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
