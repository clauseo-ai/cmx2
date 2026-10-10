import { afterAll, beforeAll, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, LIVE, gitRepo, liveNote, liveProfile, liveTest, nonce, port } from "../../../eval/src/harness.ts";

/**
 * a real daemon (port 4836) and the real provider: a helper's question tool asks its spawner, not the user.
 * the root answers it from what it was told, or asks the user with its own question tool and passes the
 * answer on; either way the helper's call returns the root's answer and the user's question list only ever
 * holds the root's question.
 *
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it the tests are skipped and no daemon starts.
 */
const N = nonce();
const SCRATCH = `/tmp/cmx2-it-ask-${N}`;
const REPO = join(SCRATCH, "repo");
const CONFIG = join(SCRATCH, "config");
const ROOT_MODEL = "anthropic/claude-sonnet-5-5";
const HELPER_MODEL = "anthropic/claude-haiku-5-5";
const T = 240_000;
let d: Daemon;

liveNote("ask.test.ts (real model turns)");

beforeAll(async () => {
	if (!LIVE) return;
	liveProfile(CONFIG);
	writeFileSync(
		join(CONFIG, "routing.jsonc"),
		JSON.stringify({ models: { test: { ref: HELPER_MODEL, effort: "low", note: "the model these tests run on" } }, guide: [{ task: "anything", start: "test low" }], rules: [], caps: { running_turns: 4, depth: 3, budget_tokens: null } }),
	);
	await gitRepo(REPO, { "README.md": "a scratch repo for helper questions\n" });
	d = new Daemon({ port: port(4836), dataDir: join(SCRATCH, "data"), log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG } });
	await d.start();
	console.log(`daemon pid ${d.pid} on ${port(4836)}, scratch ${SCRATCH}`);
}, 60_000);

afterAll(async () => {
	await d?.stop();
});

const BRIEF =
	"use your question tool once to ask which name to use for a new module, with two options: parser and reader. then reply with exactly the name you were given and nothing else. do not read or change any files.";

async function root(slug: string, instruction: string) {
	const s = await d.api("/session", { directory: REPO, title: `it-ask-${slug}-${N}`, model: ROOT_MODEL, effort: "low" });
	await d.api(`/session/${s.id}/message`, { parts: [{ type: "text", text: instruction }] });
	return s.id as string;
}

async function helper(rootID: string, name: string) {
	const r = await d.api(`/session/${rootID}/agents`, { model: "test", name, brief: BRIEF });
	return r.agents[0] as { id: string; path: string };
}

async function reportOf(rootID: string, path: string) {
	return d.until(
		async () => {
			const a = ((await d.api(`/session/${rootID}/agents`)).agents as any[]).find((x) => x.path === path);
			return a?.state === "parked" && a.lastReport ? a : undefined;
		},
		`${path} parked with a report`,
		T,
	);
}

/** the helper's question tool results, as text */
async function answers(childID: string): Promise<string[]> {
	const msgs = (await d.api(`/session/${childID}/message`)) as any[];
	return msgs.flatMap((m) => m.parts.filter((p: any) => p.type === "tool" && p.tool === "question").map((p: any) => String(p.state?.output ?? "")));
}

liveTest(
	"the root answers its helper's question itself; nothing reaches the user",
	async () => {
		const rid = await root("self", "a helper will start soon and may ask you which name to use. answer it yourself with reader; do not ask me. reply ok now.");
		const kid = await helper(rid, "namer");
		const a = await reportOf(rid, kid.path);
		const got = await answers(kid.id);
		console.log(`helper's tool results: ${JSON.stringify(got)}; report: ${JSON.stringify(a.lastReport.slice(0, 200))}`);
		expect(got.some((t) => t.startsWith("/root answered:") && /reader/i.test(t))).toBe(true);
		expect(a.lastReport).toMatch(/reader/i);
		const open = (await d.api(`/question?directory=${encodeURIComponent(REPO)}`)) as any[];
		expect(open.filter((q) => q.sessionID === kid.id)).toEqual([]);
	},
	T + 60_000,
);

liveTest(
	"the root passes its helper's question up to the user and the answer back down",
	async () => {
		const rid = await root("up", "a helper will start soon and may ask you something. whatever it asks, ask me with your question tool and pass my answer on to it. reply ok now.");
		const kid = await helper(rid, "asker");
		const q = await d.until(
			async () => ((await d.api(`/question?directory=${encodeURIComponent(REPO)}`)) as any[]).find((x) => x.sessionID === rid || x.sessionID === kid.id),
			"a question in the user's list",
			T,
		);
		console.log(`the user's question came from ${q.sessionID === rid ? "the root" : "the helper"}: ${JSON.stringify(q.questions[0]?.question)}`);
		expect(q.sessionID).toBe(rid);
		const parser = q.questions[0].options.find((o: any) => /parser/i.test(o.label))?.label ?? "parser";
		await d.api(`/question/${q.id}/reply`, { answers: [[parser]] });
		const a = await reportOf(rid, kid.path);
		const got = await answers(kid.id);
		console.log(`helper's tool results: ${JSON.stringify(got)}; report: ${JSON.stringify(a.lastReport.slice(0, 200))}`);
		expect(got.some((t) => t.startsWith("/root answered:") && /parser/i.test(t))).toBe(true);
		expect(a.lastReport).toMatch(/parser/i);
	},
	T * 2,
);
