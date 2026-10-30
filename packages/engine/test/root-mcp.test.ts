import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPool, type McpScope, type McpServerConfig } from "@cmx2/tools";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/**
 * a server offered to top-level sessions only (sessions: "root"), through a real stdio server and the pool:
 * a helper's deferred tools, tool_search catalog, executable tools and run's lookup all go without it
 */

const ECHO = [process.execPath, join(import.meta.dir, "../../tools/test/fixtures/mcp-echo.ts")];
const who = { sessionID: "s", rootID: "s", parentID: null, depth: 0, path: "/root", directory: "/w", host: "h" };
const rootScope: McpScope = { child: false, caller: () => who };
const childScope: McpScope = { child: true, caller: () => ({ ...who, sessionID: "k", parentID: "s", depth: 1, path: "/root/k" }) };

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: "http://127.0.0.1:9", apiKey: "fixture-key" } }, sources: [] };
}

async function session(pool: McpPool, scope: McpScope) {
	return EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-data-")),
		child: scope.child,
		dynamicTools: () => pool.toolsFor(undefined, scope),
		onEvent: () => {},
		onStep: () => {},
	});
}

const servers = (sessions: "all" | "root"): Record<string, McpServerConfig> => ({ box: { command: ECHO, sessions }, plain: { command: ECHO } });
const mcpNames = (s: unknown, from: "deferredAll" | "executableTools") => {
	const v = (s as any)[from]();
	return [...(from === "deferredAll" ? v.keys() : v.map((t: { name: string }) => t.name))].filter((n: string) => n.endsWith("_echo")).sort();
};

test("a helper never reaches a sessions: root server's tools: not deferred, not searchable, not loadable, not through run", async () => {
	const pool = new McpPool({ dataDir: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-")), version: "test", cwd: tmpdir() });
	pool.configure(servers("root"));
	await pool.ready();
	const kid = await session(pool, childScope);
	const top = await session(pool, rootScope);
	try {
		expect(mcpNames(kid, "deferredAll")).toEqual(["plain_echo"]);
		expect((kid as any).loadTools(["box_echo", "plain_echo"])).toEqual(["plain_echo"]);
		expect((kid as any).toolByName("box_echo")).toBeUndefined();
		const nested = await (kid as any).nestedCall("box_echo", {});
		expect(nested.isError).toBe(true);
		expect(mcpNames(top, "deferredAll")).toEqual(["box_echo", "plain_echo"]);
		expect((top as any).loadTools(["box_echo"])).toEqual(["box_echo"]);
		expect((top as any).toolByName("box_echo")).toBeDefined();
	} finally {
		kid.dispose();
		top.dispose();
		await pool.close();
	}
}, 20_000);

test("a server switched from all to root drops a tool a helper had already loaded", async () => {
	const pool = new McpPool({ dataDir: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-")), version: "test", cwd: tmpdir() });
	pool.configure(servers("all"));
	await pool.ready();
	const kid = await session(pool, childScope);
	try {
		expect((kid as any).loadTools(["box_echo"])).toEqual(["box_echo"]);
		expect(mcpNames(kid, "executableTools")).toEqual(["box_echo"]);
		pool.configure(servers("root"));
		await pool.ready();
		expect(mcpNames(kid, "executableTools")).toEqual([]);
		expect((kid as any).toolByName("box_echo")).toBeUndefined();
	} finally {
		kid.dispose();
		await pool.close();
	}
}, 20_000);
