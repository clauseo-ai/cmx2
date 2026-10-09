import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, LIVE, gitRepo, liveNote, liveProfile, liveTest, nonce, port } from "../../../eval/src/harness.ts";

/**
 * a real daemon (port 4838) and the real provider: an unnamed session gets a generated title after its
 * first message, a named one keeps its name, and every message, permission ask, question ask and reply
 * moves the session to the top of the list with a session.updated frame.
 *
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it both tests are skipped and no daemon starts.
 * the live profile is the config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else
 * ANTHROPIC_API_KEY from the env.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-it-activity-")));
const repo = join(root, "repo");
const tag = nonce();
const daemon = new Daemon({ port: port(4838), dataDir: join(root, "data"), password: "pw", log: join(root, "daemon.log"), env: { CMX2_CONFIG_DIR: join(root, "config") } });
liveNote("activity.test.ts (real model turns)");
const frames: Array<{ directory?: string; payload: { type: string; properties: any } }> = [];
const ctl = new AbortController();

beforeAll(async () => {
	if (!LIVE) return;
	liveProfile(join(root, "config"));
	await gitRepo(repo, { "README.md": "activity test\n" });
	// the project layer asks before shell commands, so the model's shell call raises a permission ask
	mkdirSync(join(repo, ".cmx2"), { recursive: true });
	writeFileSync(join(repo, ".cmx2", "cmx2.jsonc"), JSON.stringify({ permission: { shell: "ask" } }));
	await daemon.start();
	void (async () => {
		try {
			const res = await fetch(`${daemon.base}/global/event`, { headers: daemon.headers(), signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const data = buf
						.slice(0, i)
						.split("\n")
						.find((l) => l.startsWith("data: "));
					buf = buf.slice(i + 2);
					if (data) frames.push(JSON.parse(data.slice(6)));
				}
			}
		} catch {}
	})();
	await Bun.sleep(300);
}, 30_000);

afterAll(async () => {
	ctl.abort();
	await daemon.stop();
});

const of = (sid: string, type: string) => frames.map((f, i) => ({ f, i })).filter(({ f }) => f.payload.type === type && f.payload.properties.sessionID === sid);
const top = async () => ((await daemon.api(`/session?directory=${encodeURIComponent(repo)}&limit=10`)) as Array<{ id: string }>)[0]?.id;
const updatedAt = async (sid: string) => (await daemon.api(`/session/${sid}`)).time.updated as number;

async function send(sid: string, text: string) {
	const res = await daemon.raw(`/session/${sid}/prompt_async`, { text });
	expect(res.status).toBe(202);
}

let a = "";
let b = "";

liveTest("an unnamed session is titled from its first message; a named one keeps its name", async () => {
	a = (await daemon.api("/session", { directory: repo, model: "anthropic/claude-sonnet-5-5", effort: "low" })).id;
	b = (await daemon.api("/session", { directory: repo, title: `it-keep-${tag}`, model: "anthropic/claude-sonnet-5-5", effort: "low" })).id;
	expect((await daemon.api(`/session/${a}`)).title).toMatch(/^new session \d{4}-/);
	await send(a, "how does binary search find an item in a sorted array? answer in one sentence.");
	const titled = await daemon.until(async () => {
		const t = (await daemon.api(`/session/${a}`)).title as string;
		return t.startsWith("new session") ? undefined : t;
	}, "a generated title", 120_000);
	await daemon.idle(a, 180_000);
	const frame = of(a, "session.updated").find(({ f }) => f.payload.properties.info.title === titled);
	console.log(`generated title: "${titled}"`);
	console.log(`session.updated frame: ${JSON.stringify(frame?.f.payload).slice(0, 400)}`);
	expect(frame).toBeDefined();
	expect(titled).toBe(titled.toLowerCase());
	expect(titled.length).toBeLessThanOrEqual(60);
	expect(titled.split(/\s+/).length).toBeLessThanOrEqual(8);
	const info = await daemon.api(`/session/${a}`);
	console.log(`session cost after title and turn: ${info.cost}`);
	expect(info.cost).toBeGreaterThan(0);
	// the title request is not a turn: one step, and the transcript holds only the user's message and the answer
	expect((await daemon.api(`/session/${a}/steps`)).length).toBe(1);

	await send(b, "say ok.");
	await daemon.idle(b, 180_000);
	await Bun.sleep(3_000);
	expect((await daemon.api(`/session/${b}`)).title).toBe(`it-keep-${tag}`);
	expect(of(b, "session.updated").every(({ f }) => f.payload.properties.info.title === `it-keep-${tag}`)).toBe(true);
}, 300_000);

liveTest("messages, a permission ask and its reply, a question ask and its reply each move the session up with session.updated", async () => {
	// messages: b ran last, so it is on top; every message a's turn writes fires session.updated
	expect(await top()).toBe(b);
	const beforeMsgs = of(a, "message.updated").length;
	const beforeUpd = of(a, "session.updated").length;
	await send(a, "run the shell command `echo it-activity` with the shell tool, then tell me what it printed.");
	const ask = await daemon.until(async () => of(a, "permission.asked")[0], "a permission ask", 180_000);
	expect(frames[ask.i + 1]?.payload.type).toBe("session.updated");
	expect(frames[ask.i + 1]?.payload.properties.sessionID).toBe(a);
	expect(await top()).toBe(a);

	// while a waits on the ask, b moves to the top; the reply alone must bring a back
	await send(b, "say ok again.");
	await daemon.idle(b, 180_000);
	expect(await top()).toBe(b);
	const t0 = await updatedAt(a);
	await daemon.api(`/permission/${ask.f.payload.properties.id}/reply`, { reply: "once" });
	const replied = await daemon.until(async () => of(a, "permission.replied")[0], "the reply frame", 10_000);
	expect(frames[replied.i + 1]?.payload.type).toBe("session.updated");
	expect(await updatedAt(a)).toBeGreaterThan(t0);
	expect(await top()).toBe(a);
	await daemon.idle(a, 180_000);
	const msgs = of(a, "message.updated").length - beforeMsgs;
	const upd = of(a, "session.updated").length - beforeUpd;
	console.log(`turn with a permission ask: ${msgs} message.updated frames, ${upd} session.updated frames`);
	expect(upd).toBeGreaterThanOrEqual(3);

	// question: the same, for an ask the model raises with the question tool
	await send(b, "one more ok.");
	await daemon.idle(b, 180_000);
	await send(a, "use the question tool to ask me whether i prefer tabs or spaces (options: tabs, spaces), then reply with my choice in one word.");
	const q = await daemon.until(async () => of(a, "question.asked")[0], "a question ask", 180_000);
	expect(frames[q.i + 1]?.payload.type).toBe("session.updated");
	expect(await top()).toBe(a);
	await send(b, "last ok.");
	await daemon.idle(b, 180_000);
	expect(await top()).toBe(b);
	await daemon.api(`/question/${q.f.payload.properties.id}/reply`, { answers: [["tabs"]] });
	const qr = await daemon.until(async () => of(a, "question.replied")[0], "the question reply frame", 10_000);
	expect(frames[qr.i + 1]?.payload.type).toBe("session.updated");
	expect(await top()).toBe(a);
	await daemon.idle(a, 180_000);
	const order = (await daemon.api(`/session?directory=${encodeURIComponent(repo)}&limit=10`)).map((s: any) => `${s.id === a ? "a" : "b"} ${s.time.updated}`);
	console.log(`list order at the end: ${order.join(", ")}`);
	const violations = (await daemon.api("/global/memory")).contract_violations;
	expect(violations).toBe(0);
}, 600_000);
