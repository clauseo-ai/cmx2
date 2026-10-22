import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { Actors, type Host } from "../src/actors.ts";

/** how long a parked session's cache is kept warm: helpers 20 minutes, roots 4 hours on the 1h ttl and 20 minutes on 5m */

const MIN = 60_000;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-warmfor-"));
	const store = new Store(join(dir, "cmx2.db"));
	const host: Host = {
		createSession: async () => {},
		state: () => "idle",
		deliver: () => false,
		wake: async () => false,
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
	const now = Date.now();
	const child = (id: string, name: string, over: Partial<AgentRow> = {}, options: object = {}): AgentRow => ({
		id,
		root_id: "ses_root",
		parent_id: "ses_root",
		path: `/root/${name}`,
		name,
		depth: 1,
		seat: "sonnet",
		agent_type: null,
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		state: "parked",
		cause: null,
		previous_state: null,
		brief: "work",
		last_task: "work",
		last_report: null,
		files: "[]",
		options: JSON.stringify(options),
		delivered: 0,
		trigger_seq: 0,
		turn_tokens: 0,
		tokens: 0,
		respawns: 0,
		created_at: now,
		updated_at: now,
		closed_at: null,
		...over,
	});
	return { store, actors, child };
}

test("a root is warmed for 4 hours on the 1h ttl and 20 minutes on the 5m one", () => {
	const { actors } = setup();
	actors.ensureRoot("ses_root");
	expect(actors.warmFor("ses_root", "1h")).toEqual({ enabled: true, horizonMs: 240 * MIN });
	expect(actors.warmFor("ses_root", "5m")).toEqual({ enabled: true, horizonMs: 20 * MIN });
});

test("a session with no agent row and no parent is a root; one with a parent and no row is not warmed", () => {
	const { store, actors } = setup();
	store.putSession({ id: "ses_bare", directory: "/w", title: "bare", model: "anthropic/m", session_file: null, created_at: 1 });
	store.putSession({ id: "ses_kid", directory: "/w", title: "kid", model: "anthropic/m", session_file: null, created_at: 1, parent_id: "ses_bare" });
	expect(store.agents.get("ses_bare")).toBeFalsy();
	expect(actors.warmFor("ses_bare", "1h")).toEqual({ enabled: true, horizonMs: 240 * MIN });
	expect(actors.warmFor("ses_bare", "5m")).toEqual({ enabled: true, horizonMs: 20 * MIN });
	expect(actors.warmFor("ses_kid", "1h").enabled).toBe(false);
	expect(actors.warmFor("ses_unknown", "1h").enabled).toBe(false);
});

test("a helper keeps 20 minutes at either ttl, spawn(warm: false) turns it off, and a closed one is not warmed", () => {
	const { store, actors, child } = setup();
	actors.ensureRoot("ses_root");
	store.agents.put(child("ses_a", "a"));
	store.agents.put(child("ses_off", "off", {}, { warm: false }));
	store.agents.put(child("ses_done", "done", { state: "closed", closed_at: Date.now() }));
	expect(actors.warmFor("ses_a", "5m")).toEqual({ enabled: true, horizonMs: 20 * MIN });
	expect(actors.warmFor("ses_a", "1h")).toEqual({ enabled: true, horizonMs: 20 * MIN });
	expect(actors.warmFor("ses_off", "5m").enabled).toBe(false);
	expect(actors.warmFor("ses_done", "5m")).toEqual({ enabled: false, horizonMs: 0 });
	expect(actors.warmFor("ses_done", "1h")).toEqual({ enabled: false, horizonMs: 0 });
});
