/**
 * `/find/file` lists asynchronously, one walk per directory at a time, a deadline that answers
 * what was found with x-truncated and does not cache it as whole, no stall for other requests; and
 * `/global/fs` answers `home` with its symlinks resolved. a daemon in this process (port 0, no model).
 * the slow walk is a stand-in `rg` first on PATH that prints two paths and then sleeps; the whole route
 * and the real process spawn run.
 *
 * run: bun test packages/server/test/a29.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@cmx2/contract";
import { DEFAULTS } from "@cmx2/engine/config";
import { Daemon, port } from "../../eval/src/harness.ts";
import { keptListings } from "../src/find.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-a29-"));
const SLOW_BIN = join(SCRATCH, "bin");
const SPAWNS = join(SCRATCH, "spawns");
mkdirSync(SLOW_BIN, { recursive: true });
writeFileSync(SPAWNS, "");
writeFileSync(join(SLOW_BIN, "rg"), `#!/bin/sh\necho x >> ${SPAWNS}\ncase "$PWD" in *failing) exit 2;; esac\necho a.txt\necho src/b.ts\nexec sleep 30\n`);
chmodSync(join(SLOW_BIN, "rg"), 0o755);
const spawns = () => readFileSync(SPAWNS, "utf8").split("\n").filter(Boolean).length;

/** a stand-in `rg` in a bin directory of its own; its script gets `$PIDS`, a file it appends its pid to */
const standIn = (name: string, script: string) => {
	const bin = join(SCRATCH, `bin-${name}`);
	const pids = join(SCRATCH, `pids-${name}`);
	mkdirSync(bin, { recursive: true });
	writeFileSync(pids, "");
	writeFileSync(join(bin, "rg"), `#!/bin/sh\necho $$ >> ${pids}\n${script}\n`);
	chmodSync(join(bin, "rg"), 0o755);
	return { path: `${bin}:${process.env.PATH}`, pid: () => Number(readFileSync(pids, "utf8").split("\n").filter(Boolean).at(-1)) };
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const gone = async (pid: number, ms: number) => {
	const t0 = performance.now();
	while (alive(pid) && performance.now() - t0 < ms) await Bun.sleep(25);
	return !alive(pid);
};

const dirOf = (name: string) => {
	const d = join(SCRATCH, name);
	mkdirSync(d, { recursive: true });
	return d;
};
const slowPath = `${SLOW_BIN}:${process.env.PATH}`;
const realPath = process.env.PATH!;

let d: ReturnType<typeof serve>;
let base = "";
const find = (dir: string, query = "") => fetch(`${base}/find/file?query=${query}`, { headers: { "x-cmx2-directory": dir } });

beforeAll(() => {
	const config = { ...structuredClone(DEFAULTS), sources: [] };
	d = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(SCRATCH, "data"), checkEvents: true, reload: () => config });
	base = `http://127.0.0.1:${d.server.port}`;
});
afterAll(() => {
	process.env.PATH = realPath;
	delete process.env.CMX2_FIND_DEADLINE_MS;
	d?.stop();
});

describe("a29: /find/file does not hold the daemon", () => {
	test("a slow walk answers what it found at the deadline, flagged truncated, while other requests are answered promptly", async () => {
		process.env.PATH = slowPath;
		process.env.CMX2_FIND_DEADLINE_MS = "1500";
		const dir = dirOf("slow");
		const before = spawns();
		const t0 = performance.now();
		const walking = find(dir);
		// while the listing runs, health must answer at once, again and again
		const latencies: number[] = [];
		while (performance.now() - t0 < 1200) {
			const t = performance.now();
			expect((await fetch(`${base}/global/health`)).status).toBe(200);
			latencies.push(performance.now() - t);
			await Bun.sleep(50);
		}
		const r = await walking;
		const took = performance.now() - t0;
		expect(Math.max(...latencies)).toBeLessThan(150);
		expect(latencies.length).toBeGreaterThan(10);
		expect([r.status, r.headers.get("x-truncated")]).toEqual([200, "true"]);
		expect(await r.json()).toEqual(["a.txt", "src/", "src/b.ts"]);
		expect(took).toBeGreaterThan(1400);
		expect(took).toBeLessThan(4000);
		expect(spawns() - before).toBe(1);
		console.log(`a29 slow walk: answered in ${Math.round(took)}ms, ${latencies.length} health probes during it, slowest ${Math.round(Math.max(...latencies))}ms`);
	});

	test("asks that arrive while a walk runs share it: one rg for many requests", async () => {
		process.env.PATH = slowPath;
		process.env.CMX2_FIND_DEADLINE_MS = "700";
		const dir = dirOf("shared");
		const before = spawns();
		const answers = await Promise.all([find(dir), find(dir, "a"), find(dir, "b"), find(dir, "src")]);
		expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200]);
		expect(answers.map((r) => r.headers.get("x-truncated"))).toEqual(["true", "true", "true", "true"]);
		expect(spawns() - before).toBe(1);
	});

	test("a cut listing is not cached as whole: the next ask inside the ttl still says truncated, without a new walk", async () => {
		process.env.PATH = slowPath;
		process.env.CMX2_FIND_DEADLINE_MS = "300";
		const dir = dirOf("cut");
		const before = spawns();
		await find(dir);
		const again = await find(dir);
		expect([again.headers.get("x-truncated"), spawns() - before]).toEqual(["true", 1]);
	});

	test("a walk that finishes is whole: no x-truncated, and the paths are the repo's, .gitignore held", async () => {
		process.env.PATH = realPath;
		delete process.env.CMX2_FIND_DEADLINE_MS;
		const dir = dirOf("whole");
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src/a.ts"), "");
		writeFileSync(join(dir, "README.md"), "");
		mkdirSync(join(dir, ".git"), { recursive: true }); // ripgrep holds .gitignore inside a git work tree
		writeFileSync(join(dir, "skipped.log"), "");
		writeFileSync(join(dir, ".gitignore"), "*.log\n");
		const r = await find(dir);
		expect([r.status, r.headers.get("x-truncated")]).toEqual([200, null]);
		const paths = (await r.json()) as string[];
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("README.md");
		expect(paths).not.toContain("skipped.log");
		const dirs = await (await fetch(`${base}/find/file?type=directory`, { headers: { "x-cmx2-directory": dir } })).json();
		expect(dirs).toEqual(["src/"]);
	});

	test("a ripgrep that closes its output and then hangs is cut at the deadline, flagged truncated, and ended", async () => {
		const rg = standIn("closed", "exec 1>&-\nexec sleep 30");
		process.env.PATH = rg.path;
		process.env.CMX2_FIND_DEADLINE_MS = "800";
		const t0 = performance.now();
		const r = await find(dirOf("closed"));
		const took = performance.now() - t0;
		expect([r.status, r.headers.get("x-truncated"), await r.json()]).toEqual([200, "true", []]);
		expect(took).toBeLessThan(2500);
		expect(await gone(rg.pid(), 2000)).toBe(true);
	});

	test("a ripgrep that ignores SIGTERM is killed after a short grace, and the answer does not wait for it", async () => {
		const rg = standIn("deaf", "trap '' TERM\necho a.txt\nexec sleep 30");
		process.env.PATH = rg.path;
		process.env.CMX2_FIND_DEADLINE_MS = "800";
		const t0 = performance.now();
		const r = await find(dirOf("deaf"));
		const took = performance.now() - t0;
		expect([r.status, r.headers.get("x-truncated"), await r.json()]).toEqual([200, "true", ["a.txt"]]);
		expect(took).toBeLessThan(2500);
		expect(alive(rg.pid())).toBe(true); // asked to end and deaf to it: the grace has not run out yet
		expect(await gone(rg.pid(), 3000)).toBe(true);
	});

	test("asks against a large cached listing do not hold the daemon: the best paths are kept as it goes, not sorted whole", async () => {
		const list = join(SCRATCH, "big-listing.txt");
		const lines: string[] = [];
		for (let i = 0; i < 200_000; i++) lines.push(`p${i % 500}/q${i % 97}/r${i}/file${i}.ts`);
		writeFileSync(list, `${lines.join("\n")}\n`);
		const rg = standIn("big", `exec cat ${list}`);
		process.env.PATH = rg.path;
		delete process.env.CMX2_FIND_DEADLINE_MS;
		const dir = dirOf("big");
		const cold = await find(dir);
		expect(cold.status).toBe(200);
		let last = performance.now();
		let worst = 0;
		const tick = setInterval(() => {
			const now = performance.now();
			worst = Math.max(worst, now - last);
			last = now;
		}, 5);
		try {
			for (const query of ["", "file1", "q9", "r19", "zzzz"]) {
				const t0 = performance.now();
				const r = await find(dir, query);
				const paths = (await r.json()) as string[];
				console.log(`a29 cached ${JSON.stringify(query)}: ${paths.length} paths in ${Math.round(performance.now() - t0)}ms, worst loop stall so far ${Math.round(worst)}ms`);
				await Bun.sleep(20);
			}
		} finally {
			clearInterval(tick);
		}
		expect(worst).toBeLessThan(120);
		// the order is the picker's: shallow first, then by name (and a fuzzy match that is the file name first)
		const top = (await (await find(dir)).json()) as string[];
		expect(top.length).toBe(10);
		expect(top.every((p) => /^p\d+\/$/.test(p))).toBe(true);
		expect(await (await find(dir, "file199999")).json()).toEqual(["p499/q82/r199999/file199999.ts"]);
		// the empty query is kept on the listing: the second ask is not worked out again
		const t1 = performance.now();
		await find(dir);
		expect(performance.now() - t1).toBeLessThan(40);
	});

	test("a kept listing is dropped at its ttl, not held until newer directories push it out", async () => {
		expect(keptListings()).toBeGreaterThan(0);
		await Bun.sleep(5400);
		expect(keptListings()).toBe(0);
	}, 15_000);

	test("the manifest declares x-truncated on find/file", () => {
		const route = ROUTES.find((r) => r.operationId === "findFile")!;
		expect(Object.keys(route.headers ?? {})).toContain("x-truncated");
	});

	test("a directory that does not exist lists as empty and whole, and starts no walk", async () => {
		process.env.PATH = slowPath;
		const before = spawns();
		const r = await find(join(SCRATCH, "not-there"));
		expect([r.status, r.headers.get("x-truncated"), await r.json(), spawns() - before]).toEqual([200, null, [], 0]);
	});

	test("a walk that failed with nothing listed is flagged truncated and is not cached: the next ask walks again", async () => {
		process.env.PATH = slowPath;
		process.env.CMX2_FIND_DEADLINE_MS = "5000";
		const dir = dirOf("failing");
		const before = spawns();
		const first = await find(dir);
		const second = await find(dir);
		expect([first.status, first.headers.get("x-truncated"), await first.json()]).toEqual([200, "true", []]);
		expect([second.headers.get("x-truncated"), spawns() - before]).toEqual(["true", 2]);
	});
});

describe("a29: /global/fs home", () => {
	test("home has its symlinks resolved (a daemon started with a symlinked HOME)", async () => {
		const realHome = dirOf("real-home");
		const linkHome = join(SCRATCH, "link-home");
		symlinkSync(realHome, linkHome);
		// os.homedir() reads HOME once, so the daemon is a process of its own with the symlinked HOME
		const home = new Daemon({ port: port(4834), dataDir: join(SCRATCH, "data-home"), log: join(SCRATCH, "home.log"), env: { HOME: linkHome } });
		await home.start();
		try {
			const r = await home.api("/global/fs");
			expect([r.home, r.path]).toEqual([realHome, realHome]);
			expect((await home.api(`/global/fs?path=${encodeURIComponent("~")}`)).path).toBe(realHome);
		} finally {
			await home.stop();
		}
	});
});
