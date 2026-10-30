import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { serve } from "../src/index.ts";

/**
 * serve jobs over http: they never count in parked.jobs (with or without a notify armed), a plain job with notify
 * does, and every ProcessInfo (answers and events, checked against the manifest by checkEvents) carries serve and notify.
 * no model answers: the provider is a socket that accepts and never replies, and no turn is started.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-serve-jobs-")));
const work = join(root, "proj");
mkdirSync(work, { recursive: true });
const sockets = new Set<Socket>();
let silent: Server;
let daemon: ReturnType<typeof serve>;
let base: string;
const auth = { authorization: `Basic ${btoa("opencode:serve")}` };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(base + path, { method, headers: { ...auth, "content-type": "application/json", "x-cmx2-directory": work }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
	silent = createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	const port = (silent.address() as { port: number }).port;
	const config = { ...structuredClone(DEFAULTS), providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "unused" } }, sources: [] };
	daemon = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(root, "data"), password: "serve", checkEvents: true, reload: () => config });
	base = `http://127.0.0.1:${daemon.server.port}`;
});

afterAll(async () => {
	await daemon.stop();
	for (const s of sockets) s.destroy();
	silent.close();
});

test("serve jobs stay out of parked.jobs with and without a notify; a plain job with notify counts; serve and notify ride on answers and events", async () => {
	const frames: any[] = [];
	const ctl = new AbortController();
	const reading = (async () => {
		const res = await fetch(`${base}/global/event?types=process.started,process.exited`, { headers: auth, signal: ctl.signal });
		const reader = res.body!.getReader();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buf += new TextDecoder().decode(value);
			let i: number;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				for (const line of frame.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)).payload);
			}
		}
	})().catch(() => {});
	await Bun.sleep(100);
	const s = (await call("POST", "/session", { title: "it-serve-jobs" })).json;
	const parked = async () => (await call("GET", `/session/${s.id}`)).json.status?.parked;

	const bare = await call("POST", `/session/${s.id}/procs`, { command: "sleep 60", serve: true });
	expect(bare.status).toBe(201);
	expect(bare.json).toMatchObject({ serve: true, notify: null, kind: "job" });
	const armed = (await call("POST", `/session/${s.id}/procs`, { command: "sleep 61", serve: true, notify: { on_exit: true } })).json;
	expect(armed).toMatchObject({ serve: true, notify: { on_exit: true } });
	expect(await parked()).toBeUndefined();

	const plain = (await call("POST", `/session/${s.id}/procs`, { command: "sleep 62", notify: { on_exit: true } })).json;
	expect(plain).toMatchObject({ serve: false, notify: { on_exit: true } });
	expect(await parked()).toEqual({ agents: 0, jobs: 1 });

	const listed = (await call("GET", `/session/${s.id}/procs`)).json as any[];
	expect(listed.map((p) => [p.id, p.serve, p.notify])).toEqual([
		[bare.json.id, true, null],
		[armed.id, true, { on_exit: true }],
		[plain.id, false, { on_exit: true }],
	]);

	await call("POST", `/proc/${plain.id}/kill`);
	expect(await parked()).toBeUndefined();
	await call("POST", `/proc/${armed.id}/kill`);
	await call("POST", `/proc/${bare.json.id}/kill`);
	for (let i = 0; i < 100 && frames.filter((f) => f.type === "process.exited").length < 3; i++) await Bun.sleep(20);
	ctl.abort();
	await reading;
	const startedFrame = frames.find((f) => f.type === "process.started" && f.properties.process.id === armed.id);
	expect(startedFrame.properties.process).toMatchObject({ serve: true, notify: { on_exit: true } });
	const exited = frames.find((f) => f.type === "process.exited" && f.properties.process.id === armed.id);
	expect(exited.properties.process).toMatchObject({ serve: true, notify: null, status: "exited" });
	expect(frames.find((f) => f.type === "process.started" && f.properties.process.id === plain.id).properties.process.serve).toBe(false);
});
