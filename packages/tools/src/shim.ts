import { IS_WINDOWS } from "@cmx2/platform";

/**
 * the names a command's file has in a node_modules/.bin or a virtualenv. on windows those hold shims, not the
 * extensionless sh script windows cannot run: bun's are .exe, npm's are .cmd, a python venv's are .exe
 */
export function binNames(name: string): string[] {
	return IS_WINDOWS && !/\.(exe|cmd|bat|com)$/i.test(name) ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/**
 * spawn options that run `exe` with `args`. a .cmd or .bat shim runs through cmd.exe, which Bun.spawn cannot skip;
 * cmd reads its own command line, so that one is built here (every word quoted, the whole wrapped once more for
 * /s) and passed verbatim. a windows path cannot hold a double quote, and the args here are flags and paths
 */
export function launch(exe: string, args: string[]): { argv: string[]; windowsVerbatimArguments?: true } {
	if (!(IS_WINDOWS && /\.(cmd|bat)$/i.test(exe))) return { argv: [exe, ...args] };
	const line = [exe, ...args].map((a) => `"${a.replace(/"/g, "")}"`).join(" ");
	return { argv: [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
