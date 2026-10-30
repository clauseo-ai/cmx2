import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, loadConfig } from "@cmx2/engine/config";
import { VERSION } from "@cmx2/server";
import { daemonUrl } from "../daemon.ts";
import { fail } from "../util.ts";

export const help = `cmx2 mcp: the mcp servers in your profile

usage:
  cmx2 mcp [--port n]             each server as the running daemon sees it: transport, status, tool
                                  count, and the error when one failed to connect
  cmx2 mcp auth <name>            sign in to a remote server that asks for it (oauth in your browser);
                                  the daemon picks the tokens up at once

servers live under mcp in ~/.config/cmx2/cmx2.jsonc: a command for a local server, a url for a remote
one. their tools show up in sessions as <server>_<tool>.`;

export async function main(args: string[]) {
	const { values, positionals } = parseArgs({ args, options: { port: { type: "string" } }, allowPositionals: true });
	const d = daemonUrl(values.port);
	if (positionals[0] === "auth") {
		const name = positionals[1];
		if (!name) fail("which server? cmx2 mcp auth <name>, with a name from mcp in cmx2.jsonc");
		const server = loadConfig().mcp[name];
		if (!server) fail(`there is no mcp server named ${name} in your profile`);
		if (typeof server.url !== "string") fail(`${name} is a local server; only remote servers sign in`);
		const { mcpSignIn } = await import("@cmx2/tools");
		try {
			const r = await mcpSignIn(name, server as never, dataDir(), {
				version: VERSION,
				onUrl: (url) => {
					console.log(`open this to sign in to ${name}:\n  ${url.href}`);
					Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url.href], { stdout: "ignore", stderr: "ignore" });
				},
			});
			console.log(r.already ? `${name} was already signed in; it offers ${r.tools} tools` : `signed in to ${name}; it offers ${r.tools} tools. tokens saved under ${join(dataDir(), "mcp-auth")}`);
		} catch (e) {
			fail(`${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
		const r = await fetch(`${d.base}/global/reload`, { method: "POST", headers: d.headers }).catch(() => undefined);
		console.log(r?.ok ? "the daemon reconnected its mcp servers" : `no daemon answered on ${d.base}; it signs in with these tokens when it starts`);
		return;
	}
	if (positionals.length) fail(`mcp ${positionals.join(" ")} is not a command. try cmx2 mcp or cmx2 mcp auth <name>`);
	const res = await fetch(`${d.base}/mcp`, { headers: d.headers }).catch(() => undefined);
	if (!res) fail(`no daemon answered on ${d.base}; start one with cmx2 serve, or pass --port`);
	if (!res.ok) fail(`the daemon answered ${res.status}${res.status === 401 ? "; set CMX2_SERVER_PASSWORD, or run cmx2 pair on this machine once" : ""}`);
	const list = (await res.json()) as Array<{ name: string; transport: string; status: string; tools: string[]; error?: string; server?: { name: string; version: string }; sessions?: string; caller?: boolean; instructions?: boolean }>;
	if (!list.length) return console.log("no mcp servers in your profile. add them under mcp in cmx2.jsonc");
	const w = Math.max(...list.map((m) => m.name.length));
	for (const m of list) {
		console.log(`${m.name.padEnd(w)}  ${m.transport.padEnd(5)}  ${m.status.padEnd(10)}  ${String(m.tools.length).padStart(3)} tools${m.server ? `  ${m.server.name} ${m.server.version}` : ""}${m.sessions === "root" ? "  top-level sessions only" : ""}${m.caller ? "  sends the caller" : ""}${m.instructions ? "  instructions in the turn context" : ""}${m.error ? `\n${" ".repeat(w + 2)}${m.error}` : ""}`);
	}
}
