import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "@cmx2/platform";
import { runCommand, shellTool } from "@cmx2/tools";
import { Procs } from "../src/index.ts";
import { listenersOf, TTY_UNAVAILABLE } from "../src/procs.ts";

/**
 * windows only: jobs as job-object trees (a kill takes a native grandchild), a held command taken over as a job,
 * ports from netstat, and what a tty spawn says
 */

const win = process.platform === "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-procs-win-")));
const procs = new Procs({ dataDir: join(root, "data"), killGrace: 500, portSweepMs: 200 });
const sh = (p: string) => `'${p.replace(/\\/g, "/")}'`;
const leftovers: number[] = [];

async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

afterAll(async () => {
	await procs.stopAll();
	for (const pid of leftovers) if (pidAlive(pid)) Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"], { windowsHide: true });
});

describe.if(win)("procs on windows", () => {
	test("killing a job takes its whole tree, a native grandchild included", async () => {
		const j = procs.spawn({ command: 'ping -n 300 127.0.0.1 >/dev/null & echo "gc $(cat /proc/$!/winpid)"; wait', sessionID: "ses_w", origin: "model" });
		const gc = Number((await until(async () => (await procs.read(j.id, { wait_ms: 500 })).data.match(/gc (\d+)/) ?? undefined, "the pid line"))[1]);
		leftovers.push(gc);
		expect(pidAlive(gc)).toBe(true);
		await procs.kill(j.id);
		const info = procs.get(j.id)!;
		console.log(`[win procs] killed job: status ${info.status}, exit ${info.exitCode}, signal ${info.signal}`);
		expect(info).toMatchObject({ status: "exited", signal: "SIGTERM" });
		await until(() => !pidAlive(gc), "ping to be gone");
	});

	test("a held command is taken over as a job, and killing that job kills what held it", async () => {
		const host = procs.host("ses_held", root);
		const r = await runCommand({ cwd: root, spillDir: join(root, "spill"), procs: host }, 'ping -n 300 127.0.0.1 & echo "gc $(cat /proc/$!/winpid)"', 30);
		const gc = Number(r.output.match(/gc (\d+)/)?.[1]);
		leftovers.push(gc);
		console.log(`[win procs] held: output_held ${r.output_held}, job ${r.job_id}, ping ${gc}`);
		expect(r.output_held).toBe(true);
		expect(r.job_id).toMatch(/^job_/);
		expect(pidAlive(gc)).toBe(true);
		expect(procs.get(r.job_id!)!.status).toBe("running");
		await procs.kill(r.job_id!);
		await until(() => !pidAlive(gc), "ping to be gone");
		await until(() => procs.get(r.job_id!)?.status === "exited", "the job to exit");
	});

	test("a job's listening port shows up through netstat", async () => {
		const code = 'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log("port " + s.port)';
		const j = procs.spawn({ command: `${sh(process.execPath)} -e ${sh(code)}`, sessionID: "ses_port", origin: "model" });
		const port = Number((await until(async () => (await procs.read(j.id, { wait_ms: 500 })).data.match(/port (\d+)/) ?? undefined, "the port line"))[1]);
		expect(await procs.ports(j.id)).toEqual([port]);
		await until(() => procs.get(j.id)!.ports.includes(port), "the sweep to list the port");
		const owners = await listenersOf(port, [j.pid]);
		console.log(`[win procs] port ${port}: ${JSON.stringify(owners)}`);
		expect(owners.some((o) => o.pgid === j.pid && /bun/i.test(o.command))).toBe(true);
		await procs.kill(j.id);
	});

	test("a tty job says terminals are not available on windows yet", async () => {
		expect(() => procs.spawn({ command: "echo hi", tty: true, sessionID: "ses_tty", origin: "model" })).toThrow(TTY_UNAVAILABLE);
		const tool = shellTool({ cwd: root, spillDir: join(root, "spill"), procs: procs.host("ses_tty", root) });
		let said = "";
		try {
			await tool.execute("c", { command: "echo hi", tty: true });
		} catch (e) {
			said = (e as Error).message;
		}
		// what the model sees: the tool call fails with this message
		console.log(`[win procs] tty: ${said}`);
		expect(said).toBe("terminals are not available on windows yet; run the command without tty (as a plain job or in the foreground)");
	});
});
