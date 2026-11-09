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


// every platform: on windows these prove the command reaches git's bash through the env var intact
describe("a command reaches bash byte for byte", () => {
	// a quoted heredoc prints its body untouched, so the output is exactly the text the command carried
	const payloads: Record<string, string> = {
		"quotes, backslashes, variables and globs": `"double" 'single' back\\slash \\\\two \\" $HOME \${PATH} *.ts ? [ab] {x,y} ~ & | ; < > ( ) ^ % ! \`tick\``,
		"non-ascii text and tabs": "ünïcødé 日本語 🙂\ttab",
		"a trailing backslash": "ends with \\",
		"doubled quotes": `""q"" \\"\\" \\\\" '"' "'"`,
		"several lines": "one\n  two\n\nfour\\\nfive",
	};
	for (const [name, payload] of Object.entries(payloads)) {
		test(`a command reaches bash intact: ${name}`, async () => {
			const command = `cat <<'CMX2_EOF'\n${payload}\nCMX2_EOF`;
			const r = await runCommand(scratch("quote"), command, 30);
			if (r.output !== `${payload}\n`) console.log(`[win quoting] ${name}: sent ${JSON.stringify(payload)} got ${JSON.stringify(r.output)}`);
			expect(r.exit_code).toBe(0);
			expect(r.output).toBe(`${payload}\n`);
		});
	}

	test("a command with no whitespace, a glob and quotes reaches bash intact", async () => {
		const r = await runCommand(scratch("quote"), `{printf,%s,'a\\\\b"c*'}`, 30);
		expect(r.output).toBe('a\\\\b"c*');
	});

	test("the variable that carries the command is gone before it runs, and exit codes come through", async () => {
		const env = scratch("quote");
		const r = await runCommand(env, 'printf "%s|%s" "${CMX2_COMMAND-unset}" "$PWD"; exit 3', 30);
		expect(r.exit_code).toBe(3);
		const [v, pwd] = r.output.split("|");
		expect(v).toBe("unset");
		// the command runs in the working directory (the last part of the name; windows may spell the rest in short form)
		expect(pwd!.split("/").pop()).toBe(env.cwd.split(/[\\/]/).pop()!);
	});
});

describe.if(process.platform === "win32")("the shell tool on windows", () => {
	test("commands run in git bash", async () => {
		const r = await runCommand(scratch("uname"), "uname -s", 30);
		expect(r.exit_code).toBe(0);
		expect(r.output.trim()).toMatch(/^(MINGW|MSYS)/);
	});

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
