import { dlopen, FFIType, type Pointer } from "bun:ffi";

/**
 * kernel32 through bun:ffi, for job objects and process times on windows. the library is opened on the first call,
 * never at import: a dlopen that fails at module load takes the whole daemon down with it, and kernel32 exists only
 * on windows. every function here is windows-only; callers check IS_WINDOWS first.
 */

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const JobObjectBasicAccountingInformation = 1;
const JobObjectBasicProcessIdList = 3;
/** 100 ns ticks between 1601-01-01 (FILETIME's epoch) and 1970-01-01 */
const EPOCH_DIFF_TICKS = 116444736000000000n;

const symbols = {
	CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
	GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	GetLastError: { args: [], returns: FFIType.u32 },
} as const;

type Kernel32 = ReturnType<typeof dlopen<typeof symbols>>["symbols"];
/** a windows HANDLE as bun:ffi hands it back: a pointer-sized number, never 0 */
export type Handle = Pointer;

let k32: Kernel32 | undefined;

function lib(): Kernel32 {
	if (process.platform !== "win32") throw new Error("kernel32 is only there on windows");
	k32 ??= dlopen("kernel32.dll", symbols).symbols;
	return k32;
}

function handle(p: unknown): Handle | undefined {
	return typeof p === "number" && p !== 0 ? (p as Pointer) : undefined;
}

/** an anonymous job object with no limits (no kill-on-close: a job a daemon keeps running outlives it) */
export function createJob(): Handle | undefined {
	return handle(lib().CreateJobObjectW(null, null));
}

/** puts a running process in a job; the windows error code when that fails */
export function assignToJob(job: Handle, pid: number): { ok: true } | { ok: false; error: number; step: "open" | "assign" } {
	const k = lib();
	const h = handle(k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid));
	if (h === undefined) return { ok: false, error: k.GetLastError(), step: "open" };
	try {
		if (k.AssignProcessToJobObject(job, h)) return { ok: true };
		return { ok: false, error: k.GetLastError(), step: "assign" };
	} finally {
		k.CloseHandle(h);
	}
}

/** whether a pid is in the job (undefined when the process cannot be opened) */
export function processInJob(pid: number, job: Handle): boolean | undefined {
	const k = lib();
	const h = handle(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
	if (h === undefined) return undefined;
	try {
		const out = new Int32Array(1);
		return k.IsProcessInJob(h, job, out) ? out[0] !== 0 : undefined;
	} finally {
		k.CloseHandle(h);
	}
}

/** ends every process in the job */
export function terminateJob(job: Handle, exitCode = 1): boolean {
	return lib().TerminateJobObject(job, exitCode) !== 0;
}

/** how many processes in the job still run, or undefined when the job cannot be asked */
export function jobActiveProcesses(job: Handle): number | undefined {
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGER times, then TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses
	const buf = new Uint32Array(12);
	if (!lib().QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buf, buf.byteLength, null)) return undefined;
	return buf[10];
}

/** the pids of the job's running processes, or undefined when the job cannot be asked */
export function jobPids(job: Handle): number[] | undefined {
	// JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR pids (8 bytes each on x64 and arm64)
	for (let room = 64; room <= 65536; room *= 4) {
		const buf = new BigUint64Array(1 + room);
		const ok = lib().QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, buf.byteLength, null);
		const counts = new Uint32Array(buf.buffer, 0, 2);
		const assigned = counts[0]!;
		const listed = counts[1]!;
		if (ok && listed >= assigned) return Array.from(buf.subarray(1, 1 + listed), Number);
		if (!ok && assigned <= room) return undefined;
	}
	return undefined;
}

export function closeHandle(h: Handle): void {
	lib().CloseHandle(h);
}

/** whether a pid runs: true or false when the process could be opened, undefined when it could not (no such pid, or no access) */
export function processRunning(pid: number): boolean | undefined {
	const k = lib();
	const h = handle(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
	if (h === undefined) return undefined;
	try {
		const code = new Uint32Array(1);
		if (!k.GetExitCodeProcess(h, code)) return undefined;
		return code[0] === STILL_ACTIVE;
	} finally {
		k.CloseHandle(h);
	}
}

/** when a live pid was created, in ms since the epoch; undefined when it cannot be opened or has exited */
export function processCreationMs(pid: number): number | undefined {
	const k = lib();
	const h = handle(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
	if (h === undefined) return undefined;
	try {
		const code = new Uint32Array(1);
		if (k.GetExitCodeProcess(h, code) && code[0] !== STILL_ACTIVE) return undefined;
		const created = new BigUint64Array(1);
		const exited = new BigUint64Array(1);
		const kernel = new BigUint64Array(1);
		const user = new BigUint64Array(1);
		if (!k.GetProcessTimes(h, created, exited, kernel, user)) return undefined;
		return Number((created[0]! - EPOCH_DIFF_TICKS) / 10000n);
	} finally {
		k.CloseHandle(h);
	}
}
