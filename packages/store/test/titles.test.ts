import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nestedDetails } from "@cmx2/tools/record";
import { projectMessage, Store } from "../src/index.ts";

/** a24 and a27 at the projection: the title of an agent tool part, and a run part's nested answers kept to size */

// one store, a session per projection
const s = new Store(join(mkdtempSync(join(tmpdir(), "cmx2-store-")), "cmx2.db"));
let sessions = 0;
function project(calls: Array<{ id: string; name: string; arguments: unknown; result: { content: string; details?: unknown } }>) {
	const sid = `ses_titles${sessions++}`;
	s.putSession({ id: sid, directory: "/w", title: "p", model: "anthropic/m", session_file: null, created_at: 1 });
	const ctx = (seq: number) => ({ sessionId: sid, cwd: "/w", seq, completedAt: 99 });
	projectMessage(s, ctx(1), { role: "user", content: "go", timestamp: 1 });
	projectMessage(s, ctx(2), {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
		provider: "anthropic",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	});
	calls.forEach((c, i) => projectMessage(s, ctx(3 + i), { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: c.result.content }], details: c.result.details, isError: false, timestamp: 3 + i }));
	return s.messages(sid).rows[1]!.parts.map((p) => JSON.parse(p.data)).filter((p) => p.type === "tool");
}

const agent = (name: string) => ({ id: `ses_${name}`, name, path: `/root/${name}`, seat: "engineer", state: "working", files: [] });

test("agent verbs are titled by the agent they name", () => {
	const parts = project([
		{ id: "c1", name: "spawn", arguments: { brief: "x" }, result: { content: "spawned", details: { agents: [agent("helper")], child_session_id: "ses_helper", id: "ses_helper", path: "/root/helper" } } },
		{ id: "c2", name: "spawn", arguments: { brief: "x", pool: { n: 3 } }, result: { content: "spawned", details: { agents: [agent("a"), agent("b"), agent("c")], child_session_id: "ses_a", id: "ses_a", path: "/root/a" } } },
		{ id: "c3", name: "message", arguments: { to: "parent", body: "hi" }, result: { content: "delivered", details: { to: "/root/worker_a", id: "ses_w", state: "idle", woke: true, pending: 1 } } },
		{ id: "c4", name: "wait", arguments: { timeout_ms: 1000 }, result: { content: "timed out", details: { arrived: false } } },
		{ id: "c5", name: "wait", arguments: { correlation_id: "q7" }, result: { content: "timed out", details: { arrived: false } } },
		{ id: "c6", name: "agents", arguments: { action: "close", target: "/root/helper" }, result: { content: "closed", details: {} } },
		{ id: "c7", name: "agents", arguments: {}, result: { content: "list", details: { agents: [] } } },
		{ id: "c8", name: "read", arguments: { path: "src/a.ts" }, result: { content: "x", details: {} } },
	]);
	expect(parts.map((p) => p.state.title)).toEqual(["agent helper", "pool of 3 agents", "note to worker_a", "wait for agents", "wait for q7", "close helper", "agents", "src/a.ts"]);
});

test("a run part's nested answers are kept whole when they fit, and shrunk biggest first when they do not", () => {
	const spawnAnswer = (name: string, pad = 0) => ({ child_session_id: `ses_${name}`, id: `ses_${name}`, path: `/root/${name}`, agents: [{ ...agent(name), lastReport: "x".repeat(pad) }] });
	const entry = (name: string, details: unknown) => ({ helper: "agents.spawn", tool: "spawn", ok: true, ms: 1, title: `agent ${name}`, details });
	const run = (nested: unknown[]) => project([{ id: "r", name: "run", arguments: { code: "" }, result: { content: "ok", details: { ok: true, calls: nested.length, nested, attachments: 0 } } }])[0].state.metadata.nested as any[];

	const small = run([entry("a", spawnAnswer("a")), entry("b", spawnAnswer("b"))]);
	expect(small[0].details.agents[0].name).toBe("a");
	expect(small[1].details.child_session_id).toBe("ses_b");

	// one answer is large: it shrinks to its ids and a marker, the others stay whole
	const mixed = run([entry("a", spawnAnswer("a")), entry("big", spawnAnswer("big", 6000)), entry("c", spawnAnswer("c"))]);
	expect(mixed[0].details.agents[0].name).toBe("a");
	expect(mixed[1].details).toEqual({ truncated: true, child_session_id: "ses_big", id: "ses_big", path: "/root/big", agents: [{ id: "ses_big", name: "big", path: "/root/big" }] });
	expect(mixed[1].title).toBe("agent big");
	expect(mixed[2].details.agents[0].name).toBe("c");
});

const read = (i: number) => ({ helper: "fs.read", tool: "read", ok: true, ms: 1, permission: "allow", rule: "read *: allow", title: `src/file${i}.ts`, details: { path: `/w/src/file${i}.ts`, startLine: 1, endLine: 40, totalLines: 40, truncated: false, cutLines: 0 } });
const spawnEntry = (name: string, pad = 0) => ({ helper: "agents.spawn", tool: "spawn", ok: true, ms: 3, permission: "allow", title: `agent ${name}`, details: { child_session_id: `ses_${name}`, id: `ses_${name}`, path: `/root/${name}`, agents: [{ ...agent(name), lastTask: "b".repeat(pad) }] } });
const metaOf = (nested: unknown[]) => project([{ id: "r", name: "run", arguments: { code: "" }, result: { content: "ok", details: { ok: true, calls: nested.length, nested, attachments: 0 } } }])[0].state.metadata as any;

test("a run part of thousands of calls is summarised in linear time, not re-serialised per entry", () => {
	const nested = Array.from({ length: 3000 }, (_, i) => read(i));
	const t0 = performance.now();
	const meta = metaOf(nested);
	const ms = performance.now() - t0;
	// the daemon is not held: the bad version took 1.7 s at this size
	expect(ms).toBeLessThan(250);
	expect(meta.truncated).toBe(true);
	expect(meta.calls).toBe(3000);
	expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
});

test("when the answers do not fit but the entries do, every entry stays with its title and only the spawns keep their answers", () => {
	// 20 reads are about 6 kb with their answers and about 4 without
	const nested: unknown[] = [];
	for (let i = 0; i < 20; i++) nested.push(read(i));
	nested.splice(7, 0, spawnEntry("w7", 2000));
	const meta = metaOf(nested);
	expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
	expect(meta).toMatchObject({ calls: 21, truncated: true });
	const kept = meta.nested as any[];
	expect(kept).toHaveLength(21);
	expect(kept.map((n) => n.title)).toEqual(nested.map((n: any) => n.title));
	expect(kept.filter((n) => n.tool === "read").every((n) => n.details === undefined)).toBe(true);
	expect(kept[7].details.child_session_id).toBe("ses_w7");
});

test("when the entries alone are over the cap, the spawn entries keep their ids", () => {
	const nested: unknown[] = [];
	for (let i = 0; i < 40; i++) {
		nested.push(read(i));
		if (i % 10 === 3) nested.push(spawnEntry(`w${i}`, 2000));
	}
	const meta = metaOf(nested);
	expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
	expect(meta.truncated).toBe(true);
	expect(meta.calls).toBe(44);
	const kept = (meta.nested as any[]).filter((n) => n.tool === "spawn");
	expect(kept.map((n) => n.details.child_session_id)).toEqual(["ses_w3", "ses_w13", "ses_w23", "ses_w33"]);
	expect(kept.map((n) => n.details.path)).toEqual(["/root/w3", "/root/w13", "/root/w23", "/root/w33"]);
	expect(kept.map((n) => n.title)).toEqual(["agent w3", "agent w13", "agent w23", "agent w33"]);
});

/** a pool of sixteen as a nested record keeps it: the record's own cut has already dropped the briefs and shrunk the agents */
const pools = new Map<string, Record<string, unknown>>();
const poolEntry = (name: string): Record<string, unknown> => {
	const cached = pools.get(name);
	if (cached) return cached;
	const agents = Array.from({ length: 16 }, (_, i) => ({ ...agent(`${name}_${i}`), lastTask: "b".repeat(2000), pool: { id: "pool_1", name, index: i, n: 16 } }));
	const answer = { agents, child_session_id: agents[0]!.id, id: agents[0]!.id, path: agents[0]!.path };
	const entry = { helper: "agents.spawn", tool: "spawn", ok: true, ms: 3, permission: "allow", title: `pool of 16 agents`, details: nestedDetails("spawn", answer, 2048) };
	pools.set(name, entry);
	return entry;
};

test("when the spawn entries alone are over the cap they keep their scalars, and when those are too the part keeps its counts", () => {
	const nested: unknown[] = [];
	for (let i = 0; i < 50; i++) {
		nested.push(read(i));
		if (i % 12 === 5) nested.push(poolEntry(`p${i}`));
	}
	// four pools of sixteen are over the cap with their members named; their scalars are not
	const meta = metaOf(nested);
	expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
	expect(meta).toMatchObject({ ok: true, calls: 54, truncated: true });
	const kept = (meta.nested as any[]).filter((n) => n.tool === "spawn");
	expect(kept.map((n) => n.details.path)).toEqual(["/root/p5_0", "/root/p17_0", "/root/p29_0", "/root/p41_0"]);
	for (const n of kept) {
		expect(n.details.child_session_id).toMatch(/^ses_p\d+_0$/);
		expect(n.details.agents).toBeUndefined();
		expect(n.title).toBe("pool of 16 agents");
	}

	// forty pools: not even their scalars fit; what is left is the part's own fields, the counts included
	const many = metaOf(Array.from({ length: 40 }, (_, i) => poolEntry(`q${i}`)));
	expect(many).toEqual({ ok: true, calls: 40, attachments: 0, truncated: true });
});

test("whatever a run part holds, its metadata fits the cap and keeps the call count", () => {
	// a small deterministic generator, so a failure replays
	let seed = 20261003;
	const rnd = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	const word = (n: number) => "w".repeat(n);
	for (let round = 0; round < 300; round++) {
		const nested: any[] = Array.from({ length: rnd(120) }, (_, i) => {
			const kind = rnd(6);
			if (kind === 0) return poolEntry(`r${round}_${i}`);
			if (kind === 1) return spawnEntry(`s${round}_${i}`, rnd(2500));
			const details: Record<string, unknown> = { path: `/w/${word(rnd(300))}`, truncated: rnd(2) === 0, total: rnd(1000) };
			if (rnd(2)) details.hits = Array.from({ length: rnd(30) }, () => ({ path: "/w/a.ts", line: rnd(500), text: word(rnd(200)) }));
			if (rnd(3) === 0) details.filediff = { file: "a.ts", patch: word(rnd(4000)), additions: rnd(50), deletions: rnd(50), truncated: false };
			if (rnd(4) === 0) details.output = word(rnd(5000));
			return { ...read(i), title: word(rnd(200)), details: nestedDetails("read", details, 2048) };
		});
		const meta = metaOf(nested);
		expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
		expect(meta.calls).toBe(nested.length);
		expect(meta.ok).toBe(true);
		// a spawn the part still lists says which agent it started
		for (const n of (meta.nested ?? []) as any[]) if (n.tool === "spawn") expect(n.details.child_session_id).toMatch(/^ses_/);
	}
});
