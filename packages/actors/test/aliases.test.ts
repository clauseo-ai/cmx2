import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { Store } from "@cmx2/store";
import { Actors, type Host } from "../src/actors.ts";
import { normalName } from "../src/paths.ts";

/** names and model ids as models write them: pr17-review for pr17_review, a model id from the table for its alias */

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-aliases-"));
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
	const actors = new Actors({ store: new Store(join(dir, "cmx2.db")), host, routing: new Routing({ configDir: () => dir, machine: "t" }) });
	actors.ensureRoot("ses_root");
	return actors;
}

test("normalName lowercases and turns - and spaces into _", () => {
	expect(normalName(" PR17-Review ")).toBe("pr17_review");
	expect(normalName("/root/fix aliases")).toBe("/root/fix_aliases");
	expect(normalName("pr17_review")).toBe("pr17_review");
});

test("a spawn named pr17-review is pr17_review, and message, after and close find it by either spelling", async () => {
	const actors = setup();
	const [a] = (await actors.spawnWithNotes("ses_root", { brief: "review the pr", model: "haiku", name: "PR17-Review" }, { model: true })).agents;
	expect(a!.name).toBe("pr17_review");
	expect(a!.path).toBe("/root/pr17_review");
	const sent = await actors.message("ses_root", { to: "pr17-review", body: "one more thing", wake: false });
	expect(sent.to).toBe("/root/pr17_review");
	expect((await actors.message("ses_root", { to: "/root/pr17-review", body: "and another", wake: false })).to).toBe("/root/pr17_review");
	const [b] = (await actors.spawnWithNotes("ses_root", { brief: "review it again", model: "opus", name: "pr17 review 2", after: "pr17-review" }, { model: true })).agents;
	expect(b!.name).toBe("pr17_review_2");
	const closed = await actors.close("ses_root", "PR17-REVIEW");
	expect(closed.path).toBe("/root/pr17_review");
});

test("a spawn may name a model id from the table, with or without a provider, and runs on its alias", async () => {
	const actors = setup();
	const [a] = (await actors.spawnWithNotes("ses_root", { brief: "look things up", model: "claude-haiku-5-5", name: "a" }, { model: true })).agents;
	expect(a!.seat).toBe("haiku");
	expect(a!.effort).toBe("high");
	const [b] = (await actors.spawnWithNotes("ses_root", { brief: "look things up", model: "anthropic/claude-sonnet-5-5", name: "b" }, { model: true })).agents;
	expect(b!.seat).toBe("sonnet");
	await expect(actors.spawnWithNotes("ses_root", { brief: "x", model: "claude-nothing-1", name: "c" }, { model: true })).rejects.toThrow("no model named claude-nothing-1");
	await expect(actors.spawnWithNotes("ses_root", { brief: "x", model: "openai/gpt-x", name: "d" }, { model: true })).rejects.toThrow("no model named openai/gpt-x");
});
