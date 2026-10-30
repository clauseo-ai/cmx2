import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellTool } from "@cmx2/tools";
import { type ProcEvent, Procs } from "../src/index.ts";

/** serve jobs, what notify is still armed, and the port sweep; real processes listening on real ports */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-procs-serve-")));
const events: ProcEvent[] = [];
// the sweep is shortened so the tests run in seconds; the default is PORT_SWEEP_MS
const SWEEP = 150;
const procs = new Procs({ dataDir: join(root, "data"), onEvent: (e) => events.push(e), killGrace: 500, portSweepMs: SWEEP });
const started: number[] = [];

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until<T>(get: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

function freePort(): number {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port!;
	s.stop(true);
	return port;
}

const of = (id: string, type: ProcEvent["type"]) => events.filter((e) => e.info.id === id && e.type === type);

afterAll(async () => {
	await procs.stopAll();
	for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL");
	await Bun.sleep(200);
	expect(started.filter(alive)).toEqual([]);
});

test("a serve job says serve and what notify is armed: on_port goes once it fired, everything after exit", async () => {
	const port = freePort();
	const p = procs.spawn({
		command: `exec bun -e 'Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch() { return new Response("ok") } })'`,
		sessionID: "ses_a",
		origin: "model",
		serve: true,
		notify: { on_port: port },
	});
	started.push(p.pid);
	expect(p.serve).toBe(true);
	expect(p.armed).toEqual({ on_port: port });
	expect(of(p.id, "proc.started")[0]!.info).toMatchObject({ serve: true, armed: { on_port: port } });
	const n = await until(() => of(p.id, "proc.notify")[0], "the port notice");
	// the notice carries the job as it is after firing: the port listed, nothing armed
	expect(n.info).toMatchObject({ serve: true, armed: null, ports: [port], notify: { on_port: port } });
	expect(of(p.id, "proc.updated").some((e) => e.info.armed === null && e.info.ports.includes(port))).toBe(true);
	expect(procs.ledger("ses_a")).toContain(`${p.id}, job, pid ${p.pid}, serve, ports ${port}`);
	await procs.kill(p.id);
	expect(of(p.id, "proc.exited")[0]!.info).toMatchObject({ serve: true, armed: null, ports: [] });
});

test("a plain background job is unchanged: serve false, on_exit armed until it exits and then fires", async () => {
	const p = procs.spawn({ command: "sleep 0.3", sessionID: "ses_b", origin: "model", notify: { on_exit: true, on_pattern: "x" } });
	started.push(p.pid);
	expect(p.serve).toBe(false);
	expect(p.armed).toEqual({ on_exit: true, on_pattern: "x" });
	const n = await until(() => of(p.id, "proc.notify")[0], "the exit notice");
	expect(n.type === "proc.notify" && n.reason).toBe("exit");
	expect(n.info).toMatchObject({ serve: false, armed: null, notify: { on_exit: true, on_pattern: "x" } });
	const none = procs.spawn({ command: "true", sessionID: "ses_b", origin: "model" });
	expect(none.armed).toBeNull();
});

test("shell: serve starts a job with no default notify; background alone still notifies on exit; an explicit notify on serve stays", async () => {
	const host = procs.host("ses_e", root);
	const shell = shellTool({ cwd: root, spillDir: join(root, ".spill"), procs: host });
	const served = await shell.execute("c1", { command: "sleep 30", serve: true });
	const plain = await shell.execute("c2", { command: "sleep 31", background: true });
	const ported = await shell.execute("c3", { command: "sleep 32", background: true, serve: true, notify: { on_port: 1 } });
	const [s, b, o] = [served, plain, ported].map((r) => procs.get((r.structuredContent as { id: string }).id)!);
	started.push(s!.pid, b!.pid, o!.pid);
	expect([s!.serve, s!.notify, s!.armed]).toEqual([true, undefined, null]);
	expect([b!.serve, b!.armed]).toEqual([false, { on_exit: true }]);
	expect([o!.serve, o!.armed]).toEqual([true, { on_port: 1 }]);
	expect((served.content[0] as { text: string }).text).toContain("serve");
	for (const p of [s, b, o]) await procs.kill(p!.id);
});

test("the port sweep: process.updated when a job starts and stops listening, nothing while its ports stay the same", async () => {
	const port = freePort();
	// listens after 0.4 s, stops listening at 2 s and keeps running until killed
	const p = procs.spawn({
		command: `exec bun -e 'setTimeout(() => { const s = Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch() { return new Response("ok") } }); setTimeout(() => s.stop(true), 1600) }, 400); setInterval(() => {}, 1000)'`,
		sessionID: "ses_c",
		origin: "model",
	});
	const quiet = procs.spawn({ command: "sleep 30", sessionID: "ses_c", origin: "model" });
	started.push(p.pid, quiet.pid);
	const up = await until(() => of(p.id, "proc.updated").find((e) => e.info.ports.includes(port)), "the update with the port");
	expect(up.info.ports).toEqual([port]);
	expect(procs.get(p.id)!.ports).toEqual([port]);
	const down = await until(() => of(p.id, "proc.updated").find((e) => e.info.ports.length === 0), "the update without the port");
	expect(down.info.status).toBe("running");
	// several more sweeps with nothing changed send nothing more
	const sweepsBefore = procs.sweeps;
	await until(() => procs.sweeps >= sweepsBefore + 4, "four more sweeps");
	expect(of(p.id, "proc.updated").map((e) => e.info.ports)).toEqual([[port], []]);
	expect(of(quiet.id, "proc.updated")).toEqual([]);
	await procs.kill(p.id);
	await procs.kill(quiet.id);
});

test("the sweep stops when no process runs and starts again with the next one", async () => {
	for (const p of procs.list()) if (p.status === "running") await procs.kill(p.id);
	await until(() => !procs.sweeping, "the sweep to stop", 2000);
	const n = procs.sweeps;
	await Bun.sleep(SWEEP * 4);
	expect(procs.sweeps).toBe(n);
	expect(procs.sweeping).toBe(false);
	const p = procs.spawn({ command: "sleep 30", sessionID: "ses_d", origin: "model" });
	started.push(p.pid);
	expect(procs.sweeping).toBe(true);
	await until(() => procs.sweeps > n, "a sweep after the spawn");
	await procs.kill(p.id);
	await until(() => !procs.sweeping, "the sweep to stop again", 2000);
});
