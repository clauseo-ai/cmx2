#!/usr/bin/env bun
import { ConfigError } from "@cmx2/engine/config";
import { VERSION } from "@cmx2/server";
import { fail, wantsHelp } from "./util.ts";

// bun 1.3.14 bundles pi-ai's event stream as a lazily initialised module (pi-ai declares it free of side
// effects) and never runs its initialiser for the engine's static import, so a compiled binary's first turn
// threw "undefined is not a constructor". importing it dynamically runs the initialiser. GOTCHAS, the binary.
await import("@earendil-works/pi-ai/utils/event-stream");

interface Command {
	help: string;
	main: (args: string[]) => Promise<void>;
}

/** each command lives in its own module and loads only when it runs, so `cmx2 serve` carries no client code */
const COMMANDS: Record<string, { about: string; load: () => Promise<Command> }> = {
	tui: { about: "the terminal client in this directory (what plain cmx2 runs)", load: () => import("./commands/tui.ts") },
	run: { about: "one prompt, headless: prints the answer and exits", load: () => import("./commands/run.ts") },
	serve: { about: "run the daemon, or install it as a service (--install)", load: () => import("./commands/serve.ts") },
	pair: { about: "a url and one-time token for a client like boxbox; --revoke to cut one off", load: () => import("./commands/pair.ts") },
	doctor: { about: "what is wrong on this machine, in plain words; --redact to share it", load: () => import("./commands/doctor.ts") },
	upgrade: { about: "fetch the latest release and swap the installed binary", load: () => import("./commands/upgrade.ts") },
	session: { about: "list, show, export and import sessions", load: () => import("./commands/session.ts") },
	models: { about: "the models this machine can run", load: () => import("./commands/models.ts") },
	providers: { about: "the providers configured and whether they have a key", load: () => import("./commands/providers.ts") },
	agent: { about: "the agent types and the models helpers run on", load: () => import("./commands/agent.ts") },
	mcp: { about: "the mcp servers in your profile, and signing in to one", load: () => import("./commands/mcp.ts") },
	stats: { about: "what your sessions cost and how the steps went", load: () => import("./commands/stats.ts") },
	db: { about: "the session database: status and the cmx import", load: () => import("./commands/db.ts") },
};

const HELP = `cmx2 ${VERSION}: a coding agent that runs as a daemon you can reach from anywhere

usage: cmx2 [command] [options]

${Object.entries(COMMANDS)
	.map(([name, c]) => `  ${name.padEnd(10)} ${c.about}`)
	.join("\n")}

  cmx2 <command> --help           the details of one command
  cmx2 --version

with no command, cmx2 opens the terminal client in the current directory.
config lives in ~/.config/cmx2/cmx2.jsonc (or $CMX2_CONFIG_DIR) and reloads when it changes.
with no config, cmx2 talks to anthropic directly using ANTHROPIC_API_KEY.
data lives in ~/.local/share/cmx2 (or $CMX2_DATA_DIR).`;

async function main() {
	const [first, ...rest] = process.argv.slice(2);
	if (first === "--help" || first === "-h" || first === "help") {
		if (rest[0] && COMMANDS[rest[0]]) return console.log((await COMMANDS[rest[0]]!.load()).help);
		return console.log(HELP);
	}
	if (first === "--version" || first === "-v" || first === "version") return console.log(VERSION);
	// plain `cmx2` and `cmx2 --model x` open the tui
	const [name, args] = first === undefined || first.startsWith("-") ? ["tui", process.argv.slice(2)] : [first, rest];
	const cmd = COMMANDS[name];
	if (!cmd) fail(`unknown command "${name}". run cmx2 --help to see what exists.`);
	const mod = await cmd.load();
	if (wantsHelp(args)) return console.log(mod.help);
	await mod.main(args);
}

main().catch((e) => {
	if (e instanceof ConfigError) fail(e.message);
	if ((e as { code?: string }).code === "EADDRINUSE") fail("that port is taken. pick another with --port, or stop whatever holds it.");
	if ((e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (e as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") fail(`${(e as Error).message.split(". ")[0]!.toLowerCase()}. see cmx2 --help`);
	throw e;
});
