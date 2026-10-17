#!/usr/bin/env bun
/**
 * a stdio mcp server for the pool's tests. `ping` answers with this process's pid; `quit` ends the
 * process before it answers, the way xcode's mcpbridge goes when xcode's own service quits.
 */
const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const tools = [
	{ name: "ping", description: "answers with the server's pid", inputSchema: { type: "object", properties: {} } },
	{ name: "quit", description: "ends the server", inputSchema: { type: "object", properties: {} } },
];

function handle(m: { id?: number | string; method?: string; params?: any }) {
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "1.0.0" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	if (m.method === "tools/call") {
		if (m.params?.name === "quit") process.exit(0);
		return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(process.pid) }] } });
	}
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
