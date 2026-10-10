/* a scripted stand-in for the anthropic messages api, for recording the demo without a paid model.

   it speaks the streaming wire format on loopback. which script runs depends on the first user message of
   the request: the prompt the demo types starts the root session, a helper's brief starts a helper. every
   other request (the session title) gets a short text.

   run: bun scripts/demo/model.ts [port]   (default 4851) */

const PORT = Number(process.argv[2] ?? 4851);
const PROMPT = "add a test for the parser";

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (messages: any[], needle: string) => JSON.stringify(messages).split(needle).length - 1;

/** what the model does at this step, and how long it "thinks" first */
function script(body: any): { blocks: Block[]; delay: number } {
  const messages: any[] = body.messages ?? [];
  if (!body.tools?.length) return { blocks: [{ type: "text", text: "add a parser test" }], delay: 0 };
  const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
  const results = count(messages, '"type":"tool_result"');
  const all = JSON.stringify(messages);

  if (first.includes(PROMPT)) {
    if (results === 0) {
      return {
        delay: 300,
        blocks: [
          { type: "text", text: "two lookups first. i'll hand them to helpers on a cheaper model." },
          { type: "tool_use", name: "spawn", input: { name: "finder", model: "haiku", agent_type: "explore", brief: "find where the parser lives and name the function that parses" } },
          { type: "tool_use", name: "spawn", input: { name: "tests", model: "haiku", agent_type: "explore", brief: "list the existing tests for the parser and say which cases they cover" } },
        ],
      };
    }
    // both reports carry a marker the briefs do not
    if (!(all.includes("found: src/parser.ts") && all.includes("tests: test/parser.test.ts")))
      return { delay: 200, blocks: [{ type: "tool_use", name: "wait", input: { timeout_ms: 30000 } }] };
    return {
      delay: 300,
      blocks: [{ type: "text", text: "parse() lives in src/parser.ts. test/parser.test.ts covers numbers and sums but has no case for empty input, so that is the test to add. both helpers are parked if you want a follow-up." }],
    };
  }
  if (first.includes("find where the parser lives")) {
    if (results === 0) return { delay: 700, blocks: [{ type: "tool_use", name: "grep", input: { pattern: "export function parse", glob: "*.ts" } }] };
    return { delay: 400, blocks: [{ type: "text", text: "found: src/parser.ts, parse() on line 7" }] };
  }
  if (first.includes("list the existing tests")) {
    if (results === 0) return { delay: 1100, blocks: [{ type: "tool_use", name: "glob", input: { pattern: "**/*.test.ts" } }] };
    return { delay: 400, blocks: [{ type: "text", text: "tests: test/parser.test.ts, 2 cases (numbers, sums), none for empty input" }] };
  }
  return { blocks: [{ type: "text", text: "ok" }], delay: 0 };
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
    const body = await req.json();
    const { blocks, delay } = script(body);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const put = (s: string) => c.enqueue(enc.encode(s));
        await sleep(delay);
        put(sse("message_start", { message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
        for (const [index, b] of blocks.entries()) {
          if (b.type === "tool_use") {
            put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`, name: b.name, input: {} } }));
            put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
          } else {
            put(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
            for (const word of b.text.split(/(?<= )/)) {
              put(sse("content_block_delta", { index, delta: { type: "text_delta", text: word } }));
              await sleep(25);
            }
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
console.log(`demo model on 127.0.0.1:${PORT}`);
