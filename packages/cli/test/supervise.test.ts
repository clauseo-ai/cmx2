import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, pidAlive } from "@cmx2/platform";
import { readSupervisor } from "../src/supervise.ts";

/**
 * `cmx2 serve --supervise` from source against a real daemon on port 4862 (shifted by CMX2_PORT_SHIFT): the
 * supervisor takes CMX2_DATA_DIR from its env file, starts the daemon, starts it again when it is killed and
 * when /global/restart asks, and writes the daemon's output to serve.log. every directory is a temp one
 */
const PORT = 4862 + Number(process.env.CMX2_PORT_SHIFT ?? 0);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-sup-")));
const data = join(root, "service data");
const envFile = join(root, "service.env");
mkdirSync(join(root, "cfg"));
writeFileSync(envFile, `CMX2_DATA_DIR='${data}'\n`);
let sup: ReturnType<typeof Bun.spawn> | undefined;
let last: number | undefined;

async function health(): Promise<{ pid?: number } | undefined> {
	const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
	return r?.ok ? ((await r.json()) as { pid?: number }) : undefined;
}

async function nextPid(not: number | undefined, ms = 40_000): Promise<number> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const h = await health();
		if (h?.pid && h.pid !== not) return h.pid;
		await Bun.sleep(200);
	}
	throw new Error(`no daemon other than ${not} answered on ${PORT}`);
}

afterAll(async () => {
	if (sup) {
		sup.kill();
		await sup.exited;
	}
	// windows ends the supervisor without letting it stop its child
	const h = await health();
	if (h?.pid) killTree(h.pid);
	if (last && pidAlive(last)) killTree(last);
});

test("the supervisor restarts the daemon when it dies and when /global/restart asks, and logs to serve.log", async () => {
	sup = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "serve", "--supervise", "--env-file", envFile, "--port", String(PORT), "--hostname", "127.0.0.1"], {
		env: { ...process.env, HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, "xdg"), CMX2_CONFIG_DIR: join(root, "cfg"), CMX2_DATA_DIR: "" },
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
	});
	const first = await nextPid(undefined);
	last = first;
	const rec = readSupervisor(join(data, "supervisor.json"));
	expect(rec?.pid).toBe(sup.pid);
	expect(rec?.child).toBe(first);

	// it dies: a new one comes up
	process.kill(first);
	const second = await nextPid(first);
	last = second;
	expect(readSupervisor(join(data, "supervisor.json"))?.child).toBe(second);

	// the api's restart exits 0 and expects to be started again
	const r = await fetch(`http://127.0.0.1:${PORT}/global/restart`, { method: "POST" });
	expect(r.ok).toBe(true);
	const third = await nextPid(second);
	last = third;

	const log = readFileSync(join(data, "log", "serve.log"), "utf8");
	expect(log.match(/started the daemon, pid \d+/g)?.length).toBeGreaterThanOrEqual(3);
	expect(log).toContain(`listening on http://127.0.0.1:${PORT}`);
	expect(log).toContain("starting it again in 1 s");
	expect(existsSync(join(root, "xdg", "cmx2", "supervisor.json"))).toBe(false);
}, 120_000);
