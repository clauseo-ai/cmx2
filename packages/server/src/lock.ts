import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, ftruncateSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * the run lock: at most one agent loop per session across every daemon process on the host that
 * shares a data dir. a kernel `flock(2)` on `<data>/locks/<session>.lock`, taken without waiting.
 * the kernel drops it when the holder exits or crashes, so there is no staleness to judge and no
 * heartbeat to miss (cmx's mkdir lock needed both). the file's content names the holder, for the
 * busy error only; the lock itself is the flock.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = (() => {
	const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
	return dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
})();

export interface LockHolder {
	pid: number;
	host: string;
	port?: number;
	since: number;
}

export class RunLockHeld extends Error {
	constructor(
		readonly sessionID: string,
		readonly holder: LockHolder | undefined,
	) {
		super(
			holder
				? `session ${sessionID} is busy: another cmx2 process (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}) is running its turn`
				: `session ${sessionID} is busy: another cmx2 process is running its turn`,
		);
	}
}

export class RunLocks {
	private held = new Map<string, number>();
	private readonly dir: string;

	constructor(
		dataDir: string,
		private readonly port?: number,
	) {
		this.dir = join(dataDir, "locks");
		mkdirSync(this.dir, { recursive: true });
	}

	private path(sessionID: string) {
		return join(this.dir, `${sessionID.replace(/[^\w-]/g, "_")}.lock`);
	}

	/** takes the lock or throws `RunLockHeld`; taking a lock this process already holds is a no-op */
	acquire(sessionID: string) {
		if (this.held.has(sessionID)) return;
		const path = this.path(sessionID);
		const fd = openSync(path, "a+");
		if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			closeSync(fd);
			throw new RunLockHeld(sessionID, holderOf(path));
		}
		const me: LockHolder = { pid: process.pid, host: hostname(), ...(this.port ? { port: this.port } : {}), since: Date.now() };
		ftruncateSync(fd, 0);
		writeSync(fd, JSON.stringify(me), 0);
		this.held.set(sessionID, fd);
	}

	release(sessionID: string) {
		const fd = this.held.get(sessionID);
		if (fd === undefined) return;
		this.held.delete(sessionID);
		try {
			ftruncateSync(fd, 0);
		} catch {}
		libc.symbols.flock(fd, LOCK_UN);
		closeSync(fd);
	}

	holds(sessionID: string): boolean {
		return this.held.has(sessionID);
	}

	releaseAll() {
		for (const id of [...this.held.keys()]) this.release(id);
	}
}

function holderOf(path: string): LockHolder | undefined {
	try {
		const h = JSON.parse(readFileSync(path, "utf8"));
		return typeof h?.pid === "number" ? (h as LockHolder) : undefined;
	} catch {
		return undefined;
	}
}
