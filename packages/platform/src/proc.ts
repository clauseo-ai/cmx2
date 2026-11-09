import { spawnSync } from "node:child_process";
import { IS_WINDOWS } from "./bash.ts";

/** whether a pid runs (EPERM means it runs as someone else) */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}

/**
 * a live pid's start time as an opaque stamp, or undefined when there is no such process. two stamps of one
 * process are equal; a reused pid gets a different one. posix: `ps -o lstart` as printed. windows: the process's
 * creation time in ms
 */
export function startStamp(pid: number): string | undefined {
	if (IS_WINDOWS) {
		const ms = processStartMs(pid);
		return ms === undefined ? undefined : String(ms);
	}
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
	const s = r.status === 0 ? r.stdout.trim() : "";
	return s || undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** when a live pid started, in ms since the epoch (to the second off windows), or undefined when that cannot be read */
export function processStartMs(pid: number): number | undefined {
	if (IS_WINDOWS) return undefined; // windows: GetProcessTimes (win32.ts)
	// ps prints the start in local time; asked in utc and read field by field, it does not depend on the reader's TZ
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
	const [, mon, day, time, year] = r.status === 0 ? r.stdout.trim().split(/\s+/) : [];
	const month = MONTHS.indexOf(mon ?? "") + 1;
	const at = month && day && time && year ? Date.parse(`${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}T${time}Z`) : Number.NaN;
	return Number.isNaN(at) ? undefined : at;
}
