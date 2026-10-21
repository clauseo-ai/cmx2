import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectMessage, projectTranscript, Store } from "../src/index.ts";

/**
 * a transcript read again: an unchanged file costs no database writes, a grown one is read from the last
 * row's line on, and the projection ends the same as a full replay of the whole file every time (the
 * replay before this change, kept here as the reference).
 */

const dir = mkdtempSync(join(tmpdir(), "cmx2-replay-"));

function fullReplay(store: Store, sessionId: string, path: string, cwd: string) {
	const have = store.lastMessageSeq(sessionId);
	let seq = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		let r: any;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (r.type !== "message") continue;
		seq++;
		if (seq < have) continue;
		projectMessage(store, { sessionId, cwd, seq }, r.message);
	}
}

let call = 0;
function turn(t: number, text: string): unknown[] {
	const id = `call_${call++}`;
	return [
		{ role: "user", content: `${text} é 日本 \u2028`, timestamp: t },
		{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.txt" } }], provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }, stopReason: "toolUse", timestamp: t + 1 },
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `body ${text}` }], isError: false, timestamp: t + 2 },
		{ role: "assistant", content: [{ type: "text", text: `done ${text}` }], provider: "anthropic", model: "m", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, stopReason: "stop", timestamp: t + 3 },
	];
}
const line = (m: unknown) => `${JSON.stringify({ type: "message", message: m })}\n`;

function rows(s: Store, sid: string) {
	return {
		messages: s.db.query("select * from message where session_id = ? order by seq").all(sid),
		parts: s.db.query("select * from part where session_id = ? order by id").all(sid),
		session: s.db.query("select cost, tokens_input, tokens_output, updated_at from session where id = ?").get(sid),
	};
}
const changes = (s: Store) => (s.db.query("select total_changes() as n").get() as { n: number }).n;

test("a reread of an unchanged transcript writes nothing; a grown one ends where a full replay ends", () => {
	const path = join(dir, "t.jsonl");
	writeFileSync(path, `${JSON.stringify({ type: "header", version: 1, id: "ses_r", cwd: "/w", created: 1, profile: "p" })}\n`);
	for (const m of turn(10, "one")) appendFileSync(path, line(m));
	// a torn write mid-file that the next append ran into: neither line parses, and neither counts
	appendFileSync(path, `{"type":"message","message":{"role":"us`);
	for (const m of turn(20, "two")) appendFileSync(path, line(m));

	const ref = new Store(join(dir, "ref.db"));
	const s = new Store(join(dir, "s.db"));
	for (const st of [ref, s]) st.putSession({ id: "ses_r", directory: "/w", title: "r", model: "anthropic/m", session_file: path, created_at: 1 });
	const step = () => {
		fullReplay(ref, "ses_r", path, "/w");
		projectTranscript(s, "ses_r", path, "/w");
		expect(rows(s, "ses_r")).toEqual(rows(ref, "ses_r"));
	};
	step();
	expect(s.messages("ses_r").rows.length).toBeGreaterThan(2);

	// the same file again: nothing to write
	const before = changes(s);
	expect(projectTranscript(s, "ses_r", path, "/w")).toBe(0);
	projectTranscript(s, "ses_r", path, "/w");
	expect(changes(s) - before).toBe(0);

	// grown: a new turn, and a tool result that lands on a row already there
	for (const m of turn(30, "three")) appendFileSync(path, line(m));
	step();
	// a torn tail, read, then the rest of the line arrives
	const tail = line(turn(40, "four")[0]);
	appendFileSync(path, tail.slice(0, 20));
	step();
	appendFileSync(path, tail.slice(20));
	for (const m of turn(40, "four").slice(1)) appendFileSync(path, line(m));
	step();
	const again = changes(s);
	projectTranscript(s, "ses_r", path, "/w");
	expect(changes(s) - again).toBe(0);
	// rewritten in place to the same size by an outside writer: the mtime moves, so it is read again
	const whole = readFileSync(path, "utf8");
	writeFileSync(path, whole.replace("done four", "DONE FOUR"));
	utimesSync(path, new Date(), new Date(Date.now() + 5_000));
	step();
	// rule 14: every message the reference has is here
	expect(s.messageCount("ses_r")).toBe(ref.messageCount("ses_r"));
});

test("a reread after rows changed under it (another process projected) replays as before", () => {
	const path = join(dir, "u.jsonl");
	writeFileSync(path, `${JSON.stringify({ type: "header", version: 1, id: "ses_u", cwd: "/w", created: 1, profile: "p" })}\n`);
	for (const m of turn(10, "one")) appendFileSync(path, line(m));
	const ref = new Store(join(dir, "ref2.db"));
	const s = new Store(join(dir, "s2.db"));
	for (const st of [ref, s]) st.putSession({ id: "ses_u", directory: "/w", title: "u", model: "anthropic/m", session_file: path, created_at: 1 });
	fullReplay(ref, "ses_u", path, "/w");
	projectTranscript(s, "ses_u", path, "/w");
	// another writer adds a row past the file's end (a shell row the projection numbers seq + 0.5)
	for (const st of [ref, s]) projectMessage(st, { sessionId: "ses_u", cwd: "/w", seq: 4.5 }, { role: "user", content: "late", timestamp: 99 });
	for (const m of turn(50, "five")) appendFileSync(path, line(m));
	fullReplay(ref, "ses_u", path, "/w");
	projectTranscript(s, "ses_u", path, "/w");
	expect(rows(s, "ses_u")).toEqual(rows(ref, "ses_u"));
});
