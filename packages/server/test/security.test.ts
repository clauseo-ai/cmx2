/**
 * the security review's fixes, against daemons in this process on a real
 * socket (port 4830, shifted by CMX2_PORT_SHIFT), one at a time. the provider is a scripted stand-in
 * on loopback that speaks the anthropic stream, so the whole daemon path runs (engine, tools, actors,
 * procs, the listener) without a model: which call comes back is decided by markers in the prompt.
 *
 * run: bun test packages/server/test/security.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { NO_PUSH_TRANSPORT } from "@cmx2/engine/permission";
import { gitRepo, nonce, port } from "../../eval/src/harness.ts";
import { DELTA_FRAME_BYTES, serve } from "../src/index.ts";

const SCRATCH = `/tmp/cmx2-security-${nonce()}`;
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4830);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- the scripted provider ----------

type Block = { type: "text"; text: string[]; gapMs?: number } | { type: "tool_use"; name: string; input: unknown };

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** what the stand-in answers: markers in the session's first user message pick the script */
function script(body: any): Block[] {
	const messages: any[] = body.messages ?? [];
	if (!body.tools?.length) return [{ type: "text", text: ["a title"] }];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = JSON.stringify(messages).includes('"tool_result"');
	if (first.includes("[child-push]")) {
		if (answered) return [{ type: "text", text: ["done"] }];
		return [
			{ type: "tool_use", name: "shell", input: { command: "git push origin HEAD:main" } },
			{ type: "tool_use", name: "shell", input: { command: "git -C . push origin HEAD:main" } },
			{ type: "tool_use", name: "shell", input: { command: "sh -c 'git push origin HEAD:main'" } },
			{ type: "tool_use", name: "run", input: { code: "const a = await shell.exec({ command: 'git -C . push origin HEAD:main' }); let b; try { await shell.exec({ command: 'git push origin HEAD:main' }); } catch (e) { b = String(e); } return { a: a.output, b };" } },
		];
	}
	if (first.includes("[spawn-push]")) {
		if (answered) return [{ type: "text", text: ["done"] }];
		return [{ type: "tool_use", name: "spawn", input: { brief: "[child-push] push the branch", name: "pusher", model: "sonnet" } }];
	}
	if (first.includes("[root-push]")) {
		if (answered) return [{ type: "text", text: ["done"] }];
		return [{ type: "tool_use", name: "shell", input: { command: "git push origin HEAD:main" } }];
	}
	const glyphs = first.match(/\[glyphs (\d+) (\d+)\]/);
	if (glyphs) return [{ type: "text", text: Array.from({ length: Number(glyphs[1]) }, (_, i) => (i % 2 ? "𝄞" : "é")), gapMs: Number(glyphs[2]) }];
	const burst = first.match(/\[burst (\d+) (\d+)\]/);
	if (burst) return [{ type: "text", text: Array.from({ length: Number(burst[1]) }, (_, i) => `${String(i).padStart(8, "0")} ${"x".repeat(Number(burst[2]) - 10)}\n`) }];
	const big = first.match(/\[big (\d+)\]/);
	if (big) return [{ type: "text", text: [`"quoted"\n${"y".repeat(Number(big[1]))}`] }];
	return [{ type: "text", text: ["ok"] }];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const enc = new TextEncoder();
				const put = (s: string) => c.enqueue(enc.encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "text") {
						put(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
						if (b.gapMs) {
							for (const t of b.text) {
								put(sse("content_block_delta", { index, delta: { type: "text_delta", text: t } }));
								await Bun.sleep(b.gapMs);
							}
						} else put(b.text.map((t) => sse("content_block_delta", { index, delta: { type: "text_delta", text: t } })).join(""));
					} else {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: b.name, input: {} } }));
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
					}
					put(sse("content_block_stop", { index }));
				}
				put(sse("message_delta", { delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });

afterAll(() => provider.stop(true));

type Daemon = ReturnType<typeof serve>;
async function withDaemon<T>(o: { hostname?: string; password?: string; data: string; streamCap?: number }, fn: (d: Daemon) => Promise<T>): Promise<T> {
	const c = config();
	const d = serve({ config: c, port: PORT, hostname: o.hostname ?? "127.0.0.1", dataDir: join(ROOT, o.data), checkEvents: true, reload: () => c, ...(o.password ? { password: o.password } : {}), ...(o.streamCap ? { streamCap: o.streamCap } : {}) });
	try {
		return await fn(d);
	} finally {
		await d.stop();
	}
}

async function until<T>(f: () => Promise<T | undefined>, what: string, ms = 30_000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await f().catch(() => undefined);
		if (v !== undefined) return v;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

// ---------- auth: web pages, rebinding, open binds, bodies ----------

describe("auth", () => {
	test("an open loopback daemon refuses cross-site requests and foreign hosts, and still answers its own clients", async () => {
		await withDaemon({ data: "open" }, async () => {
			const marker = join(ROOT, "pwned");
			const csrf = await fetch(`${BASE}/pty`, { method: "POST", headers: { origin: "http://evil.example", "content-type": "text/plain" }, body: JSON.stringify({ command: "touch", args: [marker] }) });
			expect(csrf.status).toBe(403);
			expect((await csrf.json()).name).toBe("ForbiddenError");
			await Bun.sleep(300);
			expect(await Bun.file(marker).exists()).toBe(false);
			expect((await fetch(`${BASE}/session`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
			const rebind = { host: `rebind.evil.example:${PORT}` };
			expect((await fetch(`${BASE}/global/fs?path=~`, { headers: rebind })).status).toBe(403);
			expect((await fetch(`${BASE}/global/event`, { headers: rebind })).status).toBe(403);
			const ws = await $`curl -s -m 3 -o /dev/null -w %{http_code} -H ${"Origin: http://evil.example"} -H ${"Connection: Upgrade"} -H ${"Upgrade: websocket"} -H ${"Sec-WebSocket-Version: 13"} -H ${"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="} ${`${BASE}/pty/pty_x/connect`}`.nothrow().text();
			expect(ws).toBe("403");
			// what real clients send: no origin (cli, tui, boxbox's proxy), a same-origin page, a loopback name
			expect((await fetch(`${BASE}/session`)).status).toBe(200);
			expect((await fetch(`${BASE}/session`, { headers: { origin: `http://127.0.0.1:${PORT}` } })).status).toBe(200);
			expect((await fetch(`${BASE}/session`, { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
			expect((await (await fetch(`${BASE}/pty`)).json()).length).toBe(0);
		});
	});

	test("a daemon on every interface needs a credential before its first pairing", async () => {
		await withDaemon({ data: "wide", hostname: "0.0.0.0" }, async () => {
			const r = await fetch(`${BASE}/session`);
			expect(r.status).toBe(401);
			const token = (await Bun.file(join(ROOT, "wide", "auth", "local.token")).text()).trim();
			expect((await fetch(`${BASE}/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
		});
	});

	test("an unauthenticated body is refused before it is read; an authenticated one over the cap is a 413", async () => {
		await withDaemon({ data: "pw", password: "pw" }, async () => {
			const before = process.memoryUsage().rss;
			const t0 = performance.now();
			// from another process, so this one's memory is the daemon's side only
			const code = await $`head -c 300000000 /dev/zero | curl -s -o /dev/null -w %{http_code} -X POST -H ${"content-type: application/json"} --data-binary @- ${`${BASE}/session`}`.nothrow().text();
			const grew = (process.memoryUsage().rss - before) / 1024 / 1024;
			console.log(`an unauthenticated 300 MB post: ${code} in ${Math.round(performance.now() - t0)} ms, rss ${grew >= 0 ? "+" : ""}${grew.toFixed(1)} MB`);
			expect(code).toBe("401");
			expect(grew).toBeLessThan(100);
			const big = await $`head -c 140000000 /dev/zero | curl -s -o /dev/null -w %{http_code} -u cmx2:pw -X POST -H ${"content-type: application/json"} --data-binary @- ${`${BASE}/session`}`.nothrow().text();
			expect(big).toBe("413");
			expect((await fetch(`${BASE}/session`, { headers: { authorization: `Basic ${btoa("cmx2:nope")}` } })).status).toBe(401);
			expect((await fetch(`${BASE}/session`, { headers: { authorization: `Basic ${btoa("cmx2pw")}` } })).status).toBe(401);
			expect((await fetch(`${BASE}/session`, { headers: { authorization: `Basic ${btoa("cmx2:pw")}` } })).status).toBe(200);
			// the pairing exchange stays open, with a small body
			expect((await fetch(`${BASE}/pair`, { method: "POST", body: JSON.stringify({ token: "cmx2p_nope" }) })).status).toBe(401);
		});
	}, 60_000);
});

// ---------- subagents never push ----------

describe("subagents", () => {
	test("a subagent's git push is refused on every spelling; the root's is not", async () => {
		const remote = join(ROOT, "remote.git");
		const proj = join(ROOT, "proj");
		await $`git init -q --bare -b main ${remote}`.quiet();
		await gitRepo(proj);
		await $`git -C ${proj} branch -M main && git -C ${proj} remote add origin ${remote} && git -C ${proj} push -q origin main`.quiet();
		const head = async () => (await $`git -C ${remote} rev-parse main`.text()).trim();
		await withDaemon({ data: "push" }, async () => {
			const api = async (path: string, body?: unknown) => (await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
			await $`git -C ${proj} commit -q --allow-empty -m child-work`.quiet();
			const before = await head();
			const root = await api("/session", { directory: proj, title: `it-security-push-${nonce()}` });
			await api(`/session/${root.id}/prompt_async`, { text: "[spawn-push]" });
			const child = await until(async () => (await api(`/session/${root.id}/agents`)).agents.find((a: any) => a.depth === 1), "the child");
			const outputs = await until(async () => {
				const parts = (await api(`/session/${child.id}/message`)).flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool" && p.tool === "shell");
				return parts.length >= 3 && parts.slice(0, 3).every((p: any) => p.state?.status === "completed" || p.state?.status === "error") ? parts.slice(0, 3).map((p: any) => `${p.state.input.command} → ${p.state.output ?? p.state.error}`) : undefined;
			}, "the child's three pushes").catch(async (e) => {
				console.log(JSON.stringify((await api(`/session/${child.id}/message`)).flatMap((m: any) => m.parts).filter((p: any) => p.type !== "text")).slice(0, 3000));
				throw e;
			});
			for (const o of outputs) console.log(`  child: ${o.replace(/\n/g, " ").slice(0, 200)}`);
			expect(outputs[0]).toContain("a permission rule blocks this call (shell git push *: deny)");
			expect(outputs[1]).toContain(NO_PUSH_TRANSPORT);
			expect(outputs[2]).toContain(NO_PUSH_TRANSPORT);
			// a run script's helpers take the same rule and the same environment
			const run = await until(async () => (await api(`/session/${child.id}/message`)).flatMap((m: any) => m.parts).find((p: any) => p.type === "tool" && p.tool === "run" && p.state?.status !== "running")?.state, "the child's run script");
			const said = String(run.output ?? run.error);
			console.log(`  child run: ${said.replace(/\n/g, " ").slice(0, 300)}`);
			expect(said).toContain(NO_PUSH_TRANSPORT);
			expect(said).toContain("git push *: deny");
			expect(await head()).toBe(before);
			// the root is the person's session: its push goes through
			const top = await api("/session", { directory: proj, title: `it-security-rootpush-${nonce()}` });
			await api(`/session/${top.id}/prompt`, { text: "[root-push]" });
			await until(async () => ((await head()) !== before ? true : undefined), "the root's push");
		});
	}, 60_000);
});

// ---------- streamed text: a frame per delta for a reader that keeps up, 64 kb batches for one behind ----------

/** an sse reader on a raw socket, paused until told to read: a real stall (GOTCHAS: sync and the listener) */
function rawStream(path: string) {
	const sock = connect(PORT, "127.0.0.1");
	let raw = Buffer.alloc(0);
	sock.on("data", (c: Buffer) => {
		raw = Buffer.concat([raw, c]);
	});
	sock.write(`GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\n\r\n`);
	return {
		pause: () => sock.pause(),
		resume: () => sock.resume(),
		close: () => sock.destroy(),
		size: () => raw.length,
		/** the sse frames so far, out of node's chunked encoding */
		frames(): string[] {
			const at = raw.indexOf("\r\n\r\n");
			let body = "";
			let i = at + 4;
			while (i < raw.length) {
				const eol = raw.indexOf("\r\n", i);
				if (eol < 0) break;
				const n = Number.parseInt(raw.subarray(i, eol).toString(), 16);
				if (!n || eol + 2 + n > raw.length) break;
				body += raw.subarray(eol + 2, eol + 2 + n).toString("utf8");
				i = eol + 2 + n + 2;
			}
			return body.split("\n\n").filter(Boolean);
		},
	};
}

const payload = (frame: string) => {
	const d = JSON.parse(frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
	return d.payload ?? d;
};

/** waits for a session's turn to settle on a raw stream */
const idle = (s: ReturnType<typeof rawStream>, id: string) =>
	until(async () => (s.frames().map(payload).some((p) => p.type === "session.idle" && p.properties.sessionID === id) ? true : undefined), "the turn to settle", 60_000);

describe("streamed text", () => {
	test("a reader that keeps up gets a frame per delta (probe a1's 40 glyphs)", async () => {
		await withDaemon({ data: "glyphs" }, async () => {
			const s = rawStream("/global/event");
			const id = (await (await fetch(`${BASE}/session`, { method: "POST", body: JSON.stringify({ directory: WORK, title: `it-glyphs-${nonce()}` }) })).json()).id;
			await fetch(`${BASE}/session/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[glyphs 40 5]" }) });
			await idle(s, id);
			const deltas = s.frames().map(payload).filter((p) => p.type === "message.part.delta" && p.properties.sessionID === id);
			s.close();
			console.log(`40 glyphs 5 ms apart: ${deltas.length} delta frames`);
			expect(deltas.length).toBeGreaterThanOrEqual(40);
			let at = 0;
			for (const d of deltas) {
				expect(d.properties.offset).toBe(at);
				at += d.properties.delta.length;
			}
		});
	});

	test("a reader far behind gets the burst in merged frames of at most 64 kb, text and offsets intact", async () => {
		// a cap high enough that the stalled reader is never cut off, so what it gets is the batching alone
		await withDaemon({ data: "burst", streamCap: 512 * 1024 * 1024 }, async () => {
			const s = rawStream("/global/event");
			await Bun.sleep(100);
			s.pause();
			const id = (await (await fetch(`${BASE}/session`, { method: "POST", body: JSON.stringify({ directory: WORK, title: `it-burst-${nonce()}` }) })).json()).id;
			const N = 40_000;
			await fetch(`${BASE}/session/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: `[burst ${N} 100]` }) });
			s.resume();
			const done = await until(async () => {
				const ps = s.frames().map(payload);
				return ps.some((p) => p.type === "session.idle" && p.properties.sessionID === id) ? ps : undefined;
			}, "the burst to reach the reader", 60_000);
			const frames = s.frames();
			s.close();
			const deltas = done.filter((p) => p.type === "message.part.delta" && p.properties.sessionID === id);
			const deltaFrames = frames.filter((f) => f.includes('"message.part.delta"'));
			const biggest = Math.max(...deltaFrames.map((f) => Buffer.byteLength(`${f}\n\n`)));
			const text = deltas.map((d) => d.properties.delta).join("");
			const final = done.filter((p) => p.type === "message.part.updated" && p.properties.part.type === "text" && p.properties.part.sessionID === id).at(-1)?.properties.part.text;
			console.log(`a ${N}-delta burst (${(text.length / 1e6).toFixed(1)} M chars) to a stalled reader: ${deltas.length} delta frames, the biggest ${biggest} bytes`);
			expect(deltas.length).toBeLessThan(N / 4);
			expect(biggest).toBeLessThanOrEqual(DELTA_FRAME_BYTES);
			expect(text).toBe(final);
			let at = 0;
			for (const d of deltas) {
				expect(d.properties.offset).toBe(at);
				at += d.properties.delta.length;
			}
		});
	}, 90_000);

	test("a single delta over 64 kb is split between characters", async () => {
		await withDaemon({ data: "big" }, async () => {
			const s = rawStream("/global/event");
			const id = (await (await fetch(`${BASE}/session`, { method: "POST", body: JSON.stringify({ directory: WORK, title: `it-big-${nonce()}` }) })).json()).id;
			await fetch(`${BASE}/session/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[big 300000]" }) });
			await idle(s, id);
			const frames = s.frames().filter((f) => f.includes('"message.part.delta"'));
			s.close();
			const deltas = frames.map(payload).filter((p) => p.properties.sessionID === id);
			expect(deltas.length).toBeGreaterThanOrEqual(5);
			expect(Math.max(...frames.map((f) => Buffer.byteLength(`${f}\n\n`)))).toBeLessThanOrEqual(DELTA_FRAME_BYTES);
			expect(deltas.map((d) => d.properties.delta).join("")).toBe(`"quoted"\n${"y".repeat(300000)}`);
		});
	});
});

// ---------- secrets in config reads ----------

import { redactConfig, scrubText } from "../src/profile.ts";

test("GET /config masks url passwords, secret query values and command-line secrets; references stay", () => {
	const c: any = {
		...config(),
		providers: { anthropic: { baseUrl: "https://user:hunter2@proxy.internal:8080", apiKey: "sk-live-1" }, local: { baseUrl: "http://127.0.0.1:4999/v1", apiKey: "$PROXY_KEY" } },
		mcp: { exa: { url: "https://mcp.exa.ai/mcp?exaApiKey=abc123&tools=web" }, gh: { command: ["gh-mcp", "--token", "ghp_abc", "--api-key=zz", "serve"] }, s: { command: "npx srv --password pw1 --port 3" } },
	};
	const text = JSON.stringify(redactConfig(c));
	for (const secret of ["hunter2", "sk-live-1", "abc123", "ghp_abc", "zz\"", "pw1"]) expect(text).not.toContain(secret);
	expect(text).toContain("$PROXY_KEY");
	expect(text).toContain("http://127.0.0.1:4999/v1");
	expect(text).toContain("tools=web");
	expect(text).toContain('"--port 3"'.slice(1, 7));
	expect(scrubText("fetch failed: https://mcp.exa.ai/mcp?exaApiKey=abc123 refused")).toBe("fetch failed: https://mcp.exa.ai/mcp?exaApiKey=[redacted] refused");
});

// ---------- pairing ----------

import { statSync as statOf, mkdirSync as mk, chmodSync as chmodOf } from "node:fs";
import { Pairing } from "../src/pair.ts";

test("pairing: a client's name cannot inject log lines or escapes; the auth dir is 0700; a token is spent once", () => {
	const dir = join(ROOT, "pairing");
	mk(join(dir, "auth"), { recursive: true });
	chmodOf(join(dir, "auth"), 0o755);
	const p = new Pairing(dir);
	const { token } = p.begin();
	expect(statOf(join(dir, "auth")).mode & 0o777).toBe(0o700);
	const r = p.exchange(token, "phone\ncmx2: paired attacker (cred_x)\u001b[2J");
	expect(r.name).not.toMatch(/[\n\u001b]/);
	expect(() => p.exchange(token, "again")).toThrow("already used");
	expect(p.check(r.credential)?.id).toBe(r.id);
	expect(p.revoke(r.id).length).toBe(1);
	expect(p.check(r.credential)).toBeUndefined();
});

// ---------- the daemon's own secret stays out of what it starts ----------

import { Daemon as CliDaemon } from "../../eval/src/harness.ts";

test("cmx2 serve reads CMX2_SERVER_PASSWORD and keeps it out of every process it starts", async () => {
	const dir = join(ROOT, "envcheck");
	mk(join(dir, "config"), { recursive: true });
	await Bun.write(join(dir, "config", "cmx2.jsonc"), "{}");
	const d = new CliDaemon({ port: port(4831), dataDir: join(dir, "data"), log: join(dir, "d.log"), password: "hunter2-review", env: { CMX2_CONFIG_DIR: join(dir, "config") } });
	await d.start();
	try {
		const out = join(dir, "env.txt");
		await d.api("/pty", { command: "sh", args: ["-c", `printf 'pw=%s' "$CMX2_SERVER_PASSWORD" > ${out}`], cwd: dir });
		const said = await until(async () => ((await Bun.file(out).exists()) ? await Bun.file(out).text() : undefined), "the terminal's env line");
		console.log(`a terminal started by a daemon with a password set: ${said}`);
		expect(said).toBe("pw=");
		// and the password still guards the daemon
		expect((await fetch(`${d.base}/session`)).status).toBe(401);
	} finally {
		await d.stop();
	}
}, 30_000);

// ---------- every route in the contract, without a credential ----------

import { ROUTES } from "@cmx2/contract";

test("every route in the contract refuses a request without a credential (only POST /pair is open); every one refuses a rebinding host on an open daemon", async () => {
	const concrete = (p: string) => p.replace(/\{[^}]+\}/g, "x").replace(/:[A-Za-z]+/g, "x");
	const seen: string[] = [];
	await withDaemon({ data: "sweep-pw", password: "pw" }, async () => {
		for (const r of ROUTES) {
			const res = await fetch(BASE + concrete(r.path), { method: r.method, body: r.method === "GET" ? undefined : "{}", signal: AbortSignal.timeout(5000) });
			await res.body?.cancel();
			const open = r.method === "POST" && r.path === "/pair";
			seen.push(`${r.method} ${r.path} ${res.status}`);
			expect([r.method, r.path, res.status === 401]).toEqual([r.method, r.path, !open]);
		}
	});
	await withDaemon({ data: "sweep-open" }, async () => {
		for (const r of ROUTES) {
			const res = await fetch(BASE + concrete(r.path), { method: r.method, headers: { host: `rebind.evil.example:${PORT}` }, body: r.method === "GET" ? undefined : "{}", signal: AbortSignal.timeout(5000) });
			await res.body?.cancel();
			expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 403]);
		}
	});
	console.log(`${ROUTES.length} routes swept: 401 without a credential on all but POST /pair; 403 for a rebinding host on an open daemon`);
}, 120_000);
