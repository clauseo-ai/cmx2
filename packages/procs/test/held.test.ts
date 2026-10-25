import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, shellTool } from "@cmx2/tools";
import { Procs } from "../src/index.ts";

/**
 * a command whose background process holds its output pipes: the call returns, and the process is taken over
 * as a job of the session, so it is listed, read and reaped with the session like any other job
 */

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 8_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((ok) => setTimeout(ok, 50));
	}
}

function scratch() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-procs-held-")));
	const procs = new Procs({ dataDir: join(dir, "data"), killGrace: 500 });
	return { dir, procs };
}

test("a process that holds the call's pipes is listed as the session's job, and reaped with the session", async () => {
	const { dir, procs } = scratch();
	const sid = "ses_held";
	const command = "sleep 30 & echo $!";
	let sleepPid = 0;
	try {
		const env = { cwd: dir, spillDir: join(dir, "spill"), procs: procs.host(sid, dir) };
		const r = await runCommand(env, command, 10);
		expect(r.output_held).toBe(true);
		expect(r.job_id).toMatch(/^job_/);
		sleepPid = Number(r.output.trim().split("\n").pop());
		expect(alive(sleepPid)).toBe(true);
		expect(procs.get(r.job_id!)).toMatchObject({ status: "running", command, origin: "model", sessionID: sid, cwd: dir });
		expect(procs.host(sid, dir).list().map((p) => p.id)).toContain(r.job_id!);
		expect(procs.list({ sessionID: "ses_other" })).toEqual([]);

		const reaped = await procs.reapSession(sid);
		expect(reaped.killed.map((p) => p.id)).toContain(r.job_id!);
		await until(() => !alive(sleepPid) && procs.get(r.job_id!)?.status === "exited", "the held sleep to stop");
	} finally {
		if (sleepPid && alive(sleepPid)) process.kill(sleepPid, "SIGKILL");
		await procs.stopAll();
	}
});

test("the note names the job, and a job reads what its process writes after the call returned", async () => {
	const { dir, procs } = scratch();
	const sid = "ses_note";
	try {
		const tool = shellTool({ cwd: dir, spillDir: join(dir, "spill"), procs: procs.host(sid, dir) });
		const res = await tool.execute("c", { command: "(sleep 0.5; echo late) & echo started" });
		const text = (res.content[0] as { text: string }).text;
		const s = res.structuredContent as { job_id?: string; output: string };
		expect(s.output).toContain("started\n");
		expect(s.job_id).toMatch(/^job_/);
		expect(text).toContain(`it keeps running as job ${s.job_id}. read it or stop it with pty.read or pty.kill in run.`);
		expect(text).not.toContain("use background: true");
		const data = await until(async () => {
			const read = await procs.read(s.job_id!, { cursor: 0 });
			return read.data.includes("late") && read.data;
		}, "the job to read late");
		expect(data).toContain("late\n");
		await procs.reapSession("ses_note");
	} finally {
		await procs.stopAll();
	}
});

test("a held group that is already empty registers nothing", () => {
	const { dir, procs } = scratch();
	try {
		expect(procs.host("ses_empty", dir).adoptGroup!({ pgid: 2_000_000_000, command: "x", cwd: dir })).toBeUndefined();
		expect(procs.list({ sessionID: "ses_empty" })).toEqual([]);
	} finally {
		void procs.stopAll();
	}
});
