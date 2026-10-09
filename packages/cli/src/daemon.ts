import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig } from "@cmx2/engine/config";

/** where a client finds the daemon: its base url and the headers that get it past auth */
export interface Daemon {
	base: string;
	headers: Record<string, string>;
	/** set when this process started the daemon itself; call it before exiting */
	stop?: () => Promise<void>;
}

/** the credential `cmx2 pair` keeps for clients on this machine (the daemon writes it, mode 0600) */
export function localToken(): string | undefined {
	const path = join(dataDir(), "auth", "local.token");
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trim() || undefined;
}

/** CMX2_SERVER_PASSWORD wins (basic auth, user cmx2); otherwise this machine's paired credential */
export function authHeaders(): Record<string, string> {
	const pw = process.env.CMX2_SERVER_PASSWORD;
	if (pw) return { authorization: `Basic ${btoa(`cmx2:${pw}`)}` };
	const token = localToken();
	return token ? { authorization: `Bearer ${token}` } : {};
}

/** the running daemon on this machine, as the profile names it */
export function daemonUrl(port?: string | number): Daemon {
	const config = loadConfig();
	const host = config.server.hostname === "0.0.0.0" ? "127.0.0.1" : config.server.hostname;
	return { base: `http://${host}:${port ?? config.server.port}`, headers: authHeaders() };
}

/** true when something answering as cmx2 is at the url */
export async function alive(d: Daemon): Promise<boolean> {
	const r = await fetch(`${d.base}/global/health`, { headers: d.headers, signal: AbortSignal.timeout(1500) }).catch(() => undefined);
	if (!r?.ok) return false;
	const body = (await r.json().catch(() => ({}))) as { name?: string };
	return body.name === "cmx2";
}

/**
 * the daemon a client should talk to: the one already running on the profile's port, else one started
 * inside this process on a free loopback port that lives as long as the client does. `--port` picks
 * a specific running daemon and never starts one.
 */
export async function connect(opts: { port?: string } = {}): Promise<Daemon> {
	const d = daemonUrl(opts.port);
	if (await alive(d)) return d;
	if (opts.port) throw new Error(`no cmx2 daemon answered on ${d.base}; start one with cmx2 serve --port ${opts.port}`);
	const { serve } = await import("@cmx2/server");
	const config = loadConfig();
	const own = serve({ config, port: 0, hostname: "127.0.0.1", watchConfig: true });
	return { base: `http://127.0.0.1:${own.server.port}`, headers: authHeaders(), stop: own.stop };
}
