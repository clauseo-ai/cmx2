import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { clip, clipNote } from "./limits.ts";
import { text, type Tool, defineTool, type ToolEnv, type ToolResult } from "./types.ts";

/**
 * skills: a folder with a SKILL.md whose frontmatter names it and says what it is for, and whose body
 * is the instructions. each session's turn context lists their names and descriptions (`skillsContext`),
 * so the model can pick one up when a task matches; the skill tool loads the body. the list never enters
 * the prompt prefix. clients list them as commands.
 */

export interface SkillInfo {
	name: string;
	description: string;
	/** the SKILL.md file */
	path: string;
	/** the skill's folder, where its scripts and references live */
	dir: string;
	/** the skills dir it was found in */
	root: string;
	/**
	 * false when the frontmatter keeps it from the model (`disable-model-invocation: true`, or
	 * `autoinvoke: false` as opencode writes it): it is left out of the list the model sees, and the
	 * user's `/name` or a request by name still loads it
	 */
	invocable: boolean;
}

/**
 * where skills are looked up, first match wins on a name: the project's `.cmx2/skills`, the profile's
 * `skills`, then the shared `~/.agents/skills` and `~/.claude/skills` when they exist.
 */
export function defaultSkillDirs(cwd: string, configDir: string, home = homedir()): string[] {
	return [join(cwd, ".cmx2", "skills"), join(configDir, "skills"), join(home, ".agents", "skills"), join(home, ".claude", "skills")];
}

/** frontmatter as flat `key: value` pairs; `>` and `|` blocks fold their indented lines */
export function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { meta: {}, body: raw };
	const meta: Record<string, string> = {};
	const lines = m[1]!.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i]!.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2]!.trim();
		if (value === ">" || value === "|" || value === ">-" || value === "|-") {
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
			value = block.join(value.startsWith(">") ? " " : "\n");
		}
		meta[kv[1]!] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
	}
	return { meta, body: raw.slice(m[0].length) };
}

export function listSkills(dirs: string[]): SkillInfo[] {
	const seen = new Map<string, SkillInfo>();
	for (const root of dirs) {
		if (!existsSync(root)) continue;
		let names: string[];
		try {
			names = readdirSync(root).sort();
		} catch {
			continue;
		}
		for (const entry of names) {
			const path = join(root, entry, "SKILL.md");
			try {
				if (!statSync(path).isFile()) continue;
			} catch {
				continue;
			}
			const { meta } = frontmatter(readFileSync(path, "utf8"));
			const name = meta.name || entry;
			if (seen.has(name)) continue;
			const invocable = meta["disable-model-invocation"]?.toLowerCase() !== "true" && meta.autoinvoke?.toLowerCase() !== "false";
			seen.set(name, { name, description: meta.description ?? "", path, dir: dirname(path), root, invocable });
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** the skills of one working directory, read once and kept until `flush` (config reload) */
export class Skills {
	private cache: SkillInfo[] | undefined;

	constructor(private readonly dirs: string[] | (() => string[])) {}

	list(): SkillInfo[] {
		this.cache ??= listSkills(typeof this.dirs === "function" ? this.dirs() : this.dirs);
		return this.cache;
	}

	get(name: string): SkillInfo | undefined {
		return this.list().find((s) => s.name === name);
	}

	/** the instructions, frontmatter removed */
	body(skill: SkillInfo): string {
		return frontmatter(readFileSync(skill.path, "utf8")).body.trim();
	}

	flush() {
		this.cache = undefined;
	}
}

/** the longest description the list carries, the agent skills spec's own limit */
const DESCRIPTION_MAX = 1024;

/**
 * the turn-context block that lets the model pick a skill up by itself: every skill it may invoke that
 * has a description, as `- name: description`. undefined when there is none to list.
 */
export function skillsContext(all: SkillInfo[]): string | undefined {
	const lines = all
		.filter((s) => s.invocable && s.description.trim())
		.map((s) => {
			const d = s.description.replace(/\s+/g, " ").trim();
			return `- ${s.name}: ${d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX - 3)}...` : d}`;
		});
	if (!lines.length) return undefined;
	return ["skills: instructions written for a kind of task. when the task at hand matches a description below, load that skill with the skill tool before starting on it.", ...lines].join("\n");
}

export function skillTool(skills: Skills, env: ToolEnv): Tool {
	return defineTool({
		name: "skill",
		label: "skill",
		description:
			"load a skill: instructions someone wrote for a kind of task, with the folder its scripts and references live in. call it with a name to load that skill, or with no name to list what is installed and what each is for.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "the skill's name; leave it out to list them" })),
		}),
		async execute(_id, params): Promise<ToolResult<Record<string, unknown>>> {
			// the listing is the model's view: a skill kept from the model is loaded only by name
			const all = skills.list().filter((s) => s.invocable);
			const listing = all.map((s) => `${s.name}: ${s.description.replace(/\s+/g, " ").trim() || "(no description)"}`).join("\n");
			if (!params.name) {
				return { content: [text(all.length ? `installed skills:\n${listing}` : "no skills are installed")], details: { skills: all.map((s) => ({ name: s.name, description: s.description, dir: s.dir })) } };
			}
			const skill = skills.get(params.name);
			if (!skill) throw new Error(`no skill named ${params.name}. ${all.length ? `installed:\n${listing}` : "no skills are installed"}`);
			const c = clip(skills.body(skill), { keep: "head", spillDir: env.spillDir, label: "skill" });
			return {
				content: [text(`skill ${skill.name}, files in ${skill.dir}\n\n${c.text}${clipNote(c, "the first")}`)],
				details: { name: skill.name, description: skill.description, dir: skill.dir, path: skill.path, truncated: c.truncated },
			};
		},
	});
}
