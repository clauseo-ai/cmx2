#!/usr/bin/env bun
/**
 * builds the single-file binaries. `bun scripts/build.ts` builds this machine's; `--all` builds the four
 * release targets into dist/ with a SHA256SUMS file; `--version v` stamps the version (default: the
 * version in packages/cli/package.json); `--repo owner/name` stamps where `cmx2 upgrade` looks for releases.
 *
 * three entrypoints go in: the cli, the `run` sandbox's worker and the tui. bun embeds the extra two under
 * its virtual root at their path below packages/ (tools/src/codemode-worker.js, tui/src/index.js), which
 * is where run.ts and commands/tui.ts look for them in a binary. the tui is a separate entry so the
 * daemon's import graph never holds pi-tui (the engine's drift test).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;
const ENTRIES = ["packages/cli/src/index.ts", "packages/tools/src/codemode-worker.ts", "packages/tui/src/index.ts"].map((p) => join(ROOT, p));

const { values } = parseArgs({ options: { all: { type: "boolean" }, version: { type: "string" }, out: { type: "string" }, target: { type: "string" }, repo: { type: "string" } } });
const version = values.version ?? JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version;
const outDir = values.out ?? join(ROOT, "dist");
mkdirSync(outDir, { recursive: true });

function platformTarget(): string {
	const os = process.platform === "darwin" ? "darwin" : "linux";
	return `bun-${os}-${process.arch === "arm64" ? "arm64" : "x64"}`;
}

async function build(target: string): Promise<string> {
	const name = values.all ? `cmx2-${target.replace(/^bun-/, "")}` : "cmx2";
	const outfile = join(outDir, name);
	const proc = Bun.spawnSync(["bun", "build", "--compile", `--target=${target}`, "--minify-syntax", `--define=CMX2_VERSION=${JSON.stringify(version)}`, ...(values.repo ? [`--define=CMX2_REPO=${JSON.stringify(values.repo)}`] : []), ...ENTRIES, "--outfile", outfile], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		console.error(proc.stderr.toString() || proc.stdout.toString());
		throw new Error(`build for ${target} failed`);
	}
	return outfile;
}

for (const e of ENTRIES) if (!existsSync(e)) throw new Error(`${e} is missing; the binary needs all three entrypoints`);

const targets = values.all ? [...TARGETS] : [values.target ?? platformTarget()];
const sums: string[] = [];
for (const t of targets) {
	const file = await build(t);
	const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
	sums.push(`${sha}  ${file.split("/").pop()}`);
	console.log(`${file}  ${(readFileSync(file).length / 1048576).toFixed(1)} MB  sha256 ${sha.slice(0, 16)}…`);
}
if (values.all) writeFileSync(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
