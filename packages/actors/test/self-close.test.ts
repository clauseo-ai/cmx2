import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { ActorError, Actors, type Host } from "../src/actors.ts";
import { agentTools } from "../src/tools.ts";

/**
 * close and interrupt wait for the target's turn to end. an agent that closes itself or an ancestor would wait on its
 * own turn, so that is refused; a turn held open by a tool that ignores the abort is given up on after idleWaitMs
 */

const IDLE_WAIT = 100;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-self-close-"));
	const store = new Store(join(dir, "cmx2.db"));
	const busy = new Set<string>();
	/** sessions whose turn never goes idle: interrupt never resolves for them */
	const stuck = new Set<string>();
	/** what an interrupt does to a turn that does stop: the test wires the turn's abort here */
	const onInterrupt = new Map<string, () => Promise<void>>();
	const ended: string[] = [];
	const woke: string[] = [];
	const host: Host = {
		createSession: async () => {},
		state: (id) => (busy.has(id) ? "busy" : "idle"),
		deliver: (id) => busy.has(id),
		wake: async (id) => {
			woke.push(id);
			return true;
		},
		interrupt: async (id) => {
			if (stuck.has(id)) return new Promise<void>(() => {});
			await onInterrupt.get(id)?.();
		},
		messages: async () => [],
		directory: () => dir,
		exists: () => true,
		liveJobs: () => 0,
		end: async (id) => {
			ended.push(id);
			busy.delete(id);
		},
		publish: () => {},
		statusChanged: () => {},
		failNextTurn: () => {},
	};
	const actors = new Actors({ store, host, routing: new Routing({ configDir: () => dir, machine: "t" }), idleWaitMs: IDLE_WAIT });
	actors.ensureRoot("ses_root");
	const now = Date.now();
	const agent = (id: string, path: string, parent: string): AgentRow => ({
		id,
		root_id: "ses_root",
		parent_id: parent,
		path,
		name: path.split("/").pop()!,
		depth: path.split("/").length - 2,
		seat: "haiku",
		agent_type: "general",
		model: "anthropic/claude-haiku-5-5",
		effort: "high",
		state: "working",
		cause: null,
		previous_state: null,
		brief: "do the work",
		last_task: "do the work",
		last_report: null,
		files: "[]",
		options: "{}",
		delivered: 0,
		trigger_seq: 0,
		turn_tokens: 0,
		tokens: 0,
		respawns: 0,
		created_at: now,
		updated_at: now,
		closed_at: null,
	});
	store.agents.put(agent("ses_kid", "/root/kid", "ses_root"));
	store.agents.put(agent("ses_gk", "/root/kid/gk", "ses_kid"));
	for (const id of ["ses_kid", "ses_gk"]) {
		busy.add(id);
		actors.onTurn(id, { type: "start", from: 0 });
	}
	return { store, actors, busy, stuck, onInterrupt, ended, woke };
}

async function refusal(p: Promise<unknown>): Promise<ActorError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ActorError) return e;
		throw e;
	}
	throw new Error("expected a refusal");
}

test("a self-close and a close of an ancestor are refused at once, and nothing is stopped", async () => {
	const { store, actors, ended } = setup();
	const self = await refusal(actors.close("ses_kid", "/root/kid"));
	expect(self.name).toBe("BadRequestError");
	expect(self.message).toBe("you can't close yourself or an ancestor; end your turn instead.");
	const up = await refusal(actors.close("ses_gk", "/root/kid"));
	expect(up.message).toBe("you can't close yourself or an ancestor; end your turn instead.");
	expect((await refusal(actors.close("ses_gk", "ses_gk"))).message).toBe("you can't close yourself or an ancestor; end your turn instead.");
	expect(ended).toEqual([]);
	expect(store.agents.get("ses_kid")!.state).toBe("working");
	expect(store.agents.get("ses_gk")!.state).toBe("working");

	// through the tool the model calls: an error result, at once
	const tools = agentTools(actors, "ses_kid");
	const agents = tools.find((t) => t.name === "agents")!;
	const t0 = Date.now();
	const r = await agents.execute("call_1", { action: "close", target: "/root/kid" }, new AbortController().signal);
	expect(Date.now() - t0).toBeLessThan(IDLE_WAIT);
	expect(r.isError).toBe(true);
	expect(JSON.stringify(r.content)).toContain("you can't close yourself or an ancestor");
});

test("interrupting yourself or an ancestor is refused, the root included", async () => {
	const { actors } = setup();
	const msg = "you can't interrupt yourself or an ancestor; end your turn instead.";
	expect((await refusal(actors.interrupt("ses_kid", "/root/kid"))).message).toBe(msg);
	expect((await refusal(actors.interrupt("ses_gk", "/root/kid"))).message).toBe(msg);
	expect((await refusal(actors.interrupt("ses_root", "/root"))).message).toBe(msg);
	expect((await refusal(actors.interrupt("ses_kid", "/root"))).message).toBe(msg);
});

test("closing a subtree whose member has a tool call that never returns finishes within the time limit and leaves nothing behind", async () => {
	const { store, actors, stuck, ended } = setup();
	stuck.add("ses_gk");
	stuck.add("ses_kid");
	expect(actors.runningCount("ses_root")).toBe(2);
	const t0 = Date.now();
	const r = await actors.close("ses_root", "/root/kid");
	const took = Date.now() - t0;
	// two stuck turns, each given up on after the wait
	expect(took).toBeLessThan(IDLE_WAIT * 2 + 500);
	expect(r.closed).toEqual(["/root/kid/gk", "/root/kid"]);
	expect(store.agents.get("ses_kid")!.state).toBe("closed");
	expect(store.agents.get("ses_gk")!.state).toBe("closed");
	expect(ended.sort()).toEqual(["ses_gk", "ses_kid"]);
	expect(actors.runningCount("ses_root")).toBe(0);
	expect(actors.parkedOf("ses_root")).toBeUndefined();
	// a turn that ends late changes nothing: still closed, no report to anyone
	actors.onTurn("ses_kid", { type: "end", from: 0, to: 2, outcome: "aborted", stopReason: "aborted", files: [] });
	await Bun.sleep(10);
	expect(store.agents.get("ses_kid")!.state).toBe("closed");
	expect(store.agents.pending("ses_root").filter((m) => m.kind === "report")).toHaveLength(0);
});

test("interrupting a turn that never goes idle marks it interrupted within the time limit, ends its session, and a message reopens it", async () => {
	const { store, actors, stuck, ended, woke } = setup();
	stuck.add("ses_kid");
	const t0 = Date.now();
	const r = await actors.interrupt("ses_root", "/root/kid");
	expect(Date.now() - t0).toBeLessThan(IDLE_WAIT + 500);
	expect(r.interrupted).toBe(true);
	expect(store.agents.get("ses_kid")!.state).toBe("interrupted");
	expect(ended).toContain("ses_kid");
	expect(actors.runningCount("ses_root")).toBe(1);
	// stopped by its spawner: no report
	expect(store.agents.pending("ses_root").filter((m) => m.kind === "report")).toHaveLength(0);
	const sent = await actors.message("ses_root", { to: "kid", body: "carry on" });
	expect(sent.woke || woke.includes("ses_kid")).toBe(true);
});

test("a forced interrupt by the user tells the spawner", async () => {
	const { store, actors } = setup();
	actors.userInterrupt("ses_gk");
	await actors.forceInterrupted("ses_gk", "user");
	expect(store.agents.get("ses_gk")!.state).toBe("interrupted");
	const reports = store.agents.pending("ses_kid").filter((m) => m.kind === "report");
	expect(reports).toHaveLength(1);
	expect(reports[0]!.body).toContain("the user stopped its turn");
});

test("closing a subtree whose member is in wait still works", async () => {
	const { store, actors, busy, onInterrupt, ended } = setup();
	// the grandchild waits on its mailbox; an interrupt aborts its turn's signal, the wait returns and the turn ends
	const ctl = new AbortController();
	const waiting = actors.wait("ses_gk", { timeout_ms: 600_000 }, ctl.signal);
	onInterrupt.set("ses_gk", async () => {
		ctl.abort();
		await waiting;
		busy.delete("ses_gk");
		actors.onTurn("ses_gk", { type: "end", from: 0, to: 2, outcome: "aborted", stopReason: "aborted", files: [] });
	});
	onInterrupt.set("ses_kid", async () => {
		busy.delete("ses_kid");
		actors.onTurn("ses_kid", { type: "end", from: 0, to: 2, outcome: "aborted", stopReason: "aborted", files: [] });
	});
	await Bun.sleep(5);
	const t0 = Date.now();
	const r = await actors.close("ses_root", "/root/kid");
	// nothing waited out the limit
	expect(Date.now() - t0).toBeLessThan(IDLE_WAIT);
	expect(r.closed).toEqual(["/root/kid/gk", "/root/kid"]);
	expect((await waiting).timed_out).toBe(true);
	expect(store.agents.get("ses_gk")!.state).toBe("closed");
	expect(store.agents.get("ses_kid")!.state).toBe("closed");
	expect(ended.sort()).toEqual(["ses_gk", "ses_kid"]);
	expect(actors.runningCount("ses_root")).toBe(0);
});

test("the agents tool stops waiting when its turn is stopped", async () => {
	const { actors, stuck } = setup();
	stuck.add("ses_gk");
	const agents = agentTools(actors, "ses_root").find((t) => t.name === "agents")!;
	const ctl = new AbortController();
	const call = agents.execute("call_2", { action: "close", target: "/root/kid/gk" }, ctl.signal).then(
		() => "answered",
		(e: Error) => e.message,
	);
	await Bun.sleep(10);
	ctl.abort();
	const t0 = Date.now();
	expect(await call).toContain("the turn was stopped");
	expect(Date.now() - t0).toBeLessThan(IDLE_WAIT);
	// the close itself goes on and finishes
	await Bun.sleep(IDLE_WAIT + 50);
});
