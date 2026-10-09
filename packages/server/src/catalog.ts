import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "@cmx2/engine/config";
import { type ListedModel, listedProviders, listModels } from "@cmx2/engine/models";

/**
 * what the pickers list: agent types and `/` commands from markdown files in the profile and the
 * project, and the models this daemon can run. read from disk on demand and cached until
 * `/global/reload` flushes them, so editing a file shows up after a reload without a restart.
 */

export interface MarkdownDef {
	name: string;
	description?: string;
	/** `provider/model-id` */
	model?: string;
	agent?: string;
	mode?: "primary" | "subagent" | "all";
	hidden?: boolean;
	body: string;
	path: string;
	scope: "profile" | "project";
}

/** frontmatter between `---` lines: `key: value` pairs, values unquoted; enough for these files */
export function frontmatter(raw: string): { data: Record<string, string>; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { data: {}, body: raw };
	const data: Record<string, string> = {};
	for (const line of (m[1] ?? "").split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (kv) data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
	}
	return { data, body: (m[2] ?? "").trim() };
}

function readDefs(dir: string, scope: MarkdownDef["scope"]): MarkdownDef[] {
	if (!existsSync(dir)) return [];
	const out: MarkdownDef[] = [];
	for (const f of readdirSync(dir).sort()) {
		if (!f.endsWith(".md")) continue;
		const path = join(dir, f);
		const { data, body } = frontmatter(readFileSync(path, "utf8"));
		const mode = data.mode === "primary" || data.mode === "subagent" || data.mode === "all" ? data.mode : undefined;
		out.push({
			name: data.name || basename(f, ".md"),
			...(data.description ? { description: data.description } : {}),
			...(data.model ? { model: data.model } : {}),
			...(data.agent ? { agent: data.agent } : {}),
			...(mode ? { mode } : {}),
			...(data.hidden === "true" ? { hidden: true } : {}),
			body,
			path,
			scope,
		});
	}
	return out;
}

/** the agent every session runs as unless the user picks another */
export const BUILD_AGENT: MarkdownDef = {
	name: "build",
	description: "the default agent: reads, edits and runs commands in the session's directory",
	mode: "primary",
	body: "",
	path: "(built in)",
	scope: "profile",
};

/**
 * commands every project has; a file of the same name in the profile or the project replaces one.
 * `/init` hands the model the job of writing the project's AGENTS.md and leaves how to the model.
 */
export const BUILTIN_COMMANDS: MarkdownDef[] = [
	{
		name: "init",
		description: "write an AGENTS.md for this project, for the agents that work here after you",
		body: [
			"write an AGENTS.md at the root of this project for the coding agents that will work in it.",
			"read enough of the repository to get it right: how to install, build, test and run it, how the code is laid out, the conventions it already follows, and anything that would surprise a newcomer.",
			"keep it short and specific to this project; leave out what any competent engineer does anyway.",
			"if the project already has an AGENTS.md, say so and leave it as it is.",
			"$ARGUMENTS",
		].join("\n"),
		path: "(built in)",
		scope: "profile",
	},
];

export class Catalog {
	private agents = new Map<string, MarkdownDef[]>();
	private commands = new Map<string, MarkdownDef[]>();
	/** by what decides the list (the provider set and the profile's own models), since a project layer can change either */
	private models = new Map<string, Promise<ListedModel[]>>();

	constructor(private readonly profileDir: () => string) {}

	/** project definitions override profile ones by name */
	private merged(kind: "agent" | "command", cwd: string): MarkdownDef[] {
		const byName = new Map<string, MarkdownDef>();
		for (const d of readDefs(join(this.profileDir(), kind), "profile")) byName.set(d.name, d);
		for (const d of readDefs(join(cwd, ".cmx2", kind), "project")) byName.set(d.name, d);
		return [...byName.values()];
	}

	agentsFor(cwd: string): MarkdownDef[] {
		let a = this.agents.get(cwd);
		if (!a) {
			const defs = this.merged("agent", cwd).filter((d) => d.name !== BUILD_AGENT.name);
			a = [BUILD_AGENT, ...defs.sort((x, y) => x.name.localeCompare(y.name))];
			this.agents.set(cwd, a);
		}
		return a;
	}

	agent(cwd: string, name: string): MarkdownDef | undefined {
		return this.agentsFor(cwd).find((a) => a.name === name);
	}

	commandsFor(cwd: string): MarkdownDef[] {
		let c = this.commands.get(cwd);
		if (!c) {
			const files = this.merged("command", cwd);
			const taken = new Set(files.map((d) => d.name));
			c = [...BUILTIN_COMMANDS.filter((d) => !taken.has(d.name)), ...files].sort((x, y) => x.name.localeCompare(y.name));
			this.commands.set(cwd, c);
		}
		return c;
	}

	modelsFor(config: Config): Promise<ListedModel[]> {
		const key = JSON.stringify([listedProviders(config), Object.entries(config.providers).map(([id, o]) => [id, o.models])]);
		let m = this.models.get(key);
		if (!m) this.models.set(key, (m = listModels(config)));
		return m;
	}

	/** `/global/reload`: the next read goes back to disk */
	flush() {
		this.agents.clear();
		this.commands.clear();
		this.models.clear();
	}
}

/** cmx's `$1 … $n` and `$ARGUMENTS`: the highest numbered placeholder takes the rest; no placeholder appends */
export function expandTemplate(template: string, args: string): string {
	const words = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
	const numbers = [...template.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
	const top = numbers.length ? Math.max(...numbers) : 0;
	let out = template.replace(/\$(\d+)/g, (_, n) => {
		const i = Number(n);
		return i === top ? words.slice(i - 1).join(" ") : (words[i - 1] ?? "");
	});
	const usesArgs = out.includes("$ARGUMENTS");
	out = out.replaceAll("$ARGUMENTS", args);
	if (!top && !usesArgs && args.trim()) out = `${out}\n\n${args}`;
	return out;
}

/**
 * `/config/providers` in cmx's shape; boxbox reads models' id, name, limit, status and variant keys. the
 * variants are the model's efforts the daemon would run (`allowed`, routing.jsonc's never list: a rung it
 * refuses is not offered), then the profile's named variants for it (`{ effort }` each)
 */
export function providersJson(
	models: ListedModel[],
	config: Config,
	named: (ref: string) => Record<string, { effort?: string }> = () => ({}),
	allowed: (ref: string, effort: string) => boolean = () => true,
) {
	const byProvider = new Map<string, ListedModel[]>();
	for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	const slash = config.model.indexOf("/");
	const defaults: Record<string, string> = {};
	const providers = [...byProvider.entries()].map(([id, list]) => {
		defaults[id] = id === config.model.slice(0, slash) ? config.model.slice(slash + 1) : list[0]!.id;
		return {
			id,
			name: id,
			source: id in config.providers ? "config" : "env",
			env: [],
			options: {},
			models: Object.fromEntries(
				list.map((m) => [
					m.id,
					{
						id: m.id,
						providerID: id,
						name: m.name,
						status: "active",
						capabilities: {
							reasoning: m.reasoning,
							attachment: m.images,
							toolcall: true,
							temperature: false,
							input: { text: true, image: m.images, audio: false, video: false, pdf: false },
							output: { text: true, image: false, audio: false, video: false, pdf: false },
						},
						cost: {
							input: m.cost.input,
							output: m.cost.output,
							cache: { read: m.cost.cacheRead, write: m.cost.cacheWrite },
							// a model with a long-context rate (haiku 5.5 from 100k tokens) says so: the rates apply to the whole request once its input passes the threshold
							...(m.cost.tiers?.length ? { tiers: m.cost.tiers.map((t) => ({ inputTokensAbove: t.inputTokensAbove, input: t.input, output: t.output, cache: { read: t.cacheRead, write: t.cacheWrite } })) } : {}),
						},
						limit: { context: m.contextWindow, output: m.maxTokens },
						options: {},
						headers: {},
						variants: { ...Object.fromEntries(m.efforts.filter((e) => allowed(`${id}/${m.id}`, e)).map((e) => [e, {}])), ...Object.fromEntries(Object.entries(named(`${id}/${m.id}`)).filter(([, v]) => !v.effort || allowed(`${id}/${m.id}`, v.effort))) },
					},
				]),
			),
		};
	});
	return { providers, default: defaults };
}
