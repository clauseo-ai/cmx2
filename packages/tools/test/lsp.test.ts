import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LspDiagnostic, type LspLocation, LspPool, lspTool, type LspSymbol } from "../src/lsp.ts";
import { scratch, textOf } from "./helpers.ts";

/** a real typescript-language-server (the tools package's pinned dev dependency) on a scratch project */
const env = scratch("lsp");
writeFileSync(join(env.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", noEmit: true } }));
writeFileSync(join(env.cwd, "lib.ts"), "export function greet(name: string): string {\n\treturn `hi ${name}`;\n}\n");
writeFileSync(join(env.cwd, "main.ts"), 'import { greet } from "./lib";\n\nconst n: number = greet("x");\nconsole.log(n);\n');
const pool = new LspPool();
const lsp = lspTool(pool, env);
afterAll(() => pool.flush());

test("diagnostics: the type error the compiler sees, typed", async () => {
	const r = await lsp.execute("c", { operation: "diagnostics", path: "main.ts" });
	const d = r.details as { diagnostics: LspDiagnostic[]; server: string; root: string };
	console.log(textOf(r));
	expect(d.root).toBe(env.cwd);
	const err = d.diagnostics.find((x) => x.severity === "error");
	expect(err).toMatchObject({ line: 3, character: 7 });
	expect(err!.message).toContain("not assignable to type 'number'");
	expect(textOf(r)).toContain("main.ts:3:7: error");
}, 60_000);

test("definition, references, hover and symbols", async () => {
	const def = await lsp.execute("c", { operation: "definition", path: "main.ts", line: 3, character: 20 });
	const locs = (def.details as { locations: LspLocation[] }).locations;
	expect(locs[0]).toMatchObject({ path: join(env.cwd, "lib.ts"), line: 1, character: 17 });
	const refs = await lsp.execute("c", { operation: "references", path: "lib.ts", line: 1, character: 17 });
	expect((refs.details as { locations: LspLocation[] }).locations.map((l) => l.path.split("/").pop()).sort()).toEqual(["lib.ts", "main.ts", "main.ts"]);
	const hover = await lsp.execute("c", { operation: "hover", path: "main.ts", line: 3, character: 20 });
	expect(textOf(hover)).toContain("greet(name: string): string");
	const syms = await lsp.execute("c", { operation: "symbols", path: "lib.ts" });
	expect((syms.details as { symbols: LspSymbol[] }).symbols[0]).toMatchObject({ name: "greet", kind: "function", line: 1 });
	expect(pool.size).toBe(1);
}, 60_000);

test("a fix on disk shows in the next diagnostics; flush stops the server", async () => {
	writeFileSync(join(env.cwd, "main.ts"), 'import { greet } from "./lib";\n\nconst n: string = greet("x");\nconsole.log(n);\n');
	const r = await lsp.execute("c", { operation: "diagnostics", path: "main.ts" });
	expect((r.details as { diagnostics: LspDiagnostic[] }).diagnostics).toEqual([]);
	pool.flush();
	expect(pool.size).toBe(0);
	await expect(lsp.execute("c", { operation: "diagnostics", path: "nothing.xyz" })).rejects.toThrow();
}, 60_000);
