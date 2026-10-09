/**
 * through the daemon's routes in this process (events checked against the contract):
 *
 * a15: an imported (source cmx) session serves step-start, step-finish, patch and subtask parts, and every part
 *      of the page is a member of the contract's `Part` union (the compaction part already was).
 * a16: a native turn's completed edit and write parts carry metadata.filediff {file, patch, additions, deletions},
 *      file.edited carries the same counts, a big write's patch is bounded while its counts stay right, and a
 *      binary write is a note with no counts.
 *
 * the model is a scripted stand-in on loopback (what a native turn does with a tool is not model behaviour).
 *
 * run: bun test packages/server/test/edits.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Part } from "@cmx2/contract";
import { DEFAULTS } from "@cmx2/engine/config";
import { importCmx } from "@cmx2/store";
import { decompress } from "../../store/src/archive.ts";
import { CREATED_PATCH_CAP } from "@cmx2/tools";
import { Value } from "typebox/value";
import { nonce } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-edits-")));
const work = join(root, "work");
mkdirSync(work);

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + "\n";
// a 21 MB file whose first and last lines are the only ones the last call of the turn changes: git counts 2 and 2, the daemon does not diff a change that wide
const HUGE = Array.from({ length: 210_000 }, (_, i) => (i === 0 || i === 209_999 ? `EDGE ${i}` : `${String(i).padStart(7, "0")} ${"payload ".repeat(11)}`)).join("\n") + "\n";
writeFileSync(join(work, "huge.txt"), HUGE);

/** the turn's tool calls in order, one per model step; the step is how many tool results the request already holds */
const calls: Array<{ name: string; input: unknown }> = [
	{ name: "write", input: { path: "notes.txt", content: "one\ntwo\nthree\n" } },
	{ name: "edit", input: { path: "notes.txt", old_text: "two", new_text: "2\ntwo and a half" } },
	{ name: "write", input: { path: "big.txt", content: BIG } },
	{ name: "write", input: { path: "bin.dat", content: "a\u0000b\n" } },
	{ name: "write", input: { path: "notes.txt", content: "one\n2\ntwo and a half" } },
	{ name: "edit", input: { path: "huge.txt", old_text: "EDGE", new_text: "edge", replace_all: true } },
	// a script that writes, edits and writes a big file: the nested records carry the same counts the direct calls do
	{
		name: "run",
		input: {
			code: `await fs.write({ path: "n.txt", content: "a\\nb\\nc\\n" });
await fs.edit({ path: "n.txt", old_text: "b", new_text: "B\\nB2" });
await fs.write({ path: "nbig.txt", content: Array.from({ length: 3000 }, (_, i) => "line " + i + " " + "x".repeat(30)).join("\\n") + "\\n" });`,
		},
	},
];

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.json();
		const step = JSON.stringify(body.messages ?? []).split('"tool_result"').length - 1;
		const call = body.tools?.length ? calls[step] : undefined;
		const text = !body.tools?.length ? "a title" : "done";
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const put = (s: string) => c.enqueue(new TextEncoder().encode(s));
				put(sse("message_start", { message: { id: `msg_${nonce()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }));
				if (call) {
					put(sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${nonce()}`, name: call.name, input: {} } }));
					put(sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
				} else {
					put(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
					put(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
				}
				put(sse("content_block_stop", { index: 0 }));
				put(sse("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
				put(sse("message_stop", {}));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});
const config = { ...structuredClone(DEFAULTS), format: false, providers: { anthropic: { baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "unused" } }, sources: [] };
const daemon = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(root, "data"), checkEvents: true, reload: () => config });
afterAll(() => {
	provider.stop(true);
	return daemon.stop();
});
const call = (path: string, init?: RequestInit) => daemon.handle(new Request(`http://127.0.0.1${path}`, { ...init, headers: { "x-cmx2-directory": work, "content-type": "application/json", ...(init?.headers ?? {}) } }));
const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as Promise<any>;

test("a15: an imported session's page is whole inside the Part union", async () => {
	const src = join(root, "opencode.db");
	const { Database } = await import("bun:sqlite");
	const db = new Database(src, { create: true });
	db.exec(`create table project (id text primary key, worktree text not null);
		create table session (id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, share_url text,
		  summary_additions integer, summary_deletions integer, summary_files integer, time_created integer, time_updated integer, model text, cost real,
		  tokens_input integer, tokens_output integer, tokens_cache_read integer, tokens_cache_write integer, agent text);
		create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
		create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
		insert into project values ('p', '${work}');
		insert into session values ('ses_a15', 'p', null, 's', '${work}', 'imported', '1', null, null, null, null, 1, 2, null, 0, 0, 0, 0, 0, 'build');
		insert into message values ('msg_u', 'ses_a15', 1, 1, '{"role":"user","time":{"created":1}}');
		insert into message values ('msg_a', 'ses_a15', 2, 2, '{"role":"assistant","time":{"created":2,"completed":3}}');`);
	// the shapes real imported history holds (these part types and compaction)
	const parts: Record<string, unknown>[] = [
		{ type: "compaction", auto: false },
		{ type: "subtask", agent: "build", description: "git commit and push", command: "commit", model: { providerID: "p", modelID: "m" }, prompt: "commit it" },
		{ type: "step-start", snapshot: "4582d7dd3fa1d8096a3103e046485328c1c484f4" },
		{ type: "step-start" },
		{ type: "text", text: "working" },
		{ type: "patch", hash: "4582d7dd3fa1d8096a3103e046485328c1c484f4", files: ["/code/app/src/main.rs"] },
		{ type: "step-finish", reason: "tool-calls", snapshot: "abc", cost: 0.0452265, tokens: { total: 11830, input: 3, output: 77, reasoning: 0, cache: { read: 0, write: 11750 } } },
		{ type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
		// a tool call the model garbled: cmx recorded the input as the raw string
		{ type: "tool", callID: "toolu_garbled", tool: "read", state: { status: "error", input: '{"filePath": "/code/app/a.ts", "offset": 1, 30}', error: "Model tried to call unavailable tool 'invalid'.", time: { start: 1, end: 2 } } },
	];
	parts.forEach((p, i) => {
		const owner = i === 0 ? "msg_u" : "msg_a";
		db.query("insert into part values (?, ?, 'ses_a15', ?, ?, ?)").run(`prt_${String(i).padStart(2, "0")}`, owner, i + 1, i + 1, JSON.stringify(p));
	});
	db.close();
	importCmx(daemon.store, { from: src, since: 0 });
	const page: Array<{ parts: Array<Record<string, unknown>> }> = await json("/session/ses_a15/message");
	const served = page.flatMap((m) => m.parts);
	expect(served.map((p) => p.type)).toEqual(parts.map((p) => p.type));
	for (const p of served) expect([p.type, Value.Check(Part, p)]).toEqual([p.type, true]);
	// the garbled call reads with an object input and keeps its string as `raw`; the stored part is untouched
	const garbled = served.at(-1) as { state: { input: unknown; raw?: string } };
	expect(garbled.state.input).toEqual({});
	expect(garbled.state.raw).toBe('{"filePath": "/code/app/a.ts", "offset": 1, 30}');
	const archive = new (await import("bun:sqlite")).Database(join(root, "data", "archive.db"), { readonly: true });
	const row = archive.query("select data_z from part where id = ?").get(`prt_${String(parts.length - 1).padStart(2, "0")}`) as { data_z: Uint8Array };
	archive.close();
	expect(typeof JSON.parse(decompress(row.data_z)).state.input).toBe("string");
	// the generated contract names them (a decoder built from openapi.json sees the union)
	const spec = JSON.parse(readFileSync(join(import.meta.dir, "../../client/openapi.json"), "utf8"));
	const mapping = spec.components.schemas.Part.discriminator.mapping as Record<string, string>;
	for (const t of ["text", "reasoning", "tool", "file", "compaction", "step-start", "step-finish", "patch", "subtask"]) expect(Object.keys(mapping)).toContain(t);
});

/** every frame of the global stream until the session goes idle */
async function turn(sessionID: string): Promise<any[]> {
	const res = await daemon.handle(new Request("http://127.0.0.1/global/event"));
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	const events: any[] = [];
	await call(`/session/${sessionID}/prompt_async`, { method: "POST", body: JSON.stringify({ text: "make the files" }) });
	let buf = "";
	const t0 = Date.now();
	while (Date.now() - t0 < 30_000) {
		const r = await reader.read();
		if (r.done) break;
		buf += dec.decode(r.value, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
			buf = buf.slice(i + 2);
			if (!data) continue;
			const p = JSON.parse(data.slice(6)).payload;
			if (p?.properties?.sessionID === sessionID) events.push(p);
			if (p?.type === "session.idle" && p.properties.sessionID === sessionID) {
				void reader.cancel();
				return events;
			}
		}
	}
	void reader.cancel();
	throw new Error("the turn did not finish");
}

test("a16: a native turn's edits and writes carry filediff, and file.edited carries the counts", async () => {
	const s = await json("/session", { method: "POST", body: JSON.stringify({ title: "a16" }) });
	const events = await turn(s.id);
	const messages: Array<{ parts: any[] }> = await json(`/session/${s.id}/message`);
	const tools = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool");
	expect(tools.map((t) => [t.tool, t.state.status])).toEqual(calls.map((c) => [c.name, "completed"]));
	const diff = (i: number) => tools[i]!.state.metadata.filediff as { file: string; patch: string; additions: number; deletions: number };

	// a new file: all additions, nothing removed, the patch a jsdiff-shaped unified diff
	expect(diff(0)).toMatchObject({ file: join(work, "notes.txt"), additions: 3, deletions: 0 });
	expect(diff(0).patch).toStartWith(`Index: ${join(work, "notes.txt")}\n=====`);
	expect(diff(0).patch).toContain("@@ -0,0 +1,3 @@\n+one\n+two\n+three\n");
	// an edit: one line gone, two in, with context either side
	expect(diff(1)).toMatchObject({ additions: 2, deletions: 1 });
	expect(diff(1).patch).toContain("@@ -1,3 +1,4 @@\n one\n-two\n+2\n+two and a half\n three\n");
	expect(tools[1]!.state.metadata).toMatchObject({ replacements: 1, line: 2 });
	// a big write that creates a file: counts are the whole file, the patch is small (the part's input.content has every line) and truncated says so
	expect(diff(2)).toMatchObject({ additions: 3000, deletions: 0 });
	expect(Buffer.byteLength(diff(2).patch)).toBeLessThanOrEqual(CREATED_PATCH_CAP);
	expect(diff(2).patch).not.toContain("patch cut");
	expect(tools[2]!.state.metadata.truncated).toBe(true);
	expect(tools[2]!.state.input.content).toBe(BIG);
	// a binary write: a note, no counts
	expect(diff(3)).toMatchObject({ additions: 0, deletions: 0 });
	expect(diff(3).patch).toContain("Binary files differ");
	// a rewrite of a file that exists: counted against what it held, the missing final newline marked
	expect(diff(4)).toMatchObject({ additions: 1, deletions: 2 });
	expect(diff(4).patch).toContain("\\ No newline at end of file");
	expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("one\n2\ntwo and a half");
	// a change too wide to diff (a 21 MB file, its first and last lines changed): the call is done, and carries no diff and no counts, not made-up ones
	expect(readFileSync(join(work, "huge.txt"), "utf8").startsWith("edge 0\n")).toBe(true);
	expect(tools[5]!.state.metadata).toMatchObject({ replacements: 2, line: 1 });
	expect(tools[5]!.state.metadata.filediff).toBeUndefined();
	expect(tools[5]!.state.metadata.truncated).toBeUndefined();

	// a run script's nested edits and writes: each record keeps its counts (the patch too while it fits the record), and the big write's answer is cut but keeps them
	const nested = tools[6]!.state.metadata.nested as Array<{ helper: string; ok: boolean; details: any }>;
	expect(nested.map((n) => [n.helper, n.ok])).toEqual([["fs.write", true], ["fs.edit", true], ["fs.write", true]]);
	expect(nested[0]!.details.filediff).toMatchObject({ file: join(work, "n.txt"), additions: 3, deletions: 0 });
	expect(nested[0]!.details.filediff.patch).toContain("+a\n+b\n+c\n");
	expect(nested[1]!.details.filediff).toMatchObject({ additions: 2, deletions: 1 });
	expect(nested[2]!.details).toMatchObject({ truncated: true, created: true, filediff: { file: join(work, "nbig.txt"), additions: 3000, deletions: 0 } });
	expect(nested[2]!.details.filediff.patch).toBeUndefined();

	// the event: the same counts as the part, per call, in order
	const edited = events.filter((e) => e.type === "file.edited").map((e) => [e.properties.file, e.properties.additions, e.properties.deletions]);
	expect(edited).toEqual([
		[join(work, "notes.txt"), 3, 0],
		[join(work, "notes.txt"), 2, 1],
		[join(work, "big.txt"), 3000, 0],
		[join(work, "bin.dat"), 0, 0],
		[join(work, "notes.txt"), 1, 2],
		[join(work, "huge.txt"), undefined, undefined],
		// and the nested calls of the script publish theirs
		[join(work, "n.txt"), 3, 0],
		[join(work, "n.txt"), 2, 1],
		[join(work, "nbig.txt"), 3000, 0],
	]);
	// a restart-less reread (the store) serves the same part the stream announced
	const announced = events.filter((e) => e.type === "message.part.updated" && e.properties.part.type === "tool" && e.properties.part.state.status === "completed" && e.properties.part.callID === tools[1]!.callID);
	expect(announced.at(-1).properties.part.state.metadata.filediff).toEqual(diff(1));
});
