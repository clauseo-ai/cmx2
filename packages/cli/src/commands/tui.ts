import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect } from "../daemon.ts";

export const help = `cmx2 tui: the terminal client (plain cmx2 runs this)

usage:
  cmx2 [--session id] [--model provider/id] [--port n]

it talks to the daemon running on this machine, or starts one inside itself for as long as it runs
when none is up. --port picks a running daemon; --session reopens a session; --model picks the model
for a new one.

keys: enter sends (steers the running turn when one is busy), alt+enter queues behind it, esc stops the
turn, ctrl+p models, ctrl+o effort, ctrl+r agents, ctrl+t the agent tree, ctrl+c twice quits.
/ lists commands and skills, @ completes a file, ! runs a shell line. docs/tui.md has the rest,
the theme file included.`;

/**
 * the tui is its own entrypoint, loaded by a path the bundler does not follow, so pi-tui never enters
 * the daemon's import graph. a binary embeds it at tui/src/index.js (scripts/build.ts).
 */
function entry(): string {
	if (import.meta.url.includes("/$bunfs/")) return "file:///$bunfs/root/tui/src/index.js";
	return new URL("../../../tui/src/index.ts", import.meta.url).href;
}

export async function main(args: string[]) {
	const { values } = parseArgs({ args, options: { session: { type: "string" }, model: { type: "string" }, port: { type: "string" } } });
	const daemon = await connect({ port: values.port });
	const specifier = entry();
	const tui = (await import(specifier)) as { start: (o: { base: string; headers: Record<string, string>; directory: string; session?: string; model?: string }) => Promise<void> };
	try {
		await tui.start({ base: daemon.base, headers: daemon.headers, directory: realpathSync(process.cwd()), session: values.session, model: values.model });
	} finally {
		await daemon.stop?.();
	}
	process.exit(0);
}
