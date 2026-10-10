import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectMessage, Store } from "../src/index.ts";
import { TOOL_ATTACHMENTS_BUDGET, TOOL_ATTACHMENTS_MAX } from "../src/projection.ts";

/** the images a tool result returned reach its completed part as attachments, within the cap */

const s = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-store-")), "cmx2.db"));
let sessions = 0;
function project(content: unknown[], isError = false) {
	const sid = `ses_attach${sessions++}`;
	s.putSession({ id: sid, directory: "/w", title: "p", model: "anthropic/m", session_file: null, created_at: 1 });
	const ctx = (seq: number) => ({ sessionId: sid, cwd: "/w", seq, completedAt: 99 });
	projectMessage(s, ctx(1), { role: "user", content: "go", timestamp: 1 });
	projectMessage(s, ctx(2), {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "shots/foo.png" } }],
		provider: "anthropic",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	});
	projectMessage(s, ctx(3), { role: "toolResult", toolCallId: "call_1", toolName: "read", content, isError, timestamp: 3 });
	return s.messages(sid).rows[1]!.parts.map((p) => JSON.parse(p.data)).find((p) => p.type === "tool")!.state;
}
const caption = (label: string) => ({ type: "text", text: `image ${label} (800x600, 1234 bytes)` });
const image = (data = "aGVsbG8=", mimeType = "image/png") => ({ type: "image", data, mimeType });

test("an image read yields an attachment named from the caption, the output text unchanged", () => {
	const state = project([caption("shots/foo.png"), image()]);
	expect(state.status).toBe("completed");
	expect(state.output).toBe("image shots/foo.png (800x600, 1234 bytes)");
	expect(state.attachments).toEqual([{ type: "file", mime: "image/png", filename: "foo.png", url: "data:image/png;base64,aGVsbG8=" }]);
	expect("attachmentsDropped" in state).toBe(false);
});

test("an image without a caption is named image", () => {
	expect(project([{ type: "text", text: "screenshot taken" }, image("eA==", "image/jpeg")]).attachments).toEqual([{ type: "file", mime: "image/jpeg", filename: "image", url: "data:image/jpeg;base64,eA==" }]);
});

test("a text-only result has no attachments field", () => {
	const state = project([{ type: "text", text: "file body" }]);
	expect("attachments" in state).toBe(false);
	expect("attachmentsDropped" in state).toBe(false);
});

test("an error result carries no attachments", () => {
	const state = project([{ type: "text", text: "boom" }, image()], true);
	expect(state.status).toBe("error");
	expect("attachments" in state).toBe(false);
});

test("past the image count cap the rest are dropped and counted", () => {
	const state = project(Array.from({ length: TOOL_ATTACHMENTS_MAX + 3 }, (_, i) => [caption(`p${i}.png`), image()]).flat());
	expect(state.attachments).toHaveLength(TOOL_ATTACHMENTS_MAX);
	expect(state.attachments.at(-1).filename).toBe(`p${TOOL_ATTACHMENTS_MAX - 1}.png`);
	expect(state.attachmentsDropped).toBe(3);
});

test("an image that would pass the byte budget is dropped; a later small one still fits", () => {
	const big = "A".repeat(TOOL_ATTACHMENTS_BUDGET - 100);
	const state = project([image(big), image(big), image()]);
	expect(state.attachments.map((a: any) => a.url.length)).toEqual([`data:image/png;base64,${big}`.length, "data:image/png;base64,aGVsbG8=".length]);
	expect(state.attachmentsDropped).toBe(1);
});
