/**
 * the spawn verb as the model calls it (R6, R4.3): a model alias instead of a seat, a missing model named in
 * the tool's own answer, `after` and the line that says a task failed twice on one model, an agent type that
 * brings its own model, and the agents list with context and cost. a daemon in this process whose provider
 * is a scripted stand-in on loopback speaking anthropic's stream, so the whole path runs without a model.
 *
 * run: bun test packages/server/test/spawn.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-spawn-"));
const ROOT = join(SCRATCH, `spawn-${nonce()}`);
const WORK = join(ROOT, "work");
const CONFIG = join(ROOT, "config");
mkdirSync(join(WORK, ".cmx2", "agent"), { recursive: true });
mkdirSync(CONFIG, { recursive: true });
// a pal that runs on opus: the agent type names the model, so a spawn of it needs none
writeFileSync(join(WORK, ".cmx2", "agent", "pal.md"), "---\ndescription: a pal on opus\nmodel: opus\n---\nyou are a pal\n");
// the user's notes in the profile: a session they start gets them, a helper does not
const NOTES = `notes-${nonce()}`;
writeFileSync(join(CONFIG, "AGENTS.md"), `\n${NOTES}\n\n`);
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
const PORT = port(4835);
const BASE = `http://127.0.0.1:${PORT}`;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** the root's first user message carries [chain]; the number of tool results so far picks the step */
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", text: "a title" }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	if (!first.includes("[chain]")) return [{ type: "text", text: "hi" }];
	const all = JSON.stringify(messages);
	const answered = (all.match(/"type":"tool_result"/g) ?? []).length;
	const idOf = (name: string) => all.match(new RegExp(`/root/${name} \\(id (ses_[0-9a-f]+)\\)`))?.[1] ?? "ses_missing";
	const steps: Block[] = [
		{ type: "tool_use", name: "spawn", input: { name: "nomodel", brief: "no model named" } },
		{ type: "tool_use", name: "spawn", input: { name: "slash", model: "anthropic/claude-opus-5-5", brief: "a provider/model-id from the model" } },
		{ type: "tool_use", name: "spawn", input: { name: "blocked", model: "fable", brief: "a model the profile blacklists" } },
		{ type: "tool_use", name: "spawn", input: { name: "first", model: "sonnet", brief: "first try" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "spawn", input: { name: "second", model: "sonnet", after: idOf("first"), why: "needs judgment", brief: "second try" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "spawn", input: { name: "third", model: "sonnet", after: "/root/second", brief: "third try" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "spawn", input: { name: "pal1", agent_type: "pal", brief: "as a pal" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "spawn", input: { name: "rev", model: "opus", agent_type: "review", effort: "low", after: "third", brief: "review it" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "spawn", input: { name: "look", model: "sonnet", agent_type: "explore", effort: "low", brief: "look around" } },
		{ type: "tool_use", name: "wait", input: { timeout_ms: 20000 } },
		{ type: "tool_use", name: "agents", input: {} },
	];
	return [steps[answered] ?? { type: "text", text: "done" }];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				const put = (s: string) => c.enqueue(enc.encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "tool_use") {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: b.name, input: {} } }));
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
					} else {
						put(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
						put(sse("content_block_delta", { index, delta: { type: "text_delta", text: b.text } }));
					}
					put(sse("content_block_stop", { index }));
				}
				put(sse("message_delta", { delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused", blacklist: ["claude-fable-*"] } }, sources: [] });
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
	if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
});

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return (await res.json()) as any;
};

async function turn(text: string) {
	const id = (await api("/session", { directory: WORK, title: `it-spawn-${nonce()}`, model: "anthropic/claude-opus-5-5" })).id as string;
	await api(`/session/${id}/prompt`, { text });
	const t0 = Date.now();
	for (;;) {
		const status = await api("/session/status");
		if (!status[id] || status[id].type === "idle") {
			const msgs = (await api(`/session/${id}/message`)) as any[];
			if (msgs.some((m) => m.info.role === "assistant" && m.parts.some((p: any) => p.type === "text" && p.text === "done"))) return { id, msgs };
		}
		if (Date.now() - t0 > 60_000) throw new Error("the turn did not settle");
		await Bun.sleep(50);
	}
}

const toolParts = (msgs: any[], tool: string) => msgs.flatMap((m) => m.parts).filter((p: any) => p.type === "tool" && p.tool === tool);
const out = (p: any) => String(p.state.output ?? p.state.error ?? "");

describe("the spawn verb takes a model", () => {
	test("the tool answers in labels and model ids, refuses what the table does not name, and tells the third attempt on one model which it is", async () => {
		const { id, msgs } = await turn("[chain] run the chain");
		const spawns = toolParts(msgs, "spawn");
		// a spawn with no model and no agent type to bring one is an error that names the aliases
		expect(out(spawns[0])).toBe("BadRequestError: a spawn needs a model: one of haiku, sonnet, opus, fable");
		expect(spawns[0].state.status).toBe("error");
		// the model-facing verb takes aliases: a provider/model-id would step around the table
		expect(out(spawns[1])).toBe("UnknownModelError: no model named anthropic/claude-opus-5-5 in routing.jsonc; the models are haiku, sonnet, opus, fable");
		// the profile's blacklist holds for the model a spawn ends up on
		expect(out(spawns[2])).toBe("BadRequestError: anthropic/claude-fable-5-1 is on the blacklist in your profile (providers.<id>.blacklist); pick another model");
		expect(out(spawns[3])).toMatch(/^spawned \/root\/first \(id ses_[0-9a-f]+\): sonnet on claude-sonnet-5-5 at high, (queued|working)\.\nits report arrives as a message when it ends its turn\. to continue it later: message\("ses_[0-9a-f]+"\)\.$/);
		// two earlier attempts on sonnet: the third spawn on it hears which attempt it is
		const note = "this is attempt 3 on sonnet; if it falls short, step up or do it yourself.";
		expect(out(spawns[4])).not.toContain("this is attempt");
		expect(out(spawns[5])).toContain(note);
		// an agent type that names a model needs none from the spawn; the label is the alias the type used
		expect(out(spawns[6])).toMatch(/\/root\/pal1 \(id ses_[0-9a-f]+\): opus on claude-opus-5-5 at high, /);
		// a review child and an effort that moves the alias's default
		expect(out(spawns[7])).toMatch(/\/root\/rev \(id ses_[0-9a-f]+\): opus on claude-opus-5-5 at low, /);

		const roster = await api(`/session/${id}/agents`);
		const byPath = (p: string) => roster.agents.find((a: any) => a.path === p);
		expect(roster.agents.map((a: any) => [a.path, a.seat]).sort()).toEqual([
			["/root", "driver"],
			["/root/first", "sonnet"],
			["/root/look", "sonnet"],
			["/root/nomodel", undefined],
			["/root/pal1", "opus"],
			["/root/rev", "opus"],
			["/root/second", "sonnet"],
			["/root/third", "sonnet"],
		].filter((r) => r[1] !== undefined));
		const kids = ((await api(`/session/${id}/children`)) as any[]).map((k) => k.title).sort();
		expect(kids).toEqual(["first (sonnet)", "look (sonnet)", "pal1 (opus)", "rev (opus)", "second (sonnet)", "third (sonnet)"]);

		// the first message of a step-up carries the earlier attempt
		const second = await api(`/session/${byPath("/root/second").id}/message`);
		const task = second[0].parts[0].text as string;
		expect(task).toContain("you are /root/second (session ");
		expect(task).toContain("started by /root (session ");
		expect(task).toContain("second try\n\nan earlier attempt at this task, by /root/first.\nits brief:\nfirst try\nits last report:\nhi");
		// the helper is told neither its model nor its effort, and never the spawner's why
		expect(task).not.toMatch(/effort|anthropic\/claude|needs judgment/);
		expect(byPath("/root/second").why).toBe("needs judgment");
		expect(byPath("/root/first").why).toBeUndefined();
		const metrics = await api(`/session/${id}/agents/metrics`);
		// the same model at the same effort is a retry; another model or effort is a step up (after took an id, a path and a name here)
		const attempts = metrics.events.filter((e: any) => e.kind === "step_up" || e.kind === "retry");
		expect(attempts.map((e: any) => [e.kind, e.from_label, e.to_label])).toEqual([
			["retry", "sonnet", "sonnet"],
			["retry", "sonnet", "sonnet"],
			["step_up", "sonnet", "opus"],
		]);
		expect(attempts[0]).toMatchObject({ from_id: byPath("/root/first").id, child: byPath("/root/second").id, from_model: "anthropic/claude-sonnet-5-5", to_model: "anthropic/claude-sonnet-5-5", from_effort: "high", to_effort: "high", why: "needs judgment" });
		expect(attempts[1]).not.toHaveProperty("why");

		// the agents list: model label, model id, effort, state, context size and cost per step and in all
		const list = out(toolParts(msgs, "agents")[0]);
		const line = list.split("\n").find((l) => l.startsWith("- /root/first "))!;
		expect(line).toMatch(/^- \/root\/first · sonnet · claude-sonnet-5-5 · high · parked · ctx \d+k · \$0\.\d+\/step · \$0\.\d+ total · last: hi · id ses_[0-9a-f]+$/);
		expect(list).toContain("- /root/pal1 · opus · claude-opus-5-5 · high · parked");
		expect(list.split("\n").find((l) => l.startsWith("- /root/second "))).toContain(" · why: needs judgment · last: hi · id ses_");
		// the root's row names the model it runs on and its standing effort, from its session (the row itself holds neither)
		const rootRow = byPath("/root");
		expect(rootRow.model).toBe("anthropic/claude-opus-5-5");
		expect(rootRow.effort).toMatch(/^(low|medium|high|xhigh|max)$/);
		expect(list).toContain(`- /root · driver · claude-opus-5-5 · ${rootRow.effort} · `);
		expect(list).not.toContain("driver · ? · ?");
		// and over rest: the same three numbers, on agents that have taken a step
		const first = byPath("/root/first");
		expect(first.contextTokens).toBeGreaterThanOrEqual(20);
		expect(first.lastStepCost).toBeGreaterThan(0);
		expect(first.cost).toBeGreaterThan(0);
		expect(first.cost).toBeGreaterThanOrEqual(first.lastStepCost);
	}, 90_000);

	test("a review child declares shell and no edit, and an explore child declares neither", async () => {
		const { id } = await turn("[chain] run the chain again");
		const roster = (await api(`/session/${id}/agents`)).agents as any[];
		const rev = roster.find((a) => a.path === "/root/rev");
		const toolsOf = async (sid: string) => ((await api(`/session/${sid}/requests`)) as any[]).at(-1).tools as string[];
		const tools = await toolsOf(rev.id);
		expect(tools).toContain("shell");
		expect(tools).toContain("run");
		expect(tools).not.toContain("edit");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("worktree_create");
		const look = roster.find((a) => a.path === "/root/look");
		const lookTools = await toolsOf(look.id);
		for (const t of ["shell", "run", "edit", "write", "worktree_create"]) expect(lookTools).not.toContain(t);
		expect(lookTools).toContain("read");
		const prefix = await api(`/session/${rev.id}/prefix`);
		expect(prefix.bytes).toContain("your tools read, search and run commands; you do not change files.");
		expect(prefix.bytes).not.toContain("seat");
		// the profile's AGENTS.md ends the prompt of the session the user started, trimmed and wrapped, and of no helper
		const rootPrefix = (await api(`/session/${id}/prefix`)).bytes as string;
		expect(rootPrefix).toContain(`notes from the user for every session they start, kept in ${join(CONFIG, "AGENTS.md")}:\\n\\n<user_notes>\\n${NOTES}\\n</user_notes>`);
		for (const helper of [rev, look]) expect((await api(`/session/${helper.id}/prefix`)).bytes).not.toContain("user_notes");
	}, 90_000);
});
