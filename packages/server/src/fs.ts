import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { badRequest } from "./http.ts";

/** `/global/fs`: the directories inside one directory, visible first, then by name; the project picker's walk */
export function browse(raw: string | undefined, showHidden: boolean) {
	// symlinks resolved, like every session's directory and projectID, so a client can tell that a project root is the home
	const home = real(homedir());
	let path = raw && raw !== "" ? raw : home;
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	if (!path.startsWith("/")) throw badRequest(`path must be absolute, ~ or ~/..., got ${path}`);
	path = resolve(path);
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch (e) {
		const code = (e as { code?: string }).code;
		throw badRequest(code === "EACCES" ? `permission denied: ${path}` : `no such directory: ${path}`);
	}
	if (!st.isDirectory()) throw badRequest(`not a directory: ${path}`);
	let names: string[];
	try {
		names = readdirSync(path);
	} catch {
		throw badRequest(`permission denied: ${path}`);
	}
	const entries = names
		.map((name) => {
			const absolute = join(path, name);
			try {
				if (!statSync(absolute).isDirectory()) return undefined;
			} catch {
				return undefined;
			}
			return { name, absolute, hidden: name.startsWith("."), git: existsSync(join(absolute, ".git")) };
		})
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
	const r = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"], { encoding: "utf8", timeout: 2000 });
	const [top, common] = r.status === 0 ? r.stdout.trim().split("\n") : [];
	let root = top ? resolve(top) : directory;
	if (top && common) {
		const commonAbs = resolve(directory, common);
		if (basename(commonAbs) === ".git" && dirname(commonAbs) !== root) root = real(dirname(commonAbs));
	}
	roots.set(directory, root);
	return root;
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
