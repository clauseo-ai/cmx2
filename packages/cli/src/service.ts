import { authHeaders } from "./daemon.ts";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dataDir, loadConfig } from "@cmx2/engine/config";
import { compareVersions, compiled, installedBinary } from "./release.ts";
import { fail } from "./util.ts";

/**
 * `cmx2 serve --install`: the daemon as a per-user service. launchd on macos, a systemd user unit on
 * linux. the unit runs a copy of the binary under the data dir, never the file you ran, because launchd
 * stalls for minutes on a tcc consent prompt when the binary sits under ~/Documents (GOTCHAS, tcc).
 *
 * secrets never go in the unit. keys set in the installing shell (ANTHROPIC_API_KEY and friends, and any
 * `$NAME` the profile's providers reference) are written to `<data dir>/service.env`, mode 0600, which
 * the unit reads at start. the data dir is not the profile, so a profile kept in git never holds them.
 */

export interface UnitSpec {
	label: string;
	binary: string;
	port: number;
	hostname: string;
	/** plain variables for the unit (HOME, PATH, CMX2_*); never secrets */
	env: Record<string, string>;
	/** the 0600 file with keys, read at start when it exists */
	envFile: string;
	logDir: string;
	workingDirectory: string;
}

/** the launchd label and systemd unit name; CMX2_SERVICE_LABEL overrides it (tests install beside a real one) */
export function serviceLabel(env = process.env): string {
	return env.CMX2_SERVICE_LABEL || "dev.cmx2.serve";
}

function systemdName(label: string): string {
	return label === "dev.cmx2.serve" ? "cmx2" : label;
}

export function unitPath(platform = process.platform, label = serviceLabel(), home = homedir()): string {
	if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${label}.plist`);
	return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", `${systemdName(label)}.service`);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** a launchd agent. keys come from the env file through sh, so the plist itself holds none */
export function renderLaunchd(u: UnitSpec): string {
	const serveArgs = ["serve", "--port", String(u.port), "--hostname", u.hostname];
	// sh reads the env file (when there is one) and execs the binary, so the running process is cmx2 itself
	const script = `if [ -f "$0" ]; then set -a; . "$0"; set +a; fi; exec "$1" ${serveArgs.map(sq).join(" ")}`;
	const args = ["/bin/sh", "-c", script, u.envFile, u.binary];
	const env = Object.entries(u.env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(u.label)}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(u.workingDirectory)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>${xml(join(u.logDir, "serve.log"))}</string>
	<key>StandardErrorPath</key>
	<string>${xml(join(u.logDir, "serve.log"))}</string>
</dict>
</plist>
`;
}

/** systemd quotes: double quotes with backslash escapes, % doubled */
const dq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * a systemd user unit. Restart=always because `/global/restart` exits 0 and expects the supervisor to
 * start a fresh daemon.
 */
export function renderSystemd(u: UnitSpec): string {
	const env = Object.entries(u.env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `Environment=${dq(`${k}=${v}`)}`)
		.join("\n");
	return `[Unit]
Description=cmx2 daemon (${u.hostname}:${u.port})

[Service]
Type=simple
ExecStart=${[u.binary, "serve", "--port", String(u.port), "--hostname", u.hostname].map((a) => (/[\s"'\\%]/.test(a) ? dq(a) : a)).join(" ")}
WorkingDirectory=${u.workingDirectory}
${env}
EnvironmentFile=-${u.envFile}
Restart=always
RestartSec=2
StandardOutput=append:${join(u.logDir, "serve.log")}
StandardError=append:${join(u.logDir, "serve.log")}

[Install]
WantedBy=default.target
`;
}

/** the providers' key variables: the usual ones plus every `$NAME` the profile references */
export function keyNames(config: { providers: Record<string, { apiKey?: string }> }): string[] {
	const names = new Set(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "CMX2_SERVER_PASSWORD"]);
	for (const p of Object.values(config.providers)) {
		const v = p.apiKey;
		if (v?.startsWith("$")) names.add(v.slice(1).replace(/^\{|\}$/g, ""));
	}
	return [...names].sort();
}

/** KEY='value' lines that both sh and systemd's EnvironmentFile read */
export function renderEnvFile(vars: Record<string, string>): string {
	return `${Object.entries(vars)
		.map(([k, v]) => `${k}=${sq(v)}`)
		.join("\n")}\n`;
}

export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) continue;
		let v = m[2]!;
		if (v.startsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
		out[m[1]!] = v;
	}
	return out;
}

/** runs a command; one that is not installed is a failed run that says so, not an exception */
export function run(cmd: string[]): { ok: boolean; out: string; missing?: boolean } {
	try {
		const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
	} catch (e) {
		if ((e as { code?: string }).code !== "ENOENT") throw e;
		return { ok: false, out: `${cmd[0]} was not found on PATH`, missing: true };
	}
}

function uid(): number {
	return process.getuid?.() ?? 0;
}

export interface ServiceState {
	platform: string;
	label: string;
	unit: string;
	installed: boolean;
	loaded: boolean;
	running: boolean;
	pid?: number;
	/** the binary the unit runs, read back from the unit file */
	binary?: string;
	port?: number;
	hostname?: string;
}

/** reads the unit file and asks launchd or systemd how it is doing */
export function serviceState(): ServiceState {
	const label = serviceLabel();
	const unit = unitPath();
	const s: ServiceState = { platform: process.platform, label, unit, installed: existsSync(unit), loaded: false, running: false };
	if (s.installed) {
		const text = readFileSync(unit, "utf8");
		s.port = Number(text.match(/--port['"]?\s*(?:<\/string>\s*<string>)?['"]?(\d+)/)?.[1]) || undefined;
		s.hostname = text.match(/--hostname['"]?\s*(?:<\/string>\s*<string>)?['"]?([^\s'"<]+)/)?.[1];
		s.binary = process.platform === "darwin" ? text.match(/<string>\/bin\/sh<\/string>(?:\s*<string>[^<]*<\/string>){3}\s*<string>([^<]+)<\/string>/)?.[1] : text.match(/^ExecStart="?([^\s"]+)/m)?.[1];
	}
	if (process.platform === "darwin") {
		const r = run(["launchctl", "print", `gui/${uid()}/${label}`]);
		s.loaded = r.ok;
		if (r.ok) {
			s.running = /\bstate = running\b/.test(r.out);
			const pid = r.out.match(/\bpid = (\d+)/)?.[1];
			if (pid) s.pid = Number(pid);
		}
	} else if (process.platform === "linux") {
		const name = `${systemdName(label)}.service`;
		const r = run(["systemctl", "--user", "show", name, "--property=LoadState,ActiveState,MainPID"]);
		if (r.ok) {
			s.loaded = /LoadState=loaded/.test(r.out);
			s.running = /ActiveState=active/.test(r.out);
			const pid = Number(r.out.match(/MainPID=(\d+)/)?.[1]);
			if (pid) s.pid = pid;
		}
	}
	return s;
}

/** the command that restarts the installed unit, for printing */
export function restartCommand(): string {
	const label = serviceLabel();
	return process.platform === "darwin" ? `launchctl kickstart -k gui/${uid()}/${label}` : `systemctl --user restart ${systemdName(label)}.service`;
}

/** restarts the installed unit; false with the reason when it could not */
export function restartService(): { ok: boolean; out: string } {
	return run(restartCommand().split(" "));
}

/** copies over atomically: a running daemon keeps its open file, the next start gets the new one */
export function placeBinary(from: string, to: string) {
	mkdirSync(dirname(to), { recursive: true });
	const tmp = `${to}.new-${process.pid}`;
	copyFileSync(from, tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, to);
}

/** where the `cmx2` on your PATH lives: $CMX2_INSTALL_DIR (made absolute), else ~/.local/bin, the same place scripts/install.sh uses */
export function linkDir(env = process.env, home = homedir()): string {
	return env.CMX2_INSTALL_DIR ? resolve(env.CMX2_INSTALL_DIR) : join(home, ".local", "bin");
}

export type LinkResult =
	| { kind: "linked" | "repaired" | "ok" | "absent"; path: string }
	/** `was` is the version the replaced copy reported, when it was not the binary doing this */
	| { kind: "replaced"; path: string; was?: string }
	/** a regular file named cmx2 is there and stays: `copy` is the version it reports and `installed` the service binary's, when they could be read */
	| { kind: "occupied"; path: string; copy?: string; installed?: string }
	/** a working link to somewhere else (a dev build, say): not ours to repoint */
	| { kind: "elsewhere"; path: string; target: string }
	| { kind: "failed"; path: string; why: string };

/**
 * `<dir>/cmx2` as a symlink to the installed binary. a link to the binary is left as it is; a missing
 * one is made (unless `create` is false, then it is `absent`); a link that dangles is pointed back. a
 * regular file there is a copy of cmx2 (scripts/install.sh leaves one): it is replaced by the link when it
 * is `self` (the binary running this, just copied to `binary`) or reports a version no newer than the
 * installed binary's, so a machine set up the README way ends on one binary. a copy that is newer, or does
 * not answer `--version`, and a working link that points elsewhere, are left alone. a replacement is a temp
 * link renamed over the old entry, so a failure leaves the copy where it was. the link names the binary's
 * path, not its bytes, so `upgrade` replacing the binary keeps it valid.
 */
export function linkBinary(binary: string, dir: string, o: { self?: string; create?: boolean } = {}): LinkResult {
	const path = join(dir, "cmx2");
	try {
		let kind: "linked" | "repaired" | "replaced" = "linked";
		let was: string | undefined;
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st) {
			// the dir is the binary's own dir: there is nothing to link
			if (same(path, binary) && !st.isSymbolicLink()) return { kind: "ok", path };
			if (st.isSymbolicLink()) {
				if (!existsSync(path)) kind = "repaired";
				else if (resolve(dir, readlinkSync(path)) === binary || same(path, binary)) return { kind: "ok", path };
				else return { kind: "elsewhere", path, target: readlinkSync(path) };
			} else if (o.self && same(path, o.self)) kind = "replaced";
			else if (st.isFile()) {
				const copy = binaryVersion(path, 10_000);
				const installed = binaryVersion(binary, 10_000);
				if (copy === undefined || installed === undefined || compareVersions(copy, installed) > 0) return { kind: "occupied", path, ...(copy ? { copy } : {}), ...(installed ? { installed } : {}) };
				kind = "replaced";
				was = copy;
			} else return { kind: "occupied", path };
		} else if (o.create === false) return { kind: "absent", path };
		mkdirSync(dir, { recursive: true });
		if (!st) symlinkSync(binary, path);
		else {
			// the new link is made beside the old entry and renamed over it
			const tmp = `${path}.new-${process.pid}`;
			try {
				rmSync(tmp, { force: true });
				symlinkSync(binary, tmp);
				renameSync(tmp, path);
			} catch (e) {
				rmSync(tmp, { force: true });
				throw e;
			}
		}
		return kind === "replaced" ? { kind, path, ...(was ? { was } : {}) } : { kind, path };
	} catch (e) {
		return { kind: "failed", path, why: (e as Error).message };
	}
}

/** the version a cmx2 binary reports, or undefined when it does not run or does not say */
export function binaryVersion(path: string, timeout = 30_000): string | undefined {
	try {
		const p = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe", timeout });
		const v = p.stdout.toString().trim();
		return p.exitCode === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** where install remembers it made a link, so upgrade does not make one again after you took it away */
function linkMarker(): string {
	return join(dataDir(), "link");
}

/**
 * `linkBinary` for the two callers. install always makes the link and remembers where; upgrade makes
 * one only the first time (no memory of an install having done it, as after 0.8.6), and otherwise only
 * repairs one that exists or swaps the install.sh copy it runs from.
 */
export function keepLink(binary: string, o: { install: boolean; /** false leaves the copy this runs from alone */ replaceSelf?: boolean }): LinkResult {
	const marked = existsSync(linkMarker());
	const r = linkBinary(binary, o.install ? linkDir() : marked ? dirname(readFileSync(linkMarker(), "utf8").trim()) : linkDir(), { ...(o.replaceSelf === false ? {} : { self: process.execPath }), create: o.install || !marked });
	if (r.kind === "linked" || r.kind === "repaired" || r.kind === "replaced" || (o.install && r.kind === "ok")) {
		mkdirSync(dirname(linkMarker()), { recursive: true });
		writeFileSync(linkMarker(), `${r.path}\n`);
	}
	return r;
}

/** the lines that tell you what linking did, and how to put the directory on PATH when it is not there */
export function linkNotes(r: LinkResult, binary: string, path = process.env.PATH ?? "", home = homedir(), shell = process.env.SHELL ?? ""): string[] {
	const dir = dirname(r.path);
	const out: string[] = [];
	if (r.kind === "absent") return out;
	if (r.kind === "linked" || r.kind === "repaired") out.push(`linked     ${r.path} -> ${binary}`);
	else if (r.kind === "replaced") out.push(`linked     ${r.path} -> ${binary} (it replaced the copy of cmx2${r.was ? ` ${r.was}` : ""} that was there, so it follows cmx2 upgrade)`);
	else if (r.kind === "ok") out.push(`linked     ${r.path} (already points at the binary)`);
	else if (r.kind === "occupied") {
		const swap = `to use the service's binary: rm ${r.path} && ln -s ${binary} ${r.path}`;
		if (r.copy && r.installed) out.push(`not linked ${r.path} is cmx2 ${r.copy}, newer than the ${r.installed} the service runs, so it is left alone. cmx2 serve --install run from it brings the service up to it; or, ${swap}`);
		else if (r.copy) out.push(`not linked ${r.path} is a separate copy of cmx2 ${r.copy} and the service's binary did not report a version to compare with, so it is left alone. ${swap}`);
		else out.push(`not linked ${r.path} is a separate copy that did not report a cmx2 version, so it is left alone and will not follow cmx2 upgrade. ${swap}`);
	}
	else if (r.kind === "elsewhere") out.push(`not linked ${r.path} already points at ${r.target}, so it is left alone. to use the service's binary: ln -sfn ${binary} ${r.path}`);
	else if (r.kind === "failed") out.push(`not linked ${r.path}: ${r.why}. link it yourself: ln -s ${binary} ${r.path}`);
	if (r.kind === "failed" || r.kind === "occupied" || r.kind === "elsewhere") return out;
	if (!path.split(":").some((e) => e && resolve(e) === dir)) {
		// the line goes into a shell rc, so a dir under home is written as $HOME/...
		const shown = dir.startsWith(`${home}/`) ? `$HOME${dir.slice(home.length)}` : dir;
		const sh = basename(shell);
		out.push(`${dir} is not on your PATH, so cmx2 is not found yet. add it${sh === "fish" || sh === "zsh" || sh === "bash" ? "" : ", for zsh"}:`);
		if (sh === "fish") out.push(`  fish_add_path "${shown}"`);
		else if (sh === "bash") out.push(`  echo 'export PATH="${shown}:$PATH"' >> ~/.bashrc && export PATH="${dir}:$PATH"`);
		else {
			out.push(`  echo 'export PATH="${shown}:$PATH"' >> ~/.zshrc && export PATH="${dir}:$PATH"`);
			if (sh !== "zsh") out.push("or for bash, the same line into ~/.bashrc; for fish, fish_add_path with the directory");
		}
	}
	return out;
}

/**
 * the installing shell's PATH for the unit, less what will not outlive that shell: directories that are
 * not there, and version managers' per-shell links (fnm's `fnm_multishells/<pid>`), which vanish when the
 * shell exits and leave the service without the tools it found at install time
 */
export function servicePath(path: string | undefined, exists: (p: string) => boolean = existsSync): string {
	const kept = (path ?? "")
		.split(":")
		.filter((p) => p && !/\/fnm_multishells\//.test(p) && exists(p))
		.filter((p, i, all) => all.indexOf(p) === i);
	return kept.length ? kept.join(":") : "/usr/local/bin:/usr/bin:/bin";
}

export function same(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

export async function install(opts: { port?: string; hostname?: string }) {
	if (process.platform !== "darwin" && process.platform !== "linux") fail(`serve --install knows launchd (macos) and systemd (linux), not ${process.platform}`);
	if (!compiled()) fail("serve --install copies the cmx2 binary, and this is bun running the source. build one with bun scripts/build.ts and run dist/cmx2 serve --install, or install a release with scripts/install.sh");
	// before anything is copied or written: without systemd there is no user manager to install into
	if (process.platform === "linux" && run(["systemctl", "--version"]).missing) {
		fail("systemctl was not found, so there is no systemd user manager to install a service into. run cmx2 serve in a terminal, or under your own supervisor (it exits 0 on /global/restart and expects to be started again)");
	}
	const config = loadConfig();
	const port = opts.port ? Number(opts.port) : config.server.port;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`--port must be a port number, got ${opts.port}`);
	const hostname = opts.hostname ?? config.server.hostname;
	const data = dataDir();
	const binary = installedBinary();
	const logDir = join(data, "log");
	mkdirSync(logDir, { recursive: true });
	if (!same(process.execPath, binary)) placeBinary(process.execPath, binary);
	const linked = keepLink(binary, { install: true });

	// keys from this shell go to the 0600 env file, merged over what an earlier install left
	const envFile = join(data, "service.env");
	const kept = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
	const fromShell: Record<string, string> = {};
	for (const k of keyNames(config)) if (process.env[k]) fromShell[k] = process.env[k]!;
	const keys = { ...kept, ...fromShell };
	if (Object.keys(keys).length) {
		writeFileSync(envFile, renderEnvFile(keys), { mode: 0o600 });
		chmodSync(envFile, 0o600);
	}

	const env: Record<string, string> = { HOME: homedir(), PATH: servicePath(process.env.PATH) };
	for (const k of ["CMX2_CONFIG_DIR", "CMX2_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
	const spec: UnitSpec = { label: serviceLabel(), binary, port, hostname, env, envFile, logDir, workingDirectory: homedir() };
	const unit = unitPath();
	mkdirSync(dirname(unit), { recursive: true });

	if (process.platform === "darwin") {
		writeFileSync(unit, renderLaunchd(spec));
		const target = `gui/${uid()}`;
		// a loaded agent must be booted out before launchd takes the new plist
		run(["launchctl", "bootout", `${target}/${spec.label}`]);
		let r = run(["launchctl", "bootstrap", target, unit]);
		if (!r.ok) {
			// bootout returns before the old job is gone; one retry covers it
			await Bun.sleep(1000);
			r = run(["launchctl", "bootstrap", target, unit]);
		}
		if (!r.ok) fail(`launchd would not load ${unit}: ${r.out || "no reason given"}. check it with plutil -lint, or look in ${join(logDir, "serve.log")}`);
	} else {
		writeFileSync(unit, renderSystemd(spec));
		const name = `${systemdName(spec.label)}.service`;
		const reload = run(["systemctl", "--user", "daemon-reload"]);
		if (reload.missing) fail("systemctl was not found, so there is no systemd user manager to install a service into");
		if (!reload.ok) fail(`systemctl --user daemon-reload failed: ${reload.out}. is there a user session bus? on a server, run loginctl enable-linger $USER once`);
		const r = run(["systemctl", "--user", "enable", "--now", name]);
		if (!r.ok) fail(`systemd would not start ${name}: ${r.out}. journalctl --user -u ${name} has the rest`);
		// enable --now leaves an already running unit on its old definition
		run(["systemctl", "--user", "restart", name]);
	}

	// the daemon answers within a few seconds or the unit is wrong
	const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
	let health: { version?: string; pid?: number } | undefined;
	for (let i = 0; i < 40 && !health; i++) {
		await Bun.sleep(250);
		const res = await fetch(`http://${host}:${port}/global/health`, { headers: authHeaders(), signal: AbortSignal.timeout(1000) }).catch(() => undefined);
		if (res?.ok) health = (await res.json()) as typeof health;
		// a daemon behind a password or paired credentials still answers, just not to us
		else if (res?.status === 401) health = {};
	}
	console.log(`installed ${unit}`);
	console.log(`binary     ${binary}`);
	for (const line of linkNotes(linked, binary)) console.log(line);
	console.log(`logs       ${join(logDir, "serve.log")}`);
	if (Object.keys(fromShell).length) console.log(`keys       ${Object.keys(fromShell).join(", ")} from this shell, kept in ${envFile} (mode 600)`);
	else if (!Object.keys(keys).length) console.log(`keys       none in this shell; the daemon sees only what cmx2.jsonc names (a literal, $NAME from ${envFile}, or !command)`);
	if (health) console.log(`running    http://${host}:${port}${health.version ? `, cmx2 ${health.version}, pid ${health.pid}` : " (it asks for credentials)"}`);
	else fail(`the unit is loaded but nothing answered on ${host}:${port} after 10 s. read ${join(logDir, "serve.log")}; a port already taken is the usual cause`);
	if (hostname === "0.0.0.0") console.log("it listens on every interface. keep that to a private network, and pair clients with cmx2 pair");
	if (process.platform === "linux" && !/Linger=yes/.test(run(["loginctl", "show-user", process.env.USER || String(uid()), "--property=Linger"]).out)) {
		console.log("to keep it running when you are logged out and after a reboot: loginctl enable-linger $USER");
	}
}

export async function uninstall() {
	const s = serviceState();
	if (!s.installed && !s.loaded) {
		console.log(`no service installed (${s.unit} is not there)`);
		return;
	}
	if (process.platform === "darwin") {
		if (s.loaded) {
			const r = run(["launchctl", "bootout", `gui/${uid()}/${s.label}`]);
			if (!r.ok && serviceState().loaded) fail(`launchd would not unload ${s.label}: ${r.out}`);
			// bootout returns before launchd lets go of the label; wait so a status right after tells the truth
			for (let i = 0; i < 50 && serviceState().loaded; i++) await Bun.sleep(100);
		}
	} else {
		run(["systemctl", "--user", "disable", "--now", `${systemdName(s.label)}.service`]);
	}
	rmSync(s.unit, { force: true });
	if (process.platform === "linux") run(["systemctl", "--user", "daemon-reload"]);
	console.log(`stopped and removed ${s.unit}. the binary in ${dirname(installedBinary())}, your sessions and your data stay`);
}

export async function status() {
	const s = serviceState();
	if (!s.installed) {
		console.log(`not installed. cmx2 serve --install sets it up (${s.unit})`);
		if (s.loaded) console.log(`but ${s.label} is still loaded; cmx2 serve --uninstall clears it`);
		process.exitCode = 1;
		return;
	}
	console.log(`unit       ${s.unit}`);
	console.log(`binary     ${s.binary ?? "unknown"}`);
	console.log(`listens    ${s.hostname ?? "?"}:${s.port ?? "?"}`);
	console.log(`state      ${s.running ? `running, pid ${s.pid}` : s.loaded ? "loaded, not running" : "not loaded"}`);
	if (s.port) {
		const host = s.hostname === "0.0.0.0" || !s.hostname ? "127.0.0.1" : s.hostname;
		const res = await fetch(`http://${host}:${s.port}/global/health`, { headers: authHeaders(), signal: AbortSignal.timeout(1500) }).catch(() => undefined);
		const h = res?.ok ? ((await res.json()) as { version: string; pid: number }) : undefined;
		console.log(`answers    ${h ? `yes, cmx2 ${h.version}, pid ${h.pid}` : "no"}`);
		if (!h) process.exitCode = 1;
	}
}
