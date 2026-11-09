import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pidAlive, treeOf, treePids } from "@cmx2/platform";
import { runCommand, shellTool, type ShellResult } from "../src/shell.ts";
import { scratch, textOf } from "./helpers.ts";

/**
 * windows only: the shell tool runs commands in git bash, as job-object trees with no console window. the trees
 * here hold a native windows grandchild (ping) that bash starts in the background
 */

const PLATFORM_FIXTURES = join(import.meta.dir, "..", "..", "platform", "test", "fixtures");
const sh = (p: string) => `'${p.replace(/\\/g, "/")}'`;
/** prints ping's windows pid, then waits on it */
const PING_TREE = 'ping -n 300 127.0.0.1 >/dev/null & echo "gc $(cat /proc/$!/winpid)"; wait';

async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}


describe.if(process.platform === "win32")("the shell tool on windows", () => {
	test("commands run in git bash", async () => {
		const r = await runCommand(scratch("uname"), "uname -s", 30);
		expect(r.exit_code).toBe(0);
		expect(r.output.trim()).toMatch(/^(MINGW|MSYS)/);
	});

	const cases: Record<string, string> = {
		"quotes, backslashes, variables and globs": `printf %s "$BASH_EXECUTION_STRING" # "double" 'single' back\\slash \\\\two \\" $HOME \${PATH} *.ts ? [ab] {x,y} ~ & | ; < > ( ) ^ % ! \`tick\``,
		"newlines and non-ascii text": `printf %s "$BASH_EXECUTION_STRING"\n# ünïcødé 日本語 🙂\n# tab\there`,
		"a trailing backslash": `printf %s "$BASH_EXECUTION_STRING" # \\`,
		"doubled quotes": `printf %s "$BASH_EXECUTION_STRING" # ""q"" \\"\\" \\\\" '"' "'"`,
		"no whitespace at all, with a glob and quotes": `{printf,%s,"$BASH_EXECUTION_STRING"};:'*.ts'"?"`,
	};
	for (const [name, command] of Object.entries(cases)) {
		test(`a command reaches bash intact: ${name}`, async () => {
			const r = await runCommand(scratch("quote"), command, 30);
			if (r.output !== command) console.log(`[win quoting] ${name}: sent ${JSON.stringify(command)} got ${JSON.stringify(r.output)}`);
			expect(r.exit_code).toBe(0);
			expect(r.output).toBe(command);
		});
	}

	test("a timeout kills the whole tree, the native grandchild included", async () => {
		let gc = 0;
		let seen: number[] = [];
		const r = await runCommand(scratch("timeout"), PING_TREE, 3, undefined, (tail) => {
			const m = tail.match(/gc (\d+)/);
			if (!m || gc) return;
			gc = Number(m[1]);
			const root = treeOf(gc);
			seen = root ? treePids(root) : [];
		});
		expect(r.timed_out).toBe(true);
		expect(gc).toBeGreaterThan(0);
		expect(seen).toContain(gc);
		await until(() => !pidAlive(gc), "ping to be gone");
	});

	test("an abort kills the whole tree, the native grandchild included", async () => {
		const ac = new AbortController();
		let gc = 0;
		let seen: number[] = [];
		const r = await runCommand(scratch("abort"), PING_TREE, 60, ac.signal, (tail) => {
			const m = tail.match(/gc (\d+)/);
			if (!m || gc) return;
			gc = Number(m[1]);
			const root = treeOf(gc);
			seen = root ? treePids(root) : [];
			setTimeout(() => ac.abort(), 200);
		});
		expect(r.exit_code).toBeNull();
		expect(r.timed_out).toBe(false);
		expect(seen).toContain(gc);
		await until(() => !pidAlive(gc), "ping to be gone");
	});

	test("a console program the command starts has no visible window", async () => {
		const r = await runCommand(scratch("window"), `${sh(process.execPath)} ${sh(join(PLATFORM_FIXTURES, "console-window.ts"))}`, 30);
		console.log(`[win shell tool] console window: ${r.output.trim()}`);
		expect(r.exit_code).toBe(0);
		expect(JSON.parse(r.output.trim().split("\n").pop()!)).toMatchObject({ visible: false });
	});

	test("with no git bash the model gets a failed call that says what to install", async () => {
		const env = { ...scratch("nobash"), env: { CMX2_GIT_BASH: "C:\\no\\such\\bash.exe" } };
		const r = await shellTool(env).execute("c", { command: "echo hi" });
		console.log(`[win shell tool] no bash: ${textOf(r)}`);
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("CMX2_GIT_BASH is C:\\no\\such\\bash.exe, and there is no file there");
		expect((r.structuredContent as ShellResult | undefined)?.exit_code).toBeUndefined();
	});
});
