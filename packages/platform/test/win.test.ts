import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bashArgv, bashEnv, forgetTree, killTree, pidAlive, startStamp, trackTree, treeAlive, treePids, treeSpawnOptions, treeTracked, windowsListeners, type WindowsTreeSpawn } from "../src/index.ts";

/**
 * windows only: process trees as job objects, start stamps from GetProcessTimes, ports from netstat. each tree
 * holds a native windows grandchild (ping) started in the background by bash, the case taskkill /T can miss
 */

const FIXTURES = join(import.meta.dir, "fixtures");
/** a windows path as a single-quoted word git bash reads */
const sh = (p: string) => `'${p.replace(/\\/g, "/")}'`;

async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** a tree: bash with ping in the background; resolves with the root, ping's windows pid and bash's own */
async function pingTree(variant?: WindowsTreeSpawn) {
	const env = { ...process.env, ...bashEnv() };
	const p = Bun.spawn(bashArgv('ping -n 300 127.0.0.1 >/dev/null & echo "gc $(cat /proc/$!/winpid) sh $(cat /proc/$$/winpid)"; wait', { env }), {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		...treeSpawnOptions(variant ? { windows: variant } : {}),
	});
	const tracked = trackTree(p.pid);
	const reader = p.stdout.getReader();
	let out = "";
	while (!/gc \d+ sh \d+/.test(out)) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`bash ended before it printed the pids: ${out} ${await new Response(p.stderr).text()}`);
		out += new TextDecoder().decode(value);
	}
	const m = out.match(/gc (\d+) sh (\d+)/)!;
	return { p, root: p.pid, tracked, gc: Number(m[1]), bash: Number(m[2]) };
}

describe.if(process.platform === "win32")("windows process trees", () => {
	test("start stamps: stable for a live pid, gone once it exits", async () => {
		const p = Bun.spawn(["ping", "-n", "30", "127.0.0.1"], { stdout: "ignore", windowsHide: true });
		const a = startStamp(p.pid);
		expect(a).toMatch(/^\d{13}$/);
		await Bun.sleep(50);
		expect(startStamp(p.pid)).toBe(a!);
		expect(pidAlive(p.pid)).toBe(true);
		p.kill();
		await p.exited;
		expect(pidAlive(p.pid)).toBe(false);
		expect(startStamp(p.pid)).toBeUndefined();
	});

	for (const variant of ["detached", "attached"] as const) {
		test(`${variant} spawn: the grandchild is in our job and a kill takes it`, async () => {
			const t = await pingTree(variant);
			const pids = treePids(t.root);
			console.log(`[win ${variant}] tracked=${t.tracked} root=${t.root} bash=${t.bash} ping=${t.gc} job pids=${JSON.stringify(pids)}`);
			try {
				expect(t.tracked).toBe(true);
				expect(treeTracked(t.root)).toBe(true);
				expect(pids).toContain(t.gc);
				expect(pids).toContain(t.root);
				expect(pidAlive(t.gc)).toBe(true);
				expect(treeAlive(t.root)).toBe(true);
				killTree(t.root, "SIGTERM");
				await until(() => !pidAlive(t.gc) && !pidAlive(t.root), "the tree to go");
				await t.p.exited;
				await until(() => !treeAlive(t.root), "the job to empty");
			} finally {
				if (pidAlive(t.gc)) Bun.spawnSync(["taskkill", "/PID", String(t.gc), "/F"], { windowsHide: true });
				forgetTree(t.root);
			}
		});
	}

	test("an untracked tree falls back to taskkill /T", async () => {
		const env = { ...process.env, ...bashEnv() };
		const p = Bun.spawn(bashArgv("ping -n 300 127.0.0.1 >/dev/null; :", { env }), { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", ...treeSpawnOptions() });
		await Bun.sleep(500);
		expect(treeTracked(p.pid)).toBe(false);
		expect(treePids(p.pid)).toEqual([p.pid]);
		killTree(p.pid);
		await p.exited;
		expect(pidAlive(p.pid)).toBe(false);
	});

	for (const variant of ["detached", "attached"] as const) {
		test(`${variant} spawn: what outlives the process that started it`, async () => {
			const d = Bun.spawn([process.execPath, join(FIXTURES, "tree-daemon.ts"), variant], { stdout: "pipe", stderr: "pipe", windowsHide: true });
			const [out, err] = await Promise.all([new Response(d.stdout).text(), new Response(d.stderr).text()]);
			await d.exited;
			const r = JSON.parse(out.trim().split("\n").pop() || "{}") as { tracked?: boolean; gc?: number; inJob?: boolean };
			await Bun.sleep(1000);
			const alive = !!r.gc && pidAlive(r.gc);
			console.log(`[win ${variant}] daemon said ${out.trim()} ${err.trim()}; ping alive after the daemon exited: ${alive}`);
			if (r.gc && alive) Bun.spawnSync(["taskkill", "/PID", String(r.gc), "/F"], { windowsHide: true });
			expect(r.tracked).toBe(true);
			expect(r.inJob).toBe(true);
			// a kept job outlives the daemon, as on posix; only the detached spawn gives that
			if (variant === "detached") expect(alive).toBe(true);
		});
	}

	for (const variant of ["detached", "attached"] as const) {
		test(`${variant} spawn: a grandchild console program has no visible window`, async () => {
			const env = { ...process.env, ...bashEnv() };
			const p = Bun.spawn(bashArgv(`${sh(process.execPath)} ${sh(join(FIXTURES, "console-window.ts"))}`, { env }), {
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				...treeSpawnOptions({ windows: variant }),
			});
			trackTree(p.pid);
			const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			await p.exited;
			forgetTree(p.pid);
			console.log(`[win ${variant}] console window: ${out.trim()} ${err.trim()}`);
			const r = JSON.parse(out.trim().split("\n").pop()!) as { console_window: string | null; visible: boolean };
			expect(r.visible).toBe(false);
		});
	}

	test("netstat finds a listening port by pid", async () => {
		const p = Bun.spawn([process.execPath, "-e", 'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log(s.port)'], { stdout: "pipe", windowsHide: true });
		try {
			const reader = p.stdout.getReader();
			const { value } = await reader.read();
			const port = Number(new TextDecoder().decode(value).trim());
			const found = await windowsListeners();
			expect(typeof found).not.toBe("string");
			expect([...((found as Map<number, Set<number>>).get(p.pid) ?? [])]).toContain(port);
		} finally {
			p.kill();
		}
	});
});
