import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { serve } from "../src/index.ts";

/**
 * the boxbox compatibility gate (AGENTS.md rule 16): every request boxbox makes, with the bodies
 * boxbox sends (captured from boxbox-web's fleet store, composer, attach, mention, pane and
 * server.ts on 2026-09-30), replayed against a daemon on a real socket. a 404 on any of them fails.
 * shapes are checked where boxbox reads them.
 *
 * no model answers here: the provider points at a local socket that accepts and never replies, so a
 * turn stays busy until it is aborted (the queue, unsend and loop rows need a busy session). the
 * model path is driven for real through boxbox's ui against the dev daemon (the m3/m4 gate).
 */

// the pocket terminal test sends a non-ascii byte through a real shell; bash in the c locale (no LANG, as in a
// scrubbed ci environment) mangles it, so the shell needs a utf-8 locale whatever the host sets
if (!/utf-?8/i.test(process.env.LC_ALL || process.env.LANG || "")) {
	delete process.env.LC_ALL;
	process.env.LANG = "C.UTF-8";
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-boxbox-")));
const work = join(root, "proj");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(join(work, ".cmx2", "command"), { recursive: true });
mkdirSync(join(work, ".cmx2", "agent"), { recursive: true });
writeFileSync(join(work, "src", "app.ts"), "export const answer = 42;\n");
writeFileSync(join(work, "README.md"), "# proj\n");
writeFileSync(join(work, ".cmx2", "command", "hi.md"), "---\ndescription: say hi in one line\n---\nsay hi to $ARGUMENTS\n");
writeFileSync(join(work, ".cmx2", "agent", "scout.md"), "---\ndescription: reads and reports\nmode: subagent\n---\nread, then report.\n");

const sockets = new Set<Socket>();
let silent: Server;
let daemon: ReturnType<typeof serve>;
let base: string;
const log: string[] = [];

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
	const res = await fetch(base + path, {
		method,
		headers: { authorization: `Basic ${btoa("opencode:boxbox")}`, "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	log.push(`${method} ${path} -> ${res.status}`);
	// a route boxbox calls must exist; a 404 about a missing thing (an ask id) is an answer, not a missing route
	if (res.status === 404 && text.includes("no route for")) throw new Error(`${method} ${path} answered 404: ${text}`);
	return { status: res.status, json: text ? JSON.parse(text) : null };
}

const scoped = { "x-opencode-directory": work };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

beforeAll(async () => {
	silent = createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	const port = (silent.address() as { port: number }).port;
	const config = { ...structuredClone(DEFAULTS), worktree: { ...DEFAULTS.worktree, minFreeGB: 0, minFreeRatio: 0 }, providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "unused" } }, sources: [] };
	daemon = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(root, "data"), password: "boxbox", checkEvents: true, reload: () => config });
	base = `http://127.0.0.1:${daemon.server.port}`;
});

afterAll(async () => {
	await daemon.stop();
	for (const s of sockets) s.destroy();
	silent.close();
	console.log(`boxbox requests replayed:\n  ${log.join("\n  ")}`);
});

let sid = "";

test("threads: create, list, status, open, children, rename", async () => {
	const s = await call("POST", "/session", { title: "it-boxbox" }, scoped);
	expect(s.status).toBe(201);
	sid = s.json.id;
	expect((await call("GET", "/session?scope=project&roots=true&limit=50", undefined, scoped)).json.map((x: any) => x.id)).toContain(sid);
	expect((await call("GET", "/session/status")).json).toEqual({});
	expect((await call("GET", `/session/${sid}`)).json.directory).toBe(work);
	expect((await call("GET", `/session/${sid}/message?limit=50`)).json).toEqual([]);
	expect((await call("GET", `/session/${sid}/children`)).json).toEqual([]);
	const renamed = await call("PATCH", `/session/${sid}`, { title: "renamed from boxbox" });
	expect(renamed.json).toMatchObject({ id: sid, title: "renamed from boxbox" });
});

test("m5: a spawned child is a real session under its parent, the parent parks in session.status, the roster lists both", async () => {
	const frames: any[] = [];
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${base}/global/event`, { headers: { authorization: `Basic ${btoa("opencode:boxbox")}` }, signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
					buf = buf.slice(i + 2);
					if (line) frames.push(JSON.parse(line.slice(6)).payload);
				}
			}
		} catch {}
	})();
	await Bun.sleep(100);
	const parent = await call("POST", "/session", { title: "it-boxbox-parent" }, scoped);
	const pid = parent.json.id;
	const sp = await call("POST", `/session/${pid}/agents`, { brief: "look around src and report what is there", name: "scout", model: "sonnet" });
	expect(sp.status).toBe(201);
	const cid = sp.json.agents[0].id;
	expect(sp.json.agents[0].path).toBe("/root/scout");

	// what boxbox asks for when it opens the thread: the children (the pack), the child's thread and messages
	const kids = (await call("GET", `/session/${pid}/children`)).json;
	expect(kids.map((k: any) => [k.id, k.parentID, k.title])).toEqual([[cid, pid, "scout (sonnet)"]]);
	expect((await call("GET", `/session/${cid}`)).json.parentID).toBe(pid);
	const childMsgs = (await call("GET", `/session/${cid}/message?limit=50`)).json;
	expect(childMsgs[0].info.mail).toEqual({ kind: "task", from: "/root", fromID: pid, mailID: expect.any(String) });
	expect(childMsgs[0].parts[0].text).toContain("you are /root/scout");
	expect((await call("GET", "/session?scope=project&roots=true&limit=50", undefined, scoped)).json.map((x: any) => x.id)).not.toContain(cid);

	// the child's turn runs (this provider never answers): busy in the status map; the parent is idle and parked on it
	for (let i = 0; i < 50 && (await call("GET", "/session/status")).json[cid]?.type !== "busy"; i++) await Bun.sleep(100);
	const status = (await call("GET", "/session/status")).json;
	expect(status[cid]?.type).toBe("busy");
	expect(status[pid]).toBeUndefined();
	expect(status[cid].since).toBeGreaterThan(0);
	const withParked = (await call("GET", "/session/status?parked=true")).json;
	expect(withParked[pid]).toMatchObject({ type: "idle", parked: { agents: 1, jobs: 0 } });
	expect(withParked[pid].since).toBeGreaterThan(0);
	expect((await call("GET", `/session/${pid}`)).json.status).toMatchObject({ type: "idle", parked: { agents: 1, jobs: 0 } });
	expect(frames.find((f) => f.type === "session.status" && f.properties.sessionID === pid && f.properties.status.parked?.agents === 1)).toBeDefined();
	expect(frames.find((f) => f.type === "session.created" && f.properties.sessionID === cid)?.properties.info.parentID).toBe(pid);

	// the roster (GET /session/:id/agents): the new surface boxbox's roster will read
	const roster = (await call("GET", `/session/${pid}/agents`)).json;
	expect(roster.self).toBe("/root");
	expect(roster.agents.map((a: any) => [a.path, a.state, a.seat])).toEqual([
		["/root", "parked", "driver"],
		["/root/scout", "working", "sonnet"],
	]);
	expect((await call("GET", `/session/${cid}/agents`)).json.self).toBe("/root/scout");

	// stopping the child from its thread keeps it resumable; its spawner hears about it
	await call("POST", `/session/${cid}/abort`);
	const after = (await call("GET", `/session/${pid}/agents`)).json.agents.find((a: any) => a.id === cid);
	expect(after.state).toBe("interrupted");
	await Bun.sleep(200);
	await call("POST", `/session/${pid}/abort`);
	ctl.abort();
});

test("pickers: / commands, @ files, agents, models", async () => {
	const cmds = (await call("GET", "/command", undefined, scoped)).json;
	expect(cmds.find((c: any) => c.name === "hi")).toMatchObject({ name: "hi", description: "say hi in one line" });
	const files = (await call("GET", "/find/file?query=app&limit=50", undefined, scoped)).json;
	expect(files[0]).toBe("src/app.ts");
	const empty = (await call("GET", "/find/file?query=&limit=50", undefined, scoped)).json;
	expect(empty.every((f: unknown) => typeof f === "string")).toBe(true);
	const agents = (await call("GET", "/agent")).json;
	expect(agents[0]).toMatchObject({ name: "build", mode: "primary" });
	const scopedAgents = (await call("GET", "/agent", undefined, scoped)).json;
	expect(scopedAgents.map((a: any) => a.name)).toEqual(["build", "scout"]);
	const providers = (await call("GET", "/config/providers")).json;
	const anthropic = providers.providers.find((p: any) => p.id === "anthropic");
	const opus = anthropic.models["claude-opus-5-5"];
	expect(opus).toMatchObject({ id: "claude-opus-5-5", providerID: "anthropic", status: "active", limit: { context: 1_000_000 } });
	expect(Object.keys(opus.variants)).toContain("medium");
	expect(providers.default.anthropic).toBe("claude-opus-5-5");
});

test("send: text, a photo, an @ mention, model, variant and agent; busy queues and unsend takes it back; abort and loop", async () => {
	// the composer's send: fire, keep the promise, never read the body
	const first = call(
		"POST",
		`/session/${sid}/message`,
		{
			parts: [
				{ type: "text", text: "what is in src/app.ts and this photo?" },
				{ type: "file", mime: "image/png", filename: "photo.png", url: `data:image/png;base64,${png}` },
				{ type: "file", mime: "text/plain", filename: "src/app.ts", url: `file://${encodeURI(join(work, "src/app.ts"))}` },
			],
			model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" },
			variant: "low",
			agent: "build",
		},
		scoped,
	);
	await Bun.sleep(300);
	expect((await call("GET", "/session/status")).json[sid]).toMatchObject({ type: "busy" });
	const msgs = (await call("GET", `/session/${sid}/message?limit=50`)).json;
	const user = msgs.find((m: any) => m.info.role === "user");
	// the typed text, the photo, the mentioned file; then the turn context the daemon appends (synthetic)
	expect(user.parts.map((p: any) => p.type).slice(0, 3)).toEqual(["text", "file", "text"]);
	expect(user.parts[1]).toMatchObject({ type: "file", mime: "image/png" });
	expect(user.parts[2]).toMatchObject({ type: "text", synthetic: true });
	expect(user.parts[2].text).toContain("export const answer = 42;");
	expect(user.info.agent).toBe("build");

	const queued = await call("POST", `/session/${sid}/message`, { parts: [{ type: "text", text: "and then this" }] }, scoped);
	expect(queued.status).toBe(202);
	expect((await call("GET", "/session/status")).json[sid]).toMatchObject({ type: "busy", queued: 1 });
	expect((await call("DELETE", `/session/${sid}/message/${queued.json.messageID}`, undefined, scoped)).json).toBe(true);
	expect((await call("GET", "/session/status")).json[sid]).toMatchObject({ queued: 0 });

	const board = await fetch(`${base}/session/${sid}/prompt_async`, {
		method: "POST",
		headers: { authorization: `Basic ${btoa("opencode:boxbox")}`, "content-type": "application/json", ...scoped },
		body: JSON.stringify({ parts: [{ type: "text", text: "queued from the board" }] }),
	});
	log.push(`POST /session/${sid}/prompt_async -> ${board.status}`);
	// boxbox's board checks res.ok; the answer carries the queued prompt's id
	expect(board.status).toBe(202);
	expect(await board.json()).toMatchObject({ messageID: expect.stringMatching(/^msg_/), queued: true });

	const second = await call("POST", `/session/${sid}/message`, { parts: [{ type: "text", text: "and one more after the board" }] }, scoped);
	expect(second.status).toBe(202);
	expect((await call("GET", "/session/status")).json[sid]).toMatchObject({ queued: 2 });

	expect((await call("POST", `/session/${sid}/abort`, undefined, scoped)).json).toBe(true);
	const done = await first;
	expect(done.status).toBe(200);
	expect(done.json.info).toMatchObject({ role: "assistant", modelID: "claude-sonnet-5-5", providerID: "anthropic", variant: "low", agent: "build" });
	// the board's prompt waited behind the aborted turn; loop runs it now (and it stalls on the silent provider)
	expect((await call("POST", `/session/${sid}/loop`, undefined, scoped)).json).toEqual({ ran: 2 });
	await Bun.sleep(200);
	expect((await call("GET", "/session/status")).json[sid]).toMatchObject({ type: "busy" });
	// both prompts that waited behind the aborted turn went out, in order (loop once dropped all but the first)
	const texts = (await call("GET", `/session/${sid}/message?limit=50`)).json.flatMap((m: any) => (m.info.role === "user" ? m.parts.filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text) : []));
	expect(texts.slice(-2)).toEqual(["queued from the board", "and one more after the board"]);
	// a prompt queued behind a turn that stops, then a fresh send: the waiting one still goes first
	const behind = await call("POST", `/session/${sid}/message`, { parts: [{ type: "text", text: "waited behind the stop" }] }, scoped);
	expect(behind.status).toBe(202);
	await call("POST", `/session/${sid}/abort`, undefined, scoped);
	const fresh = call("POST", `/session/${sid}/message`, { parts: [{ type: "text", text: "sent after the stop" }] }, scoped);
	await Bun.sleep(300);
	const after = (await call("GET", `/session/${sid}/message?limit=50`)).json.flatMap((m: any) => (m.info.role === "user" ? m.parts.filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text) : []));
	expect(after.slice(-2)).toEqual(["waited behind the stop", "sent after the stop"]);
	await call("POST", `/session/${sid}/abort`, undefined, scoped);
	await fresh;
});

test("! shell line and / command", async () => {
	const sh = await call("POST", `/session/${sid}/shell`, { command: "echo from-bang && ls src" }, scoped);
	expect(sh.status).toBe(200);
	expect(sh.json.parts[0]).toMatchObject({ type: "tool", tool: "shell", state: { status: "completed", input: { command: "echo from-bang && ls src" } } });
	expect(sh.json.parts[0].state.output).toContain("from-bang");
	const cmd = call("POST", `/session/${sid}/command`, { command: "hi", arguments: "boxbox" }, scoped);
	await Bun.sleep(300);
	const msgs = (await call("GET", `/session/${sid}/message?limit=50`)).json;
	expect(msgs.at(-1).parts.find((p: any) => p.type === "text")?.text).toBe("say hi to boxbox");
	await call("POST", `/session/${sid}/abort`, undefined, scoped);
	expect((await cmd).status).toBe(200);
});

test("share is a typed not-supported error", async () => {
	for (const method of ["POST", "DELETE"]) {
		const r = await call(method, `/session/${sid}/share`);
		expect(r.status).toBe(501);
		expect(r.json.name).toBe("NotSupportedError");
	}
});

test("pending items and replies (reconcile on reconnect)", async () => {
	expect((await call("GET", "/permission")).json).toEqual([]);
	expect((await call("GET", "/question")).json).toEqual([]);
	// unknown asks are a typed 404 (cmx said true); boxbox v1 puts the card back to pending on any non-2xx
	for (const [path, body] of [["/permission/per_gone/reply", { reply: "once" }], ["/question/que_gone/reply", { answers: [["a"]] }], ["/question/que_gone/reject", undefined]] as const) {
		const r = await call("POST", path, body);
		expect([r.status, r.json.name]).toEqual([404, "NotFoundError"]);
	}
});

test("pocket terminal: list, shells, create, resize, connect with a cursor, delete", async () => {
	expect(Array.isArray((await call("GET", "/pty")).json)).toBe(true);
	expect((await call("GET", "/pty/shells")).json.length).toBeGreaterThan(0);
	const pty = (await call("POST", "/pty", { origin: "tui", cwd: work })).json;
	expect(pty).toMatchObject({ status: "running", origin: "tui", cwd: work });
	expect((await call("PUT", `/pty/${pty.id}`, { size: { rows: 40, cols: 100 } })).json.id).toBe(pty.id);

	const dial = (cursor?: number) =>
		new Promise<{ ws: WebSocket; replay: string; meta: number }>((resolve, reject) => {
			const ws = new WebSocket(`${base.replace("http", "ws")}/pty/${pty.id}/connect${cursor === undefined ? "" : `?cursor=${cursor}`}`, {
				headers: { authorization: `Basic ${btoa("opencode:boxbox")}`, ...scoped },
			} as never);
			ws.binaryType = "arraybuffer";
			let replay = "";
			ws.onerror = () => reject(new Error("websocket failed"));
			ws.onmessage = (e) => {
				if (typeof e.data === "string") replay += e.data;
				else {
					const b = new Uint8Array(e.data as ArrayBuffer);
					if (b[0] === 0) resolve({ ws, replay, meta: JSON.parse(new TextDecoder().decode(b.slice(1))).cursor });
				}
			};
		});
	const a = await dial();
	log.push(`GET /pty/${pty.id}/connect (websocket) -> 101, meta cursor ${a.meta}`);
	let live = "";
	a.ws.onmessage = (e) => {
		if (typeof e.data === "string") live += e.data;
	};
	a.ws.send("echo boxbox-ßytes-$((6*7))\r");
	const t0 = Date.now();
	while (!live.includes("boxbox-ßytes-42") && Date.now() - t0 < 5000) await Bun.sleep(50);
	expect(live).toContain("boxbox-ßytes-42");
	a.ws.close();
	const b = await dial(a.meta);
	log.push(`GET /pty/${pty.id}/connect?cursor=${a.meta} (websocket) -> 101, replayed ${b.replay.length} chars`);
	expect(b.replay.startsWith(live)).toBe(true);
	b.ws.close();
	expect((await call("DELETE", `/pty/${pty.id}`)).json).toBe(true);
	expect((await call("GET", "/pty")).json.find((x: any) => x.id === pty.id)).toBeUndefined();
});

test("machines screen: health, reload", async () => {
	expect((await call("GET", "/global/health")).json).toMatchObject({ healthy: true });
	expect((await call("POST", "/global/reload")).status).toBe(200);
});

test("m6 checkouts: spawn's fresh workspace, the watcher's reconcile and review fetch, merge refused while busy, merge, a conflict, discard", async () => {
	const repo = join(root, "shop");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, ".gitignore"), ".env\n");
	const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=it@cmx2", "-c", "user.name=it", ...args], { cwd }).stdout.toString().trim();
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	writeFileSync(join(repo, ".env"), "KEY=1\n");
	const frames: any[] = [];
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${base}/global/event`, { headers: { authorization: `Basic ${btoa("opencode:boxbox")}` }, signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
					buf = buf.slice(i + 2);
					if (line) frames.push(JSON.parse(line.slice(6)));
				}
			}
		} catch {}
	})();
	const home = { "x-opencode-directory": repo };

	// app/api/hosts/[host]/spawn/route.ts, workspace "fresh": create with an empty body, then the session in the checkout, then the first prompt
	const created = await call("POST", "/experimental/worktree", {}, home);
	expect(created.status).toBe(200);
	const checkout = created.json.directory as string;
	expect(typeof checkout).toBe("string");
	expect(created.json.branch).toBe(`cmx2/${created.json.name}`);
	const thread = await call("POST", "/session", {}, { "x-opencode-directory": checkout });
	expect(thread.json.directory).toBe(checkout);
	await call("POST", `/session/${thread.json.id}/prompt_async`, { parts: [{ type: "text", text: "work in the checkout" }] }, { "x-opencode-directory": checkout });

	// lib/fleet/watcher.ts reconcile: the project index with checkouts; the reducers read worktree, sandboxes and worktrees[].directory
	const projects = (await call("GET", "/project?worktrees=true", undefined, {})).json;
	const row = projects.find((x: any) => x.worktree === repo);
	expect(row.id).toBe(repo);
	expect(row.sandboxes).toEqual([checkout]);
	expect(row.worktrees).toEqual([{ name: created.json.name, directory: checkout, branch: created.json.branch, base: "main", project: repo }]);
	// the lifecycle frames the watcher reduces: project.updated {worktree, sandboxes}, then worktree.ready framed with the checkout
	for (let i = 0; i < 100 && !frames.some((f) => f.payload.type === "worktree.ready" && f.directory === checkout); i++) await Bun.sleep(20);
	expect(frames.find((f) => f.payload.type === "project.updated" && f.payload.properties.sandboxes.includes(checkout))?.payload.properties.worktree).toBe(repo);
	expect(frames.find((f) => f.payload.type === "worktree.ready" && f.directory === checkout)?.payload.properties).toMatchObject({ name: created.json.name, branch: created.json.branch });

	// lib/store/fleet.tsx worktreeMerge while the thread's turn runs: refused, the checkout stays
	const busy = await call("POST", "/experimental/worktree/merge", { directory: checkout }, { "x-opencode-directory": checkout });
	expect([busy.status, busy.json.name]).toEqual([409, "BusyError"]);
	await call("POST", `/session/${thread.json.id}/abort`, {});

	writeFileSync(join(checkout, "src", "b.ts"), "export const b = 2;\n");
	sh(checkout, "add", "-A");
	sh(checkout, "commit", "-qm", "add b");
	// watcher.fetchReview and fleet.worktreeDiff: the diff with the directory in the query and the header
	const diff = (await call("GET", `/experimental/worktree/diff?${new URLSearchParams({ directory: checkout })}`, undefined, { "x-opencode-directory": checkout })).json;
	expect(diff).toMatchObject({ branch: created.json.branch, base: "main", commits: 1, additions: 1, deletions: 0, dirty: false, mergeable: true, truncated: false });
	expect(diff.files).toEqual([{ path: "src/b.ts", status: "added", additions: 1, deletions: 0 }]);
	expect(diff.diff).toContain("+export const b = 2;");
	const merged = await call("POST", "/experimental/worktree/merge", { directory: checkout }, { "x-opencode-directory": checkout });
	expect(merged.status).toBe(200);
	expect(sh(repo, "log", "-1", "--format=%s")).toBe("add b");
	const emptied = (f: any) => f.payload.type === "project.updated" && f.payload.properties.worktree === repo && f.payload.properties.sandboxes.length === 0;
	for (let i = 0; i < 100 && !frames.some(emptied); i++) await Bun.sleep(20);
	expect(frames.some(emptied)).toBe(true);

	// a conflict: fleet.worktreeMerge sends the thread back when the body mentions MergeConflict
	const second = (await call("POST", "/experimental/worktree", {}, home)).json.directory as string;
	writeFileSync(join(second, "src", "a.ts"), "export const a = 2;\n");
	sh(second, "commit", "-qam", "a is 2");
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
	sh(repo, "commit", "-qam", "a is 3");
	const clash = await call("POST", "/experimental/worktree/merge", { directory: second }, { "x-opencode-directory": second });
	expect(clash.status).toBe(409);
	expect(JSON.stringify(clash.json)).toContain("MergeConflict");
	// fleet.worktreeDiscard reads snapshot for its rescue notice
	const discarded = await call("POST", "/experimental/worktree/discard", { directory: second }, { "x-opencode-directory": second });
	expect(discarded.status).toBe(200);
	expect(discarded.json.snapshot).toMatch(/^[0-9a-f]{40}$/);
	ctl.abort();
	expect(daemon.violations()).toBe(0);
}, 60_000); // several clones, merges and a conflict: past 5 s under the full suite's load

test("delete thread archives it (rule 15): 200, gone from the list, still on disk", async () => {
	expect((await call("DELETE", `/session/${sid}`)).json).toBe(true);
	expect((await call("GET", "/session?scope=project&roots=true&limit=50", undefined, scoped)).json.map((x: any) => x.id)).not.toContain(sid);
	const kept = await call("GET", `/session/${sid}`);
	expect(kept.status).toBe(200);
	expect(kept.json.time.archived).toBeGreaterThan(0);
	expect(daemon.store.messageCount(sid)).toBeGreaterThan(0);
	expect(daemon.violations()).toBe(0);
});
