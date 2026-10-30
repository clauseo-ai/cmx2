import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPool, type McpScope, type McpServerConfig } from "@cmx2/tools";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/**
 * a server offered to top-level sessions only (sessions: "root"), through a real stdio server and the pool:
 * a helper's deferred tools, tool_search catalog, executable tools and nested-call lookup all go without it.
 * and a flip of a server's caller or sessions setting reaches a session that already loaded its tool
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
		appendix: () => pool.instructionsFor(undefined, scope),
		cwd: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-data-")),
		child: scope.child,
		dynamicTools: () => pool.toolsFor(undefined, scope),
		onEvent: () => {},
		onStep: () => {},
	});
}

const servers = (sessions: "all" | "root", caller = false): Record<string, McpServerConfig> => ({ box: { command: ECHO, sessions, caller }, plain: { command: ECHO } });
const pool = () => new McpPool({ dataDir: mkdtempSync(join(tmpdir(), "cmx2-rootmcp-")), version: "test", cwd: tmpdir() });
/** what the echo server got from the agent's own box_echo, the tool object pi runs */
async function agentCall(s: unknown): Promise<Record<string, any>> {
	const t = ((s as any).syncTools() as Array<{ name: string; execute: (id: string, p: unknown) => Promise<any> }>).find((x) => x.name === "box_echo");
	if (!t) return { missing: true };
	const r = await t.execute("call_x", {});
	return JSON.parse(r.content[0].text);
}
const mcpNames = (s: unknown, from: "deferredAll" | "executableTools") => {
	const v = (s as any)[from]();
	return [...(from === "deferredAll" ? v.keys() : v.map((t: { name: string }) => t.name))].filter((n: string) => n.endsWith("_echo")).sort();
};

// run's helpers map to fixed tools (packages/tools/src/run.ts HELPERS), so a script cannot name an mcp tool at all
// today; the nested-call lookup checked here is the path a future generic helper would take
test("a helper never reaches a sessions: root server's tools: not deferred, not searchable, not loadable, not found by the nested-call lookup", async () => {
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

test("a loaded tool follows a caller flip: true to false stops sending the caller, false to true starts", async () => {
	const p = pool();
	p.configure(servers("all", true));
	await p.ready();
	const top = await session(p, rootScope);
	try {
		expect((top as any).loadTools(["box_echo"])).toEqual(["box_echo"]);
		expect((await agentCall(top))._meta).toEqual({ "cmx2/caller": { ...who, callID: "call_x" } });
		p.configure(servers("all", false));
		await p.ready();
		const off = await agentCall(top);
		expect(off.name).toBe("echo");
		expect(off._meta).toBeUndefined();
		p.configure(servers("all", true));
		await p.ready();
		expect((await agentCall(top))._meta).toEqual({ "cmx2/caller": { ...who, callID: "call_x" } });
	} finally {
		top.dispose();
		await p.close();
	}
}, 20_000);

test("a helper's loaded tool leaves its agent tools on a switch to root and comes back on a switch to all", async () => {
	const p = pool();
	p.configure(servers("all"));
	await p.ready();
	const kid = await session(p, childScope);
	try {
		expect((kid as any).loadTools(["box_echo"])).toEqual(["box_echo"]);
		expect((await agentCall(kid)).name).toBe("echo");
		p.configure(servers("root"));
		await p.ready();
		expect(await agentCall(kid)).toEqual({ missing: true });
		p.configure(servers("all"));
		await p.ready();
		expect((await agentCall(kid)).name).toBe("echo");
	} finally {
		kid.dispose();
		await p.close();
	}
}, 20_000);

test("an unchanged tool set keeps the agent's tool list as it is, step to step", async () => {
	const p = pool();
	p.configure(servers("all", true));
	await p.ready();
	const top = await session(p, rootScope);
	try {
		(top as any).loadTools(["box_echo", "plain_echo"]);
		const first = (top as any).syncTools();
		expect((top as any).syncTools()).toBe(first);
	} finally {
		top.dispose();
		await p.close();
	}
}, 20_000);

test("a server's instructions ride the turn context once, again only when they change, and never for a helper on a root-only server", async () => {
	const p = pool();
	const guide = (text: string): Record<string, McpServerConfig> => ({ guide: { command: ECHO, env: { ECHO_INSTRUCTIONS: text }, instructions: true, sessions: "root" } });
	p.configure(guide("first words"));
	await p.ready();
	const top = await session(p, rootScope);
	const kid = await session(p, childScope);
	try {
		const turn = (s: unknown) => String((s as any).turnText() ?? "");
		expect(turn(top)).toContain('<mcp-instructions server="guide">\ninstructions from mcp server guide (its tools load through tool_search as guide_*):\nfirst words\n</mcp-instructions>');
		expect(turn(top)).not.toContain("first words");
		expect(turn(kid)).not.toContain("instructions from mcp server");
		p.configure(guide("second words"));
		await p.ready();
		const again = turn(top);
		expect(again).toContain("second words");
		expect(again).not.toContain("first words");
		expect(turn(top)).not.toContain("second words");
		expect(turn(kid)).not.toContain("instructions from mcp server");
	} finally {
		top.dispose();
		kid.dispose();
		await p.close();
	}
}, 20_000);

test("after a compaction the state block carries a server's instructions again, and the next turn does not repeat them", async () => {
	const p = pool();
	p.configure({ guide: { command: ECHO, env: { ECHO_INSTRUCTIONS: "guide words" }, instructions: true } });
	await p.ready();
	const top = await session(p, rootScope);
	try {
		expect(String((top as any).turnText())).toContain("guide words");
		expect(String((top as any).turnText() ?? "")).not.toContain("guide words");
		// what a compaction puts after its summary: the runtime's own state, turn-context blocks included
		expect((top as any).stateBlock()).toContain('<mcp-instructions server="guide">');
		expect(String((top as any).turnText() ?? "")).not.toContain("guide words");
	} finally {
		top.dispose();
		await p.close();
	}
}, 20_000);
