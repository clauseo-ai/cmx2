import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/**
 * an mcp server that goes away must cost one tool_removal, not a removal and a re-addition every turn.
 * the session used to withdraw the tools between requests of a run but leave the agent's own list stale,
 * so each new prompt declared them again; 53 xcode tools a turn passed the api's 512 tool_addition cap.
 * a local upstream speaks anthropic's stream; the engine, pi's adapter and the sdk run for real.
 */

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const start = ev("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
const end = (stop: string) => ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }) + ev("message_stop", {});
const textReply = (text: string) =>
	start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) + ev("content_block_stop", { index: 0 }) + end("end_turn");
const globReply = () =>
	start +
	ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_glob1", name: "glob", input: {} } }) +
	ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ pattern: "*.nothing" }) } }) +
	ev("content_block_stop", { index: 0 }) +
	end("tool_use");

let replies: string[] = [];
const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests.push(await req.json().catch(() => null));
			return new Response(replies.shift() ?? textReply("fallback"), { headers: { "content-type": "text/event-stream" } });
		},
	});
});
afterAll(() => server.stop(true));

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] };
}

/** tool_addition and tool_removal blocks for one tool across a request's messages */
function changes(body: any, name: string) {
	const blocks = (body.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
	const count = (type: string) => blocks.filter((b: any) => b.type === type && b.tool?.name === name).length;
	return { added: count("tool_addition"), removed: count("tool_removal") };
}

test("a loaded mcp tool whose server went away is withdrawn once and not re-added on later turns", async () => {
	let connected = true;
	const ping = {
		name: "xs_ping",
		label: "ping",
		description: "ping (mcp server xs, tool ping)",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }),
	};
	const s = await EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-toolsync-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-toolsync-data-")),
		dynamicTools: () => (connected ? [ping as never] : []),
		onEvent: () => {},
		onStep: () => {},
	});
	try {
		// loaded while the server is up, as tool_search would
		expect((s as any).loadTools(["xs_ping"])).toEqual(["xs_ping"]);
		replies = [textReply("one")];
		await s.prompt("one");
		await s.idle();
		expect(changes(requests.at(-1), "xs_ping")).toEqual({ added: 1, removed: 0 });

		// the server goes away; a turn with a tool call runs several requests
		connected = false;
		replies = [globReply(), textReply("two")];
		await s.prompt("two");
		await s.idle();
		expect(changes(requests.at(-1), "xs_ping")).toEqual({ added: 1, removed: 1 });

		// later turns with tool calls: nothing more is added or removed
		for (const p of ["three", "four"]) {
			replies = [globReply(), textReply(p)];
			await s.prompt(p);
			await s.idle();
		}
		expect(changes(requests.at(-1), "xs_ping")).toEqual({ added: 1, removed: 1 });

		// the server comes back: one re-addition, and it is callable again
		connected = true;
		replies = [textReply("five")];
		await s.prompt("five");
		await s.idle();
		expect(changes(requests.at(-1), "xs_ping")).toEqual({ added: 2, removed: 1 });
	} finally {
		s.dispose();
	}
}, 30_000);

test("a revert leaves loaded what the remaining context declares, as a resume would", async () => {
	const ping = { name: "xs_ping", label: "ping", description: "ping (mcp server xs, tool ping)", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }) };
	const s = await EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-toolsync-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-toolsync-data-")),
		dynamicTools: () => [ping as never],
		onEvent: () => {},
		onStep: () => {},
	});
	try {
		replies = [textReply("one")];
		await s.prompt("one");
		await s.idle();
		const before = s.messages.length;
		// loaded and declared in a turn that is then reverted
		(s as any).loadTools(["xs_ping"]);
		replies = [textReply("two")];
		await s.prompt("two");
		await s.idle();
		expect(changes(requests.at(-1), "xs_ping").added).toBe(1);
		s.revert(before + 1);
		expect([...(s as any).loaded]).toEqual([]);
		// the next turn neither declares it nor withdraws it: it was never there
		replies = [textReply("three")];
		await s.prompt("three");
		await s.idle();
		expect(changes(requests.at(-1), "xs_ping")).toEqual({ added: 0, removed: 0 });
	} finally {
		s.dispose();
	}
}, 30_000);
