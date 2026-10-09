import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

/**
 * the project's formatter, run on a file write or edit just touched. a formatter counts only when the
 * project says so (its config file, or the language's one standard tool): prettier and biome by their
 * config, ruff by its config, gofmt for go and rustfmt for rust. nothing is installed or guessed; a
 * project without a formatter is left alone.
 */

export interface Formatted {
	/** which formatter ran */
	tool: string;
	/** true when the file on disk changed */
	changed: boolean;
	/** set when the formatter ran and failed; the file is as written */
	error?: string;
}

const TIMEOUT_MS = 10_000;
const PRETTIER_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css", ".scss", ".less", ".html", ".vue", ".md", ".mdx", ".yaml", ".yml", ".graphql"]);
const BIOME_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css"]);
const PRETTIER_CONFIG = [".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts"];

/** the nearest directory from here up that passes the test (config files may sit above the working directory) */
function up(from: string, _cwd: string, test: (dir: string) => boolean): string | undefined {
	let dir = from;
	for (;;) {
		if (test(dir)) return dir;
		const next = dirname(dir);
		if (next === dir) return undefined;
		dir = next;
	}
}

/** a formatter the project installed (node_modules/.bin, or its virtualenv for python tools), else one on the daemon's path */
function bin(name: string, from: string): string | undefined {
	for (const rel of [["node_modules", ".bin"], [".venv", "bin"], ["venv", "bin"]]) {
		const local = up(from, "/", (d) => existsSync(join(d, ...rel, name)));
		if (local) return join(local, ...rel, name);
	}
	return Bun.which(name) ?? undefined;
}

function packageHas(dir: string, key: string): boolean {
	const p = join(dir, "package.json");
	if (!existsSync(p)) return false;
	try {
		return key in JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return false;
	}
}

/** the formatter command for this file in this project, or nothing */
export function formatterFor(file: string, cwd: string): { tool: string; argv: string[] } | undefined {
	const ext = extname(file).toLowerCase();
	const from = dirname(file);
	if (BIOME_EXT.has(ext) && up(from, cwd, (d) => existsSync(join(d, "biome.json")) || existsSync(join(d, "biome.jsonc")))) {
		const b = bin("biome", from);
		if (b) return { tool: "biome", argv: [b, "format", "--write", file] };
	}
	if (PRETTIER_EXT.has(ext) && up(from, cwd, (d) => PRETTIER_CONFIG.some((c) => existsSync(join(d, c))) || packageHas(d, "prettier"))) {
		const b = bin("prettier", from);
		if (b) return { tool: "prettier", argv: [b, "--write", "--log-level", "warn", file] };
	}
	if ((ext === ".py" || ext === ".pyi") && up(from, cwd, (d) => existsSync(join(d, "ruff.toml")) || existsSync(join(d, ".ruff.toml")) || (existsSync(join(d, "pyproject.toml")) && readFileSync(join(d, "pyproject.toml"), "utf8").includes("[tool.ruff")))) {
		const b = bin("ruff", from);
		if (b) return { tool: "ruff", argv: [b, "format", file] };
	}
	if (ext === ".go") {
		const b = Bun.which("gofmt");
		if (b) return { tool: "gofmt", argv: [b, "-w", file] };
	}
	if (ext === ".rs") {
		const b = Bun.which("rustfmt");
		if (b) return { tool: "rustfmt", argv: [b, "--edition", "2021", file] };
	}
	return undefined;
}

/** formats the file in place when the project has a formatter for it */
export async function formatFile(file: string, cwd: string): Promise<Formatted | undefined> {
	const f = formatterFor(file, cwd);
	if (!f) return undefined;
	const before = readFileSync(file);
	const proc = Bun.spawn(f.argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	if (code !== 0) return { tool: f.tool, changed: false, error: (err.trim().split("\n")[0] ?? "").slice(0, 300) || `exit ${code}` };
	return { tool: f.tool, changed: !before.equals(readFileSync(file)) };
}
