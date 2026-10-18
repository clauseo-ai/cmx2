import { expect, test } from "bun:test";
import type { AgentInfo } from "../src/actors.ts";
import { rosterFor } from "../src/tools.ts";

const row = (path: string, why?: string): AgentInfo => ({
	id: `ses_${path.replace(/\W/g, "")}`,
	rootID: "ses_root",
	parentID: null,
	path,
	name: path.split("/").pop()!,
	depth: path.split("/").length - 2,
	seat: "opus",
	agentType: "general",
	model: "anthropic/claude-opus-5-5",
	effort: "medium",
	state: "parked",
	files: [],
	pending: 0,
	tokens: 0,
	createdAt: 0,
	updatedAt: 0,
	...(why ? { why } : {}),
});

test("an agent sees why only on agents below it, never on itself, its spawner or its siblings", () => {
	const tree = [row("/root"), row("/root/a", "needs judgment"), row("/root/a/x", "a decision"), row("/root/ab", "sibling")];
	const as = (self: string) => tree.map((a) => rosterFor(self, a)).map((a) => [a.path, a.why]);
	expect(as("/root")).toEqual([
		["/root", undefined],
		["/root/a", "needs judgment"],
		["/root/a/x", "a decision"],
		["/root/ab", "sibling"],
	]);
	// /root/ab shares a prefix with /root/a but is not below it
	expect(as("/root/a")).toEqual([
		["/root", undefined],
		["/root/a", undefined],
		["/root/a/x", "a decision"],
		["/root/ab", undefined],
	]);
	expect(tree.map((a) => rosterFor("/root/a", a)).every((a) => a.path === "/root/a/x" || !("why" in a))).toBe(true);
});
