import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { Actors, type Host } from "../src/actors.ts";

/** the roster's path prefix names a part of the tree; a trailing slash does not change which part */

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-roster-"));
	const store = new Store(join(dir, "cmx2.db"));
	const host: Host = {
		createSession: async () => {},
		state: () => "idle",
		deliver: () => false,
		wake: async () => true,
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
		state: "parked",
		cause: null,
		previous_state: null,
		brief: "b",
		last_task: "b",
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
	store.agents.put(agent("ses_sub", "/root/kid/sub", "ses_kid"));
	store.agents.put(agent("ses_kidney", "/root/kidney", "ses_root"));
	return actors;
}

const paths = (r: { agents: Array<{ path: string }> }) => r.agents.map((a) => a.path).sort();

test("a prefix with a trailing slash lists the same agents as one without", () => {
	const actors = setup();
	expect(paths(actors.roster("ses_root", "/root/"))).toEqual(["/root", "/root/kid", "/root/kid/sub", "/root/kidney"]);
	expect(paths(actors.roster("ses_root", "/root/"))).toEqual(paths(actors.roster("ses_root", "/root")));
	expect(paths(actors.roster("ses_root", "/root/kid/"))).toEqual(["/root/kid", "/root/kid/sub"]);
	expect(paths(actors.roster("ses_root", "/root/kid"))).toEqual(["/root/kid", "/root/kid/sub"]);
});

test("a bare slash lists the whole tree, as no prefix does", () => {
	const actors = setup();
	expect(paths(actors.roster("ses_root", "/"))).toEqual(paths(actors.roster("ses_root")));
});
