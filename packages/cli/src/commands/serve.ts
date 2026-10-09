import { parseArgs } from "node:util";
import { loadConfig } from "@cmx2/engine/config";
import { serve, VERSION } from "@cmx2/server";
import { fail } from "../util.ts";

export const help = `cmx2 serve: run the daemon that hosts your sessions

usage:
  cmx2 serve [--port n] [--hostname addr]
                                  run it in this terminal (default 127.0.0.1:4097, or server in your
                                  profile). ctrl-c stops it and every process its sessions started
  cmx2 serve --install [--port n] [--hostname addr]
                                  copy this binary to ~/.local/share/cmx2/bin, link it as cmx2 in
                                  ~/.local/bin (or $CMX2_INSTALL_DIR; it says when that is not on PATH)
                                  and run it as a service that starts at login and comes back if it
                                  dies: a launchd agent on macos, a systemd user unit on linux. run it
                                  again to update the unit
  cmx2 serve --uninstall          stop the service and remove its unit (sessions and data stay)
  cmx2 serve --status             whether the service is installed and running

binding: keep 127.0.0.1 on any machine with a public interface. use 0.0.0.0 only on a private network
(a tailnet), and pair clients with cmx2 pair so every request carries a credential.
set CMX2_SERVER_PASSWORD to require basic auth (user cmx2) as well.`;

export async function main(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string" },
			hostname: { type: "string" },
			"log-level": { type: "string" },
			install: { type: "boolean" },
			uninstall: { type: "boolean" },
			status: { type: "boolean" },
		},
	});
	if (values.install || values.uninstall || values.status) {
		const service = await import("../service.ts");
		if (values.install) return service.install({ port: values.port, hostname: values.hostname });
		if (values.uninstall) return service.uninstall();
		return service.status();
	}
	const config = loadConfig();
	const port = values.port ? Number(values.port) : config.server.port;
	if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, got ${values.port}`);
	const hostname = values.hostname ?? config.server.hostname;
	// read once, then out of this process's environment: every shell, job, terminal, mcp server and
	// language server the daemon starts inherits it, and a model's `env` would print it into a transcript
	const password = process.env.CMX2_SERVER_PASSWORD || undefined;
	delete process.env.CMX2_SERVER_PASSWORD;
	const { server, stop } = serve({
		config,
		port,
		hostname,
		password,
		watchConfig: true,
		checkEvents: process.env.CMX2_CHECK_EVENTS === "1",
		onRestart: () => {
			console.log("cmx2: restart requested; exiting for the supervisor to start a fresh daemon");
			process.exit(0);
		},
	});
	console.log(`cmx2 ${VERSION} listening on http://${server.hostname}:${server.port} (pid ${process.pid})`);
	const shutdown = async () => {
		await stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
