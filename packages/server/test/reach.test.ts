/**
 * a session directory that does not answer (a macos privacy prompt, a hung mount) holds only the session
 * that needs it. the stand-in is a directory whose `.cmx2/cmx2.jsonc` is a fifo with no writer: opening it
 * blocks until something writes, the way a read behind a pending prompt does. a fifo blocks an open, not a
 * stat, so this covers the reads and not a stat that hangs.
 *
 * run: bun test packages/server/test/reach.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfigAsync } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";
import { Reach, waitingText } from "../src/reach.ts";

const fifos = process.platform !== "win32";
const ROOT = join(realpathSync(mkdtempSync("/tmp/cmx2-reach-")), `reach-${nonce()}`);
const CONFIG = join(ROOT, "config");
mkdirSync(CONFIG, { recursive: true });
const CONFIG_DIR_BEFORE = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = CONFIG;
afterAll(() => {
	if (CONFIG_DIR_BEFORE === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = CONFIG_DIR_BEFORE;
});

/** a directory whose project config is a fifo nobody writes yet */
function stuckDir(name: string): string {
	const dir = join(ROOT, name);
	mkdirSync(join(dir, ".cmx2"), { recursive: true });
	expect(Bun.spawnSync(["mkfifo", join(dir, ".cmx2", "cmx2.jsonc")]).exitCode).toBe(0);
	return dir;
}

/** writes the fifo from a child, so the test's own thread never waits on it */
async function feed(dir: string, text = "{}") {
	await Bun.spawn(["sh", "-c", 'printf %s "$1" > "$2"', "sh", text, join(dir, ".cmx2", "cmx2.jsonc")]).exited;
}

/** a stand-in provider on loopback that answers every request with "pong" in anthropic's stream */
const sseLine = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = (await req.json()) as { model: string };
		const text = [
			sseLine("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }),
			sseLine("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
			sseLine("content_block_delta", { index: 0, delta: { type: "text_delta", text: "pong" } }),
			sseLine("content_block_stop", { index: 0 }),
			sseLine("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
			sseLine("message_stop", {}),
		].join("");
		return new Response(text, { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => provider.stop(true));

const settledWithin = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), Bun.sleep(ms).then(() => false)]);

describe("Reach", () => {
	test("one probe per directory, shared; ready once it settles, a failed probe included", async () => {
		let runs = 0;
		let open!: () => void;
		const r = new Reach({ probe: () => (runs++, new Promise<void>((ok) => (open = ok))) });
		const a = r.wait("/x");
		const b = r.wait("/x");
		await Bun.sleep(1);
		expect(runs).toBe(1);
		expect(r.ready("/x")).toBe(false);
		open();
		await Promise.all([a, b]);
		expect(r.ready("/x")).toBe(true);
		const denied = new Reach({ probe: async () => Promise.reject(new Error("EPERM")) });
		await denied.wait("/y");
		expect(denied.ready("/y")).toBe(true);
	});

	test("a probe past the slow mark says so, and says when it settled", async () => {
		const seen: string[] = [];
		let open!: () => void;
		const r = new Reach({ slowMs: 20, probe: () => new Promise<void>((ok) => (open = ok)), onSlow: (d) => seen.push(`slow ${d}`), onSettled: (d, _ms, slow) => seen.push(`settled ${d} ${slow}`) });
		const w = r.wait("/z");
		await Bun.sleep(50);
		expect(r.slow("/z")).toBe(true);
		open();
		await w;
		expect(seen).toEqual(["slow /z", "settled /z true"]);
		expect(r.slow("/z")).toBe(false);
	});

	test("the waiting words are plain and name the directory", () => {
		expect(waitingText("/d", "darwin")).toBe("waiting for access to /d. macos may be asking on the mac");
		expect(waitingText("/d", "linux")).toBe("waiting for access to /d. the file system is not answering");
	});
});

describe.skipIf(!fifos)("a directory that does not answer", () => {
	test("loadConfigAsync waits off the main thread and goes on once the read answers", async () => {
		const dir = stuckDir("cfg");
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		const loading = loadConfigAsync({ cwd: dir });
		expect(await settledWithin(loading, 300)).toBe(false);
		clearInterval(timer);
		// the event loop kept running while the open waited
		expect(ticks).toBeGreaterThan(5);
		await feed(dir, JSON.stringify({ effort: "low" }));
		const c = await loading;
		expect(c.effort).toBe("low");
		expect(c.sources).toContain(join(dir, ".cmx2", "cmx2.jsonc"));
	});

	test("the daemon serves everyone else while one session's directory waits, and that session goes on", async () => {
		const stuck = stuckDir("stuck");
		const fine = join(ROOT, "fine");
		mkdirSync(fine, { recursive: true });
		const data = join(ROOT, "data");
		const providers = { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } };
		writeFileSync(join(CONFIG, "cmx2.jsonc"), JSON.stringify({ providers }));
		const c = { ...structuredClone(DEFAULTS), providers, sources: [] };
		const PORT = port(4871);
		const base = `http://127.0.0.1:${PORT}`;
		const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		let d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: data, checkEvents: true });
		let id: string;
		try {
			const creating = post("/session", { directory: stuck, title: `stuck ${nonce()}` });
			expect(await settledWithin(creating, 300)).toBe(false);
			// a cheap route and another directory's session answer at once
			const t0 = Date.now();
			expect((await fetch(`${base}/global/health`)).status).toBe(200);
			expect((await post("/session", { directory: fine, title: `fine ${nonce()}` })).status).toBe(201);
			expect(Date.now() - t0).toBeLessThan(2000);
			expect(await settledWithin(creating, 50)).toBe(false);
			await feed(stuck);
			const res = await creating;
			expect(res.status).toBe(201);
			id = ((await res.json()) as { id: string }).id;
			expect(d.violations()).toBe(0);
		} finally {
			await d.stop();
		}

		// a fresh daemon resumes the session: its prompt is accepted at once and waits for the directory behind the 202, the
		// status says why, a read naming the directory waits alone, and the prompt runs when the directory answers
		d = serve({ config: c, port: PORT + 1, hostname: "127.0.0.1", dataDir: data, checkEvents: true });
		const base2 = `http://127.0.0.1:${PORT + 1}`;
		const send = (text: string) => fetch(`${base2}/session/${id}/prompt_async`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text }] }) });
		try {
			const t0 = Date.now();
			const first = await send("hi");
			expect(first.status).toBe(202);
			expect(Date.now() - t0).toBeLessThan(1000);
			const { messageID, queued } = (await first.json()) as { messageID: string; queued: boolean };
			expect(queued).toBe(true);
			// a second send waits behind the first, and can be taken back before it runs
			const second = (await (await send("never")).json()) as { messageID: string };
			expect(((await (await fetch(`${base2}/session/${id}/queue`)).json()) as Array<{ info: { id: string } }>).map((m) => m.info.id)).toEqual([messageID, second.messageID]);
			expect((await fetch(`${base2}/session/${id}/message/${second.messageID}`, { method: "DELETE" })).status).toBe(200);
			// a read that names the waiting directory waits for it alone
			const config = fetch(`${base2}/config?directory=${encodeURIComponent(stuck)}`);
			await Bun.sleep(2300);
			expect(await settledWithin(config, 10)).toBe(false);
			const status = (await (await fetch(`${base2}/session/status`)).json()) as Record<string, { type: string; waiting?: string }>;
			expect(status[id]).toMatchObject({ type: "busy", waiting: waitingText(stuck) });
			expect((await fetch(`${base2}/session?directory=${encodeURIComponent(stuck)}`)).status).toBe(200);
			expect((await fetch(`${base2}/global/fs?path=${encodeURIComponent(stuck)}&hidden=true`)).status).toBe(200);
			await feed(stuck);
			expect((await config).status).toBe(200);
			// the prompt ran: its answer lands, and the one taken back never did
			let texts: string[] = [];
			for (let i = 0; i < 100 && !texts.includes("pong"); i++) {
				await Bun.sleep(100);
				const msgs = (await (await fetch(`${base2}/session/${id}/message`)).json()) as Array<{ parts: Array<{ type: string; text?: string }> }>;
				texts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? ""));
			}
			expect(texts).toContain("hi");
			expect(texts).toContain("pong");
			expect(texts).not.toContain("never");
			expect(d.violations()).toBe(0);
		} finally {
			await d.stop();
		}
	}, 20_000);
});
