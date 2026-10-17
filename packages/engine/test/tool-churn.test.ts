import { expect, test } from "bun:test";
import { collapseToolChurn, countAdditions } from "../src/tool-churn.ts";

const ref = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const sys = (added: string[] = [], removed: string[] = [], content = "") => ({ role: "system", content, ...(added.length ? { toolsAdded: added.map(ref) } : {}), ...(removed.length ? { toolsRemoved: removed.map(ref) } : {}), timestamp: 0 });
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", id: `c_${name}`, name, arguments: {} }], timestamp: 0 });
const names = (m: any, k: "toolsAdded" | "toolsRemoved") => (m[k] ?? []).map((r: any) => r.name);

/** a server's tools loaded once, then withdrawn and restored every turn: the shape that broke a real session */
function flapping(rounds: number, tools: string[]) {
	const out: any[] = [sys(["read", "shell"], [], "prompt"), user("load"), sys(tools), call(tools[0]!)];
	for (let i = 0; i < rounds; i++) out.push(sys([], tools), user(`turn ${i}`), call("shell"), sys(tools), user(`more ${i}`));
	return out;
}

test("under the limit the messages come back as they are, the same array", () => {
	const m = flapping(3, ["x_a", "x_b"]) as never[];
	expect(collapseToolChurn(m, 100)).toBe(m);
});

test("past the limit every withdraw-and-restore pair goes, and the tool set at the end is the same", () => {
	const tools = Array.from({ length: 53 }, (_, i) => `xcode_t${i}`);
	const m = flapping(10, tools) as never[];
	expect(countAdditions(m)).toBe(2 + 53 * 11);
	const out = collapseToolChurn(m, 384) as any[];
	expect(countAdditions(out as never[])).toBe(2 + 53);
	expect(out.filter((x) => x.toolsRemoved?.length)).toEqual([]);
	// same length and order: messages are stripped, never dropped, and the stored ones are not touched
	expect(out.length).toBe(m.length);
	expect(out.map((x) => x.role)).toEqual((m as any[]).map((x) => x.role));
	expect(names(m[4], "toolsRemoved").length).toBe(53);
});

test("a removal that nothing restores stays, and so does a pair with a call of the tool in between", () => {
	const m: any[] = [sys(["read"], [], "prompt"), sys(["x_a", "x_b", "x_c"]), sys([], ["x_a", "x_b"]), call("x_b"), sys(["x_b"]), sys([], ["x_c"])];
	const out = collapseToolChurn(m as never[], 0) as any[];
	// x_a: removed, never restored; x_b: a call sits between its removal and its return; x_c: removed at the end
	expect(names(out[2], "toolsRemoved")).toEqual(["x_a", "x_b"]);
	expect(names(out[4], "toolsAdded")).toEqual(["x_b"]);
	expect(names(out[5], "toolsRemoved")).toEqual(["x_c"]);
	expect(out).toEqual(m);
});

test("a system message keeps its words when its tool changes go", () => {
	const m: any[] = [sys(["read"], [], "prompt"), sys(["x_a"]), sys([], ["x_a"], "processes alive: none"), sys(["x_a"], [], "turn context")];
	const out = collapseToolChurn(m as never[], 0) as any[];
	expect(out[2]).toEqual({ role: "system", content: "processes alive: none", timestamp: 0 });
	expect(out[3]).toEqual({ role: "system", content: "turn context", timestamp: 0 });
	expect(names(out[1], "toolsAdded")).toEqual(["x_a"]);
});
