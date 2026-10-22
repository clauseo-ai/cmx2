import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routing } from "@cmx2/routing";
import { type AgentRow, Store } from "@cmx2/store";
import { Actors, type Host } from "../src/actors.ts";
import { checksFor, evaluate, type PermissionRule, rulesFromConfig, DEFAULT_PERMISSION } from "@cmx2/engine/permission";
import { helperFragment } from "../src/prompt.ts";
import { REPORT_MAX_CHARS } from "../src/report.ts";
import { ReportFiles } from "../src/report-files.ts";

/** every helper report is saved in full as a file, and the report the parent reads names it */

function setup(opts: { maxBytes?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-reportfiles-"));
	const store = new Store(join(dir, "cmx2.db"));
	const turns = new Map<string, any[]>();
	const host: Host = {
		createSession: async () => {},
		state: () => "idle",
		deliver: () => false,
		wake: async () => true,
		interrupt: async () => {},
		messages: async (id) => turns.get(id) ?? [],
		directory: () => dir,
		exists: () => true,
		liveJobs: () => 0,
		end: async () => {},
		publish: () => {},
		statusChanged: () => {},
		failNextTurn: () => {},
	};
	const reports = new ReportFiles(join(dir, "reports"), opts.maxBytes);
	const actors = new Actors({ store, host, routing: new Routing({ configDir: () => dir, machine: "t" }), reports });
	actors.ensureRoot("ses_root");
	const now = Date.now();
	const child = (id: string, name: string, options: object = {}): AgentRow => ({
		id,
		root_id: "ses_root",
		parent_id: "ses_root",
		path: `/root/${name}`,
		name,
		depth: 1,
		seat: "haiku",
		agent_type: "explore",
		model: "anthropic/claude-haiku-5-5",
		effort: "high",
		state: "working",
		cause: null,
		previous_state: null,
		brief: "map the repo",
		last_task: "map the repo",
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
	const say = (id: string, text: string) => turns.set(id, [{ role: "assistant", content: [{ type: "text", text }] }]);
	const end = (id: string, to = 3, outcome: "completed" | "errored" | "aborted" = "completed") => actors.onTurn(id, { type: "end", from: 0, to, outcome, stopReason: "stop", files: [] });
	return { dir, store, actors, reports, child, say, end };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("a report over the cap is saved whole, and the parent's report names the file instead of the session", async () => {
	const { store, child, say, end, reports } = setup();
	store.agents.put(child("ses_map", "map"));
	const long = Array.from({ length: 2000 }, (_, i) => `packages/file_${i}.ts: one line about it`).join("\n");
	expect(long.length).toBeGreaterThan(REPORT_MAX_CHARS);
	say("ses_map", long);
	end("ses_map", 7);
	await tick();
	const mail = store.agents.pending("ses_root");
	expect(mail).toHaveLength(1);
	const path = join(reports.treeDir("ses_root"), "ses_map-7.md");
	expect(mail[0]!.body).toContain(`more characters; the full text is in ${path})`);
	expect(mail[0]!.body).toContain(`full report: ${path}.`);
	expect(mail[0]!.body).not.toContain("the full text is in session");
	expect(JSON.parse(mail[0]!.meta!).report_file).toBe(path);
	const saved = readFileSync(path, "utf8");
	expect(saved).toStartWith("report from /root/map (session ses_map), status parked\n\n");
	expect(saved).toContain(long);
});

test("a short report gets its file too, and each turn its own", async () => {
	const { store, child, say, end, reports } = setup();
	store.agents.put(child("ses_map", "map"));
	say("ses_map", "three files matter: a.ts, b.ts, c.ts");
	end("ses_map", 3);
	await tick();
	say("ses_map", "and d.ts");
	end("ses_map", 6);
	await tick();
	const bodies = store.agents.pending("ses_root").map((m) => m.body);
	const first = join(reports.treeDir("ses_root"), "ses_map-3.md");
	const second = join(reports.treeDir("ses_root"), "ses_map-6.md");
	expect(bodies[0]).toContain(`full report: ${first}.`);
	expect(bodies[1]).toContain(`full report: ${second}.`);
	expect(readFileSync(first, "utf8")).toContain("three files matter: a.ts, b.ts, c.ts");
	expect(readFileSync(second, "utf8")).toContain("and d.ts");
});

test("a failed turn with text gets a file; one with no text gets none", async () => {
	const { store, child, say, end, reports } = setup();
	store.agents.put(child("ses_a", "a"));
	store.agents.put(child("ses_b", "b"));
	say("ses_a", "half a map");
	end("ses_a", 4, "errored");
	end("ses_b", 4, "errored");
	await tick();
	expect(readFileSync(join(reports.treeDir("ses_root"), "ses_a-4.md"), "utf8")).toContain("status failed\n\nit failed while writing this");
	expect(existsSync(join(reports.treeDir("ses_root"), "ses_b-4.md"))).toBe(false);
	const b = store.agents.pending("ses_root").find((m) => m.from_path === "/root/b")!;
	expect(b.body).not.toContain("full report:");
});

test("a pool's combined report names each member's file", async () => {
	const { store, child, say, end, reports } = setup();
	const pool = { id: "pool_x", name: "maps", n: 2, collect: "all", any_n: 1, strategy: "one_for_one" };
	store.agents.put(child("ses_m1", "maps_1", { pool: { ...pool, index: 1 } }));
	store.agents.put(child("ses_m2", "maps_2", { pool: { ...pool, index: 2 } }));
	say("ses_m1", "x".repeat(5000));
	say("ses_m2", "the second map");
	end("ses_m1", 5);
	end("ses_m2", 8);
	await tick();
	const mail = store.agents.pending("ses_root");
	expect(mail).toHaveLength(1);
	const f1 = join(reports.treeDir("ses_root"), "ses_m1-5.md");
	const f2 = join(reports.treeDir("ses_root"), "ses_m2-8.md");
	expect(mail[0]!.body).toContain(`agent /root/maps_1 reached status: parked (full report: ${f1})`);
	expect(mail[0]!.body).toContain(`agent /root/maps_2 reached status: parked (full report: ${f2})`);
	expect(mail[0]!.body).toContain(`1000 more characters; the full text is in ${f1})`);
	expect(readFileSync(f1, "utf8")).toContain("x".repeat(5000));
});

test("message with files delivers their contents with the note", async () => {
	const { dir, store, actors, child } = setup();
	store.agents.put(child("ses_kid", "kid"));
	writeFileSync(join(dir, "map.md"), "the whole map\nline two");
	const big = join(dir, "big.md");
	writeFileSync(big, "y".repeat(25_000));
	writeFileSync(join(dir, "rel.md"), "z".repeat(20_010));
	await actors.message("ses_root", { to: "kid", body: "here is the map", files: ["map.md", big, "missing.md", "rel.md"] });
	const [m] = store.agents.pending("ses_kid");
	expect(m!.body).toStartWith("here is the map\n\n");
	expect(m!.body).toContain('<file path="map.md">\nthe whole map\nline two\n</file>');
	expect(m!.body).toContain(`<file path="${big}">`);
	expect(m!.body).toContain(`(5000 more characters; read ${big} for the rest)`);
	expect(m!.body).toContain('<file path="missing.md">(not found)</file>');
	// a relative path is cut with the absolute one, so the recipient can read the rest from any directory
	expect(m!.body).toContain(`(10 more characters; read ${join(dir, "rel.md")} for the rest)`);
});

test("retention: past the byte cap the oldest files go, the newest stays, and a restart counts what is on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-reportfiles-"));
	const rf = new ReportFiles(join(dir, "reports"), 2500);
	const a = rf.write("ses_r1", "ses_a", 1, "a".repeat(1000));
	const b = rf.write("ses_r1", "ses_b", 1, "b".repeat(1000));
	expect(rf.usage()).toEqual({ files: 2, bytes: 2000 });
	const c = rf.write("ses_r2", "ses_c", 1, "c".repeat(1000));
	expect(existsSync(a)).toBe(false);
	expect(existsSync(b)).toBe(true);
	expect(existsSync(c)).toBe(true);
	expect(rf.usage()).toEqual({ files: 2, bytes: 2000 });
	// one file bigger than the whole cap is kept; everything older goes, and emptied tree directories with it
	const d = rf.write("ses_r3", "ses_d", 1, "d".repeat(3000));
	expect(existsSync(d)).toBe(true);
	expect(readdirSync(join(dir, "reports"))).toEqual(["ses_r3"]);
	// a fresh owner (a daemon restart) reads the sizes back from disk
	const again = new ReportFiles(join(dir, "reports"), 2500);
	expect(again.usage()).toEqual({ files: 1, bytes: 3000 });
	// and the count cap evicts the same way
	const counted = new ReportFiles(join(dir, "counted"), 1_000_000, 2);
	mkdirSync(join(dir, "counted"));
	const x = counted.write("ses_r", "ses_x", 1, "x");
	counted.write("ses_r", "ses_y", 1, "y");
	counted.write("ses_r", "ses_z", 1, "z");
	expect(existsSync(x)).toBe(false);
	expect(counted.usage().files).toBe(2);
});

test("the read-only and review fragments say the final reply is the deliverable and is saved to a file", () => {
	const line = "your final reply is your deliverable: the daemon saves it in full to a file your spawner's report names, so when a brief asks you to write something to a file, put it in your final reply instead.";
	expect(helperFragment({ readOnly: true })).toEndWith(`your tools read and search; you do not change files or run commands. ${line}`);
	expect(helperFragment({ review: true })).toEndWith(`your tools read, search and run commands; you do not change files. ${line}`);
	expect(helperFragment()).not.toContain(line);
});
test("the report rules: * crosses /, so an edit to any report file is denied and a tree reads its own reports without an ask", () => {
	// the same two rules the daemon appends after the saved ones (server/index.ts, reportRules)
	const reportsDir = "/data/reports";
	const rules: PermissionRule[] = [
		...rulesFromConfig(DEFAULT_PERMISSION),
		{ permission: "external_directory", pattern: `${reportsDir}/ses_root/*`, action: "allow" },
		{ permission: "edit", pattern: `${reportsDir}/*`, action: "deny" },
	];
	const verdict = (tool: string, path: string) => checksFor(tool, { path }, "/work/repo").map((c) => c.patterns.map((p) => evaluate(rules, c.permission, p).action));
	const file = `${reportsDir}/ses_root/ses_kid-7.md`;
	// read: the read rule allows, the external_directory check matches the tree's rule one level down
	expect(verdict("read", file)).toEqual([["allow"], ["allow"]]);
	// write and edit: denied, two levels below the pattern's directory, and in another tree too
	expect(verdict("write", file)[0]).toEqual(["deny"]);
	expect(verdict("edit", file)[0]).toEqual(["deny"]);
	expect(verdict("write", `${reportsDir}/ses_other/ses_x-1.md`)[0]).toEqual(["deny"]);
	// another tree's reports still ask
	expect(verdict("read", `${reportsDir}/ses_other/ses_x-1.md`)[1]).toEqual(["ask"]);
});
