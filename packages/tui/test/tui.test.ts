import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@cmx2/client";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Completer } from "../src/complete.ts";
import { narrow } from "../src/dialogs.ts";
import { agentTree, compact, statusLine, toolLine } from "../src/format.ts";
import { apply, initialState, setMessages } from "../src/state.ts";
import { buildTheme, DARK, guessMode, readThemeFile } from "../src/theme.ts";

const ev = (type: string, properties: Record<string, unknown>) => ({ id: "e", type, properties }) as unknown as Event;
const plain = buildTheme({}, { mode: "none" }).theme;

test("the theme file overrides slots, keeps defaults for the rest and says what it could not read", () => {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-tui-"));
	writeFileSync(join(dir, "tui.json"), JSON.stringify({ theme: { mode: "light", colors: { accent: "#ff0000", ok: "not a colour" } } }));
	const { file } = readThemeFile(dir);
	const { theme, warnings } = buildTheme(file, { mode: "truecolor" });
	expect(theme.name).toBe("light");
	expect(theme.palette.accent).toBe("#ff0000");
	expect(theme.palette.ok).not.toBe("not a colour");
	expect(warnings).toEqual(['tui.json: ok "not a colour" is not a colour; kept the default']);
	expect(theme.fg.accent("x")).toContain("\x1b[38;2;255;0;0m");
	writeFileSync(join(dir, "tui.json"), "{ nope");
	expect(readThemeFile(dir).warning).toContain("is not valid json");
});

test("dark unless the terminal says its background is light; NO_COLOR paints nothing", () => {
	expect(guessMode({ COLORFGBG: "15;0" })).toBe("dark");
	expect(guessMode({ COLORFGBG: "0;15" })).toBe("light");
	expect(guessMode({})).toBe("dark");
	expect(buildTheme({}, { env: { NO_COLOR: "1" } }).theme.fg.accent("x")).toBe("x");
	expect(buildTheme({}, { env: {} }).theme.palette).toEqual(DARK);
});

test("deltas build the text at their offsets; a repeat does not double it and a gap waits for a read", () => {
	const s = initialState();
	s.sessionID = "ses_1";
	apply(s, ev("message.updated", { sessionID: "ses_1", info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "", streaming: true, time: { start: 2 } } }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "hel", offset: 0 }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "lo", offset: 3 }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "lo", offset: 3 }));
	expect(apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "zz", offset: 99 }))).toBe(false);
	expect((s.messages[0]!.parts[0] as { text: string }).text).toBe("hello");
	// the finished part replaces the streamed one
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "hello.", time: { start: 2, end: 9 } } }));
	expect((s.messages[0]!.parts[0] as { text: string }).text).toBe("hello.");
	// another session's events are ignored
	expect(apply(s, ev("message.part.delta", { sessionID: "ses_2", messageID: "m9", partID: "p9", field: "text", delta: "x", offset: 0 }))).toBe(false);
});

test("thinking streams into its own part, in content order, and never becomes reply text", async () => {
	const s = initialState();
	s.sessionID = "ses_1";
	apply(s, ev("message.updated", { sessionID: "ses_1", info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } }));
	const part = (id: string, type: string, extra: object = {}) => ({ id, sessionID: "ses_1", messageID: "m1", type, text: "", streaming: true, time: { start: 2 }, ...extra });
	// announced in content order, each before its first delta
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: part("p0", "reasoning") }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p0", field: "text", delta: "let me ", offset: 0 }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p0", field: "text", delta: "think", offset: 7 }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: part("p1", "text") }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "the answer", offset: 0 }));
	const parts = s.messages[0]!.parts as Array<{ type: string; text: string; streaming?: boolean }>;
	expect(parts.map((p) => [p.type, p.text, p.streaming])).toEqual([
		["reasoning", "let me think", true],
		["text", "the answer", true],
	]);
	// a delta for a part this screen never saw announced (the stream opened mid-part) has no type to go by: it is not drawn as a reply
	expect(apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p9", field: "text", delta: "thinking in the middle", offset: 40 }))).toBe(false);
	expect(apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m_unknown", partID: "p0", field: "text", delta: "x", offset: 0 }))).toBe(false);
	expect(s.messages).toHaveLength(1);
	expect(s.messages[0]!.parts).toHaveLength(2);
	// the finals keep the order and end the streaming
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { ...part("p0", "reasoning", { text: "let me think about it", time: { start: 2, end: 5 } }), streaming: undefined } }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { ...part("p1", "text", { text: "the answer is 4", time: { start: 5, end: 8 } }), streaming: undefined } }));
	expect((s.messages[0]!.parts as Array<{ type: string; text: string }>).map((p) => [p.type, p.text])).toEqual([
		["reasoning", "let me think about it"],
		["text", "the answer is 4"],
	]);
	// the screen draws thinking as thinking while it streams, and the reply text as the reply
	const { TranscriptView } = await import("../src/view.ts");
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: part("p2", "reasoning") }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p2", field: "text", delta: "a second thought here", offset: 0 }));
	const drawn = new TranscriptView(s, plain, () => []).render(64).join("\n");
	expect(drawn).toContain("the answer is 4");
	expect(drawn).toContain("thinking, 4 words");
	expect(drawn).not.toContain("a second thought here");
	// a read of the message mid-thinking gives the same typed parts
	const r = initialState();
	r.sessionID = "ses_1";
	setMessages(r, [{ info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts: [part("p0", "reasoning", { text: "one two three" }) as never] }]);
	apply(r, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p0", field: "text", delta: " four", offset: 13 }));
	expect((r.messages[0]!.parts[0] as { type: string; text: string }).type).toBe("reasoning");
	expect((r.messages[0]!.parts[0] as { text: string }).text).toBe("one two three four");
});

test("a thought that ended while the reply streams stays folded; the step's end publishing it again changes nothing", async () => {
	const s = initialState();
	s.sessionID = "ses_1";
	apply(s, ev("message.updated", { sessionID: "ses_1", info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } }));
	const base = { sessionID: "ses_1", messageID: "m1" };
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { ...base, id: "p0", type: "reasoning", text: "", streaming: true, time: { start: 2 } } }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p0", field: "text", delta: "one two three", offset: 0 }));
	// the block ended: its final arrives while the reply is still to come, then the reply streams
	const final = { ...base, id: "p0", type: "reasoning", text: "one two three", time: { start: 2, end: 4 } };
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: final }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { ...base, id: "p1", type: "text", text: "", streaming: true, time: { start: 4 } } }));
	apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "the reply so far", offset: 0 }));
	const { TranscriptView } = await import("../src/view.ts");
	const drawn = () => new TranscriptView(s, plain, () => []).render(64).join("\n");
	const mid = drawn();
	expect(mid).toContain("thinking, 3 words");
	expect(mid).toContain("the reply so far");
	expect(mid).not.toContain("one two three");
	const parts = () => (s.messages[0]!.parts as Array<{ id: string; type: string; text: string; streaming?: boolean; time?: { end?: number } }>).map((p) => [p.id, p.type, p.text, p.streaming, p.time?.end]);
	expect(parts()).toEqual([["p0", "reasoning", "one two three", undefined, 4], ["p1", "text", "the reply so far", true, undefined]]);
	// the step ends and publishes each final again: the same parts, once each, the same drawing
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: final }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { ...base, id: "p1", type: "text", text: "the reply so far, and the rest", time: { start: 4, end: 9 } } }));
	expect(parts()).toEqual([["p0", "reasoning", "one two three", undefined, 4], ["p1", "text", "the reply so far, and the rest", undefined, 9]]);
	expect(drawn()).toContain("thinking, 3 words");
	// a delta for the ended part (a frame that was in flight) cannot reopen it: the offset is not at its end
	expect(apply(s, ev("message.part.delta", { sessionID: "ses_1", messageID: "m1", partID: "p0", field: "text", delta: " four", offset: 20 }))).toBe(false);
	expect(parts()[0]![2]).toBe("one two three");
});

test("a queued prompt shows until it lands, then the transcript copy replaces it", () => {
	const s = initialState();
	s.sessionID = "ses_1";
	apply(s, ev("message.updated", { sessionID: "ses_1", info: { id: "msg_1_qa", sessionID: "ses_1", role: "user", time: { created: 1 }, queued: true } }));
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { id: "prt_1_qa_0", sessionID: "ses_1", messageID: "msg_1_qa", type: "text", text: "later" } }));
	expect(s.messages).toHaveLength(1);
	apply(s, ev("message.removed", { sessionID: "ses_1", messageID: "msg_1_qa" }));
	expect(s.messages).toHaveLength(0);
});

test("asks open for the session and its agents, and close when anyone answers", () => {
	const s = initialState();
	s.sessionID = "ses_1";
	expect(apply(s, ev("permission.asked", { id: "per_x", sessionID: "ses_other", permission: "shell", patterns: ["ls"], metadata: {}, always: [] }))).toBe(false);
	apply(s, ev("agent.spawned", { sessionID: "ses_1", agent: { id: "ses_child", parentID: "ses_1", path: "/root/scout", name: "scout", depth: 1, state: "working", files: [], tokens: 0 } }));
	apply(s, ev("permission.asked", { id: "per_1", sessionID: "ses_child", permission: "shell", patterns: ["ls"], metadata: {}, always: ["ls *"] }));
	apply(s, ev("question.asked", { id: "que_1", sessionID: "ses_1", questions: [{ question: "which?", header: "", options: [] }] }));
	expect(s.permissions.map((p) => p.id)).toEqual(["per_1"]);
	expect(s.questions.map((q) => q.id)).toEqual(["que_1"]);
	apply(s, ev("permission.replied", { sessionID: "ses_child", requestID: "per_1", reply: "once", by: "phone" }));
	apply(s, ev("question.rejected", { sessionID: "ses_1", requestID: "que_1", by: "abort" }));
	expect(s.permissions).toHaveLength(0);
	expect(s.questions).toHaveLength(0);
});

test("status, effort, model and the context in use come from events", () => {
	const s = initialState();
	s.sessionID = "ses_1";
	apply(s, ev("session.status", { sessionID: "ses_1", status: { type: "busy", queued: 2 } }));
	apply(s, ev("session.effort", { sessionID: "ses_1", effort: "high" }));
	apply(s, ev("session.model", { sessionID: "ses_1", model: "anthropic/claude-sonnet-5-5" }));
	apply(s, ev("message.updated", { sessionID: "ses_1", info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 100, output: 5, cache: { read: 20_000, write: 400 } } } }));
	expect(s.context).toBe(20_500);
	const line = statusLine(s, plain, 200);
	expect(line).toBe("claude-sonnet-5-5 · high · build · working, 2 waiting · context 21k");
});

test("the status line drops extras before it cuts the state at 64 columns", () => {
	const s = initialState();
	s.model = "anthropic/claude-sonnet-5-5";
	s.effort = "medium";
	s.status = { type: "retry", attempt: 2, message: "overloaded; retrying in 4 s", next: 0 };
	s.context = 123_456;
	s.cost = 1.5;
	const line = statusLine(s, plain, 64);
	expect(visibleWidth(line)).toBeLessThanOrEqual(64);
	expect(line).toContain("retry 2");
	expect(line).not.toContain("context");
});

test("tool calls are one line with a mark, the subject and the time; errors add their first words", () => {
	const done = toolLine({ id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "shell", state: { status: "completed", input: { command: "bun test" }, output: "", title: "", metadata: {}, time: { start: 1000, end: 3500 } } }, plain, 80);
	expect(done).toEqual(["✓ shell bun test 2.5 s"]);
	const failed = toolLine({ id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "read", state: { status: "error", input: { path: "a.ts" }, error: "no such file\nat x", time: {} } }, plain, 80);
	expect(failed).toEqual(["✗ read a.ts", "  no such file at x"]);
	const running = toolLine({ id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "shell", state: { status: "running", input: { command: "make" }, metadata: { output: "one\ntwo\n" } } }, plain, 80);
	expect(running).toEqual(["… shell make", "  two"]);
	expect(compact(999)).toBe("999");
	expect(compact(12_345)).toBe("12k");
	expect(compact(2_500_000)).toBe("2.5m");
});

test("the agent tree nests children under their parent with state and last words", () => {
	const s = initialState();
	s.sessionID = "ses_root";
	for (const a of [
		{ id: "a", parentID: "ses_root", path: "/root/eng", name: "eng", depth: 1, state: "working", lastTask: "fix the build", files: [], tokens: 12_000, seat: "engineer" },
		{ id: "b", parentID: "a", path: "/root/eng/probe", name: "probe", depth: 2, state: "parked", lastReport: "found it", files: [], tokens: 0 },
	])
		apply(s, ev("agent.spawned", { sessionID: "ses_root", agent: a }));
	expect(agentTree(s, plain, 80)).toEqual(["● eng working engineer 12k tok", "  fix the build", "  ◐ probe parked", "    found it"]);
});

test("a transcript read picks up the context of the last finished step", () => {
	const s = initialState();
	setMessages(s, [
		{ info: { id: "u", sessionID: "s", role: "user", time: { created: 1 } }, parts: [] },
		{ info: { id: "a", sessionID: "s", role: "assistant", time: { created: 2 }, tokens: { input: 10, cache: { read: 90, write: 0 } } }, parts: [] },
	]);
	expect(s.context).toBe(100);
});

test("pickers find by substring first, then fuzzy", () => {
	const items = ["claude-sonnet-4-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((v) => ({ value: v, label: v }));
	expect(narrow(items, "sonnet-5-5").map((i) => i.value)[0]).toBe("claude-sonnet-5-5");
	expect(narrow(items, "").length).toBe(3);
});

test("/ completes commands and @ completes paths through the daemon", async () => {
	const c = new Completer(
		() => [{ name: "model", description: "pick the model" }, { name: "review" }],
		async (q) => [`src/${q}.ts`],
	);
	const signal = new AbortController().signal;
	expect((await c.getSuggestions(["/mo"], 0, 3, { signal }))?.items.map((i) => i.value)).toEqual(["/model"]);
	const at = await c.getSuggestions(["look at @ind"], 0, 12, { signal });
	expect(at).toEqual({ items: [{ value: "@src/ind.ts", label: "src/ind.ts" }], prefix: "@ind" });
	expect(c.applyCompletion(["look at @ind"], 0, 12, at!.items[0]!, at!.prefix)).toEqual({ lines: ["look at @src/ind.ts "], cursorLine: 0, cursorCol: 20 });
	expect(await c.getSuggestions(["plain words"], 0, 11, { signal })).toBeNull();
});

test("the transcript puts waiting prompts last, tells a steer from a queued one, and fits 64 columns", async () => {
	const { TranscriptView } = await import("../src/view.ts");
	const s = initialState();
	s.sessionID = "ses_1";
	s.steers.add("c-steer");
	const user = (id: string, text: string, extra: Record<string, unknown> = {}) => {
		apply(s, ev("message.updated", { sessionID: "ses_1", info: { id, sessionID: "ses_1", role: "user", time: { created: 1 }, ...extra } }));
		apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text", text } }));
	};
	user("m1", "write a story about a lighthouse keeper and make it long enough to wrap at sixty four columns");
	user("q1", "name her ada", { queued: true, clientID: "c-steer" });
	user("q2", "then say done", { queued: true, clientID: "c-other" });
	apply(s, ev("message.part.updated", { sessionID: "ses_1", part: { id: "a_p", sessionID: "ses_1", messageID: "a1", type: "text", text: "**ada** kept the light." } }));
	const lines = new TranscriptView(s, plain, () => []).render(64);
	expect(lines.every((l) => visibleWidth(l) <= 64)).toBe(true);
	const text = lines.join("\n");
	expect(text.indexOf("ada kept the light")).toBeLessThan(text.indexOf("› steering name her ada"));
	expect(text).toContain("› queued then say done");
});
