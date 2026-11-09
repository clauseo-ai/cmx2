import { spawnSync } from "node:child_process";
import { IS_WINDOWS } from "./bash.ts";
import { pidAlive } from "./proc.ts";
import { assignToJob, closeHandle, createJob, type Handle, jobActiveProcesses, jobPids, terminateJob } from "./win32.ts";

/**
 * a process tree: a command and everything it starts, killed as one. on macos and linux the tree is a process
 * group: the child is spawned detached (setsid), so its pgid is its pid, and `process.kill(-pgid)` takes the group.
 * windows has no process groups. there `trackTree` puts the child in a job object of its own right after the
 * spawn; every process it starts joins the job, and `killTree` terminates the job. the child is spawned detached,
 * which keeps it out of the kill-on-close job libuv puts every other child in, so a kept job outlives the daemon as
 * it does on posix, and windowsHide. a tree this process did not track (one a previous daemon started, or one whose
 * assignment failed) falls back to `taskkill /T /F`, which walks parent links and so misses a grandchild whose parent
 * already exited.
 *
 * the root's pid names the tree everywhere (`pgid` in the procs journal is that pid on windows too).
 */

export type WindowsTreeSpawn = "detached" | "attached";

/** how a tree's root is spawned on windows; see the module comment */
const WINDOWS_SPAWN: WindowsTreeSpawn = "detached";

/**
 * spawn options that make the child the root of its own tree. `windows` picks the other spawn on windows (for the
 * test that compares them): "attached" leaves the child in libuv's kill-on-close job, so its tree dies with this process
 */
export function treeSpawnOptions(o: { windows?: WindowsTreeSpawn } = {}): { detached?: true; windowsHide?: true } {
	if (!IS_WINDOWS) return { detached: true };
	return (o.windows ?? WINDOWS_SPAWN) === "detached" ? { detached: true, windowsHide: true } : { windowsHide: true };
}

/** job objects of the trees this process tracks, by root pid (windows) */
const jobs = new Map<number, Handle>();
let assignFailSaid = false;

/**
 * right after a spawn with `treeSpawnOptions`: on windows, puts the child in a job object of its own and answers
 * whether that worked (a tree with no job is killed with taskkill); true and nothing to do elsewhere
 */
export function trackTree(root: number): boolean {
	if (!IS_WINDOWS) return true;
	if (jobs.has(root)) return true;
	try {
		const job = createJob();
		if (job === undefined) throw new Error("CreateJobObject failed");
		const r = assignToJob(job, root);
		if (!r.ok) {
			closeHandle(job);
			throw new Error(`${r.step === "open" ? "OpenProcess" : "AssignProcessToJobObject"} failed with windows error ${r.error}`);
		}
		jobs.set(root, job);
		return true;
	} catch (e) {
		if (!assignFailSaid) console.error(`cmx2: pid ${root} could not be put in a job object (${e instanceof Error ? e.message : String(e)}); its tree is killed with taskkill /T, which can miss orphans`);
		assignFailSaid = true;
		return false;
	}
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
	const job = jobs.get(root);
	if (job !== undefined && terminateJob(job, 1)) return;
	spawnSync("taskkill", ["/PID", String(root), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** whether any process of the tree still runs. windows: the job's active count, or the root alone with no job */
export function treeAlive(root: number): boolean {
	if (!IS_WINDOWS) {
		try {
			process.kill(-root, 0);
			return true;
		} catch (e) {
			return (e as { code?: string }).code === "EPERM";
		}
	}
	const job = jobs.get(root);
	const active = job === undefined ? undefined : jobActiveProcesses(job);
	return active === undefined ? pidAlive(root) : active > 0;
}

/** the pids in the tree that this platform can name: windows lists the job's processes (the root alone with no job); posix answers [] (lsof -g reads groups itself) */
export function treePids(root: number): number[] {
	if (!IS_WINDOWS) return [];
	const job = jobs.get(root);
	return (job === undefined ? undefined : jobPids(job)) ?? [root];
}

/** the root of the tracked tree whose job holds pid (windows), or undefined; always undefined elsewhere */
export function treeOf(pid: number): number | undefined {
	for (const [root, job] of jobs) if (root === pid || jobPids(job)?.includes(pid)) return root;
	return undefined;
}

/** whether this process holds a job for the tree (windows); false elsewhere */
export function treeTracked(root: number): boolean {
	return jobs.has(root);
}

/** the tree is done with (its job exited and nothing will kill it again): drops what trackTree holds */
export function forgetTree(root: number): void {
	const job = jobs.get(root);
	if (job === undefined) return;
	jobs.delete(root);
	closeHandle(job);
}
