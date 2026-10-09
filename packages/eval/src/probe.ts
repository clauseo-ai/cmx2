/**
 * beta probe: one request per feature per model against the configured anthropic endpoint,
 * printed as a table of http status. run with `bun run probe`.
 */
import { loadConfig } from "@cmx2/engine/config";

const config = loadConfig();
const anthropic = config.providers.anthropic ?? {};
const base = (anthropic.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
const key = resolveKey(anthropic.apiKey) ?? process.env.ANTHROPIC_API_KEY;
if (!key) {
	console.error("no anthropic key: set ANTHROPIC_API_KEY or providers.anthropic.apiKey in cmx2.jsonc");
	process.exit(2);
}

function resolveKey(v?: string): string | undefined {
	if (!v) return undefined;
	if (v.startsWith("$")) return process.env[v.slice(1).replace(/^\{|\}$/g, "")];
	return v;
}

const models = (process.argv[2] ?? "claude-opus-5-5,claude-fable-5-1,claude-sonnet-5-5").split(",");
// long enough to clear every model's minimum cacheable prefix
const LONG_SYSTEM = `you answer in one word.\n${"reference material, ignore. ".repeat(900)}`;
const tool = {
	name: "lookup",
	description: "look up a word",
	input_schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
};

interface Probe {
	feature: string;
	beta: string[];
	body: (model: string) => Record<string, unknown>;
	/** extra check on a 200 body; returns a note */
	note?: (res: any) => string;
}

const user = (text: string) => ({ role: "user", content: text });
const baseBody = (model: string) => ({ model, max_tokens: 64, messages: [user("say ok")] });

const probes: Probe[] = [
	{ feature: "baseline (no betas)", beta: [], body: baseBody },
	{
		// negative control: a beta that has never existed. a 400 here means betas reach anthropic and are
		// validated there, so a 200 on the real betas below is acceptance, not a proxy that drops headers
		feature: "negative control (invented beta)",
		beta: ["cmx2-invented-negative-control-2099-01-01"],
		body: baseBody,
	},
	{
		feature: "per-message effort",
		beta: ["mid-conversation-output-config-2026-07-01"],
		body: (m) => ({
			...baseBody(m),
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
			messages: [user("say ok"), { role: "system", content: [], output_config: { effort: "low" } }],
		}),
	},
	{
		feature: "block binding drop_block",
		beta: ["thinking-binding-controls-2026-08-01"],
		body: (m) => ({
			...baseBody(m),
			thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		}),
	},
	{
		feature: "turn-scoped system (clear_at)",
		beta: ["mid-conversation-system-clear-at-2026-08-21"],
		body: (m) => ({
			...baseBody(m),
			messages: [
				user("say ok"),
				{ role: "system", content: [{ type: "text", text: "answer in capitals" }], clear_at: "next_user_message" },
			],
		}),
	},
	{
		feature: "tool search (defer_loading)",
		beta: ["advanced-tool-use-2025-11-20"],
		body: (m) => ({
			...baseBody(m),
			tools: [
				{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
				{ ...tool, defer_loading: true },
			],
		}),
	},
	{
		feature: "mid-conversation tool changes",
		beta: ["mid-conversation-tool-changes-2026-07-01"],
		body: (m) => ({
			...baseBody(m),
			tools: [{ ...tool, name: "anchor" }, { ...tool, defer_loading: true }],
			messages: [
				user("say ok"),
				{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } }] },
			],
		}),
	},
	{
		feature: "1h cache ttl",
		beta: [],
		body: (m) => ({
			...baseBody(m),
			system: [{ type: "text", text: LONG_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
		}),
		note: (r) => {
			const u = r.usage ?? {};
			const h1 = u.cache_creation?.ephemeral_1h_input_tokens;
			return `write ${u.cache_creation_input_tokens ?? 0} read ${u.cache_read_input_tokens ?? 0}${h1 !== undefined ? ` (1h ${h1})` : ""}`;
		},
	},
];

async function send(p: Probe, model: string): Promise<{ status: number; note: string }> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		"x-api-key": key!,
		...(anthropic.headers ?? {}),
	};
	if (p.beta.length) headers["anthropic-beta"] = p.beta.join(",");
	const t0 = performance.now();
	const res = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify(p.body(model)),
		signal: AbortSignal.timeout(90_000),
	});
	const ms = Math.round(performance.now() - t0);
	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	if (res.ok) return { status: res.status, note: `${ms} ms${p.note ? `, ${p.note(json)}` : ""}` };
	const msg = json?.error?.message ?? text.slice(0, 160);
	return { status: res.status, note: String(msg).replace(/\s+/g, " ").slice(0, 140) };
}

console.log(`endpoint ${base.replace(/\/\/[^/]+/, "//<endpoint>")} (host masked), ${new Date().toISOString()}\n`);
const rows: string[][] = [];
for (const p of probes) {
	for (const m of models) {
		const r = await send(p, m).catch((e) => ({ status: 0, note: String(e?.message ?? e).slice(0, 140) }));
		rows.push([p.feature, p.beta.join(",") || "-", m, String(r.status), r.note]);
		console.log(`| ${rows.at(-1)!.join(" | ")} |`);
	}
}
