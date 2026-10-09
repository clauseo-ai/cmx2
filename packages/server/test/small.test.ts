import { afterAll, expect, test } from "bun:test";
import { port } from "../../eval/src/harness.ts";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@cmx2/engine/config";
import { serve } from "../src/index.ts";

/**
 * m9 items over the real routes, on a daemon on a real socket (port 4929, shifted by
 * CMX2_PORT_SHIFT): s1 the provider list holds only what the profile configures, s4 the variants
 * hold only the efforts routing.jsonc lets a model run. no model is called.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-small-")));
const cfgDir = join(root, "config");
mkdirSync(cfgDir);
// a typical shape: a local proxy for anthropic and google, a custom provider with its own model
const OWNER = `{
  "model": "anthropic/claude-opus-5-5",
  "providers": {
    "anthropic": { "baseUrl": "http://127.0.0.1:9/anthropic", "apiKey": "proxy-ignores-this", "blacklist": ["*-fast", "claude-fable-5"] },
    "google": { "baseUrl": "http://127.0.0.1:9/google", "apiKey": "proxy-ignores-this" },
    "glm": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:9/glm",
      "apiKey": "proxy-ignores-this",
      "models": { "zai-org/glm-5-maas": { "name": "GLM 5", "reasoning": true, "contextWindow": 200000, "maxTokens": 32000 } }
    },
    "unused": { "blacklist": ["*"] }
  }
}`;
writeFileSync(join(cfgDir, "cmx2.jsonc"), OWNER);
const saved = { dir: process.env.CMX2_CONFIG_DIR, a: process.env.ANTHROPIC_API_KEY, g: process.env.GEMINI_API_KEY };
process.env.CMX2_CONFIG_DIR = cfgDir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
const daemon = serve({ config: loadConfig(), port: port(4929), hostname: "127.0.0.1", dataDir: join(root, "data"), checkEvents: true });
const base = `http://127.0.0.1:${port(4929)}`;
afterAll(async () => {
	await daemon.stop();
	for (const [k, v] of [["CMX2_CONFIG_DIR", saved.dir], ["ANTHROPIC_API_KEY", saved.a], ["GEMINI_API_KEY", saved.g]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

type Providers = { providers: Array<{ id: string; models: Record<string, { variants: Record<string, unknown> }> }>; default: Record<string, string> };
const providers = async () => (await (await fetch(`${base}/config/providers`)).json()) as Providers;
const reload = async () => expect((await fetch(`${base}/global/reload`, { method: "POST" })).status).toBe(200);

test("s1: /config/providers lists the providers the profile configures, their models, minus the blacklist, default marked", async () => {
	const p = await providers();
	expect(p.providers.map((x) => x.id).sort()).toEqual(["anthropic", "glm", "google"]);
	const anthropic = Object.keys(p.providers.find((x) => x.id === "anthropic")!.models);
	expect(anthropic).toContain("claude-opus-5-5");
	expect(anthropic).not.toContain("claude-fable-5");
	expect(Object.keys(p.providers.find((x) => x.id === "glm")!.models)).toEqual(["zai-org/glm-5-maas"]);
	expect(p.default).toMatchObject({ anthropic: "claude-opus-5-5" });
	console.log(`owner-shaped profile: ${p.providers.map((x) => `${x.id} ${Object.keys(x.models).length}`).join(", ")}; default ${JSON.stringify(p.default)}`);
});

test("s1: a provider the profile does not configure is not listed, even anthropic; the default model's provider always is", async () => {
	writeFileSync(
		join(cfgDir, "cmx2.jsonc"),
		`{ "model": "glm/zai-org/glm-5-maas", "providers": { "glm": { "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/glm", "apiKey": "k", "models": { "zai-org/glm-5-maas": { "name": "GLM 5" } } } } }`,
	);
	await reload();
	let p = await providers();
	expect(p.providers.map((x) => x.id)).toEqual(["glm"]);
	expect(p.default).toEqual({ glm: "zai-org/glm-5-maas" });
	// a key in the environment is enough for a provider pi ships
	process.env.GEMINI_API_KEY = "k";
	await reload();
	p = await providers();
	expect(p.providers.map((x) => x.id).sort()).toEqual(["glm", "google"]);
	delete process.env.GEMINI_API_KEY;
	writeFileSync(join(cfgDir, "cmx2.jsonc"), OWNER);
	await reload();
});

test("s5: a model with a long-context rate carries it as cost.tiers, and one without carries none", async () => {
	const anthropic = (await (await fetch(`${base}/config/providers`)).json()).providers.find((x: any) => x.id === "anthropic").models;
	expect(anthropic["claude-haiku-5-5"].cost).toEqual({
		input: 0.1,
		output: 0.5,
		cache: { read: 0.01, write: 0.125 },
		tiers: [{ inputTokensAbove: 99_999, input: 0.5, output: 2.5, cache: { read: 0.05, write: 0.625 } }],
	});
	expect(anthropic["claude-sonnet-5-5"].cost).toEqual({ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } });
});

test("s4: variants hold only the efforts routing.jsonc lets the model run, named variants included", async () => {
	const efforts = async () => {
		const m = (await providers()).providers.find((x) => x.id === "anthropic")!.models;
		return { opus: Object.keys(m["claude-opus-5-5"]!.variants), sonnet: Object.keys(m["claude-sonnet-5-5"]!.variants) };
	};
	const before = await efforts();
	expect(before.opus).toContain("xhigh");
	writeFileSync(
		join(cfgDir, "cmx2.jsonc"),
		OWNER.replace(`"providers"`, `"variants": { "anthropic/claude-opus-5-5": { "push": { "effort": "xhigh" }, "quick": { "effort": "low" } } }, "providers"`),
	);
	writeFileSync(join(cfgDir, "routing.jsonc"), `{ "never": { "claude-opus-5-5": ["xhigh"] } }`);
	await reload();
	const after = await efforts();
	expect(after.opus).not.toContain("xhigh");
	expect(after.opus).toContain("quick");
	expect(after.opus).not.toContain("push");
	expect(after.sonnet).toEqual(before.sonnet);
	// and the send the picker would have offered is the one the daemon refuses, so the two agree
	const work = join(root, "work");
	mkdirSync(work);
	const s = (await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: work }) })).json()) as { id: string };
	const refused = await fetch(`${base}/session/${s.id}/prompt_async`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, variant: "xhigh" }),
	});
	expect(refused.status).toBe(400);
	console.log(`opus variants before: ${before.opus.join(",")}; after never xhigh: ${after.opus.join(",")}; send at xhigh: ${refused.status}`);
});

test("s1: a provider whose auth is only in headers is still listed", async () => {
	writeFileSync(
		join(cfgDir, "cmx2.jsonc"),
		`{ "model": "glm/zai-org/glm-5-maas", "providers": { "anthropic": { "headers": { "x-api-key": "k" } }, "glm": { "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/glm", "apiKey": "k", "models": { "zai-org/glm-5-maas": { "name": "GLM 5" } } } } }`,
	);
	await reload();
	expect((await providers()).providers.map((x) => x.id).sort()).toEqual(["anthropic", "glm"]);
	writeFileSync(join(cfgDir, "cmx2.jsonc"), OWNER);
	await reload();
});

test("s1: a project layer that changes the default model does not decide the list for every directory", async () => {
	writeFileSync(
		join(cfgDir, "cmx2.jsonc"),
		`{ "model": "glm/zai-org/glm-5-maas", "providers": { "glm": { "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/glm", "apiKey": "k", "models": { "zai-org/glm-5-maas": { "name": "GLM 5" } } } } }`,
	);
	await reload();
	const repo = join(root, "layered");
	mkdirSync(join(repo, ".cmx2"), { recursive: true });
	writeFileSync(join(repo, ".cmx2", "cmx2.jsonc"), `{ "model": "anthropic/claude-opus-5-5" }`);
	// the layered directory asks first
	const layered = (await (await fetch(`${base}/config/providers?directory=${encodeURIComponent(repo)}`)).json()) as Providers;
	expect(layered.providers.map((x) => x.id).sort()).toEqual(["anthropic", "glm"]);
	expect((await providers()).providers.map((x) => x.id)).toEqual(["glm"]);
	writeFileSync(join(cfgDir, "cmx2.jsonc"), OWNER);
	await reload();
});
