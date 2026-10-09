import { spawnSync } from "node:child_process";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Config, ProviderApi, ProviderOverride } from "./config.ts";

// pin pi's model catalog to the one bundled with the pinned version; nothing here refreshes it from
// the network, and these stop any pi code path that would.
process.env.PI_OFFLINE ??= "1";
process.env.PI_SKIP_VERSION_CHECK ??= "1";

export class ModelError extends Error {}

const ENV_KEYS: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };

/**
 * what pi 0.99.1 gets wrong or lacks for anthropic, merged over its catalog. pi 1.1.0 ships haiku 5.5
 * but not the sonnet 5.5 cache-read price, and the jump from 0.99.1 is a major one, so cmx2 keeps the
 * pin and overlays instead. drop an entry here when a deliberate pi bump ships it right.
 *
 * haiku 5.5 bills a request at the long rates, input and output, once it holds 100,000 input tokens
 * (input + cache read + cache write). pi applies a tier when the count is strictly above
 * `inputTokensAbove`, so 99,999 puts a request of exactly 100,000 in the tier. pi derives 1h cache
 * writes as twice the input price of the rate that applies.
 */
function anthropicOverlay(known: Record<string, Model<Api>>): Record<string, Model<Api>> {
	const sonnet = known["claude-sonnet-5-5"];
	const overlay: Record<string, Model<Api>> = {};
	if (sonnet) {
		// anthropic cut the sonnet 5.5 cache-read price to $0.10 per million on 2026-10-07, on vertex too
		overlay["claude-sonnet-5-5"] = { ...sonnet, cost: { ...sonnet.cost, cacheRead: 0.1 } };
		overlay["claude-haiku-5-5"] = {
			...sonnet,
			id: "claude-haiku-5-5",
			name: "Claude Haiku 5.5",
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				tiers: [{ inputTokensAbove: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
			},
			inputLimits: sonnet.inputLimits && {
				...sonnet.inputLimits,
				images: sonnet.inputLimits.images && { ...sonnet.inputLimits.images, maxPerRequest: 100 },
			},
		} as Model<Api>;
	}
	return { ...known, ...overlay };
}

let anthropicCatalog: Promise<Record<string, Model<Api>>> | undefined;

async function catalog(provider: string): Promise<Record<string, Model<Api>> | undefined> {
	// imported on demand so a daemon that never talks to google never loads google's catalog
	if (provider === "anthropic") {
		anthropicCatalog ??= import("@earendil-works/pi-ai/providers/anthropic.models").then((m) => anthropicOverlay(m.ANTHROPIC_MODELS as never));
		return anthropicCatalog;
	}
	if (provider === "google") return (await import("@earendil-works/pi-ai/providers/google.models")).GOOGLE_MODELS as never;
	return undefined;
}

/** `provider/model-id` → a pi model with the configured endpoint applied */
export async function resolveModel(config: Config, ref: string): Promise<Model<Api>> {
	const slash = ref.indexOf("/");
	if (slash <= 0) throw new ModelError(`model must look like "provider/model-id", got ${JSON.stringify(ref)}`);
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	const o: ProviderOverride = config.providers[provider] ?? {};
	const custom = o.models?.[id];
	if (custom) {
		if (!o.api || !o.baseUrl) throw new ModelError(`providers.${provider} needs api and baseUrl to serve ${id}`);
		return {
			id,
			name: custom.name ?? id,
			api: o.api,
			provider,
			baseUrl: o.baseUrl,
			reasoning: custom.reasoning ?? false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...custom.cost },
			contextWindow: custom.contextWindow ?? 128_000,
			maxTokens: custom.maxTokens ?? 16_384,
			...(o.headers ? { headers: o.headers } : {}),
		} as Model<Api>;
	}
	const known = (await catalog(provider))?.[id];
	if (!known) {
		const hint = o.models ? `providers.${provider}.models has ${Object.keys(o.models).join(", ")}` : `add it under providers.${provider}.models in cmx2.jsonc`;
		throw new ModelError(`model ${ref} is not in pi's catalog; ${hint}`);
	}
	return { ...known, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.headers ? { headers: { ...known.headers, ...o.headers } } : {}) };
}

/** the key for a provider: config literal, `$ENV`, `!command`, then the provider's usual env var */
export function resolveApiKey(config: Config, provider: string): string | undefined {
	const v = config.providers[provider]?.apiKey;
	if (v?.startsWith("$")) return process.env[v.slice(1).replace(/^\{|\}$/g, "")];
	if (v?.startsWith("!")) {
		const r = spawnSync("sh", ["-c", v.slice(1)], { encoding: "utf8", timeout: 10_000 });
		return r.status === 0 ? r.stdout.trim() || undefined : undefined;
	}
	if (v) return v;
	const env = ENV_KEYS[provider];
	return env ? process.env[env] : undefined;
}

type Adapter = { streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream };

const adapters = new Map<ProviderApi, Promise<Adapter>>();

function adapter(api: string): Promise<Adapter> {
	let a = adapters.get(api as ProviderApi);
	if (!a) {
		if (api === "anthropic-messages") a = import("@earendil-works/pi-ai/api/anthropic-messages") as Promise<Adapter>;
		else if (api === "google-generative-ai") a = import("@earendil-works/pi-ai/api/google-generative-ai") as Promise<Adapter>;
		else if (api === "openai-completions") a = import("@earendil-works/pi-ai/api/openai-completions") as Promise<Adapter>;
		else throw new ModelError(`api ${api} is not wired into cmx2`);
		adapters.set(api as ProviderApi, a);
	}
	return a;
}

/** pi-agent-core's StreamFn over the three adapters cmx2 uses */
export async function streamFn(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
	return (await adapter(model.api)).streamSimple(model, context, options);
}

/** a model as the picker shows it; efforts are the levels the provider accepts for it */
export interface ListedModel {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
	images: boolean;
	contextWindow: number;
	maxTokens: number;
	/** per million tokens; `tiers` are request-wide: the highest matching input threshold applies to every token of the request */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> };
	efforts: string[];
}

const PI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * the providers a config is set up for: those the profile gives a baseUrl, a key, headers (an auth header
 * is a key too) or models of its own, those whose usual env key is set, and the one that holds the
 * default model. a provider the profile never mentions stays out.
 */
export function listedProviders(config: Config): string[] {
	const out = new Set<string>();
	for (const [id, o] of Object.entries(config.providers)) if (o.baseUrl || o.apiKey || o.headers || o.models) out.add(id);
	for (const [id, env] of Object.entries(ENV_KEYS)) if (process.env[env]) out.add(id);
	const slash = config.model.indexOf("/");
	if (slash > 0) out.add(config.model.slice(0, slash));
	return [...out];
}

/**
 * the models a daemon can run: pi's catalog for the providers pi ships that the config is set up for
 * (`listedProviders`), plus every configured custom model, so the picker lists what the user can use.
 * fast-mode entries are left out (the proxy rejects the beta).
 */
export async function listModels(config: Config): Promise<ListedModel[]> {
	const out: ListedModel[] = [];
	const providers = listedProviders(config);
	for (const provider of providers) {
		const o = config.providers[provider] ?? {};
		for (const [id, m] of Object.entries(o.models ?? {})) {
			out.push({
				id,
				provider,
				name: m.name ?? id,
				reasoning: m.reasoning ?? false,
				images: false,
				contextWindow: m.contextWindow ?? 128_000,
				maxTokens: m.maxTokens ?? 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...m.cost },
				efforts: m.reasoning ? ["low", "medium", "high"] : [],
			});
		}
		const known = await catalog(provider);
		if (!known) continue;
		for (const m of Object.values(known)) {
			if (m.id.endsWith("-fast") || o.models?.[m.id]) continue;
			const map = (m as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
			const efforts = map ? PI_EFFORTS.filter((e) => map[e] !== null && map[e] !== undefined) : m.reasoning ? ["low", "medium", "high"] : [];
			out.push({
				id: m.id,
				provider,
				name: m.name,
				reasoning: m.reasoning,
				images: m.input.includes("image"),
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: m.cost,
				efforts,
			});
		}
	}
	return out;
}
