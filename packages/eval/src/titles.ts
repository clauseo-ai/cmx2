/**
 * session titles against the real providers in your profile: each model named (or the title model and
 * the profile's default model) names a few sample first messages through the structured request, and the
 * script prints the title, how it came back (json_schema, tool or the text fallback) and its cost. a few
 * tiny requests per model.
 *   bun packages/eval/src/titles.ts [provider/model ...]
 */

import { loadConfig } from "@cmx2/engine/config";
import { resolveModel } from "@cmx2/engine/models";
import { TITLE_MODEL, titleWith } from "@cmx2/engine/title";

const SAMPLES = [
	"the login form on the settings page submits twice when you press enter, can you find out why and fix it",
	"write a bash script that backs up ~/projects to an external drive every night and keeps the last 7 copies",
	"plan how we'd test our markdown document editor end to end with claude code driving a browser",
];

const config = loadConfig();
const refs = process.argv.slice(2).length ? process.argv.slice(2) : [TITLE_MODEL, config.model];
let misses = 0;
for (const ref of refs) {
	let model: Awaited<ReturnType<typeof resolveModel>>;
	try {
		model = await resolveModel(config, ref);
	} catch (e) {
		console.log(`${ref}: ${e instanceof Error ? e.message : String(e)}`);
		misses++;
		continue;
	}
	for (const text of SAMPLES) {
		const t0 = performance.now();
		const t = await titleWith(config, ref, model, text);
		const ms = Math.round(performance.now() - t0);
		if (!t) misses++;
		console.log(`${ref} [${model.api}] ${t ? `${t.via}: "${t.title}" $${t.cost.toFixed(5)}` : "no title"} ${ms} ms`);
	}
}
process.exit(misses ? 1 : 0);
