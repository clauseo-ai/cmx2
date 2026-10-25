import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellTool, type ShellResult } from "../src/shell.ts";
import { scratch, textOf } from "./helpers.ts";

/** a command that starts a background process and leaves its pipes open must not hold the call until its timeout */

const NOTE = "a background process is still holding this command's output";

/** the pid a command printed last, which the test then owns and stops */
function lastPid(output: string): number {
	const pid = Number(output.trim().split("\n").pop());
	expect(Number.isInteger(pid) && pid > 0).toBe(true);
	return pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stop(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

test("a background sleep that inherits the pipes returns at once with the note, and the output before it", async () => {
	const env = scratch("held-pipe");
	const t0 = performance.now();
	const r = await shellTool(env).execute("c", { command: "echo before; sleep 30 & echo $!" });
	const elapsed = performance.now() - t0;
	const s = r.structuredContent as ShellResult;
	const pid = lastPid(s.output);
	try {
		expect(elapsed).toBeLessThan(2000);
		expect(s).toMatchObject({ exit_code: 0, timed_out: false, output_held: true });
		expect(s.output).toContain("before\n");
		expect(r.isError).toBe(false);
		expect(textOf(r)).toContain(NOTE);
		expect(textOf(r)).toContain("use background: true to run it as a job you can read and stop");
		expect(textOf(r)).toContain("(exit 0,");
		expect(alive(pid)).toBe(true);
	} finally {
		stop(pid);
	}
});

test("a background process whose output goes to a file does not hold the call", async () => {
	const env = scratch("held-file");
	const t0 = performance.now();
	const r = await shellTool(env).execute("c", { command: "sleep 30 > bg.log 2>&1 & echo $!" });
	const elapsed = performance.now() - t0;
	const s = r.structuredContent as ShellResult;
	const pid = lastPid(s.output);
	try {
		expect(elapsed).toBeLessThan(2000);
		expect(s).toMatchObject({ exit_code: 0, timed_out: false, output_held: false });
		expect(textOf(r)).not.toContain(NOTE);
		expect(alive(pid)).toBe(true);
	} finally {
		stop(pid);
	}
});

test("a background process that writes after the call returned keeps running and is not sent SIGPIPE", async () => {
	const env = scratch("held-late");
	const r = await shellTool(env).execute("c", { command: "(sleep 0.5; echo late; echo done > late.txt) & echo started" });
	const s = r.structuredContent as ShellResult;
	expect(s.output_held).toBe(true);
	expect(s.output).toContain("started\n");
	await new Promise((ok) => setTimeout(ok, 1200));
	expect(existsSync(join(env.root, "late.txt"))).toBe(true);
});

test("a plain foreground command still runs to its timeout, and the timeout says how to run it in the background", async () => {
	const env = scratch("held-timeout");
	const t0 = performance.now();
	const r = await shellTool(env).execute("c", { command: "echo before; sleep 5", timeout: 1 });
	const elapsed = performance.now() - t0;
	expect(elapsed).toBeLessThan(4000);
	expect(r.details).toMatchObject({ exit_code: null, timed_out: true, output_held: false });
	expect(r.isError).toBe(true);
	expect(textOf(r)).toContain("before");
	expect(textOf(r)).toContain("(killed after 1s, ");
	expect(textOf(r)).toContain("; for long builds, tests or servers, run with background: true and notify)");
	expect(textOf(r)).not.toContain(NOTE);
});

test("a command with no background process prints no note", async () => {
	const env = scratch("held-none");
	const r = await shellTool(env).execute("c", { command: "echo hi" });
	expect(r.details).toMatchObject({ exit_code: 0, output_held: false });
	expect(textOf(r)).toMatch(/^hi\n\n\(exit 0, \d+(\.\d)?s\)$/);
});
