import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { getJson } from "../api.ts";
import { connect } from "../daemon.ts";
import { fail } from "../util.ts";

export const help = `cmx2 models: the models this machine can run

usage:
  cmx2 models [provider] [--json] [--port n]

one line per model: provider/id, context window, the variants you can pick (efforts, and any named
variants from your profile), and * on each provider's default. models on the blacklist in your
profile are left out. the list comes from the daemon (the running one, or one started for this
command), so it is exactly what a client's model picker shows.

add models under providers in ~/.config/cmx2/cmx2.jsonc; pick the default with model.`;

interface ProviderList {
	providers: Array<{ id: string; models: Record<string, { id: string; name: string; limit: { context: number; output: number }; variants?: Record<string, unknown> }> }>;
	default: Record<string, string>;
}

const k = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`);

export async function main(args: string[]) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" }, port: { type: "string" } } });
	const d = await connect({ port: values.port }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
	try {
		const list = await getJson<ProviderList>(d, "/config/providers", realpathSync(process.cwd()));
		const want = positionals[0];
		const providers = list.providers.filter((p) => !want || p.id === want);
		if (want && !providers.length) fail(`no provider named ${want}. the daemon knows ${list.providers.map((p) => p.id).join(", ") || "none"}`);
		if (values.json) return console.log(JSON.stringify(want ? { providers, default: { [want]: list.default[want] } } : list, null, 2));
		const rows = providers.flatMap((p) =>
			Object.values(p.models).map((m) => ({ ref: `${p.id}/${m.id}`, def: list.default[p.id] === m.id, ctx: k(m.limit.context), variants: Object.keys(m.variants ?? {}).join(" ") || "none" })),
		);
		if (!rows.length) return console.log("no models. set ANTHROPIC_API_KEY, or add a provider under providers in cmx2.jsonc");
		const w = Math.max(...rows.map((r) => r.ref.length));
		for (const r of rows) console.log(`${r.def ? "*" : " "} ${r.ref.padEnd(w)}  ${r.ctx.padStart(5)}  ${r.variants}`);
	} finally {
		await d.stop?.();
	}
}
