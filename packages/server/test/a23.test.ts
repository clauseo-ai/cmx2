/**
 * contract version 5: thinking streams, every streamed part is announced before its
 * deltas, and a part's end is published when its block ends. a daemon in this process (port 4830, shifted by CMX2_PORT_SHIFT) whose provider is a scripted
 * stand-in on loopback speaking anthropic's stream (thinking blocks with thinking_delta, then text), so the
 * whole path runs (pi's adapter, the engine, the projection, the listener) without a model. the real
 * provider's turn is driven by hand and printed in the commit's notes.
 *
 * run: bun test packages/server/test/a23.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-a23-"));
const ROOT = join(SCRATCH, `a23-${nonce()}`);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });
const PORT = port(4830);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- the scripted provider ----------

type Block = { type: "thinking" | "text"; deltas: string[]; gapMs: number; preMs?: number } | { type: "tool_use"; name: string; input: unknown; gapMs?: number };

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** markers in the session's first user message pick what the stand-in answers */
function script(body: any): Block[] {
	if (!body.tools?.length) return [{ type: "text", deltas: ["a title"], gapMs: 0 }];
	const messages: any[] = body.messages ?? [];
	const first = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
	const answered = JSON.stringify(messages).includes('"tool_result"');
	if (first.includes("[plain]")) return [{ type: "text", deltas: ["no ", "thinking ", "here"], gapMs: 15 }];
	if (first.includes("[tool]")) {
		if (answered) return [{ type: "text", deltas: ["all ", "done"], gapMs: 15 }];
		return [
			{ type: "thinking", deltas: ["I should ", "look first"], gapMs: 15 },
			{ type: "text", deltas: ["checking ", "now"], gapMs: 15 },
			{ type: "tool_use", name: "shell", input: { command: "echo a23" } },
		];
	}
	if (first.includes("[toolfirst]")) {
		if (answered) return [{ type: "text", deltas: ["done"], gapMs: 0 }];
		return [{ type: "tool_use", name: "shell", input: { command: "echo a23" }, gapMs: 1500 }];
	}
	if (first.includes("[gap]")) {
		// the thinking block ends, then the provider is quiet for a while before the text block starts
		return [
			{ type: "thinking", deltas: ["a short ", "thought"], gapMs: 20 },
			{ type: "text", deltas: ["after ", "the ", "pause"], gapMs: 20, preMs: 1200 },
		];
	}
	if (first.includes("[slow]")) {
		return [
			{ type: "thinking", deltas: Array.from({ length: 16 }, (_, i) => `thought ${i} `), gapMs: 120 },
			{ type: "text", deltas: Array.from({ length: 8 }, (_, i) => `word${i} `), gapMs: 120 },
		];
	}
	if (first.includes("[two]")) {
		return [
			{ type: "thinking", deltas: ["first ", "thought"], gapMs: 10 },
			{ type: "text", deltas: ["an aside ", "𝄞é"], gapMs: 10 },
			{ type: "thinking", deltas: ["second ", "thought"], gapMs: 10 },
			{ type: "text", deltas: ["the ", "answer"], gapMs: 10 },
		];
	}
	return [
		{ type: "thinking", deltas: ["let me ", "think about ", "this: ", "2 and 2 is 4"], gapMs: 25 },
		{ type: "text", deltas: ["the answer ", "is ", "4"], gapMs: 25 },
	];
}

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const blocks = script(body);
		const stream = new ReadableStream<Uint8Array>({
			async start(c) {
				const enc = new TextEncoder();
				const put = (s: string) => c.enqueue(enc.encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				for (const [index, b] of blocks.entries()) {
					if (b.type === "tool_use") {
						put(sse("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${nonce()}${index}`, name: b.name, input: {} } }));
						if (b.gapMs) await Bun.sleep(b.gapMs);
						put(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
					} else {
						if (b.preMs) await Bun.sleep(b.preMs);
						put(sse("content_block_start", { index, content_block: b.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } }));
						for (const t of b.deltas) {
							put(sse("content_block_delta", { index, delta: b.type === "thinking" ? { type: "thinking_delta", thinking: t } : { type: "text_delta", text: t } }));
							if (b.gapMs) await Bun.sleep(b.gapMs);
						}
						if (b.type === "thinking") put(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }));
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
let d: ReturnType<typeof serve>;

beforeAll(() => {
	const c = config();
	d = serve({ config: c, port: PORT, hostname: "127.0.0.1", dataDir: join(ROOT, "data"), checkEvents: true, reload: () => c });
});
afterAll(async () => {
	// every event the daemon published in this file matched its schema in the manifest
	expect(d.violations()).toBe(0);
	await d.stop();
	provider.stop(true);
});

// ---------- helpers ----------

const api = async (path: string, body?: unknown) => {
	const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cmx2-directory": WORK }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { json: (await res.json()) as any, seq: res.headers.get("x-cmx2-seq")! };
};

/** an sse tap that keeps each frame with when it arrived */
class Tap {
	frames: Array<{ at: number; id?: string; p: any }> = [];
	private ctl = new AbortController();
	constructor(headers: Record<string, string> = {}, path = "/global/event") {
		void (async () => {
			try {
				const res = await fetch(BASE + path, { headers, signal: this.ctl.signal });
				const reader = res.body!.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const block = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = block.split("\n").find((l) => l.startsWith("data: "));
						if (!data) continue;
						const j = JSON.parse(data.slice(6));
						this.frames.push({ at: performance.now(), ...(block.startsWith("id: ") ? { id: block.split("\n")[0]!.slice(4) } : {}), p: j.payload ?? j });
					}
				}
			} catch {}
		})();
	}
	/** this session's frames, in arrival order */
	of(sessionID: string) {
		return this.frames.filter((f) => f.p.properties?.sessionID === sessionID || f.p.properties?.info?.sessionID === sessionID);
	}
	async until(pred: () => boolean, what: string, ms = 20_000) {
		const t0 = Date.now();
		while (!pred()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}
	close() {
		this.ctl.abort();
	}
}

const newSession = async (tag: string) => (await api("/session", { directory: WORK, title: `it-a23-${tag}-${nonce()}` })).json.id as string;
const idleOf = (t: Tap, id: string) => t.until(() => t.of(id).some((f) => f.p.type === "session.idle"), "the turn to settle");
const kind = (f: { p: any }) => (f.p.type === "message.part.updated" ? `${f.p.type}:${f.p.properties.part.type}${f.p.properties.part.streaming ? ":streaming" : ":final"}` : f.p.type);

/** a whole turn on a tap: the session's frames once it settles */
async function turn(text: string, tag: string) {
	const tap = new Tap();
	await tap.until(() => tap.frames.length > 0, "the stream");
	const id = await newSession(tag);
	await api(`/session/${id}/prompt`, { text });
	await idleOf(tap, id);
	await Bun.sleep(30);
	tap.close();
	return { id, frames: tap.of(id) };
}

const textOf = (deltas: any[]) => deltas.map((f) => f.p.properties.delta).join("");

/** the frames about one assistant message: its info, its parts, their deltas */
const aboutMessage = <T extends { p: any }>(frames: T[], messageID: string): T[] =>
	frames.filter((f) => (f.p.type === "message.updated" ? f.p.properties.info.id : f.p.type === "message.part.updated" ? f.p.properties.part.messageID : f.p.type === "message.part.delta" ? f.p.properties.messageID : undefined) === messageID);
/** the first assistant message a session's frames announce */
const firstAssistant = (frames: Array<{ p: any }>) => frames.find((f) => f.p.type === "message.updated" && f.p.properties.info.role === "assistant")!.p.properties.info.id as string;

// ---------- the event sequence ----------

describe("a23: the events of a thinking turn", () => {
	test("announced before deltas, in content order, offsets contiguous per part, finals whole with time", async () => {
		const { id, frames } = await turn("what is 2 and 2", "sequence");
		const mid = firstAssistant(frames);
		const msgs = aboutMessage(frames, mid);
		const t0 = msgs[0]!.at;
		console.log("a23 sequence, ms from the message's first frame (a scripted anthropic stream with thinking):");
		for (const f of msgs) {
			const pr = f.p.properties;
			const what = f.p.type === "message.part.delta" ? `${pr.partID.slice(-2)} offset ${pr.offset} ${JSON.stringify(pr.delta)}` : f.p.type === "message.part.updated" ? `${pr.part.id.slice(-2)} ${pr.part.type} ${pr.part.streaming ? "streaming" : "final"} ${JSON.stringify(pr.part.text)} time ${JSON.stringify(pr.part.time)}` : `${pr.info.role} ${pr.info.time.completed ? "completed" : "created"}`;
			console.log(`  ${String(Math.round(f.at - t0)).padStart(5)}  ${f.id ? `seq ${f.id.split(":")[1]!.padEnd(5)}` : "no seq   "} ${f.p.type.padEnd(21)} ${what}`);
		}

		// the message is announced first, then reasoning (announce, deltas), then the text (announce, deltas), then the finals
		const shape = msgs.map(kind);
		const compact = shape.filter((k, i) => k !== shape[i - 1]);
		expect(compact).toEqual([
			"message.updated",
			"message.part.updated:reasoning:streaming",
			"message.part.delta",
			// the reasoning's block ended: its final goes out then, before the text is announced (a26)
			"message.part.updated:reasoning:final",
			"message.part.updated:text:streaming",
			"message.part.delta",
			"message.part.updated:text:final",
			// the step ends: the message completes and each final is published again
			"message.updated",
			"message.part.updated:reasoning:final",
			"message.part.updated:text:final",
		]);

		// the announcements are logged and numbered, the deltas are neither
		const announces = msgs.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming);
		expect(announces).toHaveLength(2);
		for (const a of announces) {
			expect(a.id).toMatch(/^[0-9a-f]+:\d+$/);
			expect(a.p.seq).toBeGreaterThan(0);
			expect(a.p.properties.part).toMatchObject({ sessionID: id, messageID: mid, text: "", streaming: true });
			expect(typeof a.p.properties.part.time.start).toBe("number");
			expect(a.p.properties.part.time.end).toBeUndefined();
		}
		const [rAnn, tAnn] = announces as [any, any];
		expect(rAnn.p.properties.part).toMatchObject({ type: "reasoning" });
		expect(tAnn.p.properties.part).toMatchObject({ type: "text" });
		expect(tAnn.p.seq).toBeGreaterThan(rAnn.p.seq);
		// content order is positional: the same ids the finals have
		expect(rAnn.p.properties.part.id.endsWith("_0")).toBe(true);
		expect(tAnn.p.properties.part.id.endsWith("_1")).toBe(true);

		// deltas: only to announced parts, after the announcement, contiguous, and they add up to the final text
		const deltas = msgs.filter((f) => f.p.type === "message.part.delta");
		const announcedAt = new Map(announces.map((a) => [a.p.properties.part.id as string, a.at]));
		for (const dl of deltas) {
			expect(announcedAt.has(dl.p.properties.partID)).toBe(true);
			expect(dl.at).toBeGreaterThanOrEqual(announcedAt.get(dl.p.properties.partID)!);
			expect(dl.id).toBeUndefined();
			expect(dl.p.properties).toMatchObject({ messageID: mid, field: "text" });
		}
		const byPart = new Map<string, any[]>();
		for (const dl of deltas) byPart.set(dl.p.properties.partID, [...(byPart.get(dl.p.properties.partID) ?? []), dl]);
		for (const [pid, list] of byPart) {
			let at = 0;
			for (const dl of list) {
				expect(dl.p.properties.offset).toBe(at);
				at += dl.p.properties.delta.length;
			}
			expect(pid).toBeTruthy();
		}
		expect(textOf(byPart.get(rAnn.p.properties.part.id)!)).toBe("let me think about this: 2 and 2 is 4");
		expect(textOf(byPart.get(tAnn.p.properties.part.id)!)).toBe("the answer is 4");
		// reasoning ended before the text began
		expect(byPart.get(rAnn.p.properties.part.id)!.at(-1)!.at).toBeLessThanOrEqual(tAnn.at);

		// the finals: the whole text, no streaming, time {start, end}, start as announced; each part's is published twice, when its block
		// ends and when the step does, the same text and the same time
		const finals = msgs.filter((f) => f.p.type === "message.part.updated" && !f.p.properties.part.streaming);
		expect(finals.map((f) => f.p.properties.part.type)).toEqual(["reasoning", "text", "reasoning", "text"]);
		for (const [i, f] of finals.entries()) {
			const part = f.p.properties.part;
			const ann = announces[i % 2]!.p.properties.part;
			expect(part.id).toBe(ann.id);
			expect(part.streaming).toBeUndefined();
			expect(part.time.start).toBe(ann.time.start);
			expect(part.time.end).toBeGreaterThanOrEqual(part.time.start);
			expect(f.id).toMatch(/^[0-9a-f]+:\d+$/);
		}
		expect(finals[0]!.p.properties.part.text).toBe("let me think about this: 2 and 2 is 4");
		expect(finals[1]!.p.properties.part.text).toBe("the answer is 4");
		expect(finals[2]!.p.properties.part).toEqual(finals[0]!.p.properties.part);
		expect(finals[3]!.p.properties.part).toEqual(finals[1]!.p.properties.part);
		// a26: the reasoning's final is logged and numbered, comes before the text's announcement and its first delta, and its end is no later
		// than the text's start; the text's final comes after the text's last delta
		const [rFinal, tFinal] = finals as [any, any];
		expect(rFinal.p.seq).toBeLessThan(tAnn.p.seq);
		expect(rFinal.p.seq).toBeGreaterThan(rAnn.p.seq);
		expect(msgs.indexOf(rFinal)).toBeLessThan(msgs.indexOf(tAnn));
		expect(msgs.indexOf(rFinal)).toBeLessThan(msgs.indexOf(byPart.get(tAnn.p.properties.part.id)![0]!));
		expect(rFinal.at).toBeLessThanOrEqual(tAnn.at);
		expect(rFinal.p.properties.part.time.end).toBeLessThanOrEqual(tAnn.p.properties.part.time.start);
		expect(msgs.indexOf(tFinal)).toBeGreaterThan(msgs.indexOf(byPart.get(tAnn.p.properties.part.id)!.at(-1)!));
		// and it came before the step ended, not with it
		const completed = msgs.find((f) => f.p.type === "message.updated" && f.p.properties.info.time.completed)!;
		expect(msgs.indexOf(tFinal)).toBeLessThan(msgs.indexOf(completed));
		expect(rFinal.p.seq).toBeLessThan(completed.p.seq);

		// the store keeps the time: a read returns it, typed and ordered, with no streaming
		const read = (await api(`/session/${id}/message`)).json.at(-1);
		expect(read.info.id).toBe(mid);
		expect(read.parts.map((p: any) => [p.type, p.text, p.streaming])).toEqual([
			["reasoning", "let me think about this: 2 and 2 is 4", undefined],
			["text", "the answer is 4", undefined],
		]);
		expect(read.parts.map((p: any) => p.time)).toEqual(finals.slice(2).map((f) => f.p.properties.part.time));
		const one = (await api(`/session/${id}/message/${mid}`)).json;
		expect(one.parts).toEqual(read.parts);
	});

	test("a turn with no thinking still announces its text part before the first delta", async () => {
		const { frames } = await turn("[plain]", "plain");
		const msgs = aboutMessage(frames, firstAssistant(frames));
		const first = msgs.findIndex((f) => f.p.type === "message.part.delta");
		expect(first).toBeGreaterThan(0);
		expect(kind(msgs[first - 1]!)).toBe("message.part.updated:text:streaming");
		expect(msgs[first - 1]!.p.properties.part.id).toBe(msgs[first]!.p.properties.partID);
		expect(msgs.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming)).toHaveLength(1);
		expect(textOf(msgs.filter((f) => f.p.type === "message.part.delta"))).toBe("no thinking here");
	});

	test("thinking, text, thinking, text: four announcements in content order, offsets restart per part, surrogate pairs count as two", async () => {
		const { id, frames } = await turn("[two]", "two");
		const msgs = aboutMessage(frames, firstAssistant(frames));
		const announces = msgs.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming);
		expect(announces.map((a) => [a.p.properties.part.type, a.p.properties.part.id.slice(-1)])).toEqual([["reasoning", "0"], ["text", "1"], ["reasoning", "2"], ["text", "3"]]);
		// each announcement comes after every delta of the part before it and before its own
		for (const [i, a] of announces.entries()) {
			const at = msgs.indexOf(a);
			const own = msgs.filter((f) => f.p.type === "message.part.delta" && f.p.properties.partID === a.p.properties.part.id);
			expect(own.length).toBeGreaterThan(0);
			expect(msgs.indexOf(own[0]!)).toBeGreaterThan(at);
			if (i > 0) expect(msgs.indexOf(own[0]!)).toBeGreaterThan(msgs.indexOf(msgs.filter((f) => f.p.type === "message.part.delta" && f.p.properties.partID === announces[i - 1]!.p.properties.part.id).at(-1)!));
			expect(own[0]!.p.properties.offset).toBe(0);
		}
		const aside = msgs.filter((f) => f.p.type === "message.part.delta" && f.p.properties.partID === announces[1]!.p.properties.part.id);
		expect(aside.map((f) => f.p.properties.offset)).toEqual([0, "an aside ".length]);
		expect(textOf(aside)).toBe("an aside 𝄞é");
		const read = (await api(`/session/${id}/message`)).json.at(-1);
		expect(read.parts.map((p: any) => [p.type, p.text])).toEqual([["reasoning", "first thought"], ["text", "an aside 𝄞é"], ["reasoning", "second thought"], ["text", "the answer"]]);
	});

	test("a step that calls a tool: the thinking and text parts keep their ids and place, the tool part follows them", async () => {
		const { id, frames } = await turn("[tool]", "tool");
		const msgs = frames.filter((f) => f.p.type.startsWith("message"));
		const announces = msgs.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming).map((a) => a.p.properties.part);
		// the first step's two parts, then the second step's text
		expect(announces.map((p: any) => [p.type, p.id.slice(-2)])).toEqual([["reasoning", "_0"], ["text", "_1"], ["text", "_0"]]);
		const read = (await api(`/session/${id}/message`)).json.filter((m: any) => m.info.role === "assistant");
		expect(read[0].parts.map((p: any) => p.type)).toEqual(["reasoning", "text", "tool"]);
		expect(read[0].parts.slice(0, 2).map((p: any) => p.id)).toEqual(announces.slice(0, 2).map((p: any) => p.id));
		expect(read[0].parts.map((p: any) => p.streaming)).toEqual([undefined, undefined, undefined]);
		expect(read[0].parts[0].time.end).toBeGreaterThanOrEqual(read[0].parts[0].time.start);
		expect(read[0].parts[2].state.status).toBe("completed");
		expect(read[1].parts.map((p: any) => [p.type, p.text])).toEqual([["text", "all done"]]);
		// each streamed part's final goes out when its block ends; the tool part is published once, at the step's end, after them, and
		// the step's end publishes the streamed finals again
		const order = msgs.filter((f) => f.p.type === "message.part.updated" && !f.p.properties.part.streaming && f.p.properties.part.messageID === read[0].info.id).map((f) => f.p.properties.part.type);
		expect(order.slice(0, 2)).toEqual(["reasoning", "text"]);
		expect(order.slice(2, 5)).toEqual(["reasoning", "text", "tool"]);
	});
});

// ---------- the in-flight read ----------

describe("a23: reading the message while it streams", () => {
	test("mid-thinking the read returns the typed reasoning part with its text so far; once the text starts, both, in order, and each read agrees with its x-cmx2-seq", async () => {
		const tap = new Tap();
		await tap.until(() => tap.frames.length > 0, "the stream");
		const id = await newSession("read");
		await api(`/session/${id}/prompt`, { text: "[slow]" });
		const deltasOf = () => tap.of(id).filter((f) => f.p.type === "message.part.delta");
		await tap.until(() => deltasOf().length >= 4, "four reasoning deltas");

		const t = await api(`/session/${id}/message?limit=5`);
		const last = t.json.at(-1);
		expect(last.info.role).toBe("assistant");
		expect(last.info.time.completed).toBeUndefined();
		expect(last.parts).toHaveLength(1);
		expect(last.parts[0]).toMatchObject({ type: "reasoning", streaming: true });
		expect(typeof last.parts[0].time.start).toBe("number");
		expect(last.parts[0].time.end).toBeUndefined();
		const pid = last.parts[0].id as string;
		expect(pid.endsWith("_0")).toBe(true);
		const soFar = last.parts[0].text as string;
		expect(soFar.length).toBeGreaterThan(0);
		// the text is exactly the deltas below its length; the single read says the same, at least as far
		expect(
			deltasOf()
				.filter((f) => f.p.properties.partID === pid && f.p.properties.offset < soFar.length)
				.map((f) => f.p.properties.delta)
				.join(""),
		).toBe(soFar);
		const one = (await api(`/session/${id}/message/${last.info.id}`)).json;
		expect(one.parts[0]).toMatchObject({ id: pid, type: "reasoning", streaming: true });
		expect(one.parts[0].text.startsWith(soFar)).toBe(true);
		console.log(`a23 in-flight read mid-thinking: ${JSON.stringify(last.parts[0])}; x-cmx2-seq ${t.seq}`);
		// the read's seq covers the announcement
		const ann = tap.of(id).find((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === pid)!;
		expect(Number(t.seq.split(":")[1])).toBeGreaterThanOrEqual(ann.p.seq);

		// once the text part has started the read has both, reasoning first, each typed
		await tap.until(() => tap.of(id).some((f) => f.p.type === "message.part.updated" && f.p.properties.part.type === "text" && f.p.properties.part.streaming), "the text part's announcement");
		await tap.until(() => deltasOf().some((f) => f.p.properties.partID.endsWith("_1")), "a text delta");
		const both = (await api(`/session/${id}/message?limit=5`)).json.at(-1);
		// the reasoning's block has ended, so it reads final (the whole text, time with end); the text is still streaming
		expect(both.parts.map((p: any) => [p.type, p.streaming])).toEqual([["reasoning", undefined], ["text", true]]);
		expect(both.parts[0].time.end).toBeGreaterThanOrEqual(both.parts[0].time.start);
		expect(both.parts[0].time.end).toBeLessThanOrEqual(both.parts[1].time.start);
		expect(both.parts[1].time.end).toBeUndefined();
		expect(both.parts.map((p: any) => p.id.slice(-1))).toEqual(["0", "1"]);
		expect(both.parts[0].text).toBe(Array.from({ length: 16 }, (_, i) => `thought ${i} `).join(""));
		expect(both.parts[1].text.length).toBeGreaterThan(0);
		expect(both.parts.every((p: any) => typeof p.time.start === "number")).toBe(true);
		// a limit of 1 reads the streaming message alone
		const alone = (await api(`/session/${id}/message?limit=1`)).json;
		expect(alone).toHaveLength(1);
		expect(alone[0].info.id).toBe(last.info.id);
		expect(alone[0].parts.map((p: any) => p.type)).toEqual(["reasoning", "text"]);

		await idleOf(tap, id);
		tap.close();
		const done = (await api(`/session/${id}/message`)).json.at(-1);
		expect(done.parts.map((p: any) => [p.type, p.streaming])).toEqual([["reasoning", undefined], ["text", undefined]]);
		expect(done.parts[1].text).toBe(Array.from({ length: 8 }, (_, i) => `word${i} `).join(""));
	}, 30_000);

	test("between the thinking's end and the text's start the read serves the reasoning part final, alone (a26)", async () => {
		const tap = new Tap();
		await tap.until(() => tap.frames.length > 0, "the stream");
		const id = await newSession("gap");
		await api(`/session/${id}/prompt`, { text: "[gap]" });
		const reasoningFinal = () => tap.of(id).find((f) => f.p.type === "message.part.updated" && f.p.properties.part.type === "reasoning" && !f.p.properties.part.streaming);
		await tap.until(() => !!reasoningFinal(), "the reasoning's final, before the text has begun");
		const textAnnounced = () => tap.of(id).some((f) => f.p.type === "message.part.updated" && f.p.properties.part.type === "text" && f.p.properties.part.streaming);
		expect(textAnnounced()).toBe(false);
		const t = await api(`/session/${id}/message?limit=5`);
		const last = t.json.at(-1);
		expect(last.info.role).toBe("assistant");
		expect(last.info.time.completed).toBeUndefined();
		// the text has not started (the provider is quiet for over a second): the message has the one part, and it is final
		expect(textAnnounced()).toBe(false);
		expect(last.parts).toHaveLength(1);
		expect(last.parts[0]).toMatchObject({ type: "reasoning", text: "a short thought" });
		expect(last.parts[0].streaming).toBeUndefined();
		expect(last.parts[0].time.end).toBeGreaterThanOrEqual(last.parts[0].time.start);
		// it is the part the log said: the same text and time as the final the stream carried
		expect(last.parts[0]).toEqual(reasoningFinal()!.p.properties.part);
		const one = (await api(`/session/${id}/message/${last.info.id}`)).json;
		expect(one.parts).toEqual(last.parts);
		console.log(`a26 in-flight read between the thinking's end and the text's start: ${JSON.stringify(last.parts[0])}; x-cmx2-seq ${t.seq}`);
		await idleOf(tap, id);
		tap.close();
		const done = (await api(`/session/${id}/message`)).json.at(-1);
		expect(done.parts.map((p: any) => [p.type, p.text, p.streaming])).toEqual([["reasoning", "a short thought", undefined], ["text", "after the pause", undefined]]);
		// the step's end agrees with what the block's end said
		expect(done.parts[0]).toEqual(last.parts[0]);
	}, 30_000);

	test("a step that has started only a tool call reads with no parts: a tool call is not a part until its step ends", async () => {
		const id = await newSession("empty");
		const tap = new Tap();
		await tap.until(() => tap.frames.length > 0, "the stream");
		await api(`/session/${id}/prompt`, { text: "[toolfirst]" });
		await tap.until(() => tap.of(id).some((f) => f.p.type === "message.updated" && f.p.properties.info.role === "assistant"), "the message announced");
		const read = await api(`/session/${id}/message`);
		const last = read.json.at(-1);
		expect(last.info.role).toBe("assistant");
		expect(last.info.time.completed).toBeUndefined();
		expect(last.parts).toEqual([]);
		expect(tap.of(id).some((f) => f.p.type === "message.part.updated" && f.p.properties.part.messageID === last.info.id)).toBe(false);
		// the step ends: the tool part is published then, and the message reads from the store
		await tap.until(() => tap.of(id).some((f) => f.p.type === "message.part.updated" && f.p.properties.part.messageID === last.info.id && f.p.properties.part.type === "tool"), "the tool part", 10_000);
		await idleOf(tap, id);
		tap.close();
		const done = (await api(`/session/${id}/message`)).json.filter((m: any) => m.info.role === "assistant");
		expect(done[0].parts.map((p: any) => p.type)).toEqual(["tool"]);
	}, 30_000);
});

// ---------- resume ----------

describe("a23: resuming mid-thinking", () => {
	test("the reasoning part streaming at the resume point comes back once, whole, before any delta; the delta after it continues at its length", async () => {
		const live = new Tap();
		await live.until(() => live.frames.length > 0, "the stream");
		const id = await newSession("resume");
		await api(`/session/${id}/prompt`, { text: "[slow]" });
		await live.until(() => live.of(id).filter((f) => f.p.type === "message.part.delta").length >= 5, "five reasoning deltas");
		const read = await api(`/session/${id}/message`);
		const part = read.json.at(-1).parts[0];
		expect(part).toMatchObject({ type: "reasoning", streaming: true });

		// resumed at the read's cursor: the part is after the cursor's state, so it arrives whole, unnumbered, ahead of the deltas
		const resumed = new Tap({ "last-event-id": read.seq });
		await resumed.until(() => resumed.frames.some((f) => f.p.type === "message.part.delta"), "a delta after the resend");
		const frames = resumed.frames;
		const resendAt = frames.findIndex((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === part.id);
		const deltaAt = frames.findIndex((f) => f.p.type === "message.part.delta");
		expect(resendAt).toBeGreaterThanOrEqual(0);
		expect(resendAt).toBeLessThan(deltaAt);
		const resend = frames[resendAt]!;
		expect(resend.id).toBeUndefined();
		expect(resend.p.seq).toBeUndefined();
		expect(resend.p.properties.part).toMatchObject({ type: "reasoning", streaming: true });
		expect(resend.p.properties.part.text.startsWith(part.text)).toBe(true);
		expect(frames[deltaAt]!.p.properties.partID).toBe(part.id);
		expect(frames[deltaAt]!.p.properties.offset).toBe(resend.p.properties.part.text.length);
		// once, not once per delta
		expect(frames.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === part.id)).toHaveLength(1);

		// resumed from before the message: the log replays its announcements (numbered), then the streaming part is resent whole
		const first = live.of(id).find((f) => f.p.type === "message.updated" && f.p.properties.info.role === "assistant")!;
		const before = `${first.id!.split(":")[0]}:${Number(first.id!.split(":")[1]) - 1}`;
		const early = new Tap({ "last-event-id": before });
		await early.until(() => early.frames.some((f) => f.p.type === "message.part.delta" && f.p.properties.sessionID === id), "a delta after the replay");
		const mine = aboutMessage(early.of(id), first.p.properties.info.id);
		const kinds = mine.map((f) => `${f.id ? "logged" : "live"} ${kind(f)}`);
		const firstDelta = kinds.indexOf("live message.part.delta");
		expect(kinds.slice(0, firstDelta)).toEqual(["logged message.updated", "logged message.part.updated:reasoning:streaming", "live message.part.updated:reasoning:streaming"]);
		const [logged, again] = [mine[1]!.p.properties.part, mine[2]!.p.properties.part];
		expect(logged.text).toBe("");
		expect(again.id).toBe(logged.id);
		expect(again.time.start).toBe(logged.time.start);
		expect(mine[firstDelta]!.p.properties.offset).toBe(again.text.length);

		await idleOf(live, id);
		live.close();
		resumed.close();
		early.close();
	}, 30_000);
});

describe("a26: resuming after a part's block has ended", () => {
	test("between the thinking's end and the text's start: the reasoning part is resent final, unnumbered; the text is announced after it", async () => {
		const live = new Tap();
		await live.until(() => live.frames.length > 0, "the stream");
		const id = await newSession("resume-gap");
		await api(`/session/${id}/prompt`, { text: "[gap]" });
		await live.until(() => live.of(id).some((f) => f.p.type === "message.part.updated" && f.p.properties.part.type === "reasoning" && !f.p.properties.part.streaming), "the reasoning's final");
		const read = await api(`/session/${id}/message`);
		const part = read.json.at(-1).parts[0];
		expect(part).toMatchObject({ type: "reasoning", text: "a short thought" });
		expect(part.streaming).toBeUndefined();
		const resumed = new Tap({ "last-event-id": read.seq });
		await resumed.until(() => resumed.frames.some((f) => f.p.type === "message.part.delta"), "a text delta after the resume");
		const mine = resumed.of(id).filter((f) => f.p.type.startsWith("message"));
		const kinds = mine.map((f) => `${f.id ? "logged" : "live"} ${kind(f)}`);
		// the part is whole and final, once, ahead of everything else; then the live stream: the text's announcement (logged), its deltas
		expect(kinds[0]).toBe("live message.part.updated:reasoning:final");
		expect(kinds.filter((k) => k.includes("reasoning"))).toEqual(["live message.part.updated:reasoning:final"]);
		expect(mine[0]!.p.properties.part).toEqual(part);
		expect(kinds.slice(1, 3)).toEqual(["logged message.part.updated:text:streaming", "live message.part.delta"]);
		expect(mine[2]!.p.properties.partID).toBe(mine[1]!.p.properties.part.id);
		expect(mine[2]!.p.properties.offset).toBe(0);
		await idleOf(live, id);
		live.close();
		resumed.close();
	}, 30_000);

	test("while the text streams: the reasoning part is resent final and the text part streaming with its words so far, in content order; the next delta continues the text", async () => {
		const live = new Tap();
		await live.until(() => live.frames.length > 0, "the stream");
		const id = await newSession("resume-text");
		await api(`/session/${id}/prompt`, { text: "[slow]" });
		const textDeltas = (t: Tap) => t.of(id).filter((f) => f.p.type === "message.part.delta" && f.p.properties.partID.endsWith("_1"));
		await live.until(() => textDeltas(live).length >= 3, "three text deltas");
		const read = await api(`/session/${id}/message`);
		const parts = read.json.at(-1).parts;
		expect(parts.map((p: any) => [p.type, p.streaming])).toEqual([["reasoning", undefined], ["text", true]]);
		const resumed = new Tap({ "last-event-id": read.seq });
		await resumed.until(() => textDeltas(resumed).length >= 1, "a text delta after the resend");
		const mine = resumed.of(id).filter((f) => f.p.type.startsWith("message"));
		const firstDelta = mine.findIndex((f) => f.p.type === "message.part.delta");
		const before = mine.slice(0, firstDelta);
		expect(before.map((f) => `${f.id ? "logged" : "live"} ${kind(f)}`)).toEqual(["live message.part.updated:reasoning:final", "live message.part.updated:text:streaming"]);
		const [rs, ts] = before.map((f) => f.p.properties.part) as [any, any];
		expect(rs.text).toBe(Array.from({ length: 16 }, (_, i) => `thought ${i} `).join(""));
		expect(rs.time.end).toBeLessThanOrEqual(ts.time.start);
		expect(ts.text.startsWith(parts[1].text)).toBe(true);
		expect(mine[firstDelta]!.p.properties.partID).toBe(ts.id);
		expect(mine[firstDelta]!.p.properties.offset).toBe(ts.text.length);
		// no delta ever goes to the ended part
		expect(live.of(id).some((f) => f.p.type === "message.part.delta" && f.p.properties.partID === rs.id && f.at > (live.of(id).find((g) => g.p.type === "message.part.updated" && g.p.properties.part.id === rs.id && !g.p.properties.part.streaming)?.at ?? Infinity))).toBe(false);
		await idleOf(live, id);
		live.close();
		resumed.close();
	}, 30_000);
});

// ---------- the log and the reads ----------

describe("a23: the log and the reads agree", () => {
	test("folding the logged message.part.updated events gives exactly the parts a read returns, streamed or not", async () => {
		const { id } = await turn("what is 2 and 2", "agree");
		const { id: tid } = await turn("[tool]", "agree-tool");
		for (const sid of [id, tid]) {
			const rows = (await api(`/session/${sid}/message`)).json as Array<{ info: any; parts: any[] }>;
			const folded = new Map<string, any>();
			let streamingLeft = 0;
			for (const e of d.store.eventsAfter(0, { limit: 100_000 })) {
				if (e.type !== "message.part.updated") continue;
				const part = JSON.parse(e.properties).part;
				if (part.sessionID !== sid) continue;
				folded.set(part.id, part);
			}
			for (const p of folded.values()) if (p.streaming) streamingLeft++;
			expect(streamingLeft).toBe(0);
			const read = rows.flatMap((m) => m.parts);
			expect(read.length).toBeGreaterThan(0);
			for (const p of read) expect(JSON.stringify(folded.get(p.id))).toBe(JSON.stringify(p));
			expect([...folded.keys()].sort()).toEqual(read.map((p) => p.id).sort());
		}
	});
});
