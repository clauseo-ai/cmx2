import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * the bash every command runs in. on macos and linux it is `bash` from PATH, as it always was. on windows it is git
 * for windows' bash, found by where git is installed, never by looking bash up on PATH: `bash` on a windows PATH is
 * usually C:\Windows\System32\bash.exe, the wsl launcher, which would run the command in a linux vm with a
 * different filesystem view. `bin\bash.exe` is git's launcher: it puts git's unix tools (ls, grep, sed) on PATH
 * before it starts the real bash, which `usr\bin\bash.exe` alone does not.
 */

export const IS_WINDOWS = process.platform === "win32";

export type BashSource = "CMX2_GIT_BASH" | "git" | "default";
export type BashLookup = { path: string; from: BashSource } | { error: string };

export const BASH_HINT = "install git for windows (winget install --id Git.Git -e) or set CMX2_GIT_BASH to the full path of its bin\\bash.exe";

export class BashMissing extends Error {
	override name = "BashMissing";
}

type Lookup = { env?: Record<string, string | undefined>; exists?: (p: string) => boolean; which?: (cmd: string, path: string | undefined) => string | null };

/** the windows env is case-insensitive; a copied object is not */
function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
	if (env[name] !== undefined) return env[name];
	const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
	return k ? env[k] : undefined;
}

/** a path inside the windows directory (System32's bash.exe is the wsl launcher) or a store alias (WindowsApps\bash.exe is too) */
function wslLauncher(path: string, env: Record<string, string | undefined>): boolean {
	const p = win32.normalize(path).toLowerCase();
	const root = (envGet(env, "SystemRoot") ?? envGet(env, "windir") ?? "C:\\Windows").toLowerCase();
	return p.startsWith(`${win32.normalize(root)}\\`) || p.includes("\\windowsapps\\");
}

/** the git install root for a git.exe: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe (and clangarm64, mingw32) */
export function gitRootOf(gitExe: string): string | undefined {
	const parts = win32.normalize(gitExe).split("\\");
	if (parts.length < 3) return undefined;
	const dir = parts[parts.length - 2]!.toLowerCase();
	const up = parts[parts.length - 3]!.toLowerCase();
	if (dir === "bin" && /^(mingw64|mingw32|clangarm64|clang64|ucrt64)$/.test(up)) return parts.slice(0, -3).join("\\");
	if (dir === "cmd" || dir === "bin") return parts.slice(0, -2).join("\\");
	return undefined;
}

/**
 * git for windows' bash: CMX2_GIT_BASH when it is set (it must exist and must not be the wsl launcher), else the
 * bin\bash.exe of the git that is on PATH, else the usual install places (program files, a per-user install, scoop)
 */
export function findGitBash(o: Lookup = {}): BashLookup {
	const env = o.env ?? process.env;
	const exists = o.exists ?? existsSync;
	const which = o.which ?? ((cmd: string, path: string | undefined) => Bun.which(cmd, path === undefined ? {} : { PATH: path }));
	const set = envGet(env, "CMX2_GIT_BASH")?.trim().replace(/^"(.*)"$/, "$1");
	if (set) {
		if (wslLauncher(set, env)) return { error: `CMX2_GIT_BASH is ${set}, which is the wsl launcher, not git's bash. point it at git for windows' bin\\bash.exe` };
		if (!exists(set)) return { error: `CMX2_GIT_BASH is ${set}, and there is no file there` };
		return { path: set, from: "CMX2_GIT_BASH" };
	}
	const git = which("git", envGet(env, "PATH"));
	const root = git ? gitRootOf(git) : undefined;
	if (root) {
		const bash = win32.join(root, "bin", "bash.exe");
		if (exists(bash) && !wslLauncher(bash, env)) return { path: bash, from: "git" };
	}
	const places = [envGet(env, "ProgramFiles"), envGet(env, "ProgramW6432"), envGet(env, "ProgramFiles(x86)")].filter((p): p is string => !!p).map((p) => win32.join(p, "Git"));
	const local = envGet(env, "LOCALAPPDATA");
	if (local) places.push(win32.join(local, "Programs", "Git"));
	const profile = envGet(env, "USERPROFILE");
	if (profile) places.push(win32.join(profile, "scoop", "apps", "git", "current"));
	places.push("C:\\Program Files\\Git");
	for (const p of places) {
		const bash = win32.join(p, "bin", "bash.exe");
		if (exists(bash)) return { path: bash, from: "default" };
	}
	return { error: `git for windows' bash was not found${git ? ` (git is at ${git}, with no bin\\bash.exe beside it)` : ""}. ${BASH_HINT}` };
}

let found: { key: string; path: string } | undefined;

/** the bash to run commands with: `bash` off windows; git's bash on windows (cached once found), or a BashMissing error that says how to fix it */
export function bashPath(env: Record<string, string | undefined> = process.env): string {
	if (!IS_WINDOWS) return "bash";
	const key = `${envGet(env, "CMX2_GIT_BASH") ?? ""}\0${envGet(env, "PATH") ?? ""}`;
	if (found?.key === key) return found.path;
	const r = findGitBash({ env });
	if ("error" in r) throw new BashMissing(r.error);
	found = { key, path: r.path };
	return r.path;
}

/**
 * argv for one command line: `bash -c <command>` (`-lc` with login). on windows it is git's bash, and the env
 * gets CHERE_INVOKING=1 so a login shell's profile stays in the working directory instead of going home. the
 * command goes on the command line as it is, which windows does not carry intact (see bashCommand): use this for
 * fixed commands only, and bashCommand for anything a model or a person wrote
 */
export function bashArgv(command: string, o: { login?: boolean; env?: Record<string, string | undefined> } = {}): string[] {
	return [bashPath(o.env), o.login ? "-lc" : "-c", command];
}

/** what a command's env needs on top of the caller's on this platform (nothing off windows) */
export function bashEnv(): Record<string, string> {
	return IS_WINDOWS ? { CHERE_INVOKING: "1" } : {};
}

/** on windows a command reaches bash in this env var, not on the command line */
export const COMMAND_VAR = "CMX2_COMMAND";
/** what windows' bash runs: the command from the env var, the var unset first so the command's children do not inherit it */
export const WINDOWS_WRAPPER = `eval "unset ${COMMAND_VAR}; $${COMMAND_VAR}"`;

/**
 * argv and env that run one command line in bash: `bash -c <command>` (`-lc` with login) and `env` plus bashEnv().
 * windows passes the command in COMMAND_VAR instead. bun quotes argv for windows' parser, and the msys runtime
 * that starts git's bash reads its command line by other rules: it folds a doubled backslash into one. an env
 * var arrives byte for byte, so the command line holds only a fixed wrapper, which has no backslash in it
 */
export function bashCommand(command: string, o: { login?: boolean; env?: Record<string, string | undefined> } = {}): { argv: string[]; env: Record<string, string | undefined> } {
	const env = { ...(o.env ?? process.env), ...bashEnv() };
	if (!IS_WINDOWS) return { argv: bashArgv(command, { login: o.login }), env };
	return { argv: [bashPath(env), o.login ? "-lc" : "-c", WINDOWS_WRAPPER], env: { ...env, [COMMAND_VAR]: command } };
}
