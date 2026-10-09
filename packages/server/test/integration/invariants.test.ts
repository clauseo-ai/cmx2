/**
 * the agent invariants, against a real daemon (port 4833) and the real provider path. every child turn
 * here is a real model turn (sonnet 5.5 at low effort through the configured provider); the verbs are
 * driven over the daemon's rest surface, which runs the same code the model's tools run.
 *
 * ported from cmx's `test/integration/multi-agent-invariants.test.ts` (48 invariants plus the 3-test
 * bug-3 audit); names keep cmx's slugs. five that named a primitive cmx2 dropped are ported onto the
 * primitive that replaced it and say so in their names (self-close, the legacy task tool, close without
 * a target, links, abort cascade). the m5
 * invariants for the new primitives follow at the end.
 *
 * needs a provider key or profile and CMX2_LIVE_TESTS=1; without it every test here is skipped and no daemon starts.
 * the live profile is the config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else
 * ANTHROPIC_API_KEY from the env.
 *
 * run: CMX2_LIVE_TESTS=1 bun test packages/server/test/integration/invariants.test.ts (about 15 minutes)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, LIVE, gitRepo, liveDescribe, liveNote, liveProfile, nonce, port } from "../../../eval/src/harness.ts";

const PORT = port(4833);
const N = nonce();
const SCRATCH = `/tmp/cmx2-inv-${N}`;
const REPO = join(SCRATCH, "repo");
const CONFIG = join(SCRATCH, "config");
const MODEL = "anthropic/claude-sonnet-5-5";
const FAULTS = ["silent", "respawner", "pair_1", "iso_1", "link_2", "unlinked_1", "mcrash", "capcrash"];
const T = 240_000;

type Frame = { directory?: string; payload: { type: string; properties: any } };
let d: Daemon;
const frames: Frame[] = [];
let listener: AbortController | undefined;

/** a version-2 routing.jsonc: one alias, test, on the test model at low effort (the shipped aliases stay beside it), a minimal guide and rules */
function routing(extra: Record<string, unknown> = {}, effort = "low") {
	writeFileSync(
		join(CONFIG, "routing.jsonc"),
		JSON.stringify(
			{
				models: { test: { ref: MODEL, effort, note: "the model these tests run on" } },
				guide: [{ task: "anything", start: "test low" }],
				rules: ["end your turn when only helpers remain."],
				caps: { running_turns: 4, depth: 3, budget_tokens: null },
				...extra,
			},
			null,
			1,
		),
	);
}

function listen() {
	listener?.abort();
	const ctl = new AbortController();
	listener = ctl;
	void (async () => {
		try {
			const res = await fetch(`${d.base}/global/event`, { signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const line = buf
						.slice(0, i)
						.split("\n")
						.find((l) => l.startsWith("data: "));
					buf = buf.slice(i + 2);
					if (line) frames.push(JSON.parse(line.slice(6)));
				}
			}
		} catch {}
	})();
}

async function startDaemon() {
	d = new Daemon({ port: PORT, dataDir: join(SCRATCH, "data"), log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG, CMX2_FAULT: FAULTS.map((f) => `first_turn:${f}`).join(",") } });
	await d.start();
	listen();
}

liveNote("the agent invariants (real model turns)");

beforeAll(async () => {
	if (!LIVE) return;
	liveProfile(CONFIG);
	routing();
	await gitRepo(REPO, { "src/answer.ts": "export const answer = 42;\n", "README.md": "a scratch repo for the agent invariants\n" });
	await startDaemon();
	console.log(`daemon pid ${d.pid} on ${PORT}, scratch ${SCRATCH}`);
}, 60_000);

afterAll(async () => {
	listener?.abort();
	await d?.stop();
});

// ---------- helpers ----------

const quick = (text: string) => `reply with exactly this and nothing else, without using any tools: ${text}`;
const slow = (secs: number, text = "slept") => `run the shell command \`sleep ${secs}\` with the shell tool (in the foreground), then reply with exactly: ${text}`;

async function root(slug: string, directory = REPO) {
	return d.api("/session", { directory, title: `it-inv-${slug}-${N}`, model: MODEL, effort: "low" });
}

/** a spawn names the model it runs on; these tests use the `test` alias unless a case says otherwise */
async function spawn(sessionID: string, body: Record<string, unknown>) {
	const r = await d.api(`/session/${sessionID}/agents`, { model: "test", ...body });
	return r.agents[0];
}

async function spawnRaw(sessionID: string, body: Record<string, unknown>) {
	const res = await d.raw(`/session/${sessionID}/agents`, { model: "test", ...body });
	return { status: res.status, body: await res.json() };
}

async function roster(id: string) {
	return (await d.api(`/session/${id}/agents`)).agents as any[];
}

async function entry(rootID: string, path: string) {
	return (await roster(rootID)).find((a) => a.path === path && a.state !== "closed") ?? (await roster(rootID)).find((a) => a.path === path);
}

async function stateIs(rootID: string, path: string, state: string, timeout = T) {
	return d.until(async () => {
		const a = await entry(rootID, path);
		return a?.state === state ? a : undefined;
	}, `${path} ${state}`, timeout);
}

async function msg(sessionID: string, body: Record<string, unknown>) {
	return d.raw(`/session/${sessionID}/agents/message`, body);
}

async function mailbox(id: string) {
	return (await d.api(`/session/${id}/mailbox`)) as any[];
}

async function wait(sessionID: string, body: Record<string, unknown>) {
	const res = await fetch(`${d.base}/session/${sessionID}/agents/wait`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(700_000) });
	return res.json() as Promise<any>;
}

/** the mail records in a session's transcript, oldest first */
async function mailIn(id: string) {
	const msgs = (await d.api(`/session/${id}/message`)) as any[];
	return msgs.filter((m) => m.info.mail).map((m) => ({ from: m.info.mail.from as string, kind: m.info.mail.kind as string, text: m.parts[0]?.text as string, id: m.info.id as string }));
}

async function messages(id: string) {
	return (await d.api(`/session/${id}/message`)) as any[];
}

/** a child parked and its report reached the parent's transcript, and the parent settled */
async function settled(parentID: string, rootID: string, path: string, timeout = T) {
	await stateIs(rootID, path, "parked", timeout);
	await d.until(async () => (await mailIn(parentID)).some((m) => m.from === path && m.kind === "report"), `report from ${path}`, timeout);
	await d.idle(parentID, timeout);
	await d.until(async () => !(await mailbox(parentID)).some((m) => m.wake), `${parentID} took its mail`, timeout);
	await d.idle(parentID, timeout);
}

async function reportFrom(parentID: string, path: string, timeout = T): Promise<string> {
	const m = await d.until(async () => (await mailIn(parentID)).filter((x) => x.from === path && x.kind === "report").at(-1), `report from ${path}`, timeout);
	return m.text;
}

function event(type: string, pred: (p: any) => boolean = () => true) {
	return frames.find((f) => f.payload.type === type && pred(f.payload.properties))?.payload.properties;
}

async function eventually(type: string, pred: (p: any) => boolean = () => true, timeout = T) {
	return d.until(async () => event(type, pred), type, timeout);
}

const names = (agents: any[]) => agents.filter((a) => a.state !== "closed").map((a) => a.path).sort();

// ---------- the cmx invariants ----------

liveDescribe("cmx invariants", () => {
	test.concurrent("multi-root-isolation", async () => {
		const [A, B] = await Promise.all([root("iso-a"), root("iso-b")]);
		const [ca, cb] = await Promise.all([spawn(A.id, { name: "worker_a", brief: quick("ready") }), spawn(B.id, { name: "worker_a", brief: quick("ready") })]);
		expect(ca.id).not.toBe(cb.id);
		await Promise.all([settled(A.id, A.id, "/root/worker_a"), settled(B.id, B.id, "/root/worker_a")]);
		expect(names(await roster(A.id))).toEqual(["/root", "/root/worker_a"]);
		expect(names(await roster(B.id))).toEqual(["/root", "/root/worker_a"]);
		expect((await msg(A.id, { to: "/root/worker_a", body: "for A only", wake: false })).status).toBe(202);
		expect((await mailbox(ca.id)).map((m) => m.body)).toEqual(["for A only"]);
		expect(await mailbox(cb.id)).toEqual([]);
		await d.api(`/session/${A.id}/agents/close`, { target: "/root/worker_a" });
		const closed = (await roster(A.id)).find((a) => a.path === "/root/worker_a");
		expect(closed.state).toBe("closed");
		expect(closed.cause).toBe("closed");
		expect((await roster(B.id)).find((a) => a.path === "/root/worker_a").state).toBe("parked");
	}, T);

	test.concurrent("child-completion-wakes-parent", async () => {
		const R = await root("wake");
		const c = await spawn(R.id, { name: "task_a", brief: quick("task a done: 7") });
		await d.until(async () => {
			const ms = await messages(R.id);
			const i = ms.findIndex((m) => m.info.mail?.from === "/root/task_a");
			return i >= 0 && ms.slice(i + 1).some((m) => m.info.role === "assistant");
		}, "root woke on the report", T);
		expect(event("session.status", (p) => p.sessionID === R.id && p.status.type === "busy")).toBeDefined();
		expect(c.path).toBe("/root/task_a");
	}, T);

	test.concurrent("child-completion-notification-body-shape", async () => {
		const R = await root("shape");
		const c = await spawn(R.id, { name: "task_b", brief: quick("done.") });
		const text = await reportFrom(R.id, "/root/task_b");
		expect(text.startsWith("warning: no deliverable")).toBe(true);
		expect(text).toContain("agent /root/task_b reached status: parked");
		expect(text).toContain(`[child session: ${c.id};`);
		const mail = (await mailIn(R.id)).find((m) => m.from === "/root/task_b")!;
		expect(mail.kind).toBe("report");
	}, T);

	test.concurrent("cross-root-send-rejection", async () => {
		const [A, B] = await Promise.all([root("xroot-a"), root("xroot-b")]);
		await spawn(A.id, { name: "worker_a", brief: quick("a") });
		const cb = await spawn(B.id, { name: "worker_a", brief: quick("b") });
		await settled(B.id, B.id, "/root/worker_a");
		const res = await msg(A.id, { to: cb.id, body: "cross-root attempt", wake: true });
		expect(res.status).toBe(404);
		expect((await res.json()).name).toBe("AgentNotFoundError");
		expect(await mailbox(cb.id)).toEqual([]);
	}, T);

	test.concurrent("session-deletion-cleanup", async () => {
		const [A, B] = await Promise.all([root("del-a"), root("del-b")]);
		await spawn(A.id, { name: "worker_a", brief: slow(60) });
		await spawn(B.id, { name: "worker_b", brief: quick("alive") });
		await stateIs(A.id, "/root/worker_a", "working");
		await d.api(`/session/${A.id}`, undefined, "DELETE");
		const a = (await roster(A.id)).find((x) => x.path === "/root/worker_a");
		expect(a.state).toBe("closed");
		expect(a.cause).toBe("session_ended");
		expect(names(await roster(A.id))).toEqual(["/root"]);
		expect(names(await roster(B.id))).toEqual(["/root", "/root/worker_b"]);
	}, T);

	test.concurrent("parent-close-cascades-to-children", async () => {
		const R = await root("cascade");
		const a = await spawn(R.id, { name: "worker_a", brief: quick("a ready") });
		await settled(R.id, R.id, "/root/worker_a");
		await spawn(a.id, { name: "worker_b", brief: quick("b ready") });
		await settled(a.id, R.id, "/root/worker_a/worker_b");
		expect(names(await roster(R.id))).toEqual(["/root", "/root/worker_a", "/root/worker_a/worker_b"]);
		const first = await d.api(`/session/${R.id}/agents/close`, { target: "/root/worker_a" });
		expect(first.previous_state).not.toBe("closed");
		expect(first.closed).toEqual(["/root/worker_a/worker_b", "/root/worker_a"]);
		const second = await d.api(`/session/${R.id}/agents/close`, { target: "/root/worker_a" });
		expect(second.already_terminated).toBe(true);
		const after = await roster(R.id);
		expect(after.find((x) => x.path === "/root/worker_a").state).toBe("closed");
		expect(after.find((x) => x.path === "/root/worker_a/worker_b").state).toBe("closed");
		expect(after.map((x) => x.path)).toContain("/root");
	}, T);

	test.concurrent("child-fiber-interrupt-during-wait", async () => {
		const R = await root("closewait");
		await spawn(R.id, { name: "longrun", brief: slow(60) });
		await stateIs(R.id, "/root/longrun", "working");
		setTimeout(() => void d.api(`/session/${R.id}/agents/close`, { target: "/root/longrun" }), 500);
		const t0 = Date.now();
		const w = await wait(R.id, { timeout_ms: 3000 });
		expect(w.timed_out).toBe(true);
		expect(Date.now() - t0).toBeGreaterThan(2900);
		expect(await mailbox(R.id)).toEqual([]);
	}, T);

	test.concurrent("child-report-wakes-parent-wait (replaces self-close-wakes-parent-wait)", async () => {
		const R = await root("reportwait");
		await spawn(R.id, { name: "finisher", brief: quick("finished: 3") });
		const t0 = Date.now();
		const w = await wait(R.id, { timeout_ms: 120_000 });
		expect(w.timed_out).toBe(false);
		expect(Date.now() - t0).toBeLessThan(120_000);
		expect(w.items[0].from).toBe("/root/finisher");
		expect(w.items[0].kind).toBe("report");
		expect(await reportFrom(R.id, "/root/finisher")).toContain("reached status: parked");
	}, T);

	test.concurrent("sibling-close-notifies-parent", async () => {
		const R = await root("sibclose");
		const a = await spawn(R.id, { name: "a", brief: quick("a") });
		await spawn(R.id, { name: "b", brief: quick("b") });
		await Promise.all([settled(R.id, R.id, "/root/a"), settled(R.id, R.id, "/root/b")]);
		await d.api(`/session/${a.id}/agents/close`, { target: "/root/b" });
		const box = await mailbox(R.id);
		expect(box).toHaveLength(1);
		expect(box[0].body).toContain("reached status: closed (closed by /root/a)");
		expect(box[0].from).toBe("/root/b");
		expect((await entry(R.id, "/root/a")).state).toBe("parked");
	}, T);

	test.concurrent("mailbox-drain-at-runloop-boundary-with-concurrent-sends", async () => {
		const R = await root("drain");
		const w = await spawn(R.id, { name: "worker", brief: quick("seeded") });
		await settled(R.id, R.id, "/root/worker");
		const sends = await Promise.all(Array.from({ length: 10 }, (_, i) => msg(R.id, { to: "/root/worker", body: `msg-${i}`, wake: false })));
		expect(sends.every((r) => r.status === 202)).toBe(true);
		const box = (await mailbox(w.id)).map((m) => m.body).sort();
		expect(box).toEqual(Array.from({ length: 10 }, (_, i) => `msg-${i}`).sort());
		await msg(R.id, { to: "/root/worker", body: quick("drained"), wake: true });
		await d.until(async () => (await mailbox(w.id)).length === 0, "worker mailbox drained", T);
		const got = (await mailIn(w.id)).map((m) => m.text).filter((t) => t.startsWith("msg-"));
		expect(got.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `msg-${i}`).sort());
		expect(new Set(got).size).toBe(10);
	}, T);

	test.concurrent("pty-cleanup-on-parent-abort (processes reaped when an agent is closed)", async () => {
		const R = await root("reap");
		const tag = `it-reap-${N}`;
		await spawn(R.id, { name: "exec", brief: `start the command \`sleep 300 # ${tag}\` as a background job (shell tool with background: true), then reply with exactly: started` });
		await settled(R.id, R.id, "/root/exec");
		const child = (await entry(R.id, "/root/exec")).id;
		const jobs = (await d.api(`/session/${child}/procs`)).filter((p: any) => p.status === "running");
		expect(jobs.length).toBeGreaterThan(0);
		const pids = jobs.map((p: any) => p.pid);
		expect(pids.every((pid: number) => (Bun.spawnSync(["ps", "-p", String(pid)]).exitCode === 0))).toBe(true);
		await d.api(`/session/${R.id}/agents/close`, { target: "/root/exec" });
		await d.until(async () => pids.every((pid: number) => Bun.spawnSync(["ps", "-p", String(pid)]).exitCode !== 0), "job reaped", 20_000);
		expect((await d.api(`/session/${child}/procs`)).filter((p: any) => p.status === "running")).toEqual([]);
	}, T);

	test.concurrent("roots-without-agents-unaffected (replaces legacy-task-tool-coexists-with-v2)", async () => {
		const [A, B] = await Promise.all([root("plain-a"), root("plain-b")]);
		await spawn(A.id, { name: "audit", brief: quick("found foo") });
		await settled(A.id, A.id, "/root/audit");
		expect((await d.api(`/session/${A.id}/children`)).map((s: any) => s.parentID)).toEqual([A.id]);
		expect(names(await roster(B.id))).toEqual(["/root"]);
		expect(await d.api(`/session/${B.id}/children`)).toEqual([]);
	}, T);
});

liveDescribe("actor discipline (INV-D)", () => {
	test.concurrent("INV-D-01-extractor-returns-text-from-finish-tool-calls", async () => {
		const R = await root("d01");
		await spawn(R.id, { name: "tc", brief: "in one reply, write the sentence 'This is my deliverable.' and in that same reply call the read tool on src/answer.ts. after the read result comes back, reply with exactly: done." });
		expect(await reportFrom(R.id, "/root/tc")).toContain("This is my deliverable.");
	}, T);

	test.concurrent("INV-D-02-explicit-send-message-delivers-and-completion-notifies", async () => {
		const R = await root("d02");
		await spawn(R.id, { name: "explicit", brief: "use the message tool to send your parent (to: parent) exactly this body: Explicit deliverable. then end your turn by replying with exactly: done." });
		const report = await reportFrom(R.id, "/root/explicit");
		const mine = (await mailIn(R.id)).filter((m) => m.from === "/root/explicit");
		expect(mine.length).toBeGreaterThanOrEqual(2);
		expect(mine[0]!.kind).toBe("message");
		expect(mine[0]!.text).toContain("Explicit deliverable");
		expect(report).toContain("reached status: parked");
		expect(report.startsWith("warning")).toBe(false);
	}, T);

	test.concurrent("INV-D-03-safety-net-warning-when-deliverable-missing", async () => {
		const R = await root("d03");
		await spawn(R.id, { name: "silent", brief: quick("never runs") });
		const text = await reportFrom(R.id, "/root/silent");
		expect(text.startsWith("warning: no deliverable")).toBe(true);
		expect(text).toContain("reached status: failed");
		expect(text).toContain("<no text emitted>");
		expect(text).toContain("injected fault");
	}, T);

	test.concurrent("INV-D-04 done-is-parked (replaces agent-close-without-target-resolves-to-caller)", async () => {
		const R = await root("d04");
		const c = await spawn(R.id, { name: "abc", brief: quick("first") });
		await settled(R.id, R.id, "/root/abc");
		expect((await entry(R.id, "/root/abc")).state).toBe("parked");
		await msg(R.id, { to: c.id, body: quick(`again-${N}`) });
		await d.until(async () => (await mailIn(R.id)).filter((m) => m.from === "/root/abc" && m.kind === "report").length >= 2, "second report", T);
		expect(await reportFrom(R.id, "/root/abc")).toContain(`again-${N}`);
	}, T);

	test.concurrent("INV-D-05-subagent-prompt-contains-canonical-path (in the first message; siblings share the prefix)", async () => {
		const R = await root("d05");
		const [a, b] = await Promise.all([spawn(R.id, { name: "canon_one", brief: quick("a") }), spawn(R.id, { name: "canon_two", brief: quick("b") })]);
		await Promise.all([settled(R.id, R.id, "/root/canon_one"), settled(R.id, R.id, "/root/canon_two")]);
		const first = (await mailIn(a.id))[0]!;
		expect(first.text).toContain("you are /root/canon_one");
		expect(first.text).toContain(`started by /root (session ${R.id})`);
		const [pa, pb] = await Promise.all([d.api(`/session/${a.id}/prefix`), d.api(`/session/${b.id}/prefix`)]);
		expect(pa.bytes).not.toContain("canon_one");
		expect(pa.bytes).not.toContain(a.id);
		expect(pa.hash).toBe(pb.hash);
	}, T);

	test.concurrent("INV-D-07-close-agent-distinguishes-already-terminated-from-path-invalid", async () => {
		const R = await root("d07");
		await spawn(R.id, { name: "child_a", brief: quick("a") });
		await settled(R.id, R.id, "/root/child_a");
		await d.api(`/session/${R.id}/agents/close`, { target: "/root/child_a" });
		const again = await d.api(`/session/${R.id}/agents/close`, { target: "/root/child_a" });
		expect(again.already_terminated).toBe(true);
		expect(again.previous_state).toBe("closed");
		const bad = await d.raw(`/session/${R.id}/agents/close`, { target: "/root/nonexistent" });
		expect(bad.status).toBe(404);
		expect((await bad.json()).name).toBe("AgentNotFoundError");
	}, T);

	test.concurrent("INV-D-06-send-message-is-unicast-not-broadcast", async () => {
		const R = await root("d06");
		const [alice, bob] = await Promise.all([spawn(R.id, { name: "alice", brief: quick("alice") }), spawn(R.id, { name: "bob", brief: quick("bob") })]);
		await Promise.all([settled(R.id, R.id, "/root/alice"), settled(R.id, R.id, "/root/bob")]);
		await msg(R.id, { to: "alice", body: "for alice only", wake: false });
		expect((await mailbox(alice.id)).map((m) => m.body)).toEqual(["for alice only"]);
		expect(await mailbox(bob.id)).toEqual([]);
	}, T);

	test.concurrent("INV-D-08-coordinator-fan-out-delivers-single-consolidated-message", async () => {
		const R = await root("d08");
		const coord = await spawn(R.id, { name: "coordinator", brief: quick("coordinating") });
		await settled(R.id, R.id, "/root/coordinator");
		const [ga, gb] = await Promise.all([spawn(coord.id, { name: "gc_a", brief: quick("a ready") }), spawn(coord.id, { name: "gc_b", brief: quick("b ready") })]);
		await Promise.all([settled(coord.id, R.id, "/root/coordinator/gc_a"), settled(coord.id, R.id, "/root/coordinator/gc_b")]);
		await settled(R.id, R.id, "/root/coordinator").catch(() => {});
		await d.idle(R.id);
		await msg(ga.id, { to: "parent", body: "finding-a", wake: false });
		await msg(gb.id, { to: "parent", body: "finding-b", wake: false });
		await d.api(`/session/${coord.id}/agents/close`, { target: "gc_a" });
		await d.api(`/session/${coord.id}/agents/close`, { target: "gc_b" });
		const findings = (await mailbox(coord.id)).map((m) => m.body).sort();
		expect(findings).toEqual(["finding-a", "finding-b"]);
		await msg(coord.id, { to: "parent", body: `integrated: ${findings.join(" + ")}`, wake: false });
		await d.api(`/session/${R.id}/agents/close`, { target: "/root/coordinator" });
		const box = await mailbox(R.id);
		expect(box).toHaveLength(1);
		expect(box[0].from).toBe("/root/coordinator");
		expect(box[0].body).toContain("finding-a");
		expect(box[0].body).toContain("finding-b");
	}, T);

	test.concurrent("INV-D-01-regression-ses_1c2e8d84affe", async () => {
		const R = await root("d01r");
		await spawn(R.id, { name: "cidoo_repro", brief: "write a reply whose text is the phrase FULL REPORT BODY repeated 30 times, and in that same reply call the read tool on src/answer.ts. after the read result comes back, reply with exactly: Done." });
		const text = await reportFrom(R.id, "/root/cidoo_repro");
		expect(text).toContain("FULL REPORT BODY");
		expect((await mailIn(R.id)).filter((m) => m.from === "/root/cidoo_repro" && m.kind === "report")).toHaveLength(1);
	}, T);

	test.concurrent("INV-D-06-regression-ses_1d84f236bffe", async () => {
		const R = await root("d06r");
		const [p, df] = await Promise.all([spawn(R.id, { name: "prosecutor", brief: quick("ready") }), spawn(R.id, { name: "defense", brief: quick("ready") })]);
		await Promise.all([settled(R.id, R.id, "/root/prosecutor"), settled(R.id, R.id, "/root/defense")]);
		await msg(p.id, { to: "/root", body: "prosecutor opening", wake: false });
		await msg(df.id, { to: "/root", body: "defense opening", wake: false });
		expect((await mailbox(R.id)).map((m) => m.body).sort()).toEqual(["defense opening", "prosecutor opening"]);
		expect(await mailbox(p.id)).toEqual([]);
		expect(await mailbox(df.id)).toEqual([]);
	}, T);

	test.concurrent("INV-D-09-correlation-id-pairs-reply-to-request", async () => {
		const R = await root("d09");
		const c = await spawn(R.id, { name: "replier", brief: quick("init") });
		await settled(R.id, R.id, "/root/replier");
		await msg(c.id, { to: "parent", body: "the reply body", correlation_id: "req-1", wake: false });
		const w = await wait(R.id, { correlation_id: "req-1", timeout_ms: 5000 });
		expect(w.timed_out).toBe(false);
		expect(w.items[0].body).toBe("the reply body");
		expect(w.items[0].correlation_id).toBe("req-1");
		const again = await wait(R.id, { correlation_id: "req-1", timeout_ms: 5000 });
		expect(again.items[0].body).toBe("the reply body");
	}, T);

	test.concurrent("INV-D-10-wait-for-reply-times-out-without-matching-correlation", async () => {
		const R = await root("d10");
		const c = await spawn(R.id, { name: "noisy", brief: quick("init") });
		await settled(R.id, R.id, "/root/noisy");
		setTimeout(() => void msg(c.id, { to: "parent", body: "unrelated traffic", correlation_id: "other", wake: false }), 500);
		const t0 = Date.now();
		const w = await wait(R.id, { correlation_id: "req-1", timeout_ms: 3000 });
		const elapsed = Date.now() - t0;
		expect(w.timed_out).toBe(true);
		expect(elapsed).toBeGreaterThan(2900);
		expect(elapsed).toBeLessThan(6000);
		expect((await mailbox(R.id)).find((m) => m.correlation_id === "other")).toBeDefined();
	}, T);

	test.concurrent("INV-D-11-missing-timeout-on-wait-emits-warning", async () => {
		const R = await root("d11");
		const [c1, c2] = await Promise.all([spawn(R.id, { name: "warned", brief: quick("w1") }), spawn(R.id, { name: "warned2", brief: quick("w2") })]);
		await Promise.all([settled(R.id, R.id, "/root/warned"), settled(R.id, R.id, "/root/warned2")]);
		await msg(R.id, { to: "warned", body: "seed", wake: false });
		await msg(R.id, { to: "warned2", body: "seed", wake: false });
		const a = await wait(c1.id, {});
		expect(a.warning).toBe("missing_timeout");
		expect(a.timed_out).toBe(false);
		const b = await wait(c2.id, { timeout_ms: 1_000_000 });
		expect(b.warning).toBe("timeout_clamped");
		expect(b.timed_out).toBe(false);
	}, T);

	test.concurrent("INV-D-12-abort-reason-delivered-as-structured-payload", async () => {
		const R = await root("d12");
		const c = await spawn(R.id, { name: "aborter", brief: "reply with exactly these two lines and nothing else:\nSome preamble.\nABORT(spec_wrong): details here." });
		const text = await reportFrom(R.id, "/root/aborter");
		expect(text).toContain("ABORT(spec_wrong)");
		const e = await eventually("agent.report", (p) => p.childID === c.id);
		expect(e.abort_reason).toEqual({ reason: "spec_wrong", details: "details here." });
	}, T);

	test.concurrent("INV-D-13-orchestrator-pivots-on-abort-approach-failed", async () => {
		const R = await root("d13");
		const c = await spawn(R.id, { name: "pivot", brief: "reply with exactly these two lines and nothing else:\ntried approaches A, B, C.\nABORT(approach_failed): tried 3 attempts, recommend reset." });
		const first = await eventually("agent.report", (p) => p.childID === c.id);
		expect(first.abort_reason).toEqual({ reason: "approach_failed", details: "tried 3 attempts, recommend reset." });
		const audit: string[] = [];
		if (first.abort_reason.reason === "approach_failed") audit.push(`pivot:${first.abort_reason.reason}`);
		expect(audit).toEqual(["pivot:approach_failed"]);
		const v2 = await spawn(R.id, { name: "pivot_v2", brief: quick("pivot delivered cleanly.") });
		const second = await eventually("agent.report", (p) => p.childID === v2.id);
		expect(second.abort_reason).toBeUndefined();
		expect(await reportFrom(R.id, "/root/pivot_v2")).toContain("pivot delivered cleanly.");
	}, T);

	test.concurrent("INV-D-14-set-phrase-ladder-extended-to-all-subagent-types", async () => {
		const R = await root("d14");
		const brief = "reply with exactly these two lines and nothing else:\npreamble.\nABORT(out_of_scope): test";
		const [g, e] = await Promise.all([spawn(R.id, { name: "g14", brief }), spawn(R.id, { name: "e14", agent_type: "explore", brief })]);
		const [rg, re] = await Promise.all([eventually("agent.report", (p) => p.childID === g.id), eventually("agent.report", (p) => p.childID === e.id)]);
		expect(rg.abort_reason).toEqual({ reason: "out_of_scope", details: "test" });
		expect(re.abort_reason).toEqual({ reason: "out_of_scope", details: "test" });
	}, T);

	test.concurrent("INV-D-15-spawn-agent-with-on-failure-respawn-restarts-on-crash", async () => {
		const R = await root("d15");
		const c = await spawn(R.id, { name: "respawner", on_failure: "respawn", brief: quick(`back-${N}`) });
		const note = await d.until(async () => (await mailIn(R.id)).find((m) => m.from === "/root/respawner" && m.kind === "system"), "respawn note", T);
		expect(note.text).toContain("attempt 1/3");
		const text = await reportFrom(R.id, "/root/respawner");
		expect(text).toContain(`back-${N}`);
		const live = await entry(R.id, "/root/respawner");
		expect(live.id).not.toBe(c.id);
		expect(live.state).toBe("parked");
		expect((await roster(R.id)).find((a) => a.id === c.id).cause).toBe("respawned");
	}, T);

	test.concurrent("INV-D-16-pool-strategy-one-for-all-kills-pair-on-single-failure", async () => {
		const R = await root("d16");
		const r = await spawnRaw(R.id, { name: "pair", brief: "unused", pool: { n: 2, strategy: "one_for_all", briefs: [quick("one"), slow(90)] } });
		expect(r.status).toBe(201);
		expect(r.body.agents.map((a: any) => a.path)).toEqual(["/root/pair_1", "/root/pair_2"]);
		const report = await d.until(async () => (await mailIn(R.id)).find((m) => m.kind === "report" && m.text.startsWith("pool pair")), "pool report", T);
		expect(report.text).toContain("/root/pair_1 failed");
		expect(report.text).toContain("one_for_all closed /root/pair_2");
		const p2 = (await roster(R.id)).find((a) => a.path === "/root/pair_2");
		expect(p2.state).toBe("closed");
		expect(p2.cause).toBe("pool_failed");
	}, T);

	test.concurrent("INV-D-17-pool-strategy-one-for-one-isolates-failures", async () => {
		const R = await root("d17");
		await spawn(R.id, { name: "iso", brief: "unused", pool: { n: 3, strategy: "one_for_one", briefs: [quick("r1"), quick("r2"), quick("r3")] } });
		const report = await d.until(async () => (await mailIn(R.id)).find((m) => m.kind === "report" && m.text.startsWith("pool iso")), "pool report", T);
		expect(report.text).toContain("3 reported");
		expect(report.text).toContain("agent /root/iso_1 reached status: failed");
		expect(report.text).toContain("r2");
		expect(report.text).toContain("r3");
		const agents = await roster(R.id);
		expect(agents.find((a) => a.path === "/root/iso_2").state).toBe("parked");
		expect(agents.find((a) => a.path === "/root/iso_3").state).toBe("parked");
	}, T);

	test.concurrent("INV-D-18-spawn-pool-collect-all-aggregates-results", async () => {
		const R = await root("d18");
		const r = await spawnRaw(R.id, { name: "agg", brief: "unused", pool: { n: 3, collect: "all", briefs: [quick("result-1"), quick("result-2"), quick("result-3")] } });
		expect(r.body.agents).toHaveLength(3);
		const report = await d.until(async () => (await mailIn(R.id)).find((m) => m.kind === "report" && m.text.startsWith("pool agg")), "pool report", T);
		for (const x of ["result-1", "result-2", "result-3"]) expect(report.text).toContain(x);
		expect((await mailIn(R.id)).filter((m) => m.kind === "report")).toHaveLength(1);
	}, T);

	test.concurrent("INV-D-19-spawn-pool-collect-first-cancels-remaining", async () => {
		const R = await root("d19");
		await spawn(R.id, { name: "race", brief: "unused", pool: { n: 3, collect: "first", briefs: [quick("first_winner"), slow(90), slow(90)] } });
		const report = await d.until(async () => (await mailIn(R.id)).find((m) => m.kind === "report" && m.text.startsWith("pool race")), "pool report", T);
		expect(report.text).toContain("first_winner");
		const agents = await roster(R.id);
		for (const p of ["/root/race_2", "/root/race_3"]) {
			const a = agents.find((x) => x.path === p);
			expect(a.state).toBe("closed");
			expect(a.cause).toBe("pool_collected");
		}
		expect(agents.find((x) => x.path === "/root/race_1").state).toBe("parked");
	}, T);

	test.concurrent("INV-D-20-spawn-pool-permission-collapses-to-task (agent verbs obey permission rules)", async () => {
		const dir = join(SCRATCH, "denied");
		await gitRepo(dir, { ".cmx2/cmx2.jsonc": JSON.stringify({ permission: { spawn: "deny" } }), "a.txt": "a\n" });
		const R = await root("d20", dir);
		await d.api(`/session/${R.id}/prompt_async`, { text: "call the spawn tool right now with brief 'say hi' and a pool of 2. then tell me in one line what the tool answered." });
		await d.until(async () => (await messages(R.id)).some((m) => m.info.role === "assistant" && m.parts.some((p: any) => p.type === "tool" && p.tool === "spawn" && p.state?.status !== "running")), "spawn call answered", T);
		await d.idle(R.id);
		const call = (await messages(R.id)).flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.tool === "spawn");
		expect(JSON.stringify(call.state)).toContain("permission rule");
		expect(names(await roster(R.id))).toEqual(["/root"]);
	}, T);

	test.concurrent("INV-D-21-link-paired-death-on-either-crash (linked death is the one_for_all pool strategy)", async () => {
		const R = await root("d21");
		await spawn(R.id, { name: "link", brief: "unused", pool: { n: 2, strategy: "one_for_all", briefs: [slow(90), quick("two")] } });
		const report = await d.until(async () => (await mailIn(R.id)).find((m) => m.kind === "report" && m.text.startsWith("pool link")), "pool report", T);
		expect(report.text).toContain("/root/link_2 failed");
		expect((await roster(R.id)).find((a) => a.path === "/root/link_1").cause).toBe("pool_failed");
		await spawn(R.id, { name: "unlinked", brief: "unused", pool: { n: 2, strategy: "one_for_one", briefs: [quick("x"), slow(60)] } });
		await stateIs(R.id, "/root/unlinked_1", "parked");
		await Bun.sleep(1500);
		expect((await entry(R.id, "/root/unlinked_2")).state).not.toBe("closed");
		await d.api(`/session/${R.id}/agents/close`, { target: "/root/unlinked_2" });
	}, T);

	test.concurrent("INV-D-22-bounded-mailbox-rejects-on-overflow", async () => {
		const R = await root("d22");
		const c = await spawn(R.id, { name: "capped", mailbox_capacity: 4, brief: quick("ready") });
		await settled(R.id, R.id, "/root/capped");
		for (let i = 1; i <= 4; i++) expect((await msg(R.id, { to: "capped", body: `msg_${i}`, wake: false })).status).toBe(202);
		const fifth = await msg(R.id, { to: "capped", body: "msg_5", wake: false });
		expect(fifth.status).toBe(429);
		const body = await fifth.json();
		expect(body.name).toBe("MailboxFullError");
		expect(body.data.capacity).toBe(4);
		expect((await msg(R.id, { to: "capped", body: "msg_6", wake: false })).status).toBe(429);
		expect((await mailbox(c.id)).map((m) => m.body)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
		await d.api(`/session/${c.id}/prompt_async`, { text: quick("caught up") });
		await d.until(async () => (await mailbox(c.id)).length === 0, "drained", T);
		await d.idle(c.id);
		expect((await msg(R.id, { to: "capped", body: "msg_7", wake: false })).status).toBe(202);
	}, T);

	test.concurrent("INV-D-23-bounded-mailbox-does-not-block-completion-notification", async () => {
		const R = await root("d23");
		const f = await spawn(R.id, { name: "filler", brief: quick("ready") });
		await settled(R.id, R.id, "/root/filler");
		for (let i = 0; i < 32; i++) expect((await msg(f.id, { to: "parent", body: `fill-${i}`, wake: false })).status).toBe(202);
		const over = await msg(f.id, { to: "parent", body: "fill-over", wake: false });
		expect(over.status).toBe(429);
		await spawn(R.id, { name: "capcrash", brief: quick("never") });
		const text = await reportFrom(R.id, "/root/capcrash");
		expect(text).toContain("reached status: failed");
	}, T);

	test.concurrent("INV-D-24-agent-type-behavior-contract-validated-at-spawn", async () => {
		const R = await root("d24");
		const c = await spawn(R.id, { name: "contracted", agent_type: "general", brief: quick("done.") });
		const e = await eventually("agent.report", (p) => p.childID === c.id);
		expect(e.behavior_violation.contract_version).toBe("subagent_v1");
		expect(e.behavior_violation.violations[0].kind).toBe("missing_delivery");
		expect(await reportFrom(R.id, "/root/contracted")).toContain("reached status:");
	}, T);

	test.concurrent("INV-D-25-behavior-contract-version-bump-coexists-with-prior-version", async () => {
		const R = await root("d25");
		const [v1, v2] = await Promise.all([spawn(R.id, { name: "v1child", behavior_version: "subagent_v1", brief: quick("done.") }), spawn(R.id, { name: "v2child", behavior_version: "subagent_v2", brief: quick("done.") })]);
		const [e1, e2] = await Promise.all([eventually("agent.report", (p) => p.childID === v1.id), eventually("agent.report", (p) => p.childID === v2.id)]);
		expect(e1.behavior_violation.contract_version).toBe("subagent_v1");
		expect(e2.behavior_violation.contract_version).toBe("subagent_v2");
		expect(e1.behavior_violation.violations.map((v: any) => v.kind)).toContain("missing_delivery");
		expect(e2.behavior_violation.violations.map((v: any) => v.kind)).toContain("missing_delivery");
		expect(JSON.stringify(e1)).not.toContain("subagent_v2");
		expect(JSON.stringify(e2)).not.toContain("subagent_v1");
	}, T);

	test.concurrent("INV-D-26-behavior-contract-violation-fails-orchestrated-wave-not-spawn", async () => {
		const R = await root("d26");
		const r = await spawnRaw(R.id, { name: "violator", brief: quick("done.") });
		expect(r.status).toBe(201);
		expect(["queued", "working"]).toContain(r.body.agents[0].state);
		const e = await eventually("agent.report", (p) => p.childID === r.body.agents[0].id);
		expect(e.behavior_violation.violations.map((v: any) => v.kind)).toContain("missing_delivery");
	}, T);

	test.concurrent("INV-D-27-deliverable-arrival-and-safety-net-metrics-fire-on-completion", async () => {
		const R = await root("d27");
		const c = await spawn(R.id, { name: "mcrash", brief: quick("never") });
		const arrived = await eventually("agent.metric.deliverable_arrived", (p) => p.childID === c.id);
		expect(arrived.source).toBe("safety_net");
		expect(await eventually("agent.metric.safety_net_fired", (p) => p.childID === c.id)).toBeDefined();
		const m = await d.api(`/session/${R.id}/agents/metrics`);
		expect(m.safety_net_firing_rate).toBe(1);
		expect(m.deliverable_arrival_rate).toBe(0);
	}, T);

	test.concurrent("INV-D-28-sibling-deadlock-metric-fires-on-wait-timeout", async () => {
		const R = await root("d28");
		const w = await wait(R.id, { timeout_ms: 1000 });
		expect(w.timed_out).toBe(true);
		expect(await eventually("agent.metric.sibling_deadlock", (p) => p.sessionID === R.id)).toBeDefined();
		expect((await d.api(`/session/${R.id}/agents/metrics`)).wait_timeouts).toBe(1);
	}, T);

	test.concurrent("INV-D-29-user-abort-tombstones-victims-and-reports-them (ending a session tombstones its agents)", async () => {
		const R = await root("d29");
		await Promise.all([spawn(R.id, { name: "victim_a", brief: slow(60, "work a") }), spawn(R.id, { name: "victim_b", brief: slow(60, "work b") })]);
		await Promise.all([stateIs(R.id, "/root/victim_a", "working"), stateIs(R.id, "/root/victim_b", "working")]);
		await d.api(`/session/${R.id}`, undefined, "DELETE");
		const agents = await roster(R.id);
		for (const p of ["/root/victim_a", "/root/victim_b"]) {
			const a = agents.find((x) => x.path === p);
			expect(a.state).toBe("closed");
			expect(a.cause).toBe("session_ended");
			expect(a.previousState).toBe("working");
		}
		expect(agents.find((x) => x.path === "/root/victim_a").lastTask).toContain("work a");
	}, T);

	test.concurrent("INV-D-30-closed-agent-tombstones-with-cause-closed", async () => {
		const R = await root("d30");
		const c = await spawn(R.id, { name: "closable", brief: quick("x") });
		await settled(R.id, R.id, "/root/closable");
		await d.api(`/session/${R.id}/agents/close`, { target: c.id });
		const a = (await roster(R.id)).find((x) => x.id === c.id);
		expect(a.state).toBe("closed");
		expect(a.cause).toBe("closed");
		expect(a.closedAt).toBeGreaterThan(0);
	}, T);

	test.concurrent("INV-D-31-completion-notification-carries-child-session-id", async () => {
		const R = await root("d31");
		const c = await spawn(R.id, { name: "auditee", brief: quick("audited") });
		const text = await reportFrom(R.id, "/root/auditee");
		expect(text).toContain(`[child session: ${c.id}; transcript kept on disk`);
		expect(text).toContain("agent /root/auditee reached status: ");
	}, T);

	test.concurrent("INV-D-32-abort-leaves-children-running-and-reports-survivors", async () => {
		const R = await root("d32");
		await d.api(`/session/${R.id}/prompt_async`, { text: "run the shell command `sleep 30` with the shell tool, then reply ok" });
		await spawn(R.id, { name: "survivor", brief: slow(60) });
		await stateIs(R.id, "/root/survivor", "working");
		await d.until(async () => (await d.api("/session/status"))[R.id]?.type === "busy", "root busy", 60_000);
		await d.api(`/session/${R.id}/abort`, {});
		expect((await entry(R.id, "/root/survivor")).state).toBe("working");
		const note = await d.until(async () => (await mailbox(R.id)).find((m) => m.kind === "system"), "survivor note", 10_000);
		expect(note.body).toContain("- /root/survivor (working)");
		await d.api(`/session/${R.id}/agents/close`, { target: "/root/survivor" });
	}, T);

	test.concurrent("INV-D-33-root-targeted-send-invokes-registered-root-wake", async () => {
		const R = await root("d33");
		const c = await spawn(R.id, { name: "caller", brief: quick("ready") });
		await settled(R.id, R.id, "/root/caller");
		const before = (await messages(R.id)).filter((m) => m.info.role === "assistant").length;
		await msg(c.id, { to: "parent", body: "wake up and say hi", wake: true });
		await d.until(async () => (await messages(R.id)).filter((m) => m.info.role === "assistant").length > before, "root woke", T);
		await d.idle(R.id);
		const childTurns = (await messages(c.id)).filter((m) => m.info.role === "assistant").length;
		await msg(R.id, { to: "caller", body: "no need to act", wake: false });
		await Bun.sleep(2000);
		expect((await d.api("/session/status"))[c.id]).toBeUndefined();
		expect((await messages(c.id)).filter((m) => m.info.role === "assistant").length).toBe(childTurns);
	}, T);

	test.concurrent("INV-D-34-wait-for-reply-reports-already-delivered-after-drain", async () => {
		const R = await root("d34");
		const c = await spawn(R.id, { name: "prober", brief: quick("ready") });
		await settled(R.id, R.id, "/root/prober");
		await msg(c.id, { to: "parent", body: "probe answer", correlation_id: "probe-cid-42", wake: true });
		await d.until(async () => (await mailIn(R.id)).some((m) => m.text === "probe answer"), "reply drained into the root", T);
		const w = await wait(R.id, { correlation_id: "probe-cid-42", timeout_ms: 5000 });
		expect(w.already_delivered).toBe(true);
		expect(w.waited_ms).toBe(0);
	}, T);
});

liveDescribe("bug 3 audit (agent types)", () => {
	test.concurrent("spawn description names the general, explore and review types", async () => {
		const R = await root("audit1");
		await d.api(`/session/${R.id}/prompt`, { text: quick("hi") });
		await d.idle(R.id);
		const pre = await d.api(`/session/${R.id}/prefix`);
		expect(pre.bytes).toContain("general (default), explore (reads and searches), review (reads and runs commands, does not edit)");
	}, T);

	test.concurrent("spawn rejects agent_type 'explorer' with a typed error", async () => {
		const R = await root("audit2");
		const r = await spawnRaw(R.id, { agent_type: "explorer", brief: "x" });
		expect(r.status).toBe(400);
		expect(r.body.data.message).toContain("no agent type explorer");
	}, T);

	test.concurrent("spawn requires a brief", async () => {
		const R = await root("audit3");
		const r = await spawnRaw(R.id, {});
		expect(r.status).toBe(400);
	}, T);
});

liveDescribe("m5 primitives", () => {
	test.concurrent("interrupt-keeps-resumable", async () => {
		const R = await root("intr");
		const c = await spawn(R.id, { name: "sleeper", brief: slow(60, "slept long") });
		await stateIs(R.id, "/root/sleeper", "working");
		await Bun.sleep(3000);
		const r = await d.api(`/session/${R.id}/agents/interrupt`, { target: "sleeper" });
		expect(r.interrupted).toBe(true);
		const st = await stateIs(R.id, "/root/sleeper", "interrupted", 30_000);
		expect(st.cause).toBe("interrupted");
		await Bun.sleep(2000);
		expect((await mailIn(R.id)).filter((m) => m.from === "/root/sleeper")).toEqual([]);
		await msg(R.id, { to: "sleeper", body: quick(`resumed-${N}`) });
		expect(await reportFrom(R.id, "/root/sleeper")).toContain(`resumed-${N}`);
		expect((await mailIn(c.id))[0]!.text).toContain("sleep 60");
	}, T);

	test.concurrent("non-root-wake", async () => {
		const R = await root("nonroot");
		const coord = await spawn(R.id, { name: "coord", brief: quick("ready") });
		await settled(R.id, R.id, "/root/coord");
		const before = (await messages(coord.id)).filter((m) => m.info.role === "assistant").length;
		await spawn(coord.id, { name: "gc", brief: quick(`gc-done-${N}`) });
		await d.until(async () => {
			const ms = await messages(coord.id);
			const i = ms.findIndex((m) => m.info.mail?.from === "/root/coord/gc");
			return i >= 0 && ms.slice(i + 1).some((m) => m.info.role === "assistant");
		}, "coordinator woke on its child's report", T);
		expect((await messages(coord.id)).filter((m) => m.info.role === "assistant").length).toBeGreaterThan(before);
		expect(event("agent.updated", (p) => p.agent?.id === coord.id && p.agent.state === "working" && p.agent.updatedAt > 0)).toBeDefined();
	}, T);

	test.concurrent("bounded-extraction", async () => {
		const R = await root("bounded");
		const c = await spawn(R.id, { name: "reporter", brief: "reply with the word LONGBODY written 50 times on one line, and nothing else" });
		await settled(R.id, R.id, "/root/reporter");
		expect(await reportFrom(R.id, "/root/reporter")).toContain("LONGBODY");
		await msg(R.id, { to: c.id, body: quick(`ok-${N}.`) });
		await d.until(async () => (await mailIn(R.id)).filter((m) => m.from === "/root/reporter" && m.kind === "report").length >= 2, "second report", T);
		const second = await reportFrom(R.id, "/root/reporter");
		expect(second).toContain(`ok-${N}.`);
		expect(second).not.toContain("LONGBODY");
	}, T);
});

liveDescribe("m5 primitives that change the daemon's routing (serial)", () => {
	test("caps-count-running-turns", async () => {
		routing({ caps: { running_turns: 3, depth: 3, budget_tokens: null } });
		const R = await root("caps");
		await spawn(R.id, { name: "cap", brief: "unused", pool: { n: 4, briefs: [1, 2, 3, 4].map((i) => slow(8, `done-${i}`)) } });
		let maxWorking = 0;
		let sawQueued = false;
		const t0 = Date.now();
		for (;;) {
			const agents = (await roster(R.id)).filter((a) => a.depth === 1);
			maxWorking = Math.max(maxWorking, agents.filter((a) => a.state === "working").length);
			sawQueued ||= agents.some((a) => a.state === "queued");
			if (agents.length === 4 && agents.every((a) => a.state === "parked")) break;
			if (Date.now() - t0 > T - 20_000) throw new Error(`pool did not finish: ${agents.map((a) => `${a.path}:${a.state}`).join(" ")}`);
			await Bun.sleep(250);
		}
		console.log(`caps: running_turns 3 (2 child slots), pool of 4: max working at once ${maxWorking}, queued seen ${sawQueued}`);
		expect(maxWorking).toBeLessThanOrEqual(2);
		expect(sawQueued).toBe(true);
		// four parked agents do not count: two more start at once
		await Promise.all([spawn(R.id, { name: "extra_a", brief: slow(6, "a") }), spawn(R.id, { name: "extra_b", brief: slow(6, "b") })]);
		await d.until(async () => (await roster(R.id)).filter((a) => a.name.startsWith("extra_") && a.state === "working").length === 2, "both extras working at once", 60_000);
		routing();
	}, T);

	test("depth-limit-typed-error", async () => {
		const R = await root("depth");
		const d1 = await spawn(R.id, { name: "d1", brief: quick("1") });
		const d2 = await spawn(d1.id, { name: "d2", brief: quick("2") });
		const d3 = await spawn(d2.id, { name: "d3", brief: quick("3") });
		const r = await spawnRaw(d3.id, { name: "d4", brief: quick("4") });
		expect(r.status).toBe(400);
		expect(r.body.name).toBe("AgentDepthExceededError");
		expect(r.body.data.depth).toBe(4);
		expect(r.body.data.max).toBe(3);
	}, T);

	test("budget-typed-error-and-partial-report", async () => {
		// siblings of a seat share a cached prefix, so a child's turn can cost little; a budget of 1 is spent by any turn
		routing({ caps: { running_turns: 4, depth: 3, budget_tokens: 1 } });
		const R = await root("budget");
		await spawn(R.id, { name: "b1", brief: slow(5, "spent") });
		// the tree's budget runs out during b1's own turn: it stops with a partial report
		const partial = await reportFrom(R.id, "/root/b1");
		expect(partial).toContain("reached status: partial");
		expect(partial).toContain("stopped at its token budget (1 tokens)");
		const r = await spawnRaw(R.id, { name: "b2", brief: quick("never") });
		expect(r.status).toBe(409);
		expect(r.body.name).toBe("BudgetExceededError");
		expect(r.body.data.budget).toBe(1);
		routing();
		const R2 = await root("dispatch-budget");
		await spawn(R2.id, { name: "thrifty", budget_tokens: 50, brief: "read src/answer.ts, then read README.md, then run `ls` in the shell, then run `git log --oneline` in the shell, then reply with a summary" });
		const text = await reportFrom(R2.id, "/root/thrifty");
		expect(text).toContain("reached status: partial");
		expect(text).toContain("stopped at its token budget (50 tokens)");
		expect((await entry(R2.id, "/root/thrifty")).state).toBe("interrupted");
	}, T);

	test("routing-hot-reload-changes-the-next-spawn", async () => {
		const R = await root("hot");
		const a = await spawn(R.id, { name: "before", brief: quick("a") });
		expect(a.effort).toBe("low");
		routing({}, "medium");
		const b = await spawn(R.id, { name: "after", brief: quick("b") });
		expect(b.effort).toBe("medium");
		routing();
		await Promise.all([settled(R.id, R.id, "/root/before"), settled(R.id, R.id, "/root/after")]);
	}, T);

	test("steer-lands-mid-turn", async () => {
		const R = await root("steer");
		await d.api(`/session/${R.id}/prompt_async`, { text: "run the shell command `sleep 8` with the shell tool. after it finishes, tell me the codeword from my most recent message, or say none if there is no codeword." });
		await d.until(async () => (await messages(R.id)).some((m) => m.parts.some((p: any) => p.type === "tool" && p.tool === "shell" && p.state?.status === "running")), "shell running", 60_000);
		const s = await d.api(`/session/${R.id}/steer`, { text: `the codeword is kiwi-${N}` });
		expect(s.result).toBe("steered");
		await d.idle(R.id);
		const requests = await d.api(`/session/${R.id}/requests`);
		expect(requests.some((r: any) => r.tail.some((t: any) => t.text.includes(`kiwi-${N}`)))).toBe(true);
		const steps = await d.api(`/session/${R.id}/steps`);
		expect(steps.some((x: any) => x.steered === 1)).toBe(true);
		expect(steps.every((x: any) => x.stop_reason !== "aborted")).toBe(true);
		const last = (await messages(R.id)).filter((m) => m.info.role === "assistant").at(-1);
		expect(JSON.stringify(last.parts)).toContain(`kiwi-${N}`);
		// queue waits for the turn: it lands after the running turn's last message, never inside it
		await d.api(`/session/${R.id}/prompt_async`, { text: "run the shell command `sleep 4`, then reply with exactly: first" });
		await d.until(async () => (await d.api("/session/status"))[R.id]?.type === "busy", "busy", 30_000);
		await d.api(`/session/${R.id}/queue`, { text: quick(`queued-${N}`) });
		await d.idle(R.id);
		await d.until(async () => (await messages(R.id)).some((m) => m.info.role === "assistant" && JSON.stringify(m.parts).includes(`queued-${N}`)), "queued turn answered", T);
		const ms = await messages(R.id);
		const firstAt = ms.findIndex((m) => m.info.role === "assistant" && JSON.stringify(m.parts).includes('"first'));
		const queuedAt = ms.findIndex((m) => m.info.role === "user" && JSON.stringify(m.parts).includes(`queued-${N}`));
		expect(firstAt).toBeGreaterThan(-1);
		expect(queuedAt).toBeGreaterThan(firstAt);
	}, T);

	test("parked-revive-after-daemon-restart", async () => {
		const R = await root("revive");
		const c = await spawn(R.id, { name: "memo", brief: `remember the codeword zebra-${N}. reply with exactly: noted` });
		await settled(R.id, R.id, "/root/memo");
		const pidBefore = d.pid;
		await d.stop();
		await startDaemon();
		console.log(`revive: daemon restarted (pid ${pidBefore} -> ${d.pid})`);
		expect((await entry(R.id, "/root/memo")).state).toBe("parked");
		await msg(R.id, { to: "/root/memo", body: "what was the codeword i gave you? reply with only the codeword." });
		const text = await d.until(async () => {
			const r = (await mailIn(R.id)).filter((m) => m.from === "/root/memo" && m.kind === "report");
			return r.length >= 2 ? r.at(-1)!.text : undefined;
		}, "report after revive", T);
		console.log(`revive: report after restart: ${text.split("\n").slice(0, 3).join(" | ")}`);
		expect(text).toContain(`zebra-${N}`);
		expect(await eventually("session.resumed", (p) => p.sessionID === c.id)).toBeDefined();
		expect((await entry(R.id, "/root/memo")).id).toBe(c.id);
	}, T);
});

liveDescribe("the model table (R6, R7)", () => {
	test.concurrent("a spawn without a model is a 400 naming the aliases", async () => {
		const R = await root("nomodel");
		const res = await d.raw(`/session/${R.id}/agents`, { brief: "x" });
		const body: any = await res.json();
		expect(res.status).toBe(400);
		expect(body.name).toBe("BadRequestError");
		expect(body.data.message).toContain("a spawn needs a model: one of haiku, sonnet, opus, fable, test");
	}, T);

	test.concurrent("an unknown alias is an UnknownModelError, and haiku at xhigh is refused with the efforts it runs at", async () => {
		const R = await root("badmodel");
		const unknown = await spawnRaw(R.id, { model: "janitor", brief: "x" });
		expect(unknown.status).toBe(400);
		expect(unknown.body.name).toBe("UnknownModelError");
		expect(unknown.body.data.message).toContain("no model named janitor in routing.jsonc; the models are haiku, sonnet, opus, fable, test");
		const haiku = await spawnRaw(R.id, { model: "haiku", effort: "xhigh", brief: "x" });
		expect(haiku.status).toBe(400);
		expect(haiku.body.name).toBe("EffortNotAllowedError");
		expect(haiku.body.data.message).toContain("claude-haiku-5-5 never runs at xhigh; it runs at low, medium, high");
	}, T);

	test.concurrent("a rest spawn that sends seat is a SeatsRemovedError", async () => {
		const R = await root("seat");
		const res = await spawnRaw(R.id, { seat: "scout", brief: "x" });
		expect(res.status).toBe(400);
		expect(res.body.name).toBe("SeatsRemovedError");
		expect(res.body.data.message).toContain("seats are gone; name a model from routing.jsonc (haiku, sonnet, opus, fable, test)");
	}, T);

	test.concurrent("a provider/model-id still spawns over rest, labelled by the first alias that names the model", async () => {
		const R = await root("ref");
		const c = await spawn(R.id, { model: MODEL, name: "byref", brief: quick(`ref-${N}`) });
		expect(c.seat).toBe("sonnet");
		expect(c.model).toBe(MODEL);
		// no effort named: the default of the alias that names the model
		expect(c.effort).toBe("high");
		await settled(R.id, R.id, "/root/byref");
		const kids = (await d.api(`/session/${R.id}/children`)) as any[];
		expect(kids.map((k) => k.title)).toEqual(["byref (sonnet)"]);
	}, T);

	test.concurrent("after carries the earlier brief and report, writes a retry or step_up metric", async () => {
		const R = await root("after");
		const first = await spawn(R.id, { name: "memo", brief: quick(`first-${N}`) });
		await settled(R.id, R.id, "/root/memo");
		const nope = await spawnRaw(R.id, { name: "bad", after: "ses_nope", brief: "x" });
		expect(nope.status).toBe(400);
		expect(nope.body.data.message).toContain("after names ses_nope, which is not one of your agents");
		const second = await spawn(R.id, { name: "again", after: first.id, brief: quick(`second-${N}`) });
		await settled(R.id, R.id, "/root/again");
		const task = (await mailIn(second.id))[0]!.text;
		expect(task).toContain("an earlier attempt at this task, by /root/memo on anthropic/claude-sonnet-5-5 at low effort.");
		expect(task).toContain(`its brief:\n${quick(`first-${N}`)}`);
		expect(task).toContain(`its last report:\nfirst-${N}`);
		const metrics = await d.api(`/session/${R.id}/agents/metrics`);
		// the same model at the same effort is a retry
		const step = metrics.events.find((e: any) => e.kind === "retry" && e.from_id === first.id);
		expect(step).toMatchObject({ child: second.id, from_model: MODEL, from_effort: "low", to_model: MODEL, to_effort: "low" });
		// a higher effort on the same model is a step up, and after takes a name as message does
		const res = await d.api(`/session/${R.id}/agents`, { model: "test", effort: "medium", name: "third", after: "again", brief: quick("third") });
		expect(res.agents[0].path).toBe("/root/third");
		await settled(R.id, R.id, "/root/third");
		const later = await d.api(`/session/${R.id}/agents/metrics`);
		expect(later.events.find((e: any) => e.kind === "step_up" && e.from_id === second.id)).toMatchObject({ child: res.agents[0].id, from_effort: "low", to_effort: "medium" });
	}, T);

	test.concurrent("a review child has shell and run and no edit; an explore child has neither shell nor edit", async () => {
		const R = await root("types");
		const rev = await spawn(R.id, { name: "rev", agent_type: "review", brief: quick(`rev-${N}`) });
		const exp = await spawn(R.id, { name: "exp", agent_type: "explore", brief: quick(`exp-${N}`) });
		await Promise.all([settled(R.id, R.id, "/root/rev"), settled(R.id, R.id, "/root/exp")]);
		const toolsOf = async (id: string) => ((await d.api(`/session/${id}/requests`)) as any[]).at(-1).tools as string[];
		const reviewTools = await toolsOf(rev.id);
		expect(reviewTools).toContain("shell");
		expect(reviewTools).toContain("run");
		expect(reviewTools).not.toContain("edit");
		expect(reviewTools).not.toContain("write");
		expect(reviewTools).not.toContain("worktree_create");
		const exploreTools = await toolsOf(exp.id);
		expect(exploreTools).not.toContain("shell");
		expect(exploreTools).not.toContain("edit");
		expect(exploreTools).toContain("read");
		const pre = await d.api(`/session/${rev.id}/prefix`);
		expect(pre.bytes).toContain("your tools read, search and run commands; you do not change files.");
		expect(pre.bytes).not.toContain("seat");
	}, T);
});

liveDescribe("the model table, serial (R7)", () => {
	test("an explore child declares the same tools after a daemon restart as it did fresh", async () => {
		const R = await root("exploreagain");
		const c = await spawn(R.id, { name: "reader", agent_type: "explore", brief: quick(`before-${N}`) });
		await settled(R.id, R.id, "/root/reader");
		const toolsOf = async (id: string) => ((await d.api(`/session/${id}/requests`)) as any[]).at(-1).tools as string[];
		const fresh = await toolsOf(c.id);
		await d.stop();
		await startDaemon();
		await msg(R.id, { to: "/root/reader", body: quick(`after-${N}`) });
		await d.until(async () => (await mailIn(R.id)).filter((m) => m.from === "/root/reader" && m.kind === "report").length >= 2, "report after restart", T);
		const reopened = await toolsOf(c.id);
		console.log(`explore tools fresh: ${fresh.join(",")}\nexplore tools reopened: ${reopened.join(",")}`);
		expect(reopened).toEqual(fresh);
		expect(reopened).not.toContain("shell");
	}, T);
});
