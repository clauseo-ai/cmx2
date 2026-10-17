import { existsSync, mkdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { connect as tcp } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Config, ConfigError, configDir, dataDir, loadConfig } from "@cmx2/engine/config";
import { VERSION } from "@cmx2/server";
import { authHeaders } from "../daemon.ts";
import { redact } from "../redact.ts";
import { compiled, installedBinary } from "../release.ts";
import { serviceState } from "../service.ts";
import { ADHOC_NOTE, certificateKind, signatureOf } from "../signing.ts";

export const help = `cmx2 doctor: what is wrong on this machine, in plain words

usage:
  cmx2 doctor [--redact] [--offline] [--json] [--port n]

it checks the profile parses, each provider has a key, the default model answers a one-token request,
the daemon answers and sits inside its memory budget, nothing else holds its port, the service unit is
installed and runs the copied binary, and the data dir is writable with room left. every problem comes
with the fix. it exits 1 when something is wrong.

  --redact    mask hostnames, urls, ip addresses, your user name and home, and anything key-shaped, so
              the report can be pasted in public. keys are never printed, with or without it
  --offline   skip the model request
  --json      the checks as json
  --port n    check a daemon on another port than the profile's`;

type Level = "ok" | "note" | "warn" | "fail";
interface Check {
	level: Level;
	what: string;
	detail: string;
	fix?: string;
}

/** the idle budget from GOALS.md; a busy daemon runs above it for a while */
const IDLE_BUDGET_MB = 150;

/** where a provider's key comes from, never the key itself */
function keySource(config: Config, provider: string): string {
	const v = config.providers[provider]?.apiKey;
	if (v?.startsWith("$")) return `$${v.slice(1).replace(/^\{|\}$/g, "")}`;
	if (v?.startsWith("!")) return "the command in providers." + provider + ".apiKey";
	if (v) return `providers.${provider}.apiKey in the profile`;
	return provider === "anthropic" ? "$ANTHROPIC_API_KEY" : provider === "google" ? "$GEMINI_API_KEY" : "nowhere";
}

function portTaken(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = tcp({ host, port });
		const done = (v: boolean) => {
			s.destroy();
			resolve(v);
		};
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
		s.setTimeout(1000, () => done(false));
	});
}

async function probe(config: Config): Promise<Check> {
	const { resolveModel, resolveApiKey, streamFn } = await import("@cmx2/engine/models");
	const slash = config.model.indexOf("/");
	const provider = config.model.slice(0, slash);
	const t0 = performance.now();
	try {
		const model = await resolveModel(config, config.model);
		const apiKey = resolveApiKey(config, provider);
		const context = { messages: [{ role: "user", content: "say ok", timestamp: Date.now() }] } as never;
		const stream = await streamFn(model, context, { apiKey, maxTokens: 16, signal: AbortSignal.timeout(30_000) });
		const m = await stream.result();
		const ms = Math.round(performance.now() - t0);
		if (m.stopReason === "error" || m.stopReason === "aborted") {
			const why = (m.errorMessage ?? "no reason given").slice(0, 240);
			const auth = /401|403|auth|api key|credential/i.test(why);
			return { level: "fail", what: `model ${config.model}`, detail: `a one-token request failed after ${ms} ms: ${why}`, fix: auth ? `check the key for ${provider} (${keySource(config, provider)})` : `check providers.${provider}.baseUrl, or pick another model in cmx2.jsonc` };
		}
		return { level: "ok", what: `model ${config.model}`, detail: `answered a one-token request in ${ms} ms` };
	} catch (e) {
		return { level: "fail", what: `model ${config.model}`, detail: (e instanceof Error ? e.message : String(e)).slice(0, 240), fix: `set the key (${keySource(config, provider)}) or fix model in cmx2.jsonc` };
	}
}

/** which provider the web tools use and where its key comes from, never the key */
async function webCheck(config: Config): Promise<Check> {
	const { pickSearch, SEARCH_ENV_KEYS } = await import("@cmx2/tools/web");
	const w = config.web;
	const extras = [w.fetch === "provider" ? "webfetch through tavily extract" : "", w.crawl ? "webcrawl on" : ""].filter(Boolean).join(", ");
	const tail = extras ? `; ${extras}` : "";
	if (w.provider === "auto") {
		const { provider, key } = pickSearch();
		if (!key) return { level: "ok", what: "web", detail: "search through tavily's free keyless mode (rate limited), keyless exa when that fails", fix: "for higher limits, a free tavily key (1,000 credits a month) from https://app.tavily.com: export TAVILY_API_KEY" };
		return { level: "ok", what: "web", detail: `search through ${provider}, key from $${SEARCH_ENV_KEYS[provider]}` };
	}
	const envName = SEARCH_ENV_KEYS[w.provider];
	const src = w.apiKey?.startsWith("$") ? w.apiKey : w.apiKey?.startsWith("!") ? "the command in web.apiKey" : w.apiKey ? "web.apiKey in the profile" : envName ? `$${envName}` : undefined;
	const { resolveSecret } = await import("@cmx2/engine/models");
	const has = !!(resolveSecret(w.apiKey) || (envName && process.env[envName]));
	if (w.provider === "searxng") return { level: "ok", what: "web", detail: `search through searxng at ${w.url}${has ? ", with a key" : ""}` };
	if (has) return { level: "ok", what: "web", detail: `${w.provider}, key from ${src}${tail}` };
	if (w.provider === "tavily" && w.crawl) return { level: "warn", what: "web", detail: `tavily without a key (looked at ${src}): search and extract run keyless, but webcrawl fails`, fix: "a free key from https://app.tavily.com: export TAVILY_API_KEY or set web.apiKey" };
	if (w.provider === "tavily" || w.provider === "exa") return { level: "ok", what: "web", detail: `${w.provider} without a key: its free keyless mode, rate limited${tail}`, fix: `export ${envName} or set web.apiKey for higher limits` };
	return { level: "warn", what: "web", detail: `${w.provider} has no key (looked at ${src}), so every search fails`, fix: `export ${envName} or set web.apiKey to a $NAME, a !command or a literal` };
}

export async function main(args: string[]) {
	const { values } = parseArgs({ args, options: { redact: { type: "boolean" }, offline: { type: "boolean" }, json: { type: "boolean" }, port: { type: "string" } } });
	const checks: Check[] = [];
	const add = (c: Check) => checks.push(c);

	add({ level: "note", what: "cmx2", detail: `${VERSION} on ${process.platform}-${process.arch}, ${compiled() ? `binary ${process.execPath}` : `source under bun ${Bun.version}`}` });
	if (compiled() && process.execPath.startsWith(join(homedir(), "Documents"))) {
		add({ level: "warn", what: "binary location", detail: "this binary sits under ~/Documents; launchd stalls for minutes on a privacy prompt when it starts binaries from there", fix: "cmx2 serve --install runs a copy from ~/.local/share/cmx2/bin, so install the service instead of pointing a unit at this file" });
	}
	// the copy the service runs is the one macos keeps grants for
	const signedPath = existsSync(installedBinary()) ? installedBinary() : compiled() ? process.execPath : undefined;
	const sig = signedPath ? signatureOf(signedPath) : undefined;
	if (sig?.adhoc) add({ level: "warn", what: "signature", detail: `${signedPath} is signed ad hoc. ${ADHOC_NOTE}`, fix: "cmx2 serve --install from this build signs the installed copy with a keychain identity (security find-identity -v -p codesigning lists them; make one first if it lists none)" });
	else if (sig?.authority) add({ level: "ok", what: "signature", detail: `${signedPath} is signed with a ${certificateKind(sig.authority)} certificate, so macos keeps its folder grants across upgrades` });

	// the profile
	let config: Config | undefined;
	try {
		config = loadConfig();
		add({ level: "ok", what: "profile", detail: config.sources.length ? `read ${config.sources.join(", ")}` : `no profile in ${configDir()}; running on the shipped defaults (anthropic direct, ${loadConfig().model})` });
	} catch (e) {
		add({ level: "fail", what: "profile", detail: e instanceof ConfigError ? e.message : String(e), fix: "fix the file it names, or move it aside to run on the defaults" });
	}

	if (config) {
		// keys: the default model's provider and every configured one
		const { resolveApiKey } = await import("@cmx2/engine/models");
		const main = config.model.slice(0, config.model.indexOf("/"));
		for (const p of [...new Set([main, ...Object.keys(config.providers)])]) {
			const has = !!resolveApiKey(config, p);
			const src = keySource(config, p);
			if (has) add({ level: "ok", what: `key for ${p}`, detail: `found (${src})` });
			else add({ level: p === main ? "fail" : "warn", what: `key for ${p}`, detail: `no key (looked at ${src})`, fix: p === "anthropic" ? "export ANTHROPIC_API_KEY=... in your shell (and run cmx2 serve --install again so the service gets it), or set providers.anthropic.apiKey to $NAME or !command" : `set providers.${p}.apiKey to a $NAME, a !command (a keychain lookup) or a literal` });
		}
		if (!values.offline) add(await probe(config));
		add(await webCheck(config));
	}

	// the daemon
	const port = values.port ? Number(values.port) : (config?.server.port ?? 4097);
	const host = !config || config.server.hostname === "0.0.0.0" ? "127.0.0.1" : config.server.hostname;
	const base = `http://${host}:${port}`;
	const headers = authHeaders();
	let timedOut = false;
	const health = await fetch(`${base}/global/health`, { headers, signal: AbortSignal.timeout(2000) }).catch((e: unknown) => {
		timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
		return undefined;
	});
	if (health?.status === 401) {
		add({ level: "warn", what: "daemon", detail: `something on ${base} wants credentials this shell does not have`, fix: "set CMX2_SERVER_PASSWORD, or run cmx2 pair on this machine once so local commands get a credential" });
	} else if (health?.ok) {
		const h = (await health.json().catch(() => ({}))) as { name?: string; version?: string; pid?: number; contract?: number };
		if (h.name !== "cmx2") {
			add({ level: "fail", what: "daemon", detail: `${base} answers, but it is not cmx2`, fix: `stop what holds port ${port}, or set server.port in cmx2.jsonc` });
		} else {
			add({ level: h.version === VERSION ? "ok" : "warn", what: "daemon", detail: `cmx2 ${h.version} answers on ${base} (pid ${h.pid}, contract ${h.contract})`, ...(h.version === VERSION ? {} : { fix: `it runs another version than this cli (${VERSION}); restart it, or cmx2 upgrade` }) });
			const mem = await fetch(`${base}/global/memory`, { headers, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
			if (mem?.ok) {
				const m = (await mem.json()) as { rss: number; live_sessions: number; uptime_s: number };
				const mb = m.rss / 1048576;
				add({ level: mb <= IDLE_BUDGET_MB ? "ok" : "warn", what: "daemon memory", detail: `${mb.toFixed(1)} MB resident, ${m.live_sessions} live sessions, up ${m.uptime_s} s (idle budget ${IDLE_BUDGET_MB} MB)`, ...(mb <= IDLE_BUDGET_MB ? {} : { fix: "a busy daemon runs above the budget for a while; if it stays there idle, report it with this output" }) });
			}
		}
	} else if (timedOut) {
		add({ level: "fail", what: "daemon", detail: `${base} did not answer /global/health within 2 s`, fix: `lsof -iTCP:${port} -sTCP:LISTEN names the process; if it is cmx2 its main thread is busy or the machine is swapping (sample <pid> 3 shows where), and the log is ~/.local/share/cmx2/log/serve.log` });
	} else if (await portTaken(host, port)) {
		add({ level: "fail", what: "daemon", detail: `something that is not cmx2 holds port ${port} on ${host}`, fix: `stop it, or pick another port with server.port in cmx2.jsonc (lsof -iTCP:${port} -sTCP:LISTEN names it)` });
	} else {
		add({ level: "note", what: "daemon", detail: `nothing listens on ${base}`, fix: "cmx2 serve runs one in a terminal; cmx2 serve --install runs one as a service. plain cmx2 starts its own when none is up" });
	}

	// the service
	const s = serviceState();
	if (!s.installed) {
		add({ level: "note", what: "service", detail: `not installed (${s.unit})`, fix: "cmx2 serve --install, on a machine that should serve all the time" });
	} else {
		const problems: string[] = [];
		if (!s.running) problems.push(s.loaded ? "loaded but not running" : "installed but not loaded");
		if (s.binary && !existsSync(s.binary)) problems.push(`its binary ${s.binary} is gone`);
		if (s.binary?.startsWith(join(homedir(), "Documents"))) problems.push("it runs a binary under ~/Documents, which stalls launchd on a privacy prompt");
		else if (s.binary && s.binary !== installedBinary()) problems.push(`it runs ${s.binary}, not the copy in ${installedBinary()}`);
		if (config && s.port && s.port !== config.server.port && !values.port) problems.push(`it listens on ${s.port}, the profile says ${config.server.port}`);
		add({
			level: problems.length ? (s.running ? "warn" : "fail") : "ok",
			what: "service",
			detail: `${s.unit}${s.running ? `, running (pid ${s.pid})` : ""}${problems.length ? `; ${problems.join("; ")}` : ", runs the copied binary"}`,
			...(problems.length ? { fix: "cmx2 serve --install again rewrites the unit and copies the binary; the log is ~/.local/share/cmx2/log/serve.log" } : {}),
		});
	}

	// grep, glob and the web client's file search run ripgrep; without it they fail at the first call
	const rg = Bun.which("rg");
	if (rg) add({ level: "ok", what: "ripgrep", detail: `found at ${rg}` });
	else add({ level: "warn", what: "ripgrep", detail: "rg is not on PATH, so the grep and glob tools and file search fail", fix: process.platform === "darwin" ? "brew install ripgrep" : "install ripgrep (apt install ripgrep, dnf install ripgrep); a service needs it on the PATH it was installed with" });

	// the data dir
	const data = dataDir();
	try {
		mkdirSync(data, { recursive: true });
		const probeFile = join(data, `.doctor-${process.pid}`);
		writeFileSync(probeFile, "ok");
		rmSync(probeFile);
		const db = join(data, "cmx2.db");
		const size = existsSync(db) ? `, cmx2.db ${(statSync(db).size / 1048576).toFixed(1)} MB` : ", no cmx2.db yet";
		const fs = statfsSync(data);
		const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
		add({ level: freeGb < 2 ? "warn" : "ok", what: "data dir", detail: `${data} is writable${size}, ${freeGb.toFixed(1)} GB free`, ...(freeGb < 2 ? { fix: "free some disk; worktrees and tool output need room, and sqlite fails writes on a full disk" } : {}) });
	} catch (e) {
		add({ level: "fail", what: "data dir", detail: `${data} is not writable: ${e instanceof Error ? e.message : String(e)}`, fix: "fix its permissions, or point CMX2_DATA_DIR somewhere writable" });
	}

	const clean = (s: string) => (values.redact ? redact(s) : s);
	const failed = checks.some((c) => c.level === "fail");
	if (values.json) {
		console.log(clean(JSON.stringify({ version: VERSION, ok: !failed, checks }, null, 2)));
	} else {
		const w = Math.max(...checks.map((c) => c.what.length));
		for (const c of checks) {
			console.log(clean(`${c.level.padEnd(4)}  ${c.what.padEnd(w)}  ${c.detail}`));
			if (c.fix && c.level !== "ok") console.log(clean(`${" ".repeat(6 + w + 2)}fix: ${c.fix}`));
		}
		const warns = checks.filter((c) => c.level === "warn").length;
		console.log(failed ? `\n${checks.filter((c) => c.level === "fail").length} problem(s) to fix above.` : warns ? `\nnothing broken; ${warns} thing(s) worth a look.` : "\nall good.");
		if (values.redact) console.log("(redacted: hosts, urls, ip addresses, user and home masked)");
	}
	if (failed) process.exitCode = 1;
}
