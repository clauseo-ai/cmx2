import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "bun:test";

/**
 * a real cmx2 daemon as a child process on a dev port (never 4096), for evals and integration tests.
 * it talks to whatever providers the profile configures; nothing is mocked.
 */

export const ROOT = join(import.meta.dir, "../../..");

/**
 * tests that call a real model provider or the live network run only with CMX2_LIVE_TESTS=1, so a plain
 * `bun test` (a fresh clone, ci) is offline and costs nothing
 */
export const LIVE = process.env.CMX2_LIVE_TESTS === "1";

/** describe/test that run when LIVE and are skipped otherwise (a skipped describe runs no hooks) */
export const liveDescribe = LIVE ? describe : describe.skip;
export const liveTest = LIVE ? test : test.skip;

/** prints one line saying how to enable what a file skipped; a no-op when LIVE */
export function liveNote(what: string) {
	if (!LIVE) console.log(`skipped ${what}: needs a provider key or profile; run with CMX2_LIVE_TESTS=1 to enable`);
}

/**
 * puts a provider profile in `configDir` for a live daemon: $CMX2_LIVE_PROFILE (a config dir) if set, else
 * the user's ~/.config/cmx2/cmx2.jsonc, else nothing (the daemon then reads ANTHROPIC_API_KEY from the env)
 */
export function liveProfile(configDir: string) {
	mkdirSync(configDir, { recursive: true });
	const dir = process.env.CMX2_LIVE_PROFILE;
	const file = dir ? join(dir, "cmx2.jsonc") : join(homedir(), ".config", "cmx2", "cmx2.jsonc");
	if (existsSync(file)) copyFileSync(file, join(configDir, "cmx2.jsonc"));
}

/**
 * a dev port shifted by CMX2_PORT_SHIFT, so two lanes (two worktrees) can run the suites at once without
 * taking each other's ports: the default lane uses 4830-4839, a lane with a shift of 20 uses 4850-4859
 */
export function port(n: number): number {
	return n + (Number(process.env.CMX2_PORT_SHIFT) || 0);
}

export interface DaemonOptions {
	port: number;
	dataDir: string;
	password?: string;
	/** a paired bearer credential, sent instead of the password */
	token?: string;
	/** a log file for the daemon's stdout and stderr */
	log: string;
	env?: Record<string, string>;
	/** a checkout to run the daemon from instead of this one (m9 arm a runs the last commit before routing v2); it needs its own `bun install` */
	root?: string;
}

export class Daemon {
	proc: ReturnType<typeof Bun.spawn> | undefined;
	readonly base: string;

	constructor(readonly opts: DaemonOptions) {
		this.base = `http://127.0.0.1:${opts.port}`;
	}

	get pid(): number | undefined {
		return this.proc?.pid;
	}

	async start() {
		const busy = (await $`lsof -nP -tiTCP:${this.opts.port} -sTCP:LISTEN`.nothrow().quiet()).stdout.toString().trim();
		if (busy) throw new Error(`port ${this.opts.port} is taken by pid ${busy}; pick another`);
		mkdirSync(this.opts.dataDir, { recursive: true });
		// the data dir as cwd, never the repo: a request that loses its directory falls back to the daemon's cwd,
		// and a model turn there once committed into the checkout running the tests (GOTCHAS: the security review)
		this.proc = Bun.spawn(["bun", join(this.opts.root ?? ROOT, "packages/cli/src/index.ts"), "serve", "--port", String(this.opts.port), "--hostname", "127.0.0.1"], {
			cwd: this.opts.dataDir,
			env: {
				...process.env,
				CMX2_DATA_DIR: this.opts.dataDir,
				CMX2_CHECK_EVENTS: "1",
				...(this.opts.password ? { CMX2_SERVER_PASSWORD: this.opts.password } : {}),
				...this.opts.env,
			},
			stdout: Bun.file(this.opts.log),
			stderr: Bun.file(`${this.opts.log}.err`),
		});
		for (let i = 0; i < 100; i++) {
			await Bun.sleep(100);
			try {
				const res = await fetch(`${this.base}/global/health`, { headers: this.headers() });
				if (res.ok) return;
			} catch {}
		}
		throw new Error(`daemon on ${this.opts.port} did not come up in 10 s; see ${this.opts.log}.err`);
	}

	async stop() {
		if (!this.proc) return;
		this.proc.kill("SIGTERM");
		await this.proc.exited;
		this.proc = undefined;
	}

	/** SIGKILL: the daemon gets no chance to flush or say goodbye, as in a crash */
	async kill() {
		if (!this.proc) return;
		this.proc.kill("SIGKILL");
		await this.proc.exited;
		this.proc = undefined;
	}

	headers(extra: Record<string, string> = {}): Record<string, string> {
		const auth = this.opts.token ? `Bearer ${this.opts.token}` : this.opts.password ? `Basic ${btoa(`cmx2:${this.opts.password}`)}` : undefined;
		return { ...(auth ? { authorization: auth } : {}), ...extra };
	}

	/** GET when no body; throws with status and body on anything but 2xx unless `raw` */
	async api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
		const res = await this.raw(path, body, method);
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
		return text ? JSON.parse(text) : undefined;
	}

	raw(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}): Promise<Response> {
		return fetch(this.base + path, {
			method,
			headers: this.headers({ "content-type": "application/json", ...headers }),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
	}

	rssMb(): number {
		const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(this.proc?.pid)]).stdout.toString().trim();
		return Math.round((Number(out) / 1024) * 10) / 10;
	}

	/** waits until the session leaves the status map (idle sessions are absent) */
	async idle(id: string, timeoutMs = 10 * 60_000) {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			const st = await this.api("/session/status");
			if (!st[id] || st[id].type === "idle") return;
			await Bun.sleep(500);
		}
		throw new Error(`session ${id} still busy after ${timeoutMs} ms`);
	}

	/** polls until `get` returns something truthy */
	async until<T>(get: () => Promise<T>, what: string, timeoutMs = 3 * 60_000): Promise<NonNullable<T>> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			const v = await get();
			if (v) return v as NonNullable<T>;
			await Bun.sleep(500);
		}
		throw new Error(`timed out waiting for ${what}`);
	}
}

export async function gitRepo(dir: string, files: Record<string, string> = { "hello.txt": "hello\n" }) {
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		await Bun.write(join(dir, name), body);
	}
	await $`git init -q -b main && git add -A && git -c user.email=it@cmx2 -c user.name=it commit -qm init`.cwd(dir).quiet();
}

export function nonce(): string {
	return Math.random().toString(36).slice(2, 7);
}
