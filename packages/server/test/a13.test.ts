/**
 * the event log and the reads agree on a message a restart ended. a cli daemon (port 4830,
 * shifted by CMX2_PORT_SHIFT) streams a slow reply from a scripted provider on loopback; mid-answer it is
 * stopped (SIGTERM, as a supervisor restart does) or killed (SIGKILL, a crash), started again on the same
 * store, and every message.updated the log carries for the session is compared with the row
 * GET /session/:id/message serves.
 *
 * run: bun test packages/server/test/a13.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, nonce, port } from "../../eval/src/harness.ts";

const SCRATCH = `/tmp/cmx2-a13-${nonce()}`;
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** answers every request with a slow reply: a word every 50 ms for 20 s, so a restart lands mid-answer */
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const slow = !!body.tools?.length;
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const put = (s: string) => {
					try {
						c.enqueue(new TextEncoder().encode(s));
						return true;
					} catch {
						return false;
					}
				};
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				// the answer thinks first (two parts announced in the log, neither finished when the daemon goes), then writes slowly
				const at = slow ? 1 : 0;
				if (slow) {
					put(sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
					for (const t of ["let me ", "think"]) put(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: t } }));
					put(sse("content_block_stop", { index: 0 }));
				}
				put(sse("content_block_start", { index: at, content_block: { type: "text", text: "" } }));
				for (let i = 0; i < (slow ? 400 : 1); i++) {
					if (!put(sse("content_block_delta", { index: at, delta: { type: "text_delta", text: slow ? `word${i} ` : "a title" } }))) return;
					if (slow) await Bun.sleep(50);
				}
				put(sse("content_block_stop", { index: at }));
				put(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				try {
					c.close();
				} catch {}
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => provider.stop(true));

/** every logged event after the start of the store, read from a stream that replays the log */
async function logged(d: Daemon, epoch: string, sessionID: string): Promise<any[]> {
	const ctl = new AbortController();
	const res = await fetch(`${d.base}/global/event?after=${epoch}:0`, { headers: d.headers(), signal: ctl.signal });
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const out: any[] = [];
	const t0 = Date.now();
	// the replay is written before the stream goes live; a heartbeat-free second of quiet means it is done
	let last = Date.now();
	while (Date.now() - last < 1000 && Date.now() - t0 < 20_000) {
		const r = await Promise.race([reader.read(), Bun.sleep(250).then(() => undefined)]);
		if (!r) continue;
		if (r.done) break;
		last = Date.now();
		buf += dec.decode(r.value, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			const data = block.split("\n").find((l) => l.startsWith("data: "));
			if (!block.startsWith("id: ") || !data) continue;
			const p = JSON.parse(data.slice(6)).payload;
			if (p.properties?.sessionID === sessionID || p.properties?.info?.sessionID === sessionID) out.push(p);
		}
	}
	ctl.abort();
	return out;
}

async function cut(how: "SIGTERM" | "SIGKILL") {
	const dir = join(ROOT, how);
	mkdirSync(join(dir, "config"), { recursive: true });
	mkdirSync(join(dir, "work"), { recursive: true });
	writeFileSync(join(dir, "config", "cmx2.jsonc"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } } }));
	const opts = { port: port(4830), dataDir: join(dir, "data"), log: join(dir, "daemon.log"), env: { CMX2_CONFIG_DIR: join(dir, "config") } };
	let d = new Daemon(opts);
	await d.start();
	try {
		const s = await d.api("/session", { directory: join(dir, "work"), title: `it-a13-${how}-${nonce()}` });
		await d.api(`/session/${s.id}/prompt_async`, { text: "a long answer, please" });
		await d.until(async () => ((await d.api(`/session/${s.id}/message`)).some((m: any) => m.info.role === "assistant") ? true : undefined), "the answer to start streaming", 20_000);
		await Bun.sleep(1500);
		if (how === "SIGTERM") await d.stop();
		else await d.kill();
		d = new Daemon(opts);
		await d.start();
		// the store's epoch, from a cursor the daemon rejects as invalid: stream.reset names it
		const probe = await fetch(`${d.base}/global/event?after=x`, { headers: d.headers() });
		const reader = probe.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		void reader.cancel();
		const ep = JSON.parse(first.split("\n").find((l) => l.startsWith("data: "))!.slice(6)).payload.properties.epoch as string;
		// a read after the restart (it opens the session, as a client that reconnects does)
		await d.api(`/session/${s.id}`);
		const rows = await d.api(`/session/${s.id}/message`);
		const events = await logged(d, ep, s.id);
		const lastInfo = new Map<string, any>();
		for (const e of events) if (e.type === "message.updated") lastInfo.set(e.properties.info.id, e.properties.info);
		const cutOff = [...lastInfo.values()].find((i) => i.role === "assistant");
		const row = rows.find((m: any) => m.info.id === cutOff?.id)?.info;
		console.log(`${how}: the cut-off message ${cutOff?.id}: event finish ${cutOff?.finish} completed ${cutOff?.time?.completed}; row ${row ? `finish ${row.finish} completed ${row.time?.completed}` : "absent"}`);
		const differ = [...lastInfo.values()].filter((info) => JSON.stringify(rows.find((m: any) => m.info.id === info.id)?.info) !== JSON.stringify(info));
		for (const info of differ) console.log(`  differs: ${info.id}\n    event ${JSON.stringify(info)}\n    row   ${JSON.stringify(rows.find((m: any) => m.info.id === info.id)?.info)}`);
		// the parts too: the last logged update of each part of the cut-off message is the part a read serves, and none is left streaming
		const lastPart = new Map<string, any>();
		for (const e of events) if (e.type === "message.part.updated" && e.properties.part.messageID === cutOff?.id) lastPart.set(e.properties.part.id, e.properties.part);
		const readParts: any[] = rows.find((m: any) => m.info.id === cutOff?.id)?.parts ?? [];
		console.log(`  parts of the cut-off message: log ${JSON.stringify([...lastPart.values()].map((p) => [p.type, p.text.length, p.streaming ?? false]))}; read ${JSON.stringify(readParts.map((p) => [p.type, p.text.length, p.streaming ?? false]))}`);
		const partsDiffer = [...lastPart.values()].filter((p) => JSON.stringify(readParts.find((r) => r.id === p.id)) !== JSON.stringify(p));
		// the session goes on, and its next answer takes a new id rather than the cut-off one
		await d.api(`/session/${s.id}/prompt_async`, { text: "again" });
		const next = await d.until(async () => (await d.api(`/session/${s.id}/message`)).find((m: any) => m.info.role === "assistant" && m.info.id > (cutOff?.id ?? ""))?.info.id, "the next answer", 20_000);
		console.log(`  the next answer is ${next}`);
		await d.api(`/session/${s.id}/abort`, {});
		return { cutOff, row, differ, lastPart, readParts, partsDiffer };
	} finally {
		await d.stop();
	}
}

test("a13: a message a SIGTERM restart cut off reads the same as its last logged event", async () => {
	const r = await cut("SIGTERM");
	expect(r.cutOff?.finish).toBe("aborted");
	expect(r.row?.time?.completed).toBe(r.cutOff?.time?.completed);
	expect(r.differ).toEqual([]);
	// a graceful stop writes what streamed: both parts, their text kept, none left streaming in the log
	expect(r.readParts.map((p) => p.type)).toEqual(["reasoning", "text"]);
	expect(r.readParts[0]!.text).toBe("let me think");
	expect(r.readParts[1]!.text.length).toBeGreaterThan(0);
	expect(r.readParts.every((p) => p.streaming === undefined && p.time.end >= p.time.start)).toBe(true);
	expect(r.partsDiffer).toEqual([]);
	expect([...r.lastPart.values()].some((p) => p.streaming)).toBe(false);
}, 90_000);

test("a13: a message a SIGKILL cut off reads the same as its last logged event, parts included", async () => {
	const r = await cut("SIGKILL");
	expect(r.cutOff).toBeDefined();
	expect(r.row?.time?.completed).toBe(r.cutOff?.time?.completed);
	expect(r.differ).toEqual([]);
	// the thinking's block had ended, so its final (whole text, its end) was logged and survives; the text was still streaming and its words
	// were never logged, so that part closes empty: the log's last word on each part is the part a read serves
	expect(r.readParts.map((p) => [p.type, p.text])).toEqual([["reasoning", "let me think"], ["text", ""]]);
	expect(r.lastPart.get(r.readParts[0]!.id)?.streaming).toBeUndefined();
	expect(r.readParts.every((p) => p.streaming === undefined && p.time.end >= p.time.start)).toBe(true);
	expect(r.lastPart.size).toBe(2);
	expect(r.partsDiffer).toEqual([]);
	expect([...r.lastPart.values()].some((p) => p.streaming)).toBe(false);
}, 90_000);
