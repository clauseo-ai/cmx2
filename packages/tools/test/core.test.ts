import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editTool, globTool, grepTool, readTool, writeTool, type GlobDetails, type GrepDetails, type ReadDetails } from "../src/fs.ts";
import { shellTool, type ShellResult } from "../src/shell.ts";
import { MAX_BYTES, MAX_LINE_CHARS, MAX_LINES } from "../src/types.ts";
import { scratch, textOf } from "./helpers.ts";

/** the core tools' contract: typed details, and anything over 2000 lines or 50 KB spilled to disk with the path returned */

test("read: numbered lines, typed details, paging past the line limit", async () => {
	const env = scratch("read");
	writeFileSync(join(env.cwd, "big.txt"), Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i + 1}`).join("\n"));
	const r = await readTool(env).execute("c1", { path: "big.txt" });
	const d = r.details as ReadDetails;
	expect(d).toMatchObject({ startLine: 1, endLine: MAX_LINES, totalLines: MAX_LINES + 500, truncated: true, cutLines: 0 });
	expect(textOf(r)).toContain(`continue with offset ${MAX_LINES + 1}`);
	const next = await readTool(env).execute("c2", { path: "big.txt", offset: MAX_LINES + 1 });
	expect((next.details as ReadDetails).endLine).toBe(MAX_LINES + 500);
});

test("read: one huge line is cut, not sent whole", async () => {
	const env = scratch("longline");
	writeFileSync(join(env.cwd, "min.js"), `${"x".repeat(300_000)}\nshort\n`);
	const r = await readTool(env).execute("c", { path: "min.js" });
	const out = textOf(r);
	expect(Buffer.byteLength(out)).toBeLessThan(MAX_BYTES);
	expect(out).toContain(`line cut at ${MAX_LINE_CHARS} of 300000 characters`);
	expect((r.details as ReadDetails).cutLines).toBe(1);
	expect(out).toContain("short");
});

test("write and edit: typed details", async () => {
	const env = scratch("write");
	const w = await writeTool(env).execute("c", { path: "a/b.txt", content: "one two two" });
	expect(w.details).toMatchObject({ path: join(env.cwd, "a/b.txt"), bytes: 11, created: true });
	const e = await editTool(env).execute("c", { path: "a/b.txt", old_text: "two", new_text: "three", replace_all: true });
	expect(e.details).toMatchObject({ replacements: 2, line: 1 });
	expect(readFileSync(join(env.cwd, "a/b.txt"), "utf8")).toBe("one three three");
	await expect(editTool(env).execute("c", { path: "a/b.txt", old_text: "three", new_text: "x" })).rejects.toThrow("appears 2 times");
});

test("grep: typed hits, and a listing over the limit spills with the path returned", async () => {
	const env = scratch("grep");
	mkdirSync(join(env.cwd, "src"));
	writeFileSync(join(env.cwd, "src/a.ts"), "const needle = 1;\nconst other = 2;\n");
	const small = await grepTool(env).execute("c", { pattern: "needle" });
	expect(small.details as GrepDetails).toEqual({ hits: [{ path: "src/a.ts", line: 1, text: "const needle = 1;" }], total: 1, truncated: false });
	expect(small.structuredContent).toEqual(small.details);

	writeFileSync(join(env.cwd, "many.txt"), Array.from({ length: 3000 }, (_, i) => `needle ${i} ${"pad ".repeat(10)}`).join("\n"));
	const big = await grepTool(env).execute("c", { pattern: "needle", limit: 5000 });
	const d = big.details as GrepDetails;
	expect(d.total).toBe(3001);
	expect(d.truncated).toBe(true);
	expect(d.spillPath).toBeDefined();
	expect(existsSync(d.spillPath!)).toBe(true);
	expect(readFileSync(d.spillPath!, "utf8").split("\n").length).toBe(3001);
	expect(textOf(big)).toContain(d.spillPath!);
});

test("glob: typed paths, and over the limit the full list spills", async () => {
	const env = scratch("glob");
	mkdirSync(join(env.cwd, "f"));
	for (let i = 0; i < 40; i++) writeFileSync(join(env.cwd, "f", `n${String(i).padStart(2, "0")}.ts`), "");
	const r = await globTool(env).execute("c", { pattern: "**/*.ts", limit: 10 });
	const d = r.details as GlobDetails;
	expect(d.paths.length).toBe(10);
	expect(d.paths[0]).toBe("f/n00.ts");
	expect(d).toMatchObject({ total: 40, truncated: true });
	expect(readFileSync(d.spillPath!, "utf8").split("\n").length).toBe(40);
	const none = await globTool(env).execute("c", { pattern: "*.nope" });
	expect(none.details).toEqual({ paths: [], total: 0, truncated: false });
});

test("shell: typed result, a failing command is data, output over the limit keeps the tail and spills", async () => {
	const env = scratch("shell");
	const ok = await shellTool(env).execute("c", { command: "echo hi" });
	expect(ok.structuredContent as ShellResult).toMatchObject({ exit_code: 0, output: "hi\n", truncated: false, timed_out: false });
	expect(ok.isError).toBe(false);
	const bad = await shellTool(env).execute("c", { command: "echo nope >&2; exit 3" });
	expect(bad.details).toMatchObject({ exit_code: 3 });
	expect(bad.isError).toBe(true);
	const big = await shellTool(env).execute("c", { command: "seq 1 5000" });
	const s = big.structuredContent as ShellResult;
	expect(s.truncated).toBe(true);
	expect(s.output).toContain("\n5000\n");
	expect(s.output).not.toContain("\n1\n");
	expect(readFileSync(s.spill_path!, "utf8").split("\n").length).toBe(5001);
	const slow = await shellTool(env).execute("c", { command: "sleep 5", timeout: 1 });
	expect(slow.details).toMatchObject({ exit_code: null, timed_out: true });
});

test("shell: jobs need a process host; without one the tool says so", async () => {
	const env = scratch("nojobs");
	await expect(shellTool(env).execute("c", { command: "sleep 1", background: true })).rejects.toThrow("background jobs are not available");
});
