import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, ftruncateSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * the run lock: at most one agent loop per session across every daemon process on the host that
 * shares a data dir. a kernel `flock(2)` on `<data>/locks/<session>.lock`, taken without waiting.
 * the kernel drops it when the holder exits or crashes, so there is no staleness to judge and no
 * heartbeat to miss (cmx's mkdir lock needed both). the file's content names the holder, for the
 * busy error only; the lock itself is the flock.
 *
 * windows has no flock. there the lock is LockFileEx on a handle from CreateFileW, exclusive and without
 * waiting, which the kernel also drops when the holder exits. it locks one byte at 0x7fffffff, past anything
 * the file holds: a locked range cannot be read by another process, and the holder's json at offset 0 has to
 * stay readable for the busy error. nothing is dlopened until a lock is first taken.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** a held lock: the descriptor flock holds on posix, the handle LockFileEx holds on windows */
type Held = { fd: number } | { handle: bigint };

interface Locker {
	/** takes the file's lock without waiting; undefined when another holder has it */
	take(path: string): Held | undefined;
	/** writes the holder's json at the start of the file */
	name(path: string, held: Held, text: string): void;
	drop(path: string, held: Held): void;
}

let locker: Locker | undefined;
function getLocker(): Locker {
	locker ??= process.platform === "win32" ? windowsLocker() : posixLocker();
	return locker;
}

function posixLocker(): Locker {
	const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
	const libc = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
	return {
		take(file) {
			const fd = openSync(file, "a+");
			if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
				closeSync(fd);
				return undefined;
			}
			return { fd };
		},
		name(_file, held, text) {
			if (!("fd" in held)) return;
			ftruncateSync(held.fd, 0);
			writeSync(held.fd, text, 0);
		},
		drop(_file, held) {
			if (!("fd" in held)) return;
			try {
				ftruncateSync(held.fd, 0);
			} catch {}
			libc.symbols.flock(held.fd, LOCK_UN);
			closeSync(held.fd);
		},
	};
}

const GENERIC_READ_WRITE = 0xc0000000;
const FILE_SHARE_ALL = 7; // read, write, delete: other processes read the holder's json
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_FAIL_IMMEDIATELY = 1;
const LOCKFILE_EXCLUSIVE_LOCK = 2;
const LOCK_OFFSET = 0x7fffffff;

function windowsLocker(): Locker {
	const k32 = dlopen("kernel32.dll", {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
		LockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		UnlockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
	});
	// an OVERLAPPED (32 bytes on 64-bit windows) whose Offset, at byte 16, names the locked byte
	const overlapped = () => {
		const o = new Uint8Array(32);
		new DataView(o.buffer).setUint32(16, LOCK_OFFSET, true);
		return o;
	};
	return {
		take(file) {
			const wide = Buffer.from(`${file}\0`, "utf16le");
			const handle = BigInt(k32.symbols.CreateFileW(ptr(wide), GENERIC_READ_WRITE, FILE_SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null));
			if (handle === -1n || handle === 0n) throw new Error(`could not open the run lock ${file}`);
			const o = overlapped();
			if (!k32.symbols.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ptr(o))) {
				k32.symbols.CloseHandle(handle);
				return undefined;
			}
			return { handle };
		},
		name(file, _held, text) {
			writeFileSync(file, text);
		},
		drop(file, held) {
			if (!("handle" in held)) return;
			try {
				truncateSync(file, 0);
			} catch {}
			const o = overlapped();
			k32.symbols.UnlockFileEx(held.handle, 0, 1, 0, ptr(o));
			k32.symbols.CloseHandle(held.handle);
		},
	};
}

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
	private held = new Map<string, Held>();
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
		const l = getLocker();
		const held = l.take(path);
		if (!held) throw new RunLockHeld(sessionID, holderOf(path));
		const me: LockHolder = { pid: process.pid, host: hostname(), ...(this.port ? { port: this.port } : {}), since: Date.now() };
		l.name(path, held, JSON.stringify(me));
		this.held.set(sessionID, held);
	}

	release(sessionID: string) {
		const held = this.held.get(sessionID);
		if (held === undefined) return;
		this.held.delete(sessionID);
		getLocker().drop(this.path(sessionID), held);
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
