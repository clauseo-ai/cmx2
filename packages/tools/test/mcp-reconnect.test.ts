import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPool, type McpStatus } from "../src/mcp.ts";

/** a real stdio server (fixtures/mcp-flaky.ts) through pi-mcp's client: the pool's reconnect, end to end */

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-flaky.ts");
const SERVERS = { flaky: { command: [process.execPath, FIXTURE] } };

function pool(changes: McpStatus[]) {
	return new McpPool({ dataDir: mkdtempSync(join(tmpdir(), "cmx2-mcp-")), version: "test", cwd: tmpdir(), redialMs: [50], onChange: (s) => changes.push(s) });
}

const textOf = (r: any) => (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
const tool = (p: McpPool, name: string) => p.toolsFor().find((t) => t.name === name)!;

async function until(what: string, ok: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

test("a stdio server that exits is dialled again, and its tools work against the new process", async () => {
	const changes: McpStatus[] = [];
	const p = pool(changes);
	try {
		p.configure(SERVERS);
		await p.ready();
		expect(p.status()[0]!.status).toBe("connected");
		const first = textOf(await tool(p, "flaky_ping").execute("c1", {}));

		await tool(p, "flaky_quit").execute("c2", {}).catch(() => {});
		await until("the drop", () => changes.some((c) => c.status === "failed"));
		expect(changes.find((c) => c.status === "failed")!.error).toMatch(/flaky closed the connection; reconnecting in \d+ s/);
		// while it is down its tools are not offered
		await until("the reconnect", () => p.status()[0]!.status === "connected");

		const second = textOf(await tool(p, "flaky_ping").execute("c3", {}));
		expect(second).toMatch(/^\d+$/);
		expect(second).not.toBe(first);
	} finally {
		await p.close();
	}
}, 20_000);

test("a server closed by the pool is not dialled again", async () => {
	const changes: McpStatus[] = [];
	const p = pool(changes);
	p.configure(SERVERS);
	await p.ready();
	await tool(p, "flaky_quit").execute("c1", {}).catch(() => {});
	await until("the drop", () => changes.some((c) => c.status === "failed"));
	await p.close();
	const seen = changes.length;
	await Bun.sleep(300);
	expect(changes.length).toBe(seen);
	expect(p.status()).toEqual([]);
}, 20_000);

test("a first dial that fails stays failed: a bad command is a config problem, not a drop", async () => {
	const changes: McpStatus[] = [];
	const p = pool(changes);
	try {
		p.configure({ broken: { command: ["/nonexistent/cmx2-no-such-server"], timeout: 2_000 } });
		await p.ready(5_000);
		expect(p.status()[0]!.status).toBe("failed");
		const seen = changes.length;
		await Bun.sleep(300);
		expect(changes.length).toBe(seen);
	} finally {
		await p.close();
	}
}, 20_000);
