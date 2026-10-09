import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "@cmx2/engine/config";
import { Store } from "@cmx2/store";
import { fail } from "../util.ts";

export const help = `cmx2 stats: what your sessions cost and how the steps went

usage:
  cmx2 stats [--days n] [--session id] [--json]

from the step telemetry in your own database (nothing leaves the machine): sessions, turns, model
steps, units of work per step (tool calls plus calls made inside run scripts), the share of input
read from the prompt cache, time to first token, poll-only steps, effort escalations, cost, the models
that cost the most, the helpers by model label (spawns, step-ups, retries, cost, hours) and a line per day.
--days picks the window (default 7); --session narrows to one session and its agents.

imported cmx history carries no step telemetry, so it is not counted here.`;

interface Totals {
	steps: number;
	sessions: number;
	input: number;
	cache_read: number;
	cache_write: number;
	output: number;
	cost: number;
	calls: number;
	tool_calls: number;
	poll_only: number;
	escalations: number;
	ttft_ms: number | null;
	duration_ms: number | null;
}

const pct = (t: { input: number; cache_read: number; cache_write: number }) => {
	const d = t.input + t.cache_read + t.cache_write;
	return d ? `${((100 * t.cache_read) / d).toFixed(1)}%` : "n/a";
};
const money = (n: number) => `$${n.toFixed(n < 10 ? 4 : 2)}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export async function main(args: string[]) {
	const { values } = parseArgs({ args, options: { days: { type: "string" }, session: { type: "string" }, json: { type: "boolean" } } });
	const days = values.days ? Number(values.days) : 7;
	if (!Number.isFinite(days) || days <= 0) fail(`--days must be a number above 0, got ${values.days}`);
	const store = new Store(join(dataDir(), "cmx2.db"));
	try {
		const since = values.session ? 0 : Date.now() - days * 86_400_000;
		let scope = "s.at >= $since";
		const args: Record<string, string | number> = { since };
		if (values.session) {
			if (!store.session(values.session)) fail(`there is no session ${values.session}; cmx2 session list shows the ids`);
			// the session and every agent below it: agents share the root's id as root_id
			scope = "(s.session_id = $sid or s.session_id in (select id from agent where root_id = $sid))";
			args.sid = values.session;
		}
		const q = <T>(sql: string) => store.db.query(sql).all(args as never) as T[];
		const t = q<Totals>(
			`select count(*) as steps, count(distinct s.session_id) as sessions, coalesce(sum(input), 0) as input, coalesce(sum(cache_read), 0) as cache_read,
			   coalesce(sum(cache_write), 0) as cache_write, coalesce(sum(output), 0) as output, coalesce(sum(cost), 0) as cost, coalesce(sum(calls), 0) as calls,
			   coalesce(sum(tool_calls), 0) as tool_calls, coalesce(sum(poll_only), 0) as poll_only, count(escalation) as escalations,
			   avg(ttft_ms) as ttft_ms, avg(duration_ms) as duration_ms
			 from step s where ${scope}`,
		)[0]!;
		const turnScope = values.session ? scope.replaceAll("s.session_id", "m.session_id") : "m.created_at >= $since";
		const turns = (q<{ n: number }>(`select count(*) as n from message m where m.role = 'user' and ${turnScope}`)[0]?.n ?? 0) as number;
		const models = q<{ model: string; steps: number; cost: number; input: number; cache_read: number; cache_write: number }>(
			`select model, count(*) as steps, sum(cost) as cost, sum(input) as input, sum(cache_read) as cache_read, sum(cache_write) as cache_write
			 from step s where ${scope} group by model order by cost desc limit 5`,
		);
		const perDay = q<{ day: string; sessions: number; steps: number; cost: number; input: number; cache_read: number; cache_write: number }>(
			`select date(at / 1000, 'unixepoch', 'localtime') as day, count(distinct session_id) as sessions, count(*) as steps, sum(cost) as cost,
			   sum(input) as input, sum(cache_read) as cache_read, sum(cache_write) as cache_write
			 from step s where ${scope} group by day order by day`,
		);
		// helpers by the label they were spawned under: each agent row joined to its session's steps; a step-up is a spawn that took over an earlier attempt
		const helperScope = values.session ? "a.root_id = $sid" : "a.created_at >= $since";
		const helpers = q<{ label: string; spawns: number; cost: number; hours: number }>(
			`select coalesce(a.seat, '?') as label, count(distinct a.id) as spawns, coalesce(sum(s.cost), 0) as cost, coalesce(sum(s.duration_ms), 0) / 3600000.0 as hours
			 from agent a left join step s on s.session_id = a.id where a.depth > 0 and ${helperScope} group by label order by cost desc`,
		);
		// a step up changes the model or the effort of the attempt it takes over; the same model at the same effort is a retry
		const attempts = q<{ kind: string; to_label: string | null; from_label: string | null }>(
			`select m.kind, json_extract(m.data, '$.to_label') as to_label, json_extract(m.data, '$.from_label') as from_label from agent_metric m
			 where m.kind in ('step_up', 'retry') and ${values.session ? "m.root_id = $sid" : "m.at >= $since"}`,
		);
		const count = (kind: string, side: "to_label" | "from_label", label: string) => attempts.filter((x) => x.kind === kind && (x[side] ?? "?") === label).length;
		const byLabel = helpers.map((h) => ({
			...h,
			stepped_up_to: count("step_up", "to_label", h.label),
			stepped_up_from: count("step_up", "from_label", h.label),
			retries: count("retry", "to_label", h.label),
		}));
		if (values.json) return console.log(JSON.stringify({ window: values.session ? { session: values.session } : { days, since }, turns, ...t, models, helpers: byLabel, perDay }, null, 2));
		const what = values.session ? `session ${values.session} and its agents` : `the last ${days} day${days === 1 ? "" : "s"}`;
		if (!t.steps) return console.log(`no model steps in ${what}. telemetry starts with the first turn a cmx2 daemon runs`);
		console.log(`${what}: ${t.sessions} session${t.sessions === 1 ? "" : "s"}, ${turns} turn${turns === 1 ? "" : "s"}, ${t.steps} steps, ${money(t.cost)}`);
		console.log(`  work per step ${(t.calls / t.steps).toFixed(2)} (native tool calls ${(t.tool_calls / t.steps).toFixed(2)}), cache read ${pct(t)}, first token ${t.ttft_ms === null ? "n/a" : `${(t.ttft_ms / 1000).toFixed(1)} s`}, step ${t.duration_ms === null ? "n/a" : `${(t.duration_ms / 1000).toFixed(1)} s`} on average`);
		console.log(`  tokens: ${tokens(t.input)} input, ${tokens(t.cache_read)} cache read, ${tokens(t.cache_write)} cache write, ${tokens(t.output)} output`);
		console.log(`  poll-only steps ${t.poll_only}, effort escalations ${t.escalations}`);
		console.log("models by cost:");
		for (const m of models) console.log(`  ${m.model}  ${m.steps} steps  ${money(m.cost)}  cache read ${pct(m)}`);
		if (byLabel.length) {
			console.log("helpers by model:");
			for (const h of byLabel) console.log(`  ${h.label}  ${h.spawns} spawn${h.spawns === 1 ? "" : "s"}  ${h.stepped_up_to} step-up${h.stepped_up_to === 1 ? "" : "s"} to it, ${h.stepped_up_from} from it, ${h.retries} retr${h.retries === 1 ? "y" : "ies"}  ${money(h.cost)}  ${h.hours.toFixed(2)} h`);
		}
		if (perDay.length > 1 || !values.session) {
			console.log("per day:");
			for (const d of perDay) console.log(`  ${d.day}  ${d.sessions} sessions  ${d.steps} steps  ${money(d.cost)}  cache read ${pct(d)}`);
		}
	} finally {
		store.close();
	}
}
