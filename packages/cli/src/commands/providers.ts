import { parseArgs } from "node:util";
import { loadConfig } from "@cmx2/engine/config";
import { listedProviders, resolveApiKey } from "@cmx2/engine/models";

export const help = `cmx2 providers: the providers this machine is set up for

usage:
  cmx2 providers [--json]

one line per provider the daemon lists models for: its name, where it came from (config: cmx2.jsonc names
it; env: its usual key variable is set, or it holds the default model), the host it talks to, whether a key resolves, and how many custom models it adds.
keys are never printed. a key in config can be a literal, $ENV_NAME, or !command whose output is the key.

anthropic works with ANTHROPIC_API_KEY alone; google with GEMINI_API_KEY. anything else (a proxy, an
openai-compatible server) goes under providers in ~/.config/cmx2/cmx2.jsonc with api, baseUrl and models.`;

const DEFAULT_HOSTS: Record<string, string> = { anthropic: "api.anthropic.com", google: "generativelanguage.googleapis.com" };
const ENV_KEYS: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };

export async function main(args: string[]) {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const config = loadConfig();
	// the same set the daemon lists models for (/config/providers)
	const rows = listedProviders(config).map((name) => {
		const o = config.providers[name] ?? {};
		let host = DEFAULT_HOSTS[name] ?? "not set";
		if (o.baseUrl) {
			try {
				host = new URL(o.baseUrl).host;
			} catch {
				host = `${o.baseUrl} (not a url)`;
			}
		}
		const key = resolveApiKey(config, name) !== undefined;
		const keyFrom = o.apiKey?.startsWith("$") ? o.apiKey : o.apiKey?.startsWith("!") ? "a command" : o.apiKey ? "config" : ENV_KEYS[name] && process.env[ENV_KEYS[name]!] ? ENV_KEYS[name] : undefined;
		return { name, source: name in config.providers ? "config" : "env", api: o.api ?? (name === "google" ? "google-generative-ai" : name === "anthropic" ? "anthropic-messages" : "unknown"), host, key, keyFrom: keyFrom ?? null, models: Object.keys(o.models ?? {}).length };
	});
	if (values.json) return console.log(JSON.stringify(rows, null, 2));
	const w = Math.max(...rows.map((r) => r.name.length));
	for (const r of rows) {
		const keyWords = r.key ? `key from ${r.keyFrom}` : `no key${ENV_KEYS[r.name] ? `: set ${ENV_KEYS[r.name]}` : `: set providers.${r.name}.apiKey`}`;
		console.log(`${r.name.padEnd(w)}  ${r.source.padEnd(6)}  ${r.host}  ${keyWords}${r.models ? `  ${r.models} custom model${r.models === 1 ? "" : "s"}` : ""}`);
	}
	console.log(`default model: ${config.model} at ${config.effort} effort${config.sources.length ? ` (from ${config.sources.at(-1)})` : " (shipped default)"}`);
}
