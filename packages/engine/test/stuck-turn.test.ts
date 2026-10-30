import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { COMPACTION_DEFAULTS } from "../src/compaction.ts";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession, type TurnEvent } from "../src/session.ts";

/**
 * a turn held open by a tool that ignores the abort signal: abort with a timeout gives up instead of waiting for ever,
 * and once the session is disposed the turn that finishes late reports no turn end, releases no lock and writes nothing
 * to the transcript; the session reopened from it answers the unanswered call and goes on
 */

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
const sseText = (text: string) =>
	[
		start,
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
const sseStuck = () =>
	[
		start,
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_stuck_1", name: "stuck", input: {} } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");

let server: ReturnType<typeof Bun.serve>;
let calls = 0;
const bodies: any[] = [];
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			bodies.push(await req.json().catch(() => null));
			return new Response(calls++ === 0 ? sseStuck() : sseText("done"), { headers: { "content-type": "text/event-stream" } });
		},
	});
});
afterAll(() => server.stop(true));

/** a tool that returns only when the test lets it, whatever the signal says */
let release: () => void = () => {};
let entered: () => void = () => {};
const stuck = {
	name: "stuck",
	label: "stuck",
	description: "a call that never returns on its own",
	parameters: Type.Object({}),
	async execute() {
		entered();
		await new Promise<void>((r) => {
			release = r;
		});
		return { content: [{ type: "text" as const, text: "finally" }], details: {} };
	},
};

function config(): Config {
	return {
		...structuredClone(DEFAULTS),
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		permission: "allow",
		providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } },
		compaction: { ...COMPACTION_DEFAULTS, auto: false },
		sources: [],
	};
}

test("abort with a timeout answers false while a tool holds the turn; the disposed session's late turn reports nothing, releases no lock and writes nothing", async () => {
	const turns: TurnEvent[] = [];
	let afterTurns = 0;
	let eventsAfterDispose = 0;
	let disposed = false;
	const cwd = mkdtempSync(join(tmpdir(), "cmx2-stuck-"));
	const dataDir = mkdtempSync(join(tmpdir(), "cmx2-stuck-data-"));
	const s = await EngineSession.create({
		cwd,
		config: config(),
		dataDir,
		extraTools: [stuck as never],
		onEvent: () => {
			if (disposed) eventsAfterDispose++;
		},
		onStep: () => {},
		onTurn: (e) => turns.push(e),
		afterTurn: () => afterTurns++,
	});
	const inTool = new Promise<void>((r) => {
		entered = r;
	});
	// prompt resolves when the turn ends, which is what this test holds off
	const turn = s.prompt("call stuck").catch(() => {});
	await inTool;
	expect(s.state).toBe("busy");
	const t0 = Date.now();
	expect(await s.abort(150)).toBe(false);
	expect(Date.now() - t0).toBeLessThan(1_000);
	expect(s.state).toBe("busy");
	s.dispose();
	disposed = true;
	const file = join(dataDir, "sessions", `${s.id}.jsonl`);
	const lines = () => readFileSync(file, "utf8").trim().split("\n").length;
	const before = lines();
	// the tool finishes late: the turn winds down in the disposed session
	release();
	await turn;
	await s.idle();
	await Bun.sleep(50);
	expect(turns.map((e) => e.type)).toEqual(["start"]);
	expect(afterTurns).toBe(0);
	expect(lines()).toBe(before);
	expect(eventsAfterDispose).toBe(0);

	// reopened from its transcript, the session answers the dangling call and its next turn completes
	const again = await EngineSession.create({ id: s.id, resume: {}, cwd, config: config(), dataDir, extraTools: [stuck as never], onEvent: () => {}, onStep: () => {}, onTurn: (e) => turns.push(e) });
	bodies.length = 0;
	await again.prompt("go on");
	await again.idle();
	expect(turns.at(-1)).toMatchObject({ type: "end", outcome: "completed" });
	const sent = JSON.stringify(bodies[0]?.messages ?? []);
	expect(sent).toContain('"tool_use_id":"toolu_stuck_1"');
	expect(sent).not.toContain("finally");
	again.dispose();
}, 15_000);
