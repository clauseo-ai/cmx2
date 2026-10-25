import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasArgs, toolAlias } from "../src/calls.ts";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/**
 * names models bring from other harnesses: a call to bash runs shell, and edit reads old_str and new_str
 * as old_text and new_text. the engine, pi's agent loop and its anthropic adapter run for real against a
 * local upstream that answers with those calls
 */

test("toolAlias maps only names no tool has; aliasArgs renames and lets the real name win", () => {
	expect(toolAlias("bash", () => false)).toBe("shell");
	expect(toolAlias("bash", (n) => n === "bash")).toBe("bash");
	expect(toolAlias("read", () => false)).toBe("read");
	expect(aliasArgs("edit", { path: "a", old_str: "x", new_str: "y" })).toEqual({ path: "a", old_text: "x", new_text: "y" });
	expect(aliasArgs("edit", { path: "a", old_str: "x", old_text: "z", new_text: "y" })).toEqual({ path: "a", old_text: "z", new_text: "y" });
	const plain = { path: "a", old_text: "x", new_text: "y" };
	expect(aliasArgs("edit", plain)).toBe(plain);
	expect(aliasArgs("write", { old_str: "x" })).toEqual({ old_str: "x" });
});

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (id: string) =>
	ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
const toolUse = (index: number, id: string, name: string, input: unknown) => [
	ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
	ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
	ev("content_block_stop", { type: "content_block_stop", index }),
];
const end = (reason: string) => [ev("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }), ev("message_stop", { type: "message_stop" })];

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-aliases-")));
const target = join(cwd, "a.txt");
const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			requests.push(await req.json());
			const body =
				requests.length === 1
					? [
							start("msg_one"),
							...toolUse(0, "toolu_bash", "bash", { command: "echo from-bash" }),
							...toolUse(1, "toolu_edit", "edit", { path: target, old_str: "before", new_str: "after" }),
							...end("tool_use"),
						]
					: [
							start("msg_two"),
							ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
							ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
							ev("content_block_stop", { type: "content_block_stop", index: 0 }),
							...end("end_turn"),
						];
			return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
});

afterAll(() => server.stop(true));

test("a call to bash runs shell and an edit with old_str and new_str applies, with bash never declared", async () => {
	writeFileSync(target, "before\n");
	const config: Config = {
		...structuredClone(DEFAULTS),
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		permission: { "*": "allow" },
		providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } },
		sources: [],
	};
	const s = await EngineSession.create({ cwd, config, dataDir: mkdtempSync(join(tmpdir(), "cmx2-aliases-data-")), onEvent: () => {}, onStep: () => {} });
	await s.prompt("go");
	await s.idle();
	s.dispose();
	expect(readFileSync(target, "utf8")).toBe("after\n");
	const results = s.messages.filter((m: any) => m.role === "toolResult") as any[];
	expect(results.map((r) => [r.toolName, r.isError])).toEqual([
		["shell", false],
		["edit", false],
	]);
	expect(JSON.stringify(results[0].content)).toContain("from-bash");
	expect(requests.length).toBe(2);
	// the tools sent to the model never include bash; the call goes back to it under the name that ran
	for (const r of requests) expect((r.tools ?? []).map((t: any) => t.name)).not.toContain("bash");
	const sent = requests[1].messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use");
	expect(sent.map((b: any) => b.name)).toEqual(["shell", "edit"]);
});
