import { expect, test } from "bun:test";
import { type GateNotes, moveTrailingSystemBreakpoint, rollingBreakpoint } from "../src/gates.ts";

const cc = { type: "ephemeral" };
const where = (p: any) => p.messages.flatMap((m: any, i: number) => (Array.isArray(m.content) ? m.content.map((b: any, j: number) => (b.cache_control ? `${i}.${j}` : null)) : [])).filter(Boolean);

test("a turn's first request: the breakpoint moves off the turn-context system message onto the user message before it", () => {
	const p = { messages: [{ role: "user", content: "task" }, { role: "system", content: [{ type: "text", text: "turn context", cache_control: cc }] }, { role: "system", content: [], output_config: { effort: "low" } }] };
	const notes: GateNotes = { applied: [] };
	moveTrailingSystemBreakpoint("anthropic-messages", p, notes);
	expect(where(p)).toEqual(["0.0"]);
	expect(p.messages[0]!.content).toEqual([{ type: "text", text: "task", cache_control: cc }]);
	expect(notes.applied).toHaveLength(1);
});

test("a breakpoint on a tool result stays where it is", () => {
	const p = { messages: [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "tool_use" }] }, { role: "user", content: [{ type: "tool_result", cache_control: cc }] }] };
	moveTrailingSystemBreakpoint("anthropic-messages", p, { applied: [] });
	expect(where(p)).toEqual(["2.0"]);
});

test("the next request keeps a breakpoint where the previous one wrote its entry", () => {
	const p = {
		system: [{ text: "s", cache_control: cc }],
		tools: [{ name: "a" }, { name: "b", cache_control: cc }],
		messages: [{ role: "user", content: "task" }, { role: "system", content: [{ type: "text", text: "turn context" }] }, { role: "assistant", content: [{ type: "text", text: "ready" }] }, { role: "user", content: [{ type: "text", text: "follow-up", cache_control: cc }] }],
	};
	rollingBreakpoint("anthropic-messages", p, { applied: [] });
	expect(where(p)).toEqual(["0.0", "3.0"]);
});

test("never more than four breakpoints, and nothing for other apis", () => {
	const full = { system: [{ cache_control: cc }, { cache_control: cc }], tools: [{ cache_control: cc }], messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text" }] }, { role: "user", content: [{ type: "text", cache_control: cc }] }] };
	rollingBreakpoint("anthropic-messages", full, { applied: [] });
	expect(where(full)).toEqual(["2.0"]);
	const other = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: [] }, { role: "user", content: [{ type: "text", cache_control: cc }] }] };
	rollingBreakpoint("google-generative-ai", other, { applied: [] });
	expect(where(other)).toEqual(["2.0"]);
});

test("the kept breakpoint carries the session's ttl, so a 1h session never puts a 5m marker ahead of a 1h one", () => {
	const long = { type: "ephemeral", ttl: "1h" };
	const p: any = {
		system: [{ text: "s", cache_control: long }],
		tools: [{ name: "b", cache_control: long }],
		messages: [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "tool_use" }] }, { role: "user", content: [{ type: "tool_result", cache_control: long }] }],
	};
	rollingBreakpoint("anthropic-messages", p, { applied: [] });
	expect(where(p)).toEqual(["0.0", "2.0"]);
	expect(p.messages[0].content[0].cache_control).toEqual(long);
	// the api's rule, checked on the result: once a 5m marker appears, no 1h marker may follow
	const order = [...p.tools, ...p.system, ...p.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))].filter((b: any) => b.cache_control).map((b: any) => b.cache_control.ttl ?? "5m");
	expect(order.slice(order.indexOf("5m") >>> 0).includes("1h")).toBe(false);
	const short: any = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text" }] }, { role: "user", content: [{ type: "text", cache_control: cc }] }] };
	rollingBreakpoint("anthropic-messages", short, { applied: [] });
	expect(short.messages[0].content[0].cache_control).toEqual(cc);
});
