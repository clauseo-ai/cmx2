#!/usr/bin/env bun
/**
 * a stdio mcp server for the pool's tests. `echo` answers with the tools/call params it received, as
 * json text, so a test can read exactly what cmx2 sent: the arguments and any `_meta`.
 */
const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const tools = [{ name: "echo", description: "answers with the params it was called with", inputSchema: { type: "object", properties: {} } }];

function handle(m: { id?: number | string; method?: string; params?: any }) {
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(m.params) }] } });
	if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buf += chunk;
	for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (line) handle(JSON.parse(line));
	}
});
export {};
