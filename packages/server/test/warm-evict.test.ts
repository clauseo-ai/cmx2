/**
 * roots are warmed while parked (D28), for up to 4 hours, so the residency cap may evict a warming root: only past
 * MAX_RESIDENT, oldest first, and only one whose warming is timers, never one with a refresh on the wire. a warming
 * helper is never evicted. a daemon in this process (port 4889, shifted by CMX2_PORT_SHIFT) whose provider is a
 * scripted stand-in on loopback speaking anthropic's stream.
 *
 * run: bun test packages/server/test/warm-evict.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { MAX_RESIDENT, serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-warm-evict-"));
const WORK = join(SCRATCH, "work");
const CONFIG = join(SCRATCH, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
const WARM_DELAY_BEFORE = process.env.CMX2_WARM_DELAY_MS;
process.env.CMX2_CONFIG_DIR = CONFIG;
delete process.env.CMX2_WARM_DELAY_MS;
const PORT = port(4889);
const BASE = `http://127.0.0.1:${PORT}`;

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
/** while `hold` is set, a request is held this long before it is answered; `held` counts them */
let hold = false;
let held = 0;
const HOLD_MS = 4000;
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		if (hold) {
			held++;
			await Bun.sleep(HOLD_MS);
		}
		const text = body.tools?.length ? "ok" : "a title";
		const out = [
			sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 1 } } }),
			sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
			sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
			sse("content_block_stop", { index: 0 }),
			sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
			sse("message_stop", {}),
		].join("");
		return new Response(out, { headers: { "content-type": "text/event-stream" } });
	},
});

const config = () => ({ ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] });
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(SCRATCH, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	try {
		expect(d.violations()).toBe(0);
	} finally {
		if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
		else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
		if (WARM_DELAY_BEFORE === undefined) delete process.env.CMX2_WARM_DELAY_MS;
		else process.env.CMX2_WARM_DELAY_MS = WARM_DELAY_BEFORE;
		await d.stop();
		provider.stop(true);
		rmSync(SCRATCH, { recursive: true, force: true });
	}
});

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const newSession = async (tag: string) => (await call("POST", "/session", { directory: WORK, title: `it-we-${tag}-${nonce()}` })).json.id as string;
const until = async (f: () => boolean, what: string, ms = 15_000) => {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
};
const settled = (id: string) => d.sessions.get(id)?.state === "idle";
const prompt = async (id: string, text: string) => {
	expect((await call("POST", `/session/${id}/message`, { parts: [{ type: "text", text }] })).status).toBe(200);
};

test("over the cap a warming root on timers is evicted, oldest first; a warming helper and a root with a refresh on the wire are not", async () => {
	// a root with a parked helper: both warm on timers (the default delay is minutes away)
	const r0 = await newSession("r0");
	await prompt(r0, "start");
	const spawned = await call("POST", `/session/${r0}/agents`, { brief: "warm evict kid", name: "we_kid", model: "anthropic/claude-opus-5-5", effort: "low" });
	expect(spawned.status).toBe(201);
	const kid = spawned.json.agents[0].id as string;
	await until(() => settled(kid), "the helper to park");
	// its report wakes the root; let that turn settle
	await Bun.sleep(500);
	await until(() => settled(r0), "the root to settle");
	expect(d.sessions.get(kid)!.warming).toBe(true);
	expect(d.sessions.get(r0)!.warmingOnTimers).toBe(true);

	// a root whose refresh goes out at once and is held by the provider: on the wire, not only timers
	process.env.CMX2_WARM_DELAY_MS = "50";
	const busy = await newSession("busy");
	await prompt(busy, "busy");
	hold = true;
	await until(() => held > 0, "the busy root's refresh to reach the provider", 3000);
	hold = false;
	delete process.env.CMX2_WARM_DELAY_MS;
	expect(d.sessions.get(busy)!.warming).toBe(true);
	expect(d.sessions.get(busy)!.warmingOnTimers).toBe(false);

	// more roots than the cap, each parked and warming on timers
	const roots: string[] = [];
	for (let i = 0; i < MAX_RESIDENT + 1; i++) {
		const id = await newSession(`r${i + 1}`);
		await prompt(id, `root ${i}`);
		roots.push(id);
	}
	await Bun.sleep(100);
	expect(d.sessions.has(kid)).toBe(true);
	expect(d.sessions.has(busy)).toBe(true);
	expect(d.sessions.has(r0)).toBe(false);
	expect(d.sessions.has(roots.at(-1)!)).toBe(true);
	const warmRoots = [r0, busy, ...roots].filter((id) => d.sessions.get(id)?.warming);
	expect(warmRoots.length).toBeLessThanOrEqual(MAX_RESIDENT);
	// evicted, never deleted: the root's history is all there
	expect(d.store.messageCount(r0)).toBeGreaterThan(0);
	// let the held refresh finish before the daemon stops
	await Bun.sleep(HOLD_MS);
}, 30_000);
