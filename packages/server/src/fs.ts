import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { badRequest } from "./http.ts";

/**
 * `/global/fs`: the directories inside one directory, visible first, then by name; the project picker's walk.
 * every read is async: walking into a folder behind a privacy prompt or on a hung mount holds this request
 * and not the daemon
 */
export async function browse(raw: string | undefined, showHidden: boolean) {
	// symlinks resolved, like every session's directory and projectID, so a client can tell that a project root is the home
	const home = await realpath(homedir()).catch(() => homedir());
	let path = raw && raw !== "" ? raw : home;
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	if (!path.startsWith("/")) throw badRequest(`path must be absolute, ~ or ~/..., got ${path}`);
	path = resolve(path);
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(path);
	} catch (e) {
		const code = (e as { code?: string }).code;
		throw badRequest(code === "EACCES" ? `permission denied: ${path}` : `no such directory: ${path}`);
	}
	if (!st.isDirectory()) throw badRequest(`not a directory: ${path}`);
	let names: string[];
	try {
		names = await readdir(path);
	} catch {
		throw badRequest(`permission denied: ${path}`);
	}
	const one = async (name: string) => {
		const absolute = join(path, name);
		if (!(await stat(absolute).catch(() => undefined))?.isDirectory()) return undefined;
		return { name, absolute, hidden: name.startsWith("."), git: !!(await stat(join(absolute, ".git")).catch(() => undefined)) };
	};
	// a wide folder is statted in batches, so one listing does not queue thousands of reads at once
	const found: Array<Awaited<ReturnType<typeof one>>> = [];
	for (let i = 0; i < names.length; i += 64) found.push(...(await Promise.all(names.slice(i, i + 64).map(one))));
	const entries = found
		.filter((e): e is NonNullable<typeof e> => !!e && (showHidden || !e.hidden))
		.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
	return { path, parent: path === "/" ? null : dirname(path), home, entries };
}

const roots = new Map<string, string>();

/**
 * the project a directory belongs to: its git top level, or the directory itself. a linked checkout (a
 * git worktree, the ones made for agents included) belongs to its repository's main checkout, so its
 * sessions list, share permission rules and fold under the same project.
 */
export function projectOf(directory: string): string {
	const hit = roots.get(directory);
	if (hit) return hit;
	const r = spawnSync("git", ["-C", directory, ...ROOT_ARGS], { encoding: "utf8", timeout: 2000 });
	return rootFrom(directory, r.status === 0 ? r.stdout : undefined);
}

const ROOT_ARGS = ["rev-parse", "--show-toplevel", "--git-common-dir"];

function rootFrom(directory: string, out: string | undefined): string {
	const [top, common] = out ? out.trim().split("\n") : [];
	let root = top ? resolve(top) : directory;
	if (top && common) {
		const commonAbs = resolve(directory, common);
		if (basename(commonAbs) === ".git" && dirname(commonAbs) !== root) root = real(dirname(commonAbs));
	}
	roots.set(directory, root);
	return root;
}

/** the project a directory belongs to when it is already known; never runs git */
export function knownProject(directory: string): string | undefined {
	return roots.get(directory);
}

/**
 * `projectOf` with git run as a child the event loop does not wait on, for a directory not reached yet:
 * git in a folder behind a privacy prompt waits for the answer, and the sync form would hold every session
 * for its timeout. the answer is cached, so later `projectOf` calls do not run git.
 */
export async function projectOfAsync(directory: string): Promise<string> {
	const hit = roots.get(directory);
	if (hit) return hit;
	try {
		const p = Bun.spawn(["git", "-C", directory, ...ROOT_ARGS], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		return rootFrom(directory, code === 0 ? out : undefined);
	} catch {
		return rootFrom(directory, undefined);
	}
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
