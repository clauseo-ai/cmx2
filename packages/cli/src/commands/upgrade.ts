import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "@cmx2/server";
import { assetName, compareVersions, compiled, fetchBytes, installedBinary, releaseBase, sha256, sumFor } from "../release.ts";
import { binaryVersion, keepLink, linkNotes, placeBinary, restartCommand, restartService, same, serviceState } from "../service.ts";
import { fail } from "../util.ts";

export const help = `cmx2 upgrade: swap in the latest release

usage:
  cmx2 upgrade [--version v] [--from url-or-dir] [--force] [--no-restart]

it downloads the build for this machine and SHA256SUMS from the latest github release, refuses a file
whose sum does not match, checks the new binary runs, then replaces the installed copy
(~/.local/share/cmx2/bin/cmx2 when cmx2 serve --install set one up, else the binary you ran), and keeps
the cmx2 link in ~/.local/bin (or $CMX2_INSTALL_DIR) pointing at it. when the
service is installed it restarts it; turns running at that moment stop, sessions stay.

  --version v     a specific release instead of the latest
  --from x        a url or a directory laid out like a release (cmx2-<os>-<arch> and SHA256SUMS);
                  $CMX2_RELEASE_BASE does the same
  --force         install even when it is the version you have, or older
  --no-restart    replace the binary only and print the restart command`;

/**
 * the link in the install dir names the installed path, so it follows an upgrade; this repairs one that
 * dangles, makes the first one, and swaps the install.sh copy this ran from. that copy goes only when the
 * installed binary is at least as new as it: a link to an older binary would answer an older version than
 * the copy it deletes (the release was compared with the copy that runs, not with the service's binary)
 */
function relink(target: string, installed: string, o: { already: boolean }) {
	if (target !== installed) return;
	const have = binaryVersion(installed);
	const current = have !== undefined && compareVersions(have, VERSION) >= 0;
	if (!current && o.already) {
		console.log(`note: the service's binary is ${have ? `cmx2 ${have}, older than the ${VERSION} you run` : "not answering --version"}. cmx2 upgrade --force or cmx2 serve --install brings it up to this one`);
	}
	const l = keepLink(installed, { install: false, replaceSelf: current });
	if (l.kind === "ok") return;
	if (l.kind === "occupied" && !current && o.already && same(l.path, process.execPath)) return console.log(`${l.path} is this copy, so it is left as it is until then (a link there would answer ${have ?? "an older version"})`);
	for (const line of linkNotes(l, installed)) console.log(line);
}

export async function main(args: string[]) {
	const { values } = parseArgs({ args, options: { version: { type: "string" }, from: { type: "string" }, force: { type: "boolean" }, "no-restart": { type: "boolean" } } });
	let base: string;
	try {
		base = values.from?.replace(/\/$/, "") ?? releaseBase(values.version);
	} catch (e) {
		fail((e as Error).message);
	}
	let asset: string;
	try {
		asset = assetName();
	} catch (e) {
		fail((e as Error).message);
	}
	const installed = installedBinary();
	const target = existsSync(installed) ? installed : compiled() ? process.execPath : undefined;
	if (!target) fail("there is no binary to replace: this is bun running the source. use git pull, or install a release with scripts/install.sh");

	console.log(`checking ${base}`);
	let sums: string;
	let bytes: Uint8Array;
	try {
		sums = new TextDecoder().decode(await fetchBytes(base, "SHA256SUMS"));
		const want = sumFor(sums, asset);
		if (!want) fail(`SHA256SUMS at ${base} has no line for ${asset}; that release has no build for this machine`);
		bytes = await fetchBytes(base, asset);
		const got = sha256(bytes);
		if (got !== want) fail(`${asset} does not match its checksum (expected ${want.slice(0, 16)}…, got ${got.slice(0, 16)}…). nothing was replaced; try again, and report it if it repeats`);
	} catch (e) {
		fail((e as Error).message);
	}

	// the new binary has to run before it replaces anything, and it names its own version
	const dir = mkdtempSync(join(tmpdir(), "cmx2-upgrade-"));
	const fresh = join(dir, "cmx2");
	try {
		writeFileSync(fresh, bytes);
		chmodSync(fresh, 0o755);
		const p = Bun.spawnSync([fresh, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		const version = p.stdout.toString().trim();
		if (p.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(version)) fail(`the downloaded binary did not run (${p.stderr.toString().trim().slice(0, 200) || `exit ${p.exitCode}`}); nothing was replaced`);
		const cmp = compareVersions(version, VERSION);
		if (cmp === 0 && !values.force) {
			console.log(`already on ${VERSION}. --force reinstalls it`);
			// a 0.8.6 upgrade could not make the link, and the copy install.sh left is as current as it is
			relink(target, installed, { already: true });
			return;
		}
		if (cmp < 0 && !values.force) fail(`the release is ${version}, older than the ${VERSION} you run. --force installs it anyway`);
		placeBinary(fresh, target);
		console.log(`replaced ${target}: ${VERSION} -> ${version}`);
		relink(target, installed, { already: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const s = serviceState();
	if (!s.installed) return console.log("no service installed, so nothing to restart");
	if (s.binary && s.binary !== target) console.log(`note: the service runs ${s.binary}, not ${target}. cmx2 serve --install points it at the copy`);
	if (values["no-restart"]) return console.log(`the service still runs the old binary until it restarts: ${restartCommand()}`);
	const r = restartService();
	if (!r.ok) fail(`the binary is replaced but the restart failed: ${r.out}. run ${restartCommand()}`);
	console.log(`restarted the service (${restartCommand()})`);
}
