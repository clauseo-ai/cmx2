import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatFile, formatterFor } from "../src/format.ts";
import { editTool, readTool, writeTool } from "../src/fs.ts";
import { errorsAfterWrite, LspPool } from "../src/lsp.ts";
import type { ToolEnv } from "../src/types.ts";
import { scratch, textOf } from "./helpers.ts";

/**
 * what write and edit do after they change a file: the project's formatter, then the language server's
 * errors, as notes in the tool result. real formatters (prettier from this package's dev dependencies,
 * gofmt from the system) and a real typescript-language-server; the hook is wired the way the engine wires it.
 */
const pool = new LspPool();
afterAll(() => pool.flush());

function withHook(env: ToolEnv, opts: { format: boolean; diagnostics: boolean }): ToolEnv {
	return {
		...env,
		afterWrite: async (abs) => {
			const notes: string[] = [];
			if (opts.format) {
				const f = await formatFile(abs, env.cwd);
				if (f?.changed) notes.push(`${f.tool} reformatted the file; read it before editing it again`);
			}
			if (opts.diagnostics) {
				const e = await errorsAfterWrite(pool, abs, env.cwd);
				if (e) notes.push(e);
			}
			return notes.join("\n\n") || undefined;
		},
	};
}

test("a prettier project: write lands formatted and says so; the file reads back formatted", async () => {
	const env = scratch("prettier");
	writeFileSync(join(env.cwd, ".prettierrc"), JSON.stringify({ semi: true, singleQuote: false }));
	mkdirSync(join(env.cwd, "node_modules", ".bin"), { recursive: true });
	symlinkSync(join(import.meta.dir, "..", "node_modules", ".bin", "prettier"), join(env.cwd, "node_modules", ".bin", "prettier"));
	const hooked = withHook(env, { format: true, diagnostics: false });
	const r = await writeTool(hooked).execute("c", { path: "ugly.ts", content: "const  x={a:1,b:'two'}\nexport default   x" });
	console.log(textOf(r));
	expect(textOf(r)).toContain("prettier reformatted the file");
	const back = textOf(await readTool(hooked).execute("c", { path: "ugly.ts" }));
	expect(readFileSync(join(env.cwd, "ugly.ts"), "utf8")).toBe('const x = { a: 1, b: "two" };\nexport default x;\n');
	expect(back).toContain('const x = { a: 1, b: "two" };');
});

test("gofmt formats go on edit; the opt-out leaves the file as written; no formatter, no note", async () => {
	const env = scratch("gofmt");
	const messy = "package main\nfunc main(){\nx:=1\n_ = x}\n";
	if (!formatterFor(join(env.cwd, "m.go"), env.cwd)) return console.log("gofmt is not installed here; skipped");
	writeFileSync(join(env.cwd, "m.go"), "package main\n\nfunc main() {\n}\n");
	const on = withHook(env, { format: true, diagnostics: false });
	const r = await editTool(on).execute("c", { path: "m.go", old_text: "func main() {\n}\n", new_text: "func main(){\nx:=1\n_ = x}\n" });
	expect(textOf(r)).toContain("gofmt reformatted the file");
	expect(readFileSync(join(env.cwd, "m.go"), "utf8")).toBe("package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n");
	const off = withHook(env, { format: false, diagnostics: false });
	await writeTool(off).execute("c", { path: "m.go", content: messy });
	expect(readFileSync(join(env.cwd, "m.go"), "utf8")).toBe(messy);
	const plain = await writeTool(on).execute("c", { path: "notes.txt", content: "left  as   is" });
	expect(textOf(plain)).toBe("created notes.txt (13 bytes)");
});

test("an edit that introduces a type error gets the language server's error in its result", async () => {
	const env = scratch("diag");
	writeFileSync(join(env.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", noEmit: true } }));
	writeFileSync(join(env.cwd, "calc.ts"), "export function double(n: number): number {\n\treturn n * 2;\n}\n");
	const hooked = withHook(env, { format: false, diagnostics: true });
	const clean = await writeTool(hooked).execute("c", { path: "use.ts", content: 'import { double } from "./calc";\n\nconst a: number = double(2);\nconsole.log(a);\n' });
	expect(textOf(clean)).toBe("created use.ts (79 bytes)");
	const broken = await editTool(hooked).execute("c", { path: "use.ts", old_text: "const a: number = double(2);", new_text: 'const a: string = double("2");' });
	console.log(textOf(broken));
	expect(textOf(broken)).toContain("typescript-language-server reports 2 errors in this file now:");
	expect(textOf(broken)).toMatch(/use\.ts:3:7: Type 'number' is not assignable to type 'string'/);
	expect(textOf(broken)).toMatch(/use\.ts:3:26: Argument of type 'string' is not assignable to parameter of type 'number'/);
}, 60_000);
