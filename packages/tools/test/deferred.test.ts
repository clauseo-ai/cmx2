import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpText, webfetchTool, websearchTool } from "../src/deferred.ts";
import { defaultSkillDirs, frontmatter, Skills, skillsContext, skillTool } from "../src/skills.ts";
import { liveTest } from "../../eval/src/harness.ts";
import { scratch, textOf } from "./helpers.ts";

const site = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		if (u.pathname === "/page") return new Response("<html><head><style>x{}</style><script>evil()</script></head><body><h1>title</h1><p>body &amp; soul</p></body></html>", { headers: { "content-type": "text/html" } });
		if (u.pathname === "/big") return new Response(Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n"));
		return new Response("gone", { status: 404 });
	},
});
afterAll(() => site.stop(true));

test("webfetch: html reduced to text, typed details, errors flagged, long bodies spill", async () => {
	const env = scratch("fetch");
	const r = await webfetchTool(env).execute("c", { url: `http://127.0.0.1:${site.port}/page` });
	expect(textOf(r)).toContain("title");
	expect(textOf(r)).toContain("body & soul");
	expect(textOf(r)).not.toContain("evil");
	expect(r.details).toMatchObject({ status: 200, contentType: "text/html", truncated: false });
	const missing = await webfetchTool(env).execute("c", { url: `http://127.0.0.1:${site.port}/nope` });
	expect(missing.isError).toBe(true);
	const big = await webfetchTool(env).execute("c", { url: `http://127.0.0.1:${site.port}/big` });
	expect(big.details).toMatchObject({ truncated: true });
	expect(textOf(big)).toContain("full output at");
	await expect(webfetchTool(env).execute("c", { url: "file:///etc/hosts" })).rejects.toThrow("only http and https");
});

test("websearch: mcp answers parse as json or as server-sent events", () => {
	const answer = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: a\nURL: https://a.test" }] } };
	expect(mcpText(JSON.stringify(answer))).toBe("Title: a\nURL: https://a.test");
	expect(mcpText(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)).toBe("Title: a\nURL: https://a.test");
	expect(() => mcpText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } }))).toThrow("rate limited");
});

// needs the network (exa's public search) and CMX2_LIVE_TESTS=1; skipped otherwise, no key needed
liveTest("websearch: a live search through exa returns typed results", async () => {
	const env = scratch("search");
	const r = await websearchTool(env).execute("c", { query: "bun javascript runtime documentation", results: 3 });
	const d = r.details as { results: Array<{ title: string; url: string }> };
	console.log(`websearch live: ${d.results.length} results, first ${JSON.stringify(d.results[0])}`);
	expect(d.results.length).toBeGreaterThan(0);
	expect(d.results[0]!.url).toStartWith("http");
}, 30_000);

test("skills: frontmatter with folded blocks, first dir wins, flush picks up a new skill", async () => {
	const env = scratch("skills");
	const project = join(env.cwd, ".cmx2", "skills");
	const profile = join(env.cwd, "profile", "skills");
	const put = (root: string, dir: string, body: string) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "SKILL.md"), body);
	};
	put(project, "deploy", "---\nname: deploy\ndescription: >\n  ship the app\n  to the vm\n---\nrun ./deploy.sh and watch the health check.\n");
	put(profile, "deploy", "---\nname: deploy\ndescription: the profile's older deploy\n---\nold\n");
	put(profile, "review", "---\nname: review\ndescription: \"review a diff\"\n---\nread the diff twice.\n");
	expect(frontmatter("---\nname: x\n---\nbody").meta).toEqual({ name: "x" });
	expect(defaultSkillDirs("/w", "/cfg", "/h")).toEqual(["/w/.cmx2/skills", "/cfg/skills", "/h/.agents/skills", "/h/.claude/skills"]);

	const skills = new Skills([project, profile]);
	expect(skills.list().map((s) => [s.name, s.description])).toEqual([
		["deploy", "ship the app to the vm"],
		["review", "review a diff"],
	]);
	const tool = skillTool(skills, env);
	const loaded = await tool.execute("c", { name: "deploy" });
	expect(textOf(loaded)).toContain("run ./deploy.sh");
	expect(textOf(loaded)).toContain(join(project, "deploy"));
	expect(loaded.details).toMatchObject({ name: "deploy", dir: join(project, "deploy") });
	await expect(tool.execute("c", { name: "nope" })).rejects.toThrow("installed:\ndeploy: ship the app to the vm\nreview: review a diff");
	expect(textOf(await tool.execute("c", {}))).toContain("review: review a diff");

	put(project, "triage", "---\nname: triage\ndescription: sort the inbox\n---\ngo\n");
	expect(skills.list().map((s) => s.name)).not.toContain("triage");
	skills.flush();
	expect(skills.list().map((s) => s.name)).toContain("triage");
});

test("skills the frontmatter keeps from the model are left out of its list and still load by name", async () => {
	const env = scratch("skills-invocable");
	const root = join(env.cwd, "skills");
	const put = (dir: string, body: string) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "SKILL.md"), body);
	};
	put("deploy", "---\nname: deploy\ndescription: |\n  ship the app.\n  use when asked to release.\n---\nrun ./deploy.sh\n");
	put("release", "---\nname: release\ndescription: cut a tag\ndisable-model-invocation: true\n---\ntag it\n");
	put("legacy", "---\nname: legacy\ndescription: an opencode skill\nautoinvoke: false\n---\nold\n");
	put("bare", "---\nname: bare\n---\nno description\n");
	put("long", `---\nname: long\ndescription: ${"word ".repeat(300)}\n---\nbody\n`);
	const skills = new Skills([root]);
	expect(skills.list().map((s) => [s.name, s.invocable])).toEqual([
		["bare", true],
		["deploy", true],
		["legacy", false],
		["long", true],
		["release", false],
	]);

	const block = skillsContext(skills.list())!;
	const lines = block.split("\n");
	expect(lines[0]).toStartWith("skills: instructions written for a kind of task.");
	// a block description reads as one line; no description means nothing to match on
	expect(lines.slice(1).map((l) => l.split(":")[0])).toEqual(["- deploy", "- long"]);
	expect(lines[1]).toBe("- deploy: ship the app. use when asked to release.");
	// the spec's 1024 character limit, marked where it was cut
	expect(lines[2]!.length).toBe("- long: ".length + 1024);
	expect(lines[2]).toEndWith("...");
	expect(skillsContext(skills.list().filter((s) => !s.invocable))).toBeUndefined();

	const tool = skillTool(skills, env);
	const listing = textOf(await tool.execute("c", {}));
	expect(listing).toContain("deploy:");
	expect(listing).not.toContain("release:");
	expect(listing).not.toContain("legacy:");
	expect(textOf(await tool.execute("c", { name: "release" }))).toContain("tag it");
});
