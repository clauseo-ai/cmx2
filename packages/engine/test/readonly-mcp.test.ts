import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/** explore and review agents (no edit) see an mcp tool only when its server marks it readOnlyHint; other sessions see every one */

const tool = (name: string, readOnly?: boolean) => ({
	name,
	label: name,
	description: `${name} (mcp server xs)`,
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	...(readOnly === undefined ? {} : { readOnly }),
});
const dynamic = [tool("xs_lookup", true), tool("xs_delete", false), tool("checkout_thing")];

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: "http://127.0.0.1:9", apiKey: "fixture-key" } }, sources: [] };
}

async function session(excludeTools?: string[]) {
	return EngineSession.create({
		cwd: mkdtempSync(join(tmpdir(), "cmx2-romcp-")),
		config: config(),
		dataDir: mkdtempSync(join(tmpdir(), "cmx2-romcp-data-")),
		dynamicTools: () => dynamic as never,
		...(excludeTools ? { excludeTools } : {}),
		onEvent: () => {},
		onStep: () => {},
	});
}

test("a read-only agent loads only readOnlyHint mcp tools; a general one loads them all", async () => {
	const ro = await session(["write", "edit", "shell", "run"]);
	const all = await session();
	try {
		const names = (s: unknown) => [...(s as any).deferredAll().keys()].filter((n: string) => n.startsWith("xs_") || n.startsWith("checkout_")).sort();
		expect(names(ro)).toEqual(["checkout_thing", "xs_lookup"]);
		expect((ro as any).loadTools(["xs_lookup", "xs_delete"])).toEqual(["xs_lookup"]);
		expect((ro as any).toolByName("xs_delete")).toBeUndefined();
		expect(names(all)).toEqual(["checkout_thing", "xs_delete", "xs_lookup"]);
		expect((all as any).loadTools(["xs_lookup", "xs_delete"])).toEqual(["xs_lookup", "xs_delete"]);
	} finally {
		ro.dispose();
		all.dispose();
	}
});
