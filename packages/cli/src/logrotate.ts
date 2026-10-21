/**
 * serve.log rotation. the service unit points the daemon's stdout and stderr at serve.log, opened for append
 * (launchd's StandardOutPath, systemd's append:), so the file would grow for ever. the daemon checks it every
 * minute; past LOG_MAX_BYTES it shifts serve.log.1 and .2 up one (the oldest, .3, goes), copies serve.log to
 * serve.log.1 and truncates serve.log. an append-mode writer then goes on at the new end, so the descriptors
 * the supervisor opened stay valid. a line written between the copy and the truncation is lost.
 */
import { copyFileSync, existsSync, fstatSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";

/** rotate once serve.log is past this */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** rotated copies kept: serve.log.1 (newest) to serve.log.3 */
export const LOG_KEEP = 3;

/** rotates `path` if it is past `maxBytes`; true when it did */
export function rotateLog(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return false;
	}
	if (size <= maxBytes) return false;
	if (existsSync(`${path}.${keep}`)) unlinkSync(`${path}.${keep}`);
	for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
	copyFileSync(path, `${path}.1`);
	truncateSync(path, 0);
	return true;
}

/** whether this process's stdout is the file at `path` (the service unit's log), not a terminal or a pipe */
export function stdoutIs(path: string): boolean {
	try {
		const out = fstatSync(1);
		const file = statSync(path);
		return out.isFile() && out.dev === file.dev && out.ino === file.ino;
	} catch {
		return false;
	}
}

/** a daemon run by the service unit keeps its log rotated; one run in a terminal leaves its output alone */
export function keepLogRotated(path: string, everyMs = 60_000): ReturnType<typeof setInterval> | undefined {
	if (!stdoutIs(path)) return undefined;
	const check = () => {
		try {
			if (rotateLog(path)) console.error(`cmx2: rotated ${path} past ${LOG_MAX_BYTES / 1048576} MB; keeping ${LOG_KEEP} older copies`);
		} catch (e) {
			console.error(`cmx2: rotating ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	check();
	const timer = setInterval(check, everyMs);
	timer.unref?.();
	return timer;
}
