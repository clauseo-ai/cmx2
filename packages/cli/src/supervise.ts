import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@cmx2/engine/config";
import { pidAlive, startStamp } from "@cmx2/platform";
import { rotateLog } from "./logrotate.ts";
import { compiled } from "./release.ts";
import { parseEnvFile } from "./service.ts";

/**
 * `cmx2 serve --supervise`: what the windows logon task runs. task scheduler starts a task once and does not
 * start it again when its process exits, and the daemon exits 0 on `/global/restart` expecting to be started
 * again (as systemd's Restart=always and launchd's KeepAlive do). so the task runs this, and this runs
 * `<binary> serve <args>` as a hidden child and starts it again whenever it exits.
 *
 * the binary is the path this process was started from, looked up again on every start, so the file an upgrade
 * put at that path is what the next start runs. the env file is read again on every start too. the child's
 * output is appended to serve.log, the log the launchd and systemd units write, and this rotates it.
 */

/** the wait before the next start: 1 s, doubling to 30 s while the daemon keeps dying within a minute */
export function nextDelay(previousMs: number, upMs: number): number {
	if (upMs >= 60_000 || previousMs <= 0) return 1000;
	return Math.min(30_000, previousMs * 2);
}

/**
 * when this file is there the supervisor exits once its daemon does, instead of starting it again. stopping
 * the daemon through /global/restart with it in place is the graceful stop: on windows, killing the supervisor
 * takes the daemon down with it at once, before it stopped its sessions' processes
 */
export function stopFile(data = dataDir()): string {
	return join(data, "supervisor.stop");
}

/** where a supervisor names itself and its daemon, so uninstall and a restart can stop them */
export function supervisorFile(data = dataDir()): string {
	return join(data, "supervisor.json");
}

export interface SupervisorRecord {
	pid: number;
	stamp?: string;
	port?: number;
	child?: number;
	childStamp?: string;
}

export function readSupervisor(path: string): SupervisorRecord | undefined {
	try {
		const r = JSON.parse(readFileSync(path, "utf8")) as SupervisorRecord;
		return typeof r.pid === "number" ? r : undefined;
	} catch {
		return undefined;
	}
}

/**
 * whether a recorded pid is still that process. a pid can be reused: the start stamp tells them apart where the
 * platform reads one, and `image` (the process's file name, for when it cannot) has to match otherwise
 */
export function stillRuns(pid: number | undefined, stamp: string | undefined, image?: (pid: number) => string | undefined, want?: string): boolean {
	if (!pid || !pidAlive(pid)) return false;
	const now = stamp ? startStamp(pid) : undefined;
	if (stamp && now !== undefined) return now === stamp;
	if (!image || !want) return true;
	return image(pid)?.toLowerCase() === want.toLowerCase();
}

/** the vars in an env file as process.env would hold them; a missing or unreadable file is none */
function envFrom(path: string | undefined): Record<string, string> {
	if (!path || !existsSync(path)) return {};
	try {
		return parseEnvFile(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
	} catch {
		return {};
	}
}

export async function supervise(o: { envFile?: string; serveArgs: string[]; port?: number }): Promise<never> {
	// captured first: after an upgrade renames the running file aside, this process may report the new name
	const binary = process.execPath;
	const prefix = compiled() ? [binary] : [binary, Bun.main];
	// the env file names CMX2_DATA_DIR and friends, so it applies before the data dir is worked out
	Object.assign(process.env, envFrom(o.envFile));
	const data = dataDir();
	const log = join(data, "log", "serve.log");
	mkdirSync(dirname(log), { recursive: true });
	const say = (line: string) => {
		try {
			appendFileSync(log, `${new Date().toISOString()} cmx2 supervisor (pid ${process.pid}): ${line}\n`);
		} catch {}
	};
	const record = supervisorFile(data);
	const stopAsked = stopFile(data);
	// a stop asked of an earlier supervisor is not meant for this one
	rmSync(stopAsked, { force: true });
	const self: SupervisorRecord = { pid: process.pid, stamp: startStamp(process.pid), ...(o.port ? { port: o.port } : {}) };
	const write = (r: SupervisorRecord) => {
		try {
			writeFileSync(record, `${JSON.stringify(r)}\n`);
		} catch {}
	};
	write(self);

	let child: ReturnType<typeof Bun.spawn> | undefined;
	let stopping = false;
	const stop = () => {
		stopping = true;
		try {
			child?.kill();
		} catch {}
		if (readSupervisor(record)?.pid === process.pid) rmSync(record, { force: true });
		say("stopped");
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	setInterval(() => {
		try {
			rotateLog(log);
		} catch {}
	}, 60_000).unref?.();

	say(`watching ${binary} serve ${o.serveArgs.join(" ")}`);
	let delay = 0;
	while (!stopping) {
		const started = Date.now();
		if (!existsSync(binary)) say(`${binary} is not there; looking again in a moment`);
		else {
			try {
				child = Bun.spawn([...prefix, "serve", ...o.serveArgs], {
					env: { ...process.env, ...envFrom(o.envFile) },
					cwd: process.cwd(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				write({ ...self, child: child.pid, childStamp: startStamp(child.pid) });
				say(`started the daemon, pid ${child.pid}`);
				const pump = async (s: ReadableStream<Uint8Array>) => {
					const reader = s.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						try {
							appendFileSync(log, value);
						} catch {}
					}
				};
				const pumps = Promise.all([pump(child.stdout as ReadableStream<Uint8Array>), pump(child.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
				const code = await child.exited;
				await pumps;
				write(self);
				say(`the daemon (pid ${child.pid}) exited with ${code}${child.signalCode ? ` (${child.signalCode})` : ""}`);
			} catch (e) {
				say(`could not start ${binary}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (existsSync(stopAsked)) {
			rmSync(stopAsked, { force: true });
			if (readSupervisor(record)?.pid === process.pid) rmSync(record, { force: true });
			say("asked to stop; not starting the daemon again");
			process.exit(0);
		}
		delay = nextDelay(delay, Date.now() - started);
		if (stopping) break;
		say(`starting it again in ${delay / 1000} s`);
		await Bun.sleep(delay);
	}
	process.exit(0);
}
