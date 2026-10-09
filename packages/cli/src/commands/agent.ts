import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { configDir, machineName } from "@cmx2/engine/config";
import { type Effort, Routing } from "@cmx2/routing";
import { getJson } from "../api.ts";
import { connect } from "../daemon.ts";
import { fail } from "../util.ts";

export const help = `cmx2 agent: the agent types, the models helpers run on, and a session's agent tree

usage:
  cmx2 agent list [--json] [--port n]
                                  the agent types you can run a turn as in this directory: build (the
                                  default) plus markdown files in ~/.config/cmx2/agent/ and .cmx2/agent/
  cmx2 agent models [--json]      the routing table in force: each model a spawn can name with its
                                  default effort and note, the caps, where escalation stops for each
                                  model, the efforts the never list keeps a model off, the files in
                                  force and any warnings. (cmx2 agent seats prints the same for one
                                  more release; seats are gone)
  cmx2 agent tree <session> [--json] [--port n]
                                  the agents a session started: path, state, model label, effort, last report

the models, the guide and the rules live in ~/.config/cmx2/routing.jsonc (docs/routing.md); it reloads on every read.`;

interface Agent {
	name: string;
	description?: string;
	mode: string;
	native: boolean;
	hidden?: boolean;
	model?: { providerID: string; modelID: string };
}

interface Roster {
	root: string;
	self: string;
	agents: Array<{ id: string; path: string; depth: number; state: string; cause?: string; seat: string | null; model: string | null; effort: string | null; lastReport?: string; lastTask?: string; pending: number; tokens: number }>;
}

async function list(args: string[]) {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" }, port: { type: "string" } } });
	const d = await connect({ port: values.port }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
	try {
		const agents = await getJson<Agent[]>(d, "/agent", realpathSync(process.cwd()));
		if (values.json) return console.log(JSON.stringify(agents, null, 2));
		const w = Math.max(...agents.map((a) => a.name.length));
		for (const a of agents.filter((a) => !a.hidden)) {
			const model = a.model ? `  ${a.model.providerID}/${a.model.modelID}` : "";
			console.log(`${a.name.padEnd(w)}  ${a.mode.padEnd(8)}${model}  ${a.description ?? ""}`.trimEnd());
		}
	} finally {
		await d.stop?.();
	}
}

/** `xhigh for claude-opus-5-5 and claude-fable-5-1, high for claude-sonnet-5-5, max otherwise` */
function stops(ceiling: Effort | Record<string, Effort>): string {
	if (typeof ceiling === "string") return ceiling;
	const { default: rest, ...named } = ceiling;
	const byEffort = new Map<Effort, string[]>();
	for (const [model, e] of Object.entries(named)) byEffort.set(e, [...(byEffort.get(e) ?? []), model]);
	const parts = [...byEffort].map(([e, models]) => `${e} for ${models.join(" and ")}`);
	return parts.length ? `${parts.join(", ")}, ${rest} otherwise` : `${rest}`;
}

function models(args: string[], opts: { seats?: boolean } = {}) {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const routing = new Routing({ configDir, machine: machineName(), projectDir: realpathSync(process.cwd()) });
	const c = routing.current();
	const err = routing.lastError();
	const warnings = routing.warnings();
	if (values.json) return console.log(JSON.stringify({ ...c, files: routing.files().filter((f) => existsSync(f)), warnings, error: err?.message ?? null }, null, 2));
	if (opts.seats) console.log("seats are gone: models replace them, and cmx2 agent models is the command. this alias goes after the next release.\n");
	if (err) console.log(`routing: the last edit did not take (${err.message}); the table below is the last good one\n`);
	const entries = Object.entries(c.models);
	const w = Math.max(...entries.map(([alias]) => alias.length));
	const refW = Math.max(...entries.map(([, m]) => m.ref.length));
	console.log("models (a spawn names one):");
	for (const [alias, m] of entries) console.log(`  ${alias.padEnd(w)}  ${m.ref.padEnd(refW)}  ${m.effort.padEnd(6)}  ${m.note}`.trimEnd());
	console.log(`caps: ${c.caps.running_turns} running turns, depth ${c.caps.depth}, budget ${c.caps.budget_tokens === null ? "none" : `${c.caps.budget_tokens} tokens`}`);
	console.log(`escalation stops at ${stops(c.escalation.ceiling)}`);
	const never = Object.entries(c.never).filter(([, e]) => e.length);
	if (never.length) console.log(`never: ${never.map(([m, e]) => `${m} at ${e.join(", ")}`).join("; ")}`);
	const files = routing.files().filter((f) => existsSync(f) && Bun.file(f).size > 0);
	console.log(files.length ? `from ${files.join(", ")} on top of the shipped defaults` : "the shipped defaults (no routing.jsonc yet; see examples/routing.jsonc)");
	if (warnings.length) console.log(`warnings:\n${warnings.map((x) => `  ${x}`).join("\n")}`);
}

async function tree(args: string[]) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" }, port: { type: "string" } } });
	const id = positionals[0];
	if (!id) fail("which session? cmx2 agent tree <session>, with an id from cmx2 session list");
	const d = await connect({ port: values.port }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
	try {
		const r = await getJson<Roster>(d, `/session/${encodeURIComponent(id)}/agents`);
		if (values.json) return console.log(JSON.stringify(r, null, 2));
		if (!r.agents.length) return console.log(`${id} has not started any agents`);
		for (const a of r.agents) {
			const pad = "  ".repeat(a.depth);
			const what = [a.seat, a.model?.split("/").pop(), a.effort].filter(Boolean).join(" ");
			const report = (a.lastReport ?? a.lastTask ?? "").replace(/\s+/g, " ").slice(0, 80);
			console.log(`${pad}${a.path}  ${a.state}${a.cause ? ` (${a.cause})` : ""}${what ? `  ${what}` : ""}${a.pending ? `  ${a.pending} unread` : ""}${a.path === r.self ? "  <- this session" : ""}`);
			if (report) console.log(`${pad}  ${report}`);
		}
	} finally {
		await d.stop?.();
	}
}

export async function main(args: string[]) {
	const [sub, ...rest] = args;
	if (sub === "list" || sub === undefined) return list(rest);
	if (sub === "models") return models(rest);
	if (sub === "seats") return models(rest, { seats: true });
	if (sub === "tree") return tree(rest);
	fail(`agent ${sub} is not a command. try cmx2 agent list, models or tree <session>`);
}
