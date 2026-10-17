import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/**
 * routing.jsonc, version 2: a table of models and a short guide the delegating model reads. a spawn
 * names a model alias; this package maps alias to model and effort, holds the `never` list, the caps and
 * the escalation ceilings, and renders the table into the delegating session's appended turn context
 * (never the prefix). read hot: every `current()` stats the layer files and re-reads only when one
 * changed, so an edit changes the next spawn without a restart.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelEntry {
	/** provider/model-id */
	ref: string;
	/** the effort a spawn gets when it names none */
	effort: Effort;
	/** one line the model reads: what this model is for, what it costs */
	note: string;
}

export interface GuideRow {
	/** the kind of task, in the house voice */
	task: string;
	/** where to start, e.g. "haiku medium" */
	start: string;
	/** where to step up when the output falls short, e.g. "sonnet high, then opus medium"; omitted when there is no step */
	up?: string;
}

export interface RoutingConfig {
	/** alias → model; aliases are lowercase words a spawn names */
	models: Record<string, ModelEntry>;
	/** guidance rendered to the model: defaults, not limits */
	guide: GuideRow[];
	/** short rules rendered after the guide */
	rules: string[];
	/** model ref (`provider/id`) or bare model id → efforts it never runs at; nothing is off but what this lists */
	never: Record<string, Effort[]>;
	caps: {
		/** turns running at once in one session tree, the root included */
		running_turns: number;
		/** how deep children may nest below the root */
		depth: number;
		/** tokens one session tree may spend (cache reads excluded); null for no limit */
		budget_tokens: number | null;
	};
	/** a helper's escalation stops at this rung: one effort for every model, or per model with a `default` */
	escalation: { ceiling: Effort | Record<string, Effort> };
}

export const DEFAULT_ROUTING: RoutingConfig = {
	models: {
		// the price ratios are averages per helper step from the step table (october 2026); they follow the list prices, so revise them when those move
		haiku: { ref: "anthropic/claude-haiku-5-5", effort: "high", note: "where bounded work starts; about a seventeenth of a sonnet step under 100k tokens of context and about a third past it, so split at 100k when the work splits" },
		sonnet: { ref: "anthropic/claude-sonnet-5-5", effort: "high", note: "about 17× a haiku step under 100k tokens of context and about opus medium per task on long contexts, since it writes more per step and takes more steps; a little behind opus on the design and writing boards, so the pick when per-step price matters: short tasks, or one long read that cannot be split" },
		opus: { ref: "anthropic/claude-opus-5-5", effort: "high", note: "exploration that shapes a plan, implementation that needs judgment, ui, docs and copy, debugging, code review; about 36× a haiku step under 100k tokens of context, and per task about what sonnet high costs; medium for applying a given defect list or re-checking a delta, since on open work it stops short of the checks" },
		fable: { ref: "anthropic/claude-fable-5-1", effort: "medium", note: "second opinion on plans and designs; about 4× opus per task" },
	},
	// haiku first: left to choose, a driver picks the model it trusts over the cheapest one that can do the task (0 haiku spawns in 43 across two unsteered threads), so the guide names haiku as the start and lists the exceptions
	guide: [
		{ task: "any bounded task whose brief pins down the behaviour and the checks; the rows below are the exceptions", start: "haiku high", up: "opus medium" },
		{ task: "lookups: finding files and usages, reading logs and docs, summarising output", start: "haiku medium (low only for one-shot text such as a commit message)", up: "opus medium" },
		{ task: "exploration whose answer shapes a plan", start: "opus medium", up: "opus high" },
		{ task: "mechanical work: renames, codemods, formatting, commit messages, changelogs, pr text, applying a given list of fixes, merge conflicts where the brief says which side wins (stop and report when claims contradict)", start: "haiku (low for text, high for code)", up: "opus medium" },
		{ task: "coding whose behaviour a test or a reference implementation pins down, porting included, split so each helper stays under about 100k tokens of context (haiku stays coherent to about 250k)", start: "haiku high", up: "opus medium" },
		{ task: "coding that needs a decision the brief cannot make", start: "opus medium", up: "opus high" },
		{ task: "scripted terminal work: fixed steps, known commands, simulator, screenshot and browser checks (one command is a background job, not a helper)", start: "haiku high", up: "opus medium" },
		{ task: "terminal work that may need diagnosis: environments, builds, setup, test loops, ci", start: "opus medium, high for debug-heavy work", up: "opus xhigh; sonnet max only after opus xhigh fails" },
		{ task: "hard implementation and debugging: unclear cause, races, performance, migrations", start: "opus medium", up: "opus high, then opus xhigh; fable medium as a second opinion" },
		{ task: "ui, frontend and design systems", start: "opus medium", up: "opus high" },
		{ task: "docs and user-facing copy", start: "opus medium", up: "opus high" },
		{ task: "review: correctness, performance against a stated target, fidelity to a reference, and risky changes (security, concurrency, persistence, migrations, public api, anything that sends a user's action to a server)", start: "opus medium, high for security, concurrency and persistence", up: "opus xhigh or fable medium" },
		{ task: "a second opinion on a plan or design", start: "opus high or fable medium, whichever is not running your session" },
		{ task: "reading more than 100k tokens", start: "split it across haiku helpers by file or topic; one sonnet high when it cannot be split" },
	],
	rules: [
		"haiku is where a task starts unless a row above says otherwise. a spawn above haiku says in its brief, in one line, why haiku cannot do it; those lines are how the guide gets revised.",
		"small work that needs your context stays with you; small work that does not goes to haiku, since one step of yours costs tens of haiku steps. a helper starts with none of your context.",
		"a brief makes the decisions the task contains (rename or reuse, which pattern to follow) and states the targets the result is measured against (frame time, latency, size). a decision the brief cannot make is a reason to start above haiku; difficulty and file count are not, and a missing tool or permission gets fixed, not escalated.",
		"judge the output when it is back, not the price before. when a helper's output falls short: retry once with a sharper brief, then spawn one step up with after, then do it yourself. no helper is retried more than twice.",
		"tests and typecheck run before any review. a review goes to risky changes, and to haiku's code when no test or reference pins it down; otherwise the tests and your read of the diff are the check. the defect list goes back to the same writer before anyone steps up.",
		"a helper past about 250k tokens of context costs about twice as much per step; give the next task to a fresh helper.",
		"a brief names the files the task touches and attaches the digests it needs with files, not a reading list; a task that needs more than about 150k of context is split or gets its own compaction point.",
		"your own context is the most expensive in the tree: delegate reading and ask for digests.",
		"a brief asks for a report under about 300 words, with the detail in a file the report names, and every claim in it naming the check behind it; a claim without a check is not done.",
		"disjoint work runs in parallel, one writer per area, each writer in its own worktree.",
		"long watches (builds, test suites, dev servers) are background jobs with notify, not helpers.",
		"when only helpers or jobs remain, end your turn; their reports wake you.",
	],
	// haiku past high spends 2 to 3x the tokens for 2 to 3 points, and an xhigh turn can end with no visible text, which is a helper's report
	never: { "claude-haiku-5-5": ["xhigh", "max"] },
	// 50, not 4: 4 was a coding agent's pick that left 3 child slots and went unnoticed (docs/routing.md, caps)
	caps: { running_turns: 50, depth: 3, budget_tokens: null },
	// on code opus 5.5 at max scores below xhigh for more, and sonnet 5.5 past high loses to a cheaper opus run
	escalation: { ceiling: { default: "xhigh", "claude-haiku-5-5": "high", "claude-sonnet-5-5": "high", "claude-opus-5-5": "xhigh", "claude-fable-5-1": "xhigh" } },
};

export type RoutingErrorCode =
	| "invalid_file"
	| "invalid_model"
	| "invalid_effort"
	| "invalid_caps"
	| "invalid_guide"
	| "forbidden_default"
	| "unknown_model"
	| "effort_not_allowed";

export class RoutingError extends Error {
	constructor(
		readonly code: RoutingErrorCode,
		message: string,
		readonly file?: string,
	) {
		super(message);
		this.name = "RoutingError";
	}
}

/** the model id without its provider: `vertex/claude-opus-5-5` → `claude-opus-5-5` */
export function modelId(ref: string): string {
	const i = ref.lastIndexOf("/");
	return i < 0 ? ref : ref.slice(i + 1);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** objects merge key by key; arrays and scalars replace */
function merge<T>(base: T, over: unknown): T {
	if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
	return out as T;
}

function readJsonc(path: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0]!;
		throw new RoutingError("invalid_file", `${path} is not valid jsonc (${printParseErrorCode(first.error)} at offset ${first.offset}); fix it or move it aside`, path);
	}
	if (!isObject(value)) throw new RoutingError("invalid_file", `${path} must hold a json object`, path);
	return value;
}

/** efforts a model never runs at: the config's entries for its ref and bare id */
function forbidden(config: RoutingConfig, model: string): Set<Effort> {
	const id = modelId(model);
	const out = new Set<Effort>();
	// a bare id or a `provider/id` entry both name the model on any provider: the file is about the model, not the proxy
	for (const [key, list] of Object.entries(config.never)) if (modelId(key) === id) for (const e of list) out.add(e);
	return out;
}

/** the rung escalation stops at for a model: its exact ref, then its bare id, then its id on another provider, then `default` */
export function ceilingFor(config: RoutingConfig, model: string): Effort {
	const c = config.escalation.ceiling;
	if (typeof c === "string") return c;
	const id = modelId(model);
	const named = c[model] ?? c[id] ?? Object.entries(c).find(([key]) => key !== "default" && modelId(key) === id)?.[1];
	return named ?? c.default!;
}

const ALIAS = /^[a-z][a-z0-9-]{0,23}$/;
const REF = /^[^/\s]+\/\S+$/;
/** the house voice rules apply to text the model reads */
const DASH = /[–—]/;
const SHOUT = /\b(DO NOT|MUST|IMPORTANT)\b/;

function validate(config: RoutingConfig, where: string): RoutingConfig {
	const fail = (code: RoutingErrorCode, msg: string): never => {
		throw new RoutingError(code, `${where}: ${msg}`, where);
	};
	const voice = (text: string, at: string) => {
		if (DASH.test(text) || SHOUT.test(text)) fail("invalid_guide", `${at} breaks the voice rules (no dashes, no shouting)`);
	};
	if (!isObject(config.models) || Object.keys(config.models).length === 0) fail("invalid_model", "models must be an object with at least one model, like { \"haiku\": { \"ref\": \"anthropic/claude-haiku-5-5\", \"effort\": \"high\", \"note\": \"...\" } }");
	if (!isObject(config.never)) fail("invalid_effort", "never must map models to a list of efforts");
	for (const [model, list] of Object.entries(config.never)) {
		if (!Array.isArray(list) || list.some((e) => !EFFORTS.includes(e))) fail("invalid_effort", `never.${model} must be a list of ${EFFORTS.join(", ")}`);
	}
	for (const [alias, entry] of Object.entries(config.models)) {
		if (!ALIAS.test(alias)) fail("invalid_model", `models.${alias}: an alias is a lowercase word like "haiku"`);
		if (!isObject(entry)) fail("invalid_model", `models.${alias} must be an object with ref, effort and note`);
		const { ref, effort, note } = entry as unknown as Record<string, unknown>;
		if (typeof ref !== "string" || !REF.test(ref)) fail("invalid_model", `models.${alias}.ref must look like "provider/model-id", got ${JSON.stringify(ref)}`);
		if (!EFFORTS.includes(effort as Effort)) fail("invalid_effort", `models.${alias}.effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(effort)}`);
		if (typeof note !== "string" || !note.trim()) fail("invalid_model", `models.${alias}.note must say in one line what the model is for`);
		if (forbidden(config, ref as string).has(effort as Effort)) {
			fail("forbidden_default", `models.${alias} defaults to ${effort}, which ${modelId(ref as string)} never runs at; pick another effort`);
		}
		voice(note as string, `models.${alias}.note`);
	}
	if (!Array.isArray(config.guide)) fail("invalid_guide", "guide must be a list of { task, start, up? } rows");
	config.guide.forEach((row, i) => {
		if (!isObject(row)) fail("invalid_guide", `guide[${i}] must be an object with task, start and an optional up`);
		for (const key of ["task", "start"] as const) {
			if (typeof row[key] !== "string" || !row[key].trim()) fail("invalid_guide", `guide[${i}].${key} must be a non-empty string`);
			voice(row[key], `guide[${i}].${key}`);
		}
		if (row.up !== undefined) {
			if (typeof row.up !== "string" || !row.up.trim()) fail("invalid_guide", `guide[${i}].up must be a non-empty string, or left out when there is no step up`);
			voice(row.up, `guide[${i}].up`);
		}
	});
	if (!Array.isArray(config.rules)) fail("invalid_guide", "rules must be a list of strings");
	config.rules.forEach((rule, i) => {
		if (typeof rule !== "string" || !rule.trim()) fail("invalid_guide", `rules[${i}] must be a non-empty string`);
		voice(rule, `rules[${i}]`);
	});
	const ceiling = config.escalation?.ceiling;
	if (isObject(ceiling)) {
		for (const [model, e] of Object.entries(ceiling)) {
			if (!EFFORTS.includes(e as Effort)) fail("invalid_effort", `escalation.ceiling.${model} must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(e)}`);
		}
		if (!("default" in ceiling)) fail("invalid_effort", `escalation.ceiling needs a "default" for models without their own entry; add "default": "xhigh"`);
	} else if (!EFFORTS.includes(ceiling as Effort)) {
		fail("invalid_effort", `escalation.ceiling must be one of ${EFFORTS.join(", ")} for every model, or an object of model to effort with a "default" (like { "default": "xhigh", "claude-opus-5-5": "xhigh" }), got ${JSON.stringify(ceiling)}`);
	}
	const caps = config.caps;
	if (!Number.isInteger(caps?.running_turns) || caps.running_turns < 2) fail("invalid_caps", `caps.running_turns must be a whole number of at least 2 (the root plus one child), got ${JSON.stringify(caps?.running_turns)}`);
	if (!Number.isInteger(caps.depth) || caps.depth < 1) fail("invalid_caps", `caps.depth must be a whole number of at least 1, got ${JSON.stringify(caps.depth)}`);
	if (caps.budget_tokens !== null && (!Number.isInteger(caps.budget_tokens) || caps.budget_tokens <= 0)) fail("invalid_caps", `caps.budget_tokens must be a positive whole number or null for no limit, got ${JSON.stringify(caps.budget_tokens)}`);
	return config;
}

/** keys of routing.jsonc version 1; a layer that still has them loads with these dropped */
const V1_KEYS = ["preset", "presets", "seats", "effort"] as const;

export interface RoutingOptions {
	/** the profile dir, read on every call so a test or a reload can move it */
	configDir: () => string;
	/** short hostname, the key for the per-machine overlay */
	machine: string;
	/** the project whose `.cmx2/routing.jsonc` applies on top */
	projectDir?: string;
	/** called once per config version that carries warnings (the daemon logs them) */
	onWarnings?: (warnings: string[]) => void;
}

export interface Resolved {
	alias: string;
	model: string;
	effort: Effort;
}

/** one sentence ending in one period */
function sentence(s: string): string {
	return `${s.trim().replace(/\.+$/, "")}.`;
}

export class Routing {
	private config: RoutingConfig = validate(structuredClone(DEFAULT_ROUTING), "the shipped routing defaults");
	private stamp: string | undefined;
	private error: RoutingError | undefined;
	/** version-1 keys found in the layers of the config in force */
	private layerWarnings: string[] = [];
	/** bumps on every successful read, so callers can tell a new table from the one they rendered */
	version = 0;

	constructor(private readonly opts: RoutingOptions) {}

	/** the files that layer on the defaults, in order */
	files(): string[] {
		const dir = this.opts.configDir();
		const out = [join(dir, "routing.jsonc"), join(dir, `routing.${this.opts.machine}.jsonc`)];
		if (this.opts.projectDir) out.push(join(this.opts.projectDir, ".cmx2", "routing.jsonc"));
		return out;
	}

	private stampOf(files: string[]): string {
		return files
			.map((f) => {
				if (!existsSync(f)) return `${f}:-`;
				const s = statSync(f);
				return `${f}:${s.mtimeMs}:${s.size}`;
			})
			.join("|");
	}

	/** the routing in force: re-read when a layer file changed, appeared or went away */
	current(): RoutingConfig {
		const files = this.files();
		const stamp = this.stampOf(files);
		if (stamp === this.stamp) return this.config;
		this.stamp = stamp;
		try {
			let next = structuredClone(DEFAULT_ROUTING);
			let where = "the shipped routing defaults";
			const layerWarnings: string[] = [];
			for (const f of files) {
				if (!existsSync(f)) continue;
				const layer = readJsonc(f);
				// a version-1 file loads: its seat keys are dropped, the shared keys keep working
				const old = V1_KEYS.filter((k) => (k === "effort" ? isObject(layer[k]) : k in layer));
				for (const k of old) delete layer[k];
				if (old.length) layerWarnings.push(`${f} uses version-1 keys (${old.join(", ")}); they are ignored. models and guide replace them: see docs/routing.md`);
				next = merge(next, layer);
				where = f;
			}
			// `models.<alias>: null` in a layer takes a shipped alias out of the table
			if (isObject(next.models)) for (const [alias, m] of Object.entries(next.models)) if (m === null) delete (next.models as Record<string, unknown>)[alias];
			this.config = validate(next, where);
			this.layerWarnings = layerWarnings;
			this.error = undefined;
			this.version++;
			const warnings = this.warnings();
			if (warnings.length) this.opts.onWarnings?.(warnings);
		} catch (e) {
			// the last good table stays in force; lastError says why the edit did not take
			if (!(e instanceof RoutingError)) throw e;
			this.error = e;
		}
		return this.config;
	}

	/** why the last read of the files failed, while the previous good config stays in force */
	lastError(): RoutingError | undefined {
		this.current();
		return this.error;
	}

	/** things that load but are probably not what the user meant: version-1 keys, a single ceiling over every model */
	warnings(): string[] {
		const ceiling = this.current().escalation.ceiling;
		const out = [...this.layerWarnings];
		if (typeof ceiling === "string") out.push(`escalation.ceiling "${ceiling}" applies to every model and replaces the per-model ceilings`);
		return out;
	}

	/** the next `current()` reads the files again */
	flush() {
		this.stamp = undefined;
	}

	allowedEfforts(model: string): Effort[] {
		const off = forbidden(this.current(), model);
		return EFFORTS.filter((e) => !off.has(e));
	}

	allowed(model: string, effort: Effort): boolean {
		return !forbidden(this.current(), model).has(effort);
	}

	/** alias → model and effort; a spawn's effort must be one the model runs at */
	resolve(alias: string, opts: { effort?: Effort } = {}): Resolved {
		const c = this.current();
		const entry = Object.hasOwn(c.models, alias) ? c.models[alias] : undefined;
		if (!entry) throw new RoutingError("unknown_model", `no model named ${alias} in routing.jsonc; the models are ${Object.keys(c.models).join(", ")}`);
		const effort = opts.effort ?? entry.effort;
		if (!EFFORTS.includes(effort)) throw new RoutingError("invalid_effort", `effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(effort)}`);
		if (!this.allowed(entry.ref, effort)) {
			throw new RoutingError("effort_not_allowed", `${modelId(entry.ref)} never runs at ${effort}; it runs at ${this.allowedEfforts(entry.ref).join(", ")}`);
		}
		return { alias, model: entry.ref, effort };
	}

	/** the first alias that names this model: by exact ref, then by bare id; for labels */
	aliasOf(ref: string): string | undefined {
		const models = Object.entries(this.current().models);
		return models.find(([, m]) => m.ref === ref)?.[0] ?? models.find(([, m]) => modelId(m.ref) === modelId(ref))?.[0];
	}

	/** the next rung up that the model runs at, at most its ceiling; undefined when there is none */
	escalate(model: string, from: Effort): Effort | undefined {
		const c = this.current();
		const off = forbidden(c, model);
		const ceiling = EFFORTS.indexOf(ceilingFor(c, model));
		for (let i = EFFORTS.indexOf(from) + 1; i <= ceiling; i++) {
			const e = EFFORTS[i]!;
			if (!off.has(e)) return e;
		}
		return undefined;
	}

	/** the model table, guide and rules for a delegating session's appended turn context; byte-stable per config */
	render(opts: { canSpawn: boolean; helper?: boolean }): string {
		const c = this.current();
		if (!opts.canSpawn) return "";
		const lines = [opts.helper ? "models for helpers. spawn names one." : "models for helpers. spawn names one; your own model is the user's choice and is not in this table."];
		for (const [alias, m] of Object.entries(c.models)) lines.push(`- ${alias}: ${modelId(m.ref)}, ${m.effort} by default. ${sentence(m.note)}`);
		const models = [...new Set(Object.values(c.models).map((m) => m.ref))].sort();
		const off = models
			.map((m) => {
				const f = EFFORTS.filter((e) => forbidden(c, m).has(e));
				return f.length ? `${modelId(m)} never runs at ${f.join(" or ")}` : undefined;
			})
			.filter((x) => x !== undefined);
		if (off.length) lines.push(`off limits: ${off.join("; ")}.`);
		if (c.guide.length) {
			lines.push("where to start, and where to step up when the output falls short (defaults, not limits):");
			for (const g of c.guide) lines.push(`- ${sentence(`${g.task}: ${g.start}${g.up ? `; then ${g.up}` : ""}`)}`);
		}
		if (c.rules.length) {
			lines.push("how to use it:");
			for (const r of c.rules) lines.push(`- ${r}`);
		}
		return lines.join("\n");
	}
}
