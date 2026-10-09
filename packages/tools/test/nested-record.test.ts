import { expect, test } from "bun:test";
import { nestedDetails, shrinkDetails } from "../src/record.ts";
import { runTool } from "../src/run.ts";
import type { NestedCall } from "../src/types.ts";

/** at the run tool: what a nested entry keeps of a helper call (the answers are a spawn's, shaped as the actors package returns them) */

const agent = (i: number, brief: string) => ({
	id: `ses_pool${String(i).padStart(2, "0")}aaaaaaaaaaaaa`,
	rootID: "ses_root",
	parentID: "ses_root",
	path: `/root/helper_${i}`,
	name: `helper_${i}`,
	depth: 1,
	seat: "engineer",
	agentType: null,
	model: "anthropic/claude-sonnet-5-5",
	effort: "high",
	state: "working",
	files: [],
	lastTask: brief,
	pending: 0,
	tokens: 0,
	pool: { id: "pool_1", name: "helper", index: i, n: 16 },
	createdAt: 1,
});

/** answers spawn the way the daemon does: the brief rides on each agent as lastTask, up to 2000 characters */
const call: NestedCall = async (tool, args) => {
	if (tool === "spawn") {
		const a = args as { brief: string; pool?: { n: number } };
		const agents = Array.from({ length: a.pool?.n ?? 1 }, (_, i) => agent(i, a.brief.slice(0, 2000)));
		const details = { agents, child_session_id: agents[0]!.id, id: agents[0]!.id, path: agents[0]!.path };
		return { result: { content: [{ type: "text", text: "spawned" }], details }, isError: false, decision: { permission: "allow" } };
	}
	return { result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0 }, structuredContent: { exit_code: 0, output: "" } }, isError: false, decision: { permission: "allow" } };
};

const runCode = async (code: string) => {
	const r = await runTool(call).execute("t", { code });
	return (r.details as { nested: any[] }).nested;
};

test("a spawn with a realistic brief keeps its agents on the nested record, without the brief", async () => {
	const [e] = await runCode('await agents.spawn({ brief: "x".repeat(2000), name: "helper_0" });');
	expect(e.title).toBe("agent helper_0");
	expect(e.details.truncated).toBeUndefined();
	expect(e.details.agents).toHaveLength(1);
	expect(e.details.agents[0]).toMatchObject({ path: "/root/helper_0", name: "helper_0", seat: "engineer", state: "working" });
	expect(e.details.agents[0].lastTask).toBeUndefined();
	expect(JSON.stringify(e.details).length).toBeLessThanOrEqual(2048);
});

test("a pool of sixteen keeps every member's id, path and name", async () => {
	const [e] = await runCode('await agents.spawn({ brief: "x".repeat(2000), pool: { n: 16 } });');
	expect(e.title).toBe("pool of 16 agents");
	expect(e.details.child_session_id).toMatch(/^ses_pool00/);
	expect(e.details.path).toBe("/root/helper_0");
	expect(e.details.agents).toHaveLength(16);
	for (const [i, a] of e.details.agents.entries()) expect(a).toMatchObject({ id: expect.stringContaining(`ses_pool${String(i).padStart(2, "0")}`), path: `/root/helper_${i}`, name: `helper_${i}` });
	expect(JSON.stringify(e.details).length).toBeLessThanOrEqual(2048);
});

test("a long command, even a heredoc, titles as its first line, capped", async () => {
	const [a, b] = await runCode('await shell.exec({ command: "cat > f.ts <<EOF\\n" + "line\\n".repeat(500) + "EOF" }); await shell.exec({ command: "echo " + "y".repeat(5000) });');
	expect(a.title).toBe("cat > f.ts <<EOF");
	expect(b.title.length).toBe(200);
	expect(b.title.startsWith("echo yyy")).toBe(true);
});

/** the shape an edit answers with once the edits lane lands: its counts and its patch ride in filediff */
const edited = () => ({ path: "/w/src/a.ts", replacements: 1, line: 12, truncated: false, filediff: { file: "src/a.ts", patch: "+x\n".repeat(1000), additions: 12, deletions: 3, truncated: false } });

test("a cut answer says it was cut, whatever the tool's own truncated said, and keeps the small fields of its objects", () => {
	const d = nestedDetails("edit", edited(), 2048)!;
	expect(d).toEqual({ truncated: true, path: "/w/src/a.ts", replacements: 1, line: 12, filediff: { file: "src/a.ts", additions: 12, deletions: 3 } });
	// the marker leads, as it does on every cut answer
	expect(Object.keys(d)[0]).toBe("truncated");
	// a tool that said it was cut (a read of a long file) still reads cut
	expect(shrinkDetails({ path: "/w/a.ts", truncated: true, total: 9, hits: [{ line: 1 }] }, 2048)).toEqual({ truncated: true, path: "/w/a.ts", total: 9 });
	// an answer that fits is not touched, its own truncated included
	expect(nestedDetails("read", { path: "/w/a.ts", truncated: false }, 2048)).toEqual({ path: "/w/a.ts", truncated: false });
});

test("a long string does not sink the answer that carries it", () => {
	const d = nestedDetails("read", { path: "/w/src/a.ts", startLine: 1, endLine: 40, totalLines: 40, truncated: false, note: "n".repeat(3000) }, 2048)!;
	expect(d).toEqual({ truncated: true, path: "/w/src/a.ts", startLine: 1, endLine: 40, totalLines: 40 });
	// the limit is the string's, not the answer's: a short one stays
	expect(shrinkDetails({ path: "p", note: "n".repeat(256), long: "n".repeat(257) }, 2048)).toEqual({ truncated: true, path: "p", note: "n".repeat(256) });
});

test("a cut answer never passes the cap, however much of it is scalars", () => {
	const wide = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, i]));
	for (const cap of [64, 300, 2048]) {
		const d = shrinkDetails({ id: "ses_a", path: "/root/a", ...wide }, cap);
		expect(JSON.stringify(d).length).toBeLessThanOrEqual(cap);
		expect(d).toMatchObject({ truncated: true, id: "ses_a", path: "/root/a" });
	}
	expect(shrinkDetails(undefined, 2048)).toEqual({ truncated: true });
});

test("a nested edit's counts survive through the run tool", async () => {
	const editCall: NestedCall = async () => ({ result: { content: [{ type: "text", text: "edited" }], details: edited() }, isError: false, decision: { permission: "allow" } });
	const r = await runTool(editCall).execute("t", { code: 'await fs.edit({ path: "src/a.ts", old_text: "a", new_text: "b" });' });
	const [e] = (r.details as { nested: any[] }).nested;
	expect(e.title).toBe("src/a.ts");
	expect(e.details).toEqual({ truncated: true, path: "/w/src/a.ts", replacements: 1, line: 12, filediff: { file: "src/a.ts", additions: 12, deletions: 3 } });
});
