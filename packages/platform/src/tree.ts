import { spawnSync } from "node:child_process";
import { IS_WINDOWS } from "./bash.ts";

/**
 * a process tree: a command and everything it starts, killed as one. on macos and linux the tree is a process
 * group: the child is spawned detached (setsid), so its pgid is its pid, and `process.kill(-pgid)` takes the group.
 * windows has no process groups. there the child is spawned with a hidden console (windowsHide, not detached, so it
 * and everything it starts share one console with no window), and `trackTree` puts it in a job object right after
 * the spawn; every process it starts joins the job, and `killTree` terminates the job. a tree this process did
 * not track (one a previous daemon started) falls back to `taskkill /T /F`, which walks parent links and so misses
 * a grandchild whose parent already exited.
 *
 * the root's pid names the tree everywhere (`pgid` in the procs journal is that pid on windows too).
 */

/** spawn options that make the child the root of its own tree */
export function treeSpawnOptions(): { detached?: true; windowsHide?: true } {
	return IS_WINDOWS ? { windowsHide: true } : { detached: true };
}

/** right after a spawn with `treeSpawnOptions`: on windows, puts the child in a job object of its own; nothing elsewhere */
export function trackTree(_root: number): void {
	if (!IS_WINDOWS) return;
	// windows: filled in with the job object (win32.ts)
}

/**
 * signals every process of the tree. posix: the group, or the root alone when the group is gone. windows: there is
 * no graceful signal for a console tree with no console of ours, so any signal terminates the job (or taskkill /T /F)
 */
export function killTree(root: number, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!IS_WINDOWS) {
		try {
			process.kill(-root, signal);
		} catch {
			try {
				process.kill(root, signal);
			} catch {}
		}
		return;
	}
	spawnSync("taskkill", ["/PID", String(root), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** whether any process of the tree still runs */
export function treeAlive(root: number): boolean {
	if (!IS_WINDOWS) {
		try {
			process.kill(-root, 0);
			return true;
		} catch (e) {
			return (e as { code?: string }).code === "EPERM";
		}
	}
	try {
		process.kill(root, 0);
		return true;
	} catch {
		return false;
	}
}

/** the pids in the tree that this platform can name: windows lists the job's processes; posix answers [] (lsof -g reads groups itself) */
export function treePids(root: number): number[] {
	if (!IS_WINDOWS) return [];
	return [root];
}

/** the tree is done with (its job exited and nothing will kill it again): drops what trackTree holds */
export function forgetTree(_root: number): void {}
