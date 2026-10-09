import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { COMPACTION_DEFAULTS, type CompactionSettings } from "./compaction.ts";
import { IMAGE_DEFAULTS, type ImageSettings } from "./images.ts";
import { DEFAULT_PERMISSION, PERMISSION_ACTIONS, type PermissionConfig } from "./permission.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** wire apis cmx2 can drive; each maps to one pi-ai adapter */
export type ProviderApi = "anthropic-messages" | "google-generative-ai" | "openai-completions";
export const PROVIDER_APIS: readonly ProviderApi[] = ["anthropic-messages", "google-generative-ai", "openai-completions"];

/** a model pi's catalog does not know, served by a provider you configure */
export interface CustomModel {
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	/** $ per million tokens, for telemetry */
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/**
 * an endpoint. for providers pi ships (anthropic, google) this only moves the endpoint and the key and
 * the models stay pi's; any other name is a custom provider and needs `api` and `models`.
 */
export interface ProviderOverride {
	/** base url as the adapter expects it: anthropic without `/v1`, google with `/v1beta`, openai-compatible with `/v1` */
	baseUrl?: string;
	/** literal key, `$ENV_NAME`, or `!command` whose stdout is the key */
	apiKey?: string;
	headers?: Record<string, string>;
	api?: ProviderApi;
	models?: Record<string, CustomModel>;
	/**
	 * the most bytes one request may carry. defaults to the model catalog's limit (32 MiB for anthropic) on
	 * the provider's own endpoint, and to 20 MB when `baseUrl` points elsewhere: vertex takes 30 MB
	 * (30000000), bedrock 20 MB. the context drops its oldest images before a request would pass it
	 */
	maxRequestBytes?: number;
}

/**
 * how turn-scoped messages (batching nudge, turn context) reach the model. `system` appends a
 * mid-conversation system message; `user-part` folds the text into the user message. `auto` picks
 * `system` where the model accepts mid-conversation system messages.
 */
export type TurnMessageMode = "auto" | "system" | "user-part";

export interface Config {
	/** `provider/model-id` used for new sessions */
	model: string;
	/** effort for new sessions until the dial changes it */
	effort: Effort;
	providers: Record<string, ProviderOverride>;
	/**
	 * the batching nudge on every turn. off by default: on opus 5.5, fable 5.1 and sonnet 5.5 it did not
	 * move calls per step (the a/b is in CHANGELOG.md, m2); on for models measured to need it.
	 */
	nudge: boolean;
	/** permission rules; the profile and project layers replace keys of the shipped default */
	permission: PermissionConfig;
	turnMessages: TurnMessageMode;
	server: { hostname: string; port: number };
	/** mcp servers by name: a local command (stdio) or a url (streamable http); their tools load through tool_search */
	mcp: Record<string, McpServerEntry>;
	/** write and edit run the project's formatter on the file (prettier, biome, gofmt, rustfmt, ruff) when it has one configured */
	format: boolean;
	/** write and edit report the language server's errors for the file in their result */
	diagnostics: boolean;
	/** checkouts made for agents (worktree_create, POST /experimental/worktree) */
	worktree: WorktreeConfig;
	/**
	 * when and how a long context is compacted: `at` in tokens (or a fraction of the window when at most 1),
	 * `prefire` the fraction of `at` where the summary starts in the background, `keep` the fraction of `at`
	 * kept verbatim after the summary, `protect` the newest tool output in tokens that tail keeps whole
	 */
	compaction: CompactionSettings;
	/**
	 * images in the context: `budget` is the base64 bytes it may carry before the oldest images the model has
	 * seen are dropped (false turns that off), `keep` the fraction of the budget a drop leaves. images cost a
	 * request bytes long before they cost compaction tokens
	 */
	images: ImageSettings;
	/** where the profile was read from, for diagnostics */
	sources: string[];
}

/**
 * how checkouts are made. `carry` is the secrets allowlist: an untracked file shaped like a secret (env
 * files, keys, certificates, tokens) goes into a checkout only when one of these basename globs names it;
 * a layer that sets it replaces the list. `setup` runs in every new checkout before it is ready, usually
 * from the project's `.cmx2/cmx2.jsonc` ("bun install", a migration).
 */
export interface WorktreeConfig {
	carry: string[];
	cap: number;
	minFreeGB: number;
	minFreeRatio: number;
	clone: boolean;
	setup: string | string[];
}

/** one mcp server as the profile names it; the tools package reads the rest of the fields */
export interface McpServerEntry {
	command?: string[] | string;
	url?: string;
	type?: "local" | "remote";
	enabled?: boolean;
	[key: string]: unknown;
}

export const DEFAULTS: Omit<Config, "sources"> = {
	model: "anthropic/claude-opus-5-5",
	effort: "medium",
	providers: {},
	nudge: false,
	permission: DEFAULT_PERMISSION,
	turnMessages: "auto",
	server: { hostname: "127.0.0.1", port: 4097 },
	mcp: {},
	format: true,
	diagnostics: true,
	worktree: { carry: [".env", ".env.*", ".envrc", ".dev.vars", "localhost*.pem"], cap: 15, minFreeGB: 5, minFreeRatio: 0.1, clone: true, setup: [] },
	compaction: COMPACTION_DEFAULTS,
	images: IMAGE_DEFAULTS,
};

export function configDir(env = process.env): string {
	return env.CMX2_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cmx2");
}

export function dataDir(env = process.env): string {
	return env.CMX2_DATA_DIR || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "cmx2");
}

/** short hostname, the key for per-machine overlays */
export function machineName(): string {
	return hostname().split(".")[0]!.toLowerCase();
}

export class ConfigError extends Error {}

function readJsonc(path: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0]!;
		throw new ConfigError(`${path} is not valid jsonc (${printParseErrorCode(first.error)} at offset ${first.offset}); fix it or move it aside`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`${path} must hold a json object`);
	}
	return value as Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** objects merge key by key; everything else replaces */
export function merge<T>(base: T, over: unknown): T {
	if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
	return out as T;
}

function validate(c: Config): Config {
	if (typeof c.model !== "string" || !c.model.includes("/")) {
		throw new ConfigError(`model must look like "provider/model-id", got ${JSON.stringify(c.model)}`);
	}
	if (!EFFORTS.includes(c.effort)) {
		throw new ConfigError(`effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(c.effort)}`);
	}
	if (!Number.isInteger(c.server.port) || c.server.port <= 0 || c.server.port > 65535) {
		throw new ConfigError(`server.port must be a port number, got ${JSON.stringify(c.server.port)}`);
	}
	if (!["auto", "system", "user-part"].includes(c.turnMessages)) {
		throw new ConfigError(`turnMessages must be auto, system or user-part, got ${JSON.stringify(c.turnMessages)}`);
	}
	if (typeof c.permission === "string") {
		if (!PERMISSION_ACTIONS.includes(c.permission)) throw new ConfigError(`permission must be allow, ask or deny, or an object of rules; got ${JSON.stringify(c.permission)}`);
	} else if (!isObject(c.permission)) {
		throw new ConfigError(`permission must be allow, ask or deny, or an object of rules; got ${JSON.stringify(c.permission)}`);
	} else {
		for (const [key, v] of Object.entries(c.permission)) {
			const actions = typeof v === "string" ? [v] : isObject(v) ? Object.values(v) : [v];
			for (const a of actions) {
				if (!PERMISSION_ACTIONS.includes(a as never)) throw new ConfigError(`permission.${key} must be allow, ask or deny (or an object of pattern: action); got ${JSON.stringify(a)}`);
			}
		}
	}
	if (!isObject(c.mcp)) throw new ConfigError(`mcp must be an object of servers by name, got ${JSON.stringify(c.mcp)}`);
	for (const [name, m] of Object.entries(c.mcp)) {
		if (!isObject(m)) throw new ConfigError(`mcp.${name} must be an object with a command or a url`);
		const hasCommand = typeof m.command === "string" || (Array.isArray(m.command) && m.command.length > 0);
		if (!hasCommand && typeof m.url !== "string") throw new ConfigError(`mcp.${name} needs a command (a local server) or a url (a remote one)`);
		if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ConfigError(`mcp server names are letters, digits, - and _ (they prefix tool names); rename "${name}"`);
	}
	if (typeof c.format !== "boolean") throw new ConfigError(`format must be true or false, got ${JSON.stringify(c.format)}`);
	if (typeof c.diagnostics !== "boolean") throw new ConfigError(`diagnostics must be true or false, got ${JSON.stringify(c.diagnostics)}`);
	const w = c.worktree;
	if (!isObject(w)) throw new ConfigError(`worktree must be an object ({carry, cap, minFreeGB, minFreeRatio, clone, setup}), got ${JSON.stringify(w)}`);
	if (!Array.isArray(w.carry) || w.carry.some((g) => typeof g !== "string")) throw new ConfigError(`worktree.carry must be a list of file name globs, got ${JSON.stringify(w.carry)}`);
	if (!Number.isInteger(w.cap) || w.cap < 1) throw new ConfigError(`worktree.cap must be a whole number of checkouts, 1 or more; got ${JSON.stringify(w.cap)}`);
	if (typeof w.minFreeGB !== "number" || w.minFreeGB < 0) throw new ConfigError(`worktree.minFreeGB must be a number of gigabytes; got ${JSON.stringify(w.minFreeGB)}`);
	if (typeof w.minFreeRatio !== "number" || w.minFreeRatio < 0 || w.minFreeRatio >= 1) throw new ConfigError(`worktree.minFreeRatio must be a fraction from 0 to 1; got ${JSON.stringify(w.minFreeRatio)}`);
	if (typeof w.clone !== "boolean") throw new ConfigError(`worktree.clone must be true or false, got ${JSON.stringify(w.clone)}`);
	if (typeof w.setup !== "string" && !(Array.isArray(w.setup) && w.setup.every((x) => typeof x === "string"))) throw new ConfigError(`worktree.setup must be a command or a list of commands, got ${JSON.stringify(w.setup)}`);
	const k = c.compaction;
	if (!isObject(k)) throw new ConfigError(`compaction must be an object like {"at": 300000}, got ${JSON.stringify(k)}`);
	if (typeof k.auto !== "boolean") throw new ConfigError(`compaction.auto must be true or false, got ${JSON.stringify(k.auto)}`);
	if (typeof k.at !== "number" || !(k.at > 0)) throw new ConfigError(`compaction.at must be a token count, or a fraction of the window up to 1; got ${JSON.stringify(k.at)}`);
	if (k.prefire !== false && (typeof k.prefire !== "number" || !(k.prefire > 0 && k.prefire < 1))) throw new ConfigError(`compaction.prefire must be a fraction between 0 and 1, or false; got ${JSON.stringify(k.prefire)}`);
	if (typeof k.keep !== "number" || !(k.keep >= 0 && k.keep < 1)) throw new ConfigError(`compaction.keep must be a fraction from 0 up to 1, got ${JSON.stringify(k.keep)}`);
	if (typeof k.protect !== "number" || !(k.protect >= 0)) throw new ConfigError(`compaction.protect must be a token count, got ${JSON.stringify(k.protect)}`);
	const im = c.images;
	if (!isObject(im)) throw new ConfigError(`images must be an object like {"budget": 12000000, "keep": 0.4}, got ${JSON.stringify(im)}`);
	if (im.budget !== false && (typeof im.budget !== "number" || !(im.budget > 0))) throw new ConfigError(`images.budget must be a number of bytes, or false; got ${JSON.stringify(im.budget)}`);
	if (typeof im.keep !== "number" || !(im.keep > 0 && im.keep < 0.75)) throw new ConfigError(`images.keep must be a fraction between 0 and 0.75 (a turn's first request drops at 75% of the budget), got ${JSON.stringify(im.keep)}`);
	for (const [name, p] of Object.entries(c.providers)) {
		if (p.maxRequestBytes !== undefined && (typeof p.maxRequestBytes !== "number" || !(p.maxRequestBytes > 0))) {
			throw new ConfigError(`providers.${name}.maxRequestBytes must be a number of bytes, got ${JSON.stringify(p.maxRequestBytes)}`);
		}
		if (p.api && !PROVIDER_APIS.includes(p.api)) {
			throw new ConfigError(`providers.${name}.api must be one of ${PROVIDER_APIS.join(", ")}, got ${JSON.stringify(p.api)}`);
		}
		if (p.models && !p.api && name !== "anthropic" && name !== "google") {
			throw new ConfigError(`providers.${name} lists models but no api; add "api": "openai-completions" (or another of ${PROVIDER_APIS.join(", ")})`);
		}
	}
	return c;
}

/** keys a repository's `.cmx2/cmx2.jsonc` cannot set: where keys go, the key commands, the listener, the mcp commands */
const PROFILE_ONLY = ["providers", "server", "mcp"] as const;
const warned = new Set<string>();

/**
 * the project layer comes with whatever repository was cloned, so it can say how to work in it but not
 * widen what the agent may do or where the keys go: `providers`, `server` and `mcp` are dropped, and its
 * permission rules may ask or deny but not allow. what it tried is listed for the log line.
 */
export function projectLayer(layer: Record<string, any>): { layer: Record<string, any>; ignored: string[] } {
	const out = { ...layer };
	const ignored: string[] = [];
	for (const k of PROFILE_ONLY) {
		if (out[k] === undefined) continue;
		delete out[k];
		ignored.push(k);
	}
	const p = out.permission;
	if (p === "allow") {
		delete out.permission;
		ignored.push("permission allow");
	} else if (isObject(p)) {
		const kept: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(p)) {
			if (v === "allow") ignored.push(`permission.${key} allow`);
			else if (isObject(v)) {
				const rules = Object.fromEntries(Object.entries(v).filter(([pattern, action]) => (action === "allow" ? (ignored.push(`permission.${key} ${pattern} allow`), false) : true)));
				if (Object.keys(rules).length) kept[key] = rules;
			} else kept[key] = v;
		}
		out.permission = kept;
	}
	return { layer: out, ignored };
}

/**
 * defaults → profile `cmx2.jsonc` → `cmx2.<hostname>.jsonc` → project `.cmx2/cmx2.jsonc` → env. the
 * project layer is limited (`projectLayer`): it cannot loosen permissions or move keys and endpoints.
 */
export function loadConfig(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Config {
	const env = opts.env ?? process.env;
	const dir = configDir(env);
	const layers = [join(dir, "cmx2.jsonc"), join(dir, `cmx2.${machineName()}.jsonc`)];
	const project = opts.cwd ? join(opts.cwd, ".cmx2", "cmx2.jsonc") : undefined;
	if (project) layers.push(project);
	let config: Config = { ...structuredClone(DEFAULTS), sources: [] };
	for (const path of layers) {
		if (!existsSync(path)) continue;
		let layer = readJsonc(path);
		// `permissions` reads as `permission` (the preset files use the plural)
		if (layer.permissions !== undefined) {
			layer.permission = layer.permission === undefined ? layer.permissions : merge(layer.permissions, layer.permission);
			delete layer.permissions;
		}
		if (path === project) {
			const r = projectLayer(layer);
			layer = r.layer;
			if (r.ignored.length && !warned.has(path)) {
				warned.add(path);
				console.error(`cmx2: ${path} is the repository's own config, so it cannot set ${r.ignored.join(", ")}; those belong in your profile (${join(dir, "cmx2.jsonc")})`);
			}
		}
		config = merge(config, layer);
		config.sources.push(path);
	}
	if (env.CMX2_MODEL) config.model = env.CMX2_MODEL;
	if (env.CMX2_EFFORT) config.effort = env.CMX2_EFFORT as Effort;
	return validate(config);
}
