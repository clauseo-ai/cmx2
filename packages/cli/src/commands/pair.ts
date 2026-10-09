import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { dataDir, loadConfig } from "@cmx2/engine/config";
import { PAIR_TOKEN_MS, Pairing } from "@cmx2/server/pair";
import { alive, daemonUrl } from "../daemon.ts";
import { fail } from "../util.ts";

export const help = `cmx2 pair: let a client like boxbox talk to this host

usage:
  cmx2 pair [--name n] [--url u]  print this host's url and a one-time token. the client trades the token
                                  at POST /pair for its own credential and keeps it; the token works once,
                                  for 10 minutes. --name labels the client in --list; --url says how the
                                  client reaches this host when the profile's address is not it
  cmx2 pair --list                the clients paired with this host
  cmx2 pair --revoke <id|name|all>
                                  cut a client off; its next request gets 401. this machine's own cli
                                  keeps working

once one client is paired, every request to the daemon needs a credential. the cli and the tui on this
machine use ~/.local/share/cmx2/auth/local.token, which the daemon writes with mode 0600.`;

export async function main(args: string[]) {
	const { values, positionals } = parseArgs({ args, options: { name: { type: "string" }, url: { type: "string" }, list: { type: "boolean" }, revoke: { type: "string" }, port: { type: "string" } }, allowPositionals: true });
	if (positionals.length) fail(`pair takes no words, got "${positionals.join(" ")}". see cmx2 pair --help`);
	const pairing = new Pairing(dataDir());
	pairing.ensureLocal();
	if (values.list) {
		const clients = pairing.clients();
		if (!clients.length) return console.log("no clients are paired with this host. cmx2 pair makes a token for one");
		const w = Math.max(...clients.map((c) => c.name.length));
		for (const c of clients) console.log(`${c.id}  ${c.name.padEnd(w)}  paired ${new Date(c.created_at).toLocaleString("sv-SE").slice(0, 16)}`);
		return;
	}
	if (values.revoke !== undefined) {
		if (!values.revoke) fail("revoke which? cmx2 pair --revoke <id|name|all>; cmx2 pair --list shows them");
		const gone = pairing.revoke(values.revoke);
		if (!gone.length) fail(`no paired client is called ${values.revoke}; cmx2 pair --list shows them`);
		for (const c of gone) console.log(`revoked ${c.id} (${c.name}); its next request gets 401`);
		if (!pairing.required()) console.log("no clients are paired now, so the daemon is back to taking requests without a credential (unless CMX2_SERVER_PASSWORD is set)");
		return;
	}
	const config = loadConfig();
	const port = values.port ?? String(config.server.port);
	const bound = config.server.hostname;
	// a daemon bound to every interface is reached by this machine's name; loopback only from here
	const host = bound === "0.0.0.0" || bound === "::" ? hostname().split(".")[0]!.toLowerCase() : bound;
	const url = values.url ?? `http://${host}:${port}`;
	const { token, expires_at } = pairing.begin(values.name);
	console.log(`url    ${url}`);
	console.log(`token  ${token}`);
	console.log(`\nthe token works once, until ${new Date(expires_at).toTimeString().slice(0, 5)} (${PAIR_TOKEN_MS / 60_000} minutes). paste both into the client (boxbox: machines, add host).`);
	console.log(`by hand: curl -s -X POST ${url}/pair -H 'content-type: application/json' -d '{"token":"${token}"}'`);
	if (bound === "127.0.0.1" || bound === "localhost") console.log(`\nthis daemon listens on ${bound} only, so a client on another machine cannot reach it. on a private network, serve with --hostname 0.0.0.0`);
	if (!(await alive(daemonUrl(port)))) console.log(`\nno daemon answers on port ${port} yet; the token keeps until it expires. start one with cmx2 serve, or cmx2 serve --install`);
}
