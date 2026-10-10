import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailRecord } from "@cmx2/engine/session";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { Actors, askBody, type Host } from "../src/actors.ts";

/** a helper's question goes to its spawner, waits for its answer, and never reaches the user's question list */

const QUESTIONS = [{ question: "which browser should i drive?", header: "browser", options: [{ label: "the visible one (recommended)", description: "attach to it" }, { label: "a fresh one", description: "start another" }] }];

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-ask-"));
	const store = new Store(join(dir, "cmx2.db"));
	const busy = new Set<string>();
	const woke: string[] = [];
	const delivered: Array<{ id: string; items: MailRecord[] }> = [];
	const host: Host = {
		createSession: async () => {},
		state: (id) => (busy.has(id) ? "busy" : "idle"),
		deliver: (id, items) => {
			if (!busy.has(id)) return false;
			delivered.push({ id, items });
			return true;
		},
		wake: async (id) => {
			woke.push(id);
			return true;
		},
		interrupt: async () => {},
		messages: async () => [],
		directory: () => dir,
		exists: () => true,
		liveJobs: () => 0,
		end: async () => {},
		publish: () => {},
		statusChanged: () => {},
		failNextTurn: () => {},
	};
	const actors = new Actors({ store, host, routing: new Routing({ configDir: () => dir, machine: "t" }) });
	actors.ensureRoot("ses_root");
	const now = Date.now();
	const child = (id: string, name: string): AgentRow => ({
		id,
		root_id: "ses_root",
		parent_id: "ses_root",
		path: `/root/${name}`,
		name,
		depth: 1,
		seat: "haiku",
		agent_type: "general",
		model: "anthropic/claude-haiku-5-5",
		effort: "high",
		state: "working",
		cause: null,
		previous_state: null,
		brief: "check the files",
		last_task: "check the files",
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
	store.agents.put(child("ses_kid", "kid"));
	store.agents.put(child("ses_sib", "sib"));
	// the helper is mid-turn when it asks: it holds a slot
	busy.add("ses_kid");
	actors.onTurn("ses_kid", { type: "start", from: 0 });
	return { store, actors, busy, woke, delivered };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("the question goes to the spawner as mail, wakes it, lends the slot, and the spawner's message is the answer", async () => {
	const { store, actors, woke } = setup();
	expect(actors.runningCount("ses_root")).toBe(1);
	const pending = actors.ask("ses_kid", QUESTIONS);
	const mail = store.agents.pending("ses_root");
	expect(mail).toHaveLength(1);
	expect(mail[0]!.kind).toBe("message");
	expect(mail[0]!.from_path).toBe("/root/kid");
	expect(mail[0]!.correlation_id).toMatch(/^ask_/);
	expect(mail[0]!.body).toContain("which browser should i drive?");
	expect(mail[0]!.body).toContain(`correlation_id: "${mail[0]!.correlation_id}"`);
	// a parked root wakes for it; the asking helper's slot is free for others
	expect(woke).toContain("ses_root");
	expect(actors.runningCount("ses_root")).toBe(0);
	expect(store.agents.get("ses_kid")!.cause).toBe("asking");
	expect(actors.isAsking("ses_kid")).toBe(true);

	const r = await actors.message("ses_root", { to: "kid", body: "the visible one; attach with --auto-connect", correlation_id: mail[0]!.correlation_id! });
	expect(r.woke).toBe(false);
	expect(await pending).toEqual({ by: "/root", text: "the visible one; attach with --auto-connect" });
	// the answer is the tool result, not mail as well, and it does not replace the helper's task
	expect(store.agents.pending("ses_kid")).toHaveLength(0);
	expect(store.agents.get("ses_kid")!.last_task).toBe("check the files");
	expect(store.agents.get("ses_kid")!.cause).toBeNull();
	expect(actors.isAsking("ses_kid")).toBe(false);
	expect(actors.runningCount("ses_root")).toBe(1);
});

test("a note from the spawner without the correlation id still answers; a sibling's note does not", async () => {
	const { store, actors } = setup();
	const pending = actors.ask("ses_kid", QUESTIONS);
	let settled = false;
	void pending.then(() => (settled = true));
	await actors.message("ses_sib", { to: "kid", body: "i think the fresh one" });
	await tick();
	expect(settled).toBe(false);
	expect(store.agents.pending("ses_kid")).toHaveLength(1);
	await actors.message("ses_root", { to: "/root/kid", body: "a fresh one" });
	expect(await pending).toEqual({ by: "/root", text: "a fresh one" });
});

test("a stopped turn fails the question, and a later note from the spawner is plain mail", async () => {
	const { store, actors } = setup();
	const ac = new AbortController();
	const pending = actors.ask("ses_kid", QUESTIONS, ac.signal);
	ac.abort();
	await expect(pending).rejects.toThrow("the turn was stopped");
	expect(actors.isAsking("ses_kid")).toBe(false);
	await actors.message("ses_root", { to: "kid", body: "too late" });
	expect(store.agents.pending("ses_kid").map((m) => m.body)).toEqual(["too late"]);
});

test("a spawner that ends a turn after reading the question without answering lets the helper go on", async () => {
	const { store, actors } = setup();
	const pending = actors.ask("ses_kid", QUESTIONS);
	let error: Error | undefined;
	void pending.catch((e) => (error = e));
	const end = { type: "end" as const, from: 0, to: 1, outcome: "completed" as const, stopReason: "stop", files: [] };
	// a turn that ended before the question reached its transcript keeps it open
	actors.onTurn("ses_root", end);
	await tick();
	expect(error).toBeUndefined();
	const mail = store.agents.pending("ses_root")[0]!;
	actors.onMailDelivered("ses_root", mail.id, 3);
	actors.onTurn("ses_root", end);
	await tick();
	expect(error?.message).toContain("/root ended its turn without answering");
	expect(error?.message).toContain("ABORT(user_question)");
	expect(store.agents.get("ses_kid")!.cause).toBeNull();
});

test("a helper whose spawner is closed cannot ask", async () => {
	const { store, actors } = setup();
	store.agents.update("ses_root", { state: "closed" });
	await expect(actors.ask("ses_kid", QUESTIONS)).rejects.toThrow("the agent that started you is gone");
});

test("the question mail lists every question with its options and says how to answer", () => {
	const body = askBody({ path: "/root/kid" }, [...QUESTIONS, { question: "which files?", header: "files", options: [{ label: "all", description: "" }], multiple: true }], "ask_1");
	expect(body).toBe(
		[
			"/root/kid asks you, and waits for your answer:",
			"",
			"1. browser: which browser should i drive?",
			"   - the visible one (recommended): attach to it",
			"   - a fresh one: start another",
			"2. files: which files?",
			"   - all",
			"   (more than one may be chosen)",
			"",
			'answer with message(to: "/root/kid", body: <your answer>, correlation_id: "ask_1"). answer from what you know when you can; when you cannot, ask with your own question tool and pass the answer on. it reads nothing else until you answer, and if you end your turn without answering it goes on without one.',
		].join("\n"),
	);
});
