#!/usr/bin/env bun
/**
 * a canned openai-compatible endpoint for ci's platform smoke of the binary (the windows-binary job). it is not a
 * model and not a test of model behaviour: it answers a turn with one fixed shell call, then quotes the shell's
 * output back, so `cmx2 run` drives the real daemon, the real shell tool and git bash end to end with no key.
 *
 *   bun scripts/ci-provider.ts [port]     (default 4832)
 *
 * a request whose messages hold a tool result gets text quoting it; one that offers the shell tool gets the call;
 * anything else (the title request beside the first turn) gets a short title.
 */
const port = Number(process.argv[2] ?? 4832);
const COMMAND = "uname -s; echo smoke-$((6*7))";

type Msg = { role: string; content?: unknown };
type Body = { model?: string; messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> };

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "");

function answer(body: Body): string {
	const base = { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: body.model ?? "canned" };
	const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === "tool");
	const names = (body.tools ?? []).map((t) => t.function?.name);
	let delta: Record<string, unknown>;
	let finish = "stop";
	if (tool) delta = { role: "assistant", content: `the shell said: ${text(tool.content).trim()}` };
	else if (names.includes("shell")) {
		delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_smoke", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: COMMAND }) } }] };
		finish = "tool_calls";
	} else if (names[0]) {
		delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_title", type: "function", function: { name: names[0], arguments: JSON.stringify({ title: "windows smoke" }) } }] };
		finish = "tool_calls";
	} else delta = { role: "assistant", content: '{"title":"windows smoke"}' };
	return (
		sse({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) +
		sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
		"data: [DONE]\n\n"
	);
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not here", { status: 404 });
		const body = (await req.json()) as Body;
		console.log(`request: ${(body.messages ?? []).map((m) => m.role).join(",")} tools=${(body.tools ?? []).length}`);
		return new Response(answer(body), { headers: { "content-type": "text/event-stream" } });
	},
});
console.log(`canned provider on http://127.0.0.1:${port}/v1`);
