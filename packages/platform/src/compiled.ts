/**
 * the virtual root a compiled binary keeps its modules under: `file:///$bunfs/root/` on macos and linux,
 * `file:///B:/~BUN/root/` on windows (escaped as `%7EBUN` in import.meta.url). undefined when `url` is not inside one (bun is running the source). pass
 * `import.meta.url`; the extra entrypoints (the run sandbox's worker, the tui) sit at their path below it
 */
export function compiledRoot(url: string): string | undefined {
	// import.meta.url escapes the ~ (file:///B:/%7EBUN/root/... on windows, seen on bun 1.4.3)
	const m = url.match(/^(.*?\/(?:\$bunfs|~BUN|%7EBUN)\/root\/)/i);
	return m?.[1];
}

/** true when `url` (pass import.meta.url) is a module inside a compiled cmx2 binary */
export function isCompiled(url: string): boolean {
	return compiledRoot(url) !== undefined;
}
