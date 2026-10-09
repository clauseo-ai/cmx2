import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, gitRepo, nonce, port } from "../../../eval/src/harness.ts";

/**
 * processes outlive nothing they should not: a real daemon (port 4831) runs jobs owned by a session,
 * is killed with SIGKILL while they run, and the next daemon on the same data dir sweeps the orphans
 * (the keep'd job is adopted, not killed). then session end reaps what is left except the keep'd job.
 * no model is called; the jobs are started over rest.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-it-sweep-")));
const data = join(root, "data");
const repo = join(root, "repo");
const tag = nonce();
let daemon = new Daemon({ port: port(4831), dataDir: data, password: "pw", log: join(root, "a.log") });

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd]).stdout.toString().trim();

afterAll(async () => {
	await daemon.stop();
	sh(`pkill -f 'sleep 31${tag.length}' || true`);
});

test("kill -9 the daemon while jobs run, restart, and the sweep stops the orphans and adopts the keep'd one", async () => {
	await gitRepo(repo);
	await daemon.start();
	const s = await daemon.api("/session", { directory: repo, title: `it-sweep-${tag}` });
	const job = await daemon.api(`/session/${s.id}/procs`, { command: `sleep 317 # orphan-${tag}` });
	const kept = await daemon.api(`/session/${s.id}/procs`, { command: `sleep 318 # kept-${tag}`, keep: `kept-${tag}` });
	console.log(`daemon pid ${daemon.pid}; job ${job.id} pid ${job.pid}; keep'd job ${kept.id} pid ${kept.pid}`);
	expect(alive(job.pid) && alive(kept.pid)).toBe(true);

	daemon.proc!.kill("SIGKILL");
	await daemon.proc!.exited;
	daemon.proc = undefined;
	console.log(`daemon killed with SIGKILL; job pid ${job.pid} alive: ${alive(job.pid)}, keep'd pid ${kept.pid} alive: ${alive(kept.pid)}`);
	expect(alive(job.pid)).toBe(true);

	daemon = new Daemon({ port: port(4831), dataDir: data, password: "pw", log: join(root, "b.log") });
	await daemon.start();
	const sweep = await daemon.api("/proc/sweep");
	console.log(`sweep result: ${JSON.stringify(sweep)}`);
	expect(sweep.killed.map((k: any) => k.pid)).toContain(job.pid);
	expect(sweep.adopted.map((k: any) => k.pid)).toContain(kept.pid);
	const t0 = Date.now();
	while (alive(job.pid) && Date.now() - t0 < 5000) await Bun.sleep(50);
	console.log(`after the sweep: orphan pid ${job.pid} alive: ${alive(job.pid)}; pgrep orphan-${tag}: "${sh(`pgrep -f 'orphan-${tag}' || true`)}"`);
	expect(alive(job.pid)).toBe(false);
	expect(alive(kept.pid)).toBe(true);

	// session end: a fresh job is reaped, the adopted keep'd one stays
	const late = await daemon.api(`/session/${s.id}/procs`, { command: `sleep 319 # late-${tag}` });
	expect((await daemon.api(`/session/${s.id}`, undefined, "DELETE")) === true).toBe(true);
	const t1 = Date.now();
	while (alive(late.pid) && Date.now() - t1 < 5000) await Bun.sleep(50);
	console.log(`session ended: late job pid ${late.pid} alive: ${alive(late.pid)}; keep'd pid ${kept.pid} alive: ${alive(kept.pid)}`);
	expect(alive(late.pid)).toBe(false);
	expect(alive(kept.pid)).toBe(true);
	process.kill(kept.pid, "SIGKILL");
}, 60_000);
