import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTool } from "../src/fs.ts";
import { hotTools } from "../src/index.ts";
import { RUN_DESCRIPTION, runDescription, runTool } from "../src/run.ts";
import type { NestedCall, Tool } from "../src/types.ts";
import { scratch } from "./helpers.ts";

/** what a run script sees: raw file text, only the helpers its agent has, and any name free to declare */

const outText = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");

function readCall(env: ReturnType<typeof scratch>): { call: NestedCall; calls: string[] } {
	const read = readTool(env);
	const calls: string[] = [];
	const call: NestedCall = async (tool, args) => {
		calls.push(tool);
		if (tool !== "read") return { result: { content: [{ type: "text", text: `no tool named ${tool}` }], details: {} }, isError: true };
		return { result: await read.execute("n", args as never), isError: false, decision: { permission: "allow" } };
	};
	return { call, calls };
}

test("fs.read inside run returns the file's text, so JSON.parse works; offset and limit count lines", async () => {
	const env = scratch("rawread");
	writeFileSync(join(env.cwd, "p.json"), '{\n  "name": "x",\n  "n": 2\n}\n');
	writeFileSync(join(env.cwd, "l.txt"), "a\nb\r\nc\nd");
	const { call } = readCall(env);
	const r = await runTool(call).execute("t", {
		code: `const p = JSON.parse(await fs.read({ path: "p.json" }));
			return [p.name, p.n, await fs.read({ path: "l.txt" }), await fs.read({ path: "l.txt", offset: 2, limit: 2 }), await fs.read({ path: "l.txt", offset: 3 })];`,
	});
	expect(r.isError).toBe(false);
	expect(JSON.parse(outText(r))).toEqual(["x", 2, "a\nb\r\nc\nd", "b\r\nc\n", "c\nd"]);
	// the direct read tool is unchanged: numbered lines
	const direct = await readTool(env).execute("d", { path: "p.json" });
	expect(outText(direct)).toContain('     2\t  "name": "x",');
});

test("a review agent's run lists no fs.write or fs.edit, and calling one says it is not available", async () => {
	const has = (t: string) => t !== "write" && t !== "edit";
	expect(RUN_DESCRIPTION).toContain("fs.write(");
	expect(RUN_DESCRIPTION).toContain("fs.edit(");
	const desc = runDescription(has);
	expect(desc).not.toContain("fs.write");
	expect(desc).not.toContain("fs.edit");
	expect(desc).toContain("fs.read(");
	expect(desc).toContain("shell.exec(");
	const env = scratch("review");
	const { call, calls } = readCall(env);
	const run = runTool(call, { has });
	expect(run.description).toBe(desc);
	const r = await run.execute("t", { code: `try { await fs.write({ path: "x", content: "y" }); } catch (e) { return e.message; }` });
	expect(outText(r)).toContain("fs.write is not available to this agent");
	expect(calls).toEqual([]);
	expect((r.details as { nested: any[] }).nested[0]).toMatchObject({ helper: "fs.write", ok: false, error: "fs.write is not available to this agent" });
});

test("hotTools builds run from the agent's tools: excluded and missing ones drop out, the same set gives the same description", () => {
	const call: NestedCall = async () => ({ result: { content: [], details: {} }, isError: false });
	const ask = async () => [];
	const env = scratch("hot");
	const runOf = (tools: Tool[]) => tools.find((t) => t.name === "run")!.description;
	const review = { exclude: ["write", "edit"], others: ["webfetch", "websearch", "proc_spawn", "proc_read", "proc_write", "proc_kill", "proc_list"] };
	const a = runOf(hotTools(env, call, ask as never, "user", review));
	expect(a).toBe(runOf(hotTools(env, call, ask as never, "user", review)));
	expect(a).not.toContain("fs.write");
	// no agent tools in the set, so no agents.* helpers
	expect(a).not.toContain("agents.");
	expect(a).toContain("pty.spawn(");
	expect(runOf(hotTools(env, call, ask as never))).toBe(RUN_DESCRIPTION);
});

test("a script may declare tools, console, text and the other globals", async () => {
	const env = scratch("scope");
	writeFileSync(join(env.cwd, "a.txt"), "hello\n");
	const { call } = readCall(env);
	const run = runTool(call);
	const r = await run.execute("t", {
		code: `const tools = ["a"];
const fs2 = fs;
let text = await fs2.read({ path: "a.txt" });
var exit = 1;
return [tools, text, exit];`,
	});
	expect(r.isError).toBe(false);
	expect(JSON.parse(outText(r))).toEqual([["a"], "hello\n", 1]);
	const r2 = await run.execute("t", { code: `const console = 1; const fs = 2; const image = 3; return [console, fs, image, typeof tools, typeof store, typeof exit, typeof search.grep];` });
	expect(r2.isError).toBe(false);
	expect(JSON.parse(outText(r2))).toEqual([1, 2, 3, "undefined", "undefined", "undefined", "function"]);
	// errors still point at the script's own line
	const r3 = await run.execute("t", { code: `const a = 1;\nnull.x;` });
	expect(outText(r3)).toContain("codemode.js:2");
});
