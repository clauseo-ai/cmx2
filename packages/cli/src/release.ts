import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "@cmx2/engine/config";
import { isCompiled } from "@cmx2/platform";

/** stamped by scripts/build.ts from `--repo` (the release workflow passes GITHUB_REPOSITORY) */
declare const CMX2_REPO: string | undefined;

/**
 * the github repository releases come from: the one this binary was released from, stamped at build
 * time, so an upgrade can only come from where the binary did. no guessed default: an unclaimed name
 * would hand whoever registers it every upgrade. CMX2_REPO names a fork; CMX2_RELEASE_BASE (or
 * `cmx2 upgrade --from`) points at any url or directory laid out like a release: the binaries named
 * `cmx2-<os>-<arch>` (`.exe` on windows) next to a SHA256SUMS file, which is what `bun scripts/build.ts --all` writes.
 */
export const DEFAULT_REPO: string | undefined = typeof CMX2_REPO === "string" && CMX2_REPO ? CMX2_REPO : undefined;

export function releaseBase(version?: string, env = process.env): string {
	if (env.CMX2_RELEASE_BASE) return env.CMX2_RELEASE_BASE.replace(/\/$/, "");
	const repo = env.CMX2_REPO || DEFAULT_REPO;
	if (!repo) throw new Error("this build does not know which repository it was released from (a source build). set CMX2_REPO=owner/name, or pass --from <url or dir>");
	return version ? `https://github.com/${repo}/releases/download/v${version.replace(/^v/, "")}` : `https://github.com/${repo}/releases/latest/download`;
}

/** what `bun scripts/build.ts --all` builds and a release publishes */
export const RELEASE_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64", "bun-windows-arm64"] as const;

/** the bun compile target for an os and arch: bun-darwin-arm64, bun-windows-x64, ... */
export function buildTarget(platform: string = process.platform, arch: string = process.arch): string {
	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
	if (!os) throw new Error(`there is no cmx2 build for ${platform}; macos, linux and windows only`);
	const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
	if (!a) throw new Error(`there is no cmx2 build for ${arch}; arm64 and x64 only`);
	return `bun-${os}-${a}`;
}

/** the release file a target builds to: cmx2-linux-x64, cmx2-windows-x64.exe */
export function targetFile(target: string): string {
	const name = `cmx2-${target.replace(/^bun-/, "")}`;
	return target.includes("-windows-") ? `${name}.exe` : name;
}

/** the release asset for this machine: cmx2-darwin-arm64, cmx2-linux-x64, cmx2-windows-x64.exe, ... */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
	return targetFile(buildTarget(platform, arch));
}

/** the file name of the binary on this os: cmx2, or cmx2.exe on windows */
export function binaryName(platform: string = process.platform): string {
	return platform === "win32" ? "cmx2.exe" : "cmx2";
}

/** where `serve --install` keeps its copy of the binary (a binary under ~/Documents stalls launchd on a tcc prompt) */
export function installedBinary(env = process.env, platform: string = process.platform): string {
	return join(dataDir(env), "bin", binaryName(platform));
}

/** true when this process is a compiled cmx2 binary rather than bun running the source */
export function compiled(): boolean {
	return isCompiled(import.meta.url);
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** the sum for one file in a SHA256SUMS body (`<hex>  <name>`, optionally `*<name>`) */
export function sumFor(sums: string, name: string): string | undefined {
	for (const line of sums.split("\n")) {
		const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
		if (m && m[2] === name) return m[1]!.toLowerCase();
	}
	return undefined;
}

/** bytes from a url or from a file in a local directory */
export async function fetchBytes(base: string, name: string): Promise<Uint8Array> {
	if (!/^https?:\/\//.test(base)) {
		const path = join(base.startsWith("file:") ? fileURLToPath(base) : base, name);
		if (!existsSync(path)) throw new Error(`${path} is not there`);
		return new Uint8Array(readFileSync(path));
	}
	const url = `${base}/${name}`;
	const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) }).catch((e: unknown) => {
		throw new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/** -1, 0 or 1 comparing two semver strings; a prerelease sorts below its release */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (x.pre === undefined) return 1;
	if (y.pre === undefined) return -1;
	return x.pre < y.pre ? -1 : 1;
}
