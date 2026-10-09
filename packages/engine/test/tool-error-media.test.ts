/**
 * a failed tool call that carries images must not reach anthropic as an `is_error` tool_result: the
 * api answers 400 ("all content must be type text if is_error is true") and, because the transcript
 * replays, every later request in the session fails the same way
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { toLlm } from "../src/session.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function transcript(isError: boolean, withImage: boolean): any[] {
	const content: any[] = [{ type: "text", text: "/tmp/shot.png\n\n(exit 1, 1.2s)" }];
	if (withImage) content.push({ type: "text", text: "image /tmp/shot.png (1x1, 70 bytes)" }, { type: "image", data: PNG, mimeType: "image/png" });
	return [
		{ role: "user", content: "take a screenshot", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_shot", name: "shell", arguments: { command: "shoot" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "toolu_shot", toolName: "shell", content, isError, timestamp: 3 },
	];
}

test("toLlm: a failed result with an image goes unflagged, images kept, with a line saying it failed", () => {
	const stored = transcript(true, true);
	const out = toLlm(stored as never) as any[];
	const r = out[2];
	expect(r.isError).toBe(false);
	expect(r.content.filter((b: any) => b.type === "image")).toHaveLength(1);
	expect(r.content.at(-1).text).toContain("this call failed");
	// the stored record is untouched
	expect(stored[2].isError).toBe(true);
	expect(stored[2].content).toHaveLength(3);
});

test("toLlm: text-only failures and successful results with images pass through as they are", () => {
	const textOnly = transcript(true, false);
	expect(toLlm(textOnly as never)[2]).toBe(textOnly[2]);
	const ok = transcript(false, true);
	expect(toLlm(ok as never)[2]).toBe(ok[2]);
});

const OK_SSE = readFileSync(join(import.meta.dir, "fixtures/anthropic-ok.sse"), "utf8");

async function payloadOf(messages: any[]) {
	const model = { ...(ANTHROPIC_MODELS as unknown as Record<string, Model<Api>>)["claude-opus-5-5"]!, baseUrl: "http://replay.invalid" };
	let payload: any;
	const s = streamSimple(model as never, { messages } as never, {
		apiKey: "replay",
		reasoning: "medium" as never,
		fetch: (async () => new Response(OK_SSE, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
		onPayload: (p: unknown) => {
			payload = structuredClone(p);
			return undefined;
		},
	} as never);
	await s.result();
	return payload;
}

function toolResultBlock(payload: any): any {
	for (const m of payload.messages) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_result") return b;
}

test("wire: without the fix pi sends is_error with an image (the shape anthropic rejects)", async () => {
	const b = toolResultBlock(await payloadOf(transcript(true, true)));
	expect(b.is_error).toBe(true);
	expect(b.content.some((c: any) => c.type === "image")).toBe(true);
});

test("wire: through toLlm the tool_result with an image is not flagged is_error", async () => {
	const b = toolResultBlock(await payloadOf(toLlm(transcript(true, true) as never)));
	expect(b.is_error).toBe(false);
	expect(b.content.some((c: any) => c.type === "image")).toBe(true);
	// a text-only failure keeps its flag
	const t = toolResultBlock(await payloadOf(toLlm(transcript(true, false) as never)));
	expect(t.is_error).toBe(true);
});
