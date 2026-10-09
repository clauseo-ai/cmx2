import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputBuffer, type ProcEvent, Procs } from "../src/index.ts";

/** real processes, real ptys; everything started here is stopped in afterAll and checked with pgrep */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-procs-")));
const events: ProcEvent[] = [];
const procs = new Procs({ dataDir: join(root, "data"), onEvent: (e) => events.push(e), killGrace: 500 });
const started: number[] = [];
const track = <T extends { pid: number }>(p: T): T => {
	started.push(p.pid);
	return p;
};

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

afterAll(async () => {
	await procs.stopAll();
	for (const pid of started) {
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	await Bun.sleep(200);
	const left = started.filter(alive);
	expect(left).toEqual([]);
});

test("buffer: head and tail with absolute cursors, the gap reported as dropped", () => {
	const b = new OutputBuffer(10, 20);
	const enc = new TextEncoder();
	for (let i = 0; i < 10; i++) b.write(enc.encode("0123456789"));
	expect(b.total).toBe(100);
	expect(b.retained).toBe(30);
	const h = b.read(0, 1000);
	expect(new TextDecoder().decode(h.bytes)).toBe("0123456789");
	expect(h.dropped).toBe(0);
	const t = b.read(10, 1000);
	expect(t.start).toBe(80);
	expect(t.dropped).toBe(70);
	expect(new TextDecoder().decode(t.bytes)).toBe("01234567890123456789");
	// no gap yet: head flows into tail in one read
	const small = new OutputBuffer(4, 100);
	small.write(enc.encode("abcdefgh"));
	expect(new TextDecoder().decode(small.read(0, 100).bytes)).toBe("abcdefgh");
	expect(new TextDecoder().decode(small.read(2, 3).bytes)).toBe("cde");
});

test("pty: spawn, write, read with cursors, resize, origin", async () => {
	const p = track(procs.spawn({ command: "cat", tty: true, sessionID: "ses_a", origin: "model", cols: 100, rows: 30 }));
	expect(p.id).toStartWith("pty_");
	expect(p.origin).toBe("model");
	procs.write(p.id, "hello-pty\n");
	const r1 = await procs.read(p.id, { cursor: 0, wait_ms: 3000 });
	expect(r1.data).toContain("hello-pty");
	expect(r1.status).toBe("running");
	procs.write(p.id, "second-line\n");
	const r2 = await procs.read(p.id, { cursor: r1.cursor, wait_ms: 3000 });
	expect(r2.start).toBe(r1.cursor);
	expect(r2.data).toContain("second-line");
	expect(r2.data).not.toContain("hello-pty");
	procs.resize(p.id, 120, 40);

	const shell = track(procs.spawn({ command: "", tty: true, sessionID: null, origin: "user", cwd: root }));
	expect(shell.origin).toBe("user");
	procs.write(shell.id, "stty size; echo cwd=$PWD\n");
	procs.resize(shell.id, 132, 43);
	procs.write(shell.id, "stty size\n");
	// a login shell reads the user's rc files first; wait for the answers, not for a quiet moment
	const all = await until(() => {
		const d = procs.snapshot(shell.id).data;
		return d.includes(`cwd=${root}`) && d.includes("43 132") && d;
	}, "the login shell to answer");
	expect(all).toContain("43 132");
	const r3 = await procs.read(shell.id, { cursor: 0 });
	expect(r3.status).toBe("running");
	console.log(`pty origin model ${p.id} pid ${p.pid}; user shell ${shell.id} pid ${shell.pid}, read ${r3.cursor} bytes`);
	await procs.kill(p.id);
	await procs.kill(shell.id);
	expect(procs.get(p.id)!.status).toBe("exited");
	expect(() => procs.write(p.id, "x")).toThrow("has exited");
});

test("job: large output keeps head and tail, reports what was dropped", async () => {
	const small = new Procs({ dataDir: join(root, "small"), headBytes: 1000, tailBytes: 2000 });
	const p = small.spawn({ command: "for i in $(seq 1 5000); do echo line-$i; done", sessionID: "ses_b", origin: "model" });
	await until(() => small.get(p.id)!.status === "exited", "the job to finish");
	const info = small.get(p.id)!;
	expect(info.exitCode).toBe(0);
	const head = await small.read(p.id);
	expect(head.data.startsWith("line-1\n")).toBe(true);
	const next = await small.read(p.id, { cursor: head.cursor });
	expect(next.dropped).toBeGreaterThan(0);
	expect(next.data.trimEnd().endsWith("line-5000")).toBe(true);
	expect(next.cursor).toBe(info.cursor);
	expect(small.retainedBytes).toBe(3000);
	console.log(`5000 lines: ${info.cursor} bytes written, head ${head.data.length}, dropped ${next.dropped}, tail from ${next.start}`);
	expect(() => small.write(p.id, "x")).toThrow();
});

test("notify: on exit carries the code and the last lines", async () => {
	const p = track(procs.spawn({ command: "echo building; echo boom >&2; exit 3", sessionID: "ses_c", origin: "model", notify: { on_exit: true } }));
	const n = await until(() => events.find((e) => e.type === "proc.notify" && e.info.id === p.id), "the exit notify");
	expect(n.type === "proc.notify" && n.reason).toBe("exit");
	expect(n.type === "proc.notify" && n.detail).toContain("exited with code 3");
	expect(n.type === "proc.notify" && n.detail).toContain("boom");
	expect(n.info.exitCode).toBe(3);
});

test("notify: on pattern fires once per matching line, not per chunk", async () => {
	// "ready" is split across writes and one line matches twice in a row with a pause between
	const cmd = `printf 'rea'; sleep 0.2; printf 'dy one\\n'; sleep 0.2; echo noise; echo 'ready two'; sleep 0.2; printf 'ready thr'; sleep 0.2; echo ee`;
	const p = track(procs.spawn({ command: cmd, sessionID: "ses_d", origin: "model", notify: { on_pattern: "^ready", on_exit: true } }));
	await until(() => events.find((e) => e.type === "proc.notify" && e.info.id === p.id && e.reason === "exit"), "the job to exit");
	const hits = events.filter((e) => e.type === "proc.notify" && e.info.id === p.id && e.reason === "pattern").map((e) => (e.type === "proc.notify" ? e.detail : ""));
	console.log(`pattern notifies: ${JSON.stringify(hits)}`);
	expect(hits).toEqual(["ready one", "ready two", "ready three"]);
});

test("notify: on port fires once the port accepts; ports() finds it through lsof", async () => {
	const port = freePort();
	const p = track(
		procs.spawn({
			command: `sleep 0.6; exec bun -e 'Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch() { return new Response("ok") } }); console.log("listening")'`,
			sessionID: "ses_e",
			origin: "model",
			notify: { on_port: port },
		}),
	);
	const t0 = Date.now();
	const n = await until(() => events.find((e) => e.type === "proc.notify" && e.info.id === p.id && e.reason === "port"), "the port notify");
	console.log(`port ${port} notify after ${Date.now() - t0} ms: ${n.type === "proc.notify" ? n.detail : ""}`);
	expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
	expect(await procs.ports(p.id)).toContain(port);
	expect(procs.ledger("ses_e")).toContain(`ports ${port}`);
	await procs.kill(p.id);
	expect(events.filter((e) => e.type === "proc.notify" && e.info.id === p.id && e.reason === "port").length).toBe(1);
});

test("ownership: reap a session keeps what it kept; ledger; the host adapter is session-bound", async () => {
	const host = procs.host("ses_f", root);
	const a = track(host.spawn({ command: "sleep 120" }));
	const b = track(host.spawn({ command: "sleep 121", keep: "dev-server" }));
	const other = track(procs.spawn({ command: "sleep 122", sessionID: "ses_g", origin: "model" }));
	expect(host.list().map((p) => p.id)).toEqual([a.id, b.id]);
	expect(a.cwd).toBe(root);
	expect(a.origin).toBe("model");
	await expect(host.read(other.id)).rejects.toThrow("no process");
	const ledger = procs.ledger("ses_f")!;
	console.log(ledger);
	expect(ledger).toContain(`${a.id}, job, pid ${a.pid}: sleep 120`);
	expect(ledger).toContain("keep dev-server");
	const r = await procs.reapSession("ses_f");
	expect(r.killed.map((p) => p.id)).toEqual([a.id]);
	expect(r.kept.map((p) => p.id)).toEqual([b.id]);
	expect(alive(a.pid)).toBe(false);
	expect(alive(b.pid)).toBe(true);
	expect(alive(other.pid)).toBe(true);
	expect(procs.ledger("ses_f")).toBe(`processes alive:\n- ${b.id}, job, pid ${b.pid}, keep dev-server: sleep 121`);
	await procs.kill(b.id);
	await procs.kill(other.id);
	expect(procs.ledger("ses_f")).toBeUndefined();
});

test("attach replays from a cursor and streams live bytes", async () => {
	const p = track(procs.spawn({ command: "echo one; sleep 0.3; echo two", sessionID: "ses_h", origin: "user" }));
	await until(() => procs.get(p.id)!.cursor >= 4, "the first line");
	const got: string[] = [];
	const stop = procs.attach(p.id, 0, (chunk) => got.push(new TextDecoder().decode(chunk)));
	await until(() => procs.get(p.id)!.status === "exited", "exit");
	stop();
	expect(got.join("")).toBe("one\ntwo\n");
});

test("crash: a daemon killed with jobs alive; the next daemon's sweep stops the orphan and adopts the kept", async () => {
	const dataDir = join(root, "crash");
	const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/crash-daemon.ts"), dataDir], { stdout: "pipe", stderr: "inherit" });
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	const pids = JSON.parse(new TextDecoder().decode(value)) as { orphan: number; kept: number };
	started.push(pids.orphan, pids.kept);
	expect(alive(pids.orphan)).toBe(true);
	child.kill("SIGKILL");
	await child.exited;
	await Bun.sleep(100);
	expect(alive(pids.orphan)).toBe(true);
	console.log(`daemon ${child.pid} killed with SIGKILL; orphan pid ${pids.orphan} still alive: ${alive(pids.orphan)}; journal ${readdirSync(join(dataDir, "procs")).join(", ")}`);

	const next = new Procs({ dataDir, killGrace: 500 });
	const sweep = next.sweep();
	console.log(`sweep result: ${JSON.stringify(sweep, null, 1)}`);
	expect(sweep.journals).toBe(1);
	expect(sweep.killed.map((e) => e.pid)).toEqual([pids.orphan]);
	expect(sweep.adopted.map((e) => e.pid)).toEqual([pids.kept]);
	expect(alive(pids.orphan)).toBe(false);
	const pgrep = Bun.spawnSync(["pgrep", "-f", "sleep 300"]).stdout.toString().trim();
	console.log(`pgrep -f 'sleep 300' after sweep: ${JSON.stringify(pgrep)}`);
	expect(pgrep.split("\n").filter(Boolean).map(Number)).not.toContain(pids.orphan);
	const adopted = next.list().find((p) => p.pid === pids.kept)!;
	expect(adopted).toMatchObject({ keep: "kept-sleeper", adopted: true, status: "running", sessionID: "ses_crash" });
	// a second sweep finds nothing new: the dead daemon's journal was consumed
	expect(next.sweep()).toEqual({ killed: [], adopted: [], gone: [], journals: 0 });
	await next.kill(adopted.id, "SIGKILL");
	await next.stopAll();
	expect(alive(pids.kept)).toBe(false);
});

test("stopAll: everything not kept or detached stops, the rest is journaled", async () => {
	const dataDir = join(root, "stop");
	const p = new Procs({ dataDir, killGrace: 500 });
	const a = track(p.spawn({ command: "sleep 130", sessionID: "ses_i", origin: "model" }));
	const d = track(p.spawn({ command: "sleep 131", sessionID: "ses_i", origin: "model", detach: true }));
	const r = await p.stopAll();
	expect(r.killed.map((x) => x.id)).toEqual([a.id]);
	expect(r.left.map((x) => x.id)).toEqual([d.id]);
	expect(alive(a.pid)).toBe(false);
	expect(alive(d.pid)).toBe(true);
	expect(readdirSync(join(dataDir, "procs"))).toEqual([`${process.pid}.json`]);
	process.kill(d.pid, "SIGKILL");
});

test("a port another process already holds is reported as such, not as the job coming up", async () => {
	const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("someone else") });
	const port = other.port;
	const job = track(procs.spawn({ command: "sleep 30", sessionID: "ses_taken", origin: "model", notify: { on_port: port } }));
	const t0 = Date.now();
	let notice: ProcEvent | undefined;
	while (!notice && Date.now() - t0 < 5000) {
		notice = events.find((e) => e.type === "proc.notify" && e.info.id === job.id);
		await Bun.sleep(50);
	}
	console.log(`taken port ${port}: ${notice && "detail" in notice ? notice.detail : "no notice"}`);
	expect(notice && "detail" in notice && notice.detail).toContain("another process holds it");
	await procs.kill(job.id);
	other.stop(true);
});
