import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Skills } from "@cmx2/tools";
import { type Config, DEFAULTS } from "../src/config.ts";
import { EngineSession } from "../src/session.ts";

/**
 * a model picks a skill up by itself only when it can see what each one is for. the turn context lists the
 * skills the session may invoke, once and again when the list changes, and the skill tool is declared from
 * request one so a match needs no tool_search. a local upstream speaks anthropic's stream; the engine, pi's
 * adapter and the sdk run for real.
 */

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const textReply = (text: string) =>
	ev("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }) +
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
	ev("content_block_stop", { index: 0 }) +
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
	ev("message_stop", {});

const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;
const scratch: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
};

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests.push(await req.json().catch(() => null));
			return new Response(textReply("ok"), { headers: { "content-type": "text/event-stream" } });
		},
	});
});
afterAll(() => {
	server.stop(true);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function config(): Config {
	return { ...structuredClone(DEFAULTS), model: "anthropic/claude-sonnet-5-5", effort: "low", providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } }, sources: [] };
}

function skillsDir(): string {
	const root = temp("cmx2-skills-");
	const put = (dir: string, body: string) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "SKILL.md"), body);
	};
	put("deploy", "---\nname: deploy\ndescription: ship the app to the vm. use when the user asks to deploy or release.\n---\nrun ./deploy.sh\n");
	put("secret-ops", "---\nname: secret-ops\ndescription: only when the user runs it\ndisable-model-invocation: true\n---\nhidden\n");
	put("bare", "---\nname: bare\n---\nno description, nothing to match on\n");
	return root;
}

const HEADER = "skills: instructions written for a kind of task.";
const count = (body: any, needle: string) => JSON.stringify(body.messages).split(needle).length - 1;

async function session(skills: Skills, excludeTools?: string[]) {
	return EngineSession.create({
		cwd: temp("cmx2-skillctx-"),
		config: config(),
		dataDir: temp("cmx2-skillctx-data-"),
		skills,
		...(excludeTools ? { excludeTools } : {}),
		onEvent: () => {},
		onStep: () => {},
	});
}

test("the turn context lists invocable skills once, again when the list changes, and after a compaction; skill is declared from the first request", async () => {
	const root = skillsDir();
	const skills = new Skills([root]);
	const s = await session(skills);
	try {
		await s.prompt("one");
		await s.idle();
		const first = requests.at(-1);
		// declared with the hot tools, not behind the deferred placeholder
		const skill = first.tools.find((t: any) => t.name === "skill");
		expect(skill).toBeDefined();
		expect(skill.defer_loading).toBeUndefined();
		expect(count(first, HEADER)).toBe(1);
		const text = JSON.stringify(first.messages);
		expect(text).toContain("- deploy: ship the app to the vm. use when the user asks to deploy or release.");
		// kept from the model by its frontmatter, and a skill with no description has nothing to match on
		expect(text).not.toContain("secret-ops");
		expect(text).not.toContain("- bare");

		// an unchanged list is not sent again
		await s.prompt("two");
		await s.idle();
		expect(count(requests.at(-1), HEADER)).toBe(1);

		// a skill added on disk shows after the flush a config reload does
		mkdirSync(join(root, "triage"));
		writeFileSync(join(root, "triage", "SKILL.md"), "---\nname: triage\ndescription: sort the inbox\n---\ngo\n");
		skills.flush();
		await s.prompt("three");
		await s.idle();
		const third = requests.at(-1);
		expect(count(third, HEADER)).toBe(2);
		expect(count(third, "- triage: sort the inbox")).toBe(1);

		// the block a compaction writes carries the list, so a summary never has to
		const state: string = (s as any).stateBlock();
		expect(state).toContain(HEADER);
		expect(state).toContain("- deploy:");
		expect(state).toContain("- triage:");
	} finally {
		s.dispose();
	}
}, 30_000);

test("an agent without the skill tool gets neither the tool nor the list", async () => {
	const s = await session(new Skills([skillsDir()]), ["skill"]);
	try {
		await s.prompt("one");
		await s.idle();
		const body = requests.at(-1);
		expect(body.tools.map((t: any) => t.name)).not.toContain("skill");
		expect(count(body, HEADER)).toBe(0);
	} finally {
		s.dispose();
	}
}, 30_000);
