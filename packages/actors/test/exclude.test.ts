import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { type ChildSpec, EXCLUDE_EXPLORE, EXCLUDE_REVIEW, Actors, excludeFor, type Host } from "../src/actors.ts";

/** which core tools a helper does not get: one list for a fresh session, a reopened one and a respawn, old rows included */

test("excludeFor reads exclude_tools, falls back to read_only for rows written before it, and is empty otherwise", () => {
	expect(excludeFor({})).toEqual([]);
	expect(excludeFor({ read_only: true })).toEqual(EXCLUDE_EXPLORE);
	expect(excludeFor({ exclude_tools: EXCLUDE_REVIEW })).toEqual(EXCLUDE_REVIEW);
	expect(excludeFor({ exclude_tools: EXCLUDE_REVIEW, read_only: true })).toEqual(EXCLUDE_REVIEW);
	expect(EXCLUDE_EXPLORE).toContain("shell");
	expect(EXCLUDE_REVIEW).not.toContain("shell");
	for (const t of ["write", "edit", "worktree_create", "worktree_merge", "worktree_discard"]) expect(EXCLUDE_REVIEW).toContain(t);
});

test("an old read_only row reopens and respawns with the explore exclusions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-exclude-"));
	const store = new Store(join(dir, "cmx2.db"));
	const created: ChildSpec[] = [];
	const host: Host = {
		createSession: async (spec) => void created.push(spec),
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
	const root = actors.ensureRoot("ses_root");
	const now = Date.now();
	const row = (id: string, name: string, options: object): AgentRow => ({
		id,
		root_id: "ses_root",
		parent_id: "ses_root",
		path: `/root/${name}`,
		name,
		depth: 1,
		seat: "sonnet",
		agent_type: "explore",
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		state: "parked",
		cause: null,
		previous_state: null,
		brief: "look around",
		last_task: "look around",
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
	});
	const old = row("ses_old", "old", { read_only: true, on_failure: "respawn" });
	const fresh = row("ses_fresh", "fresh", { exclude_tools: EXCLUDE_REVIEW });
	store.agents.put(old);
	store.agents.put(fresh);
	expect(actors.excludedTools("ses_old")).toEqual(EXCLUDE_EXPLORE);
	expect(actors.excludedTools("ses_fresh")).toEqual(EXCLUDE_REVIEW);
	expect(actors.excludedTools("ses_root")).toEqual([]);
	// the respawn builds a fresh session from the same row: it keeps the exclusions the old row implies
	await (actors as unknown as { respawn(a: AgentRow, parent: AgentRow, error: string): Promise<void> }).respawn(old, root, "boom");
	expect(created).toHaveLength(1);
	expect(created[0]!.title).toBe("old (sonnet)");
	expect(created[0]!.model).toBe("anthropic/claude-sonnet-5-5");
	expect(created[0]!.excludeTools).toEqual(EXCLUDE_EXPLORE);
});
