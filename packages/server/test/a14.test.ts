/**
 * a terminal resumed from a cursor older than the retained output replays everything retained,
 * with nothing skipped, then the meta frame. a daemon in this process (port 4830, shifted by
 * CMX2_PORT_SHIFT) runs a terminal whose output overflows what the registry keeps (the first 64 kb and
 * the last 256 kb), and websocket clients resume it from cursors in the dropped middle, in the kept
 * head and in the kept tail.
 *
 * run: bun test packages/server/test/a14.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const ROOT = realpathSync((mkdirSync(`/tmp/cmx2-a14-${nonce()}`, { recursive: true }), "/tmp"));
const DIR = join(ROOT, `cmx2-a14-${nonce()}`);
mkdirSync(DIR, { recursive: true });
const PORT = port(4830);
const HEAD = 64 * 1024;
const TAIL = 256 * 1024;
const LINES = 20_000;
/** what the terminal prints: numbered lines, about 700 kb (a pty turns \n into \r\n) */
const FULL = Array.from({ length: LINES }, (_, i) => `line ${String(i + 1).padStart(5, "0")} of the a14 overflow test\r\n`).join("");

let d: ReturnType<typeof serve>;
let id = "";
let live = "";

beforeAll(async () => {
	const config = { ...structuredClone(DEFAULTS), sources: [] };
	d = serve({ config, port: PORT, hostname: "127.0.0.1", dataDir: join(DIR, "data"), reload: () => config });
	const r = await fetch(`http://127.0.0.1:${PORT}/pty`, {
		method: "POST",
		body: JSON.stringify({ command: "sh", args: ["-c", `i=1; while [ $i -le ${LINES} ]; do printf 'line %05d of the a14 overflow test\\n' $i; i=$((i+1)); done`], cwd: DIR }),
	});
	id = (await r.json()).id;
	const l = await fetch(`http://127.0.0.1:${PORT}/pty`, {
		method: "POST",
		body: JSON.stringify({ command: "sh", args: ["-c", `i=1; while [ $i -le ${LINES} ]; do printf 'line %05d of the a14 overflow test\\n' $i; i=$((i+1)); done; sleep 60`], cwd: DIR }),
	});
	live = (await l.json()).id;
	for (let i = 0; i < 200; i++) {
		const p = await (await fetch(`http://127.0.0.1:${PORT}/pty/${id}`)).json();
		if (p.status === "exited") break;
		await Bun.sleep(50);
	}
}, 60_000);
afterAll(() => d?.stop(), 30_000);

/** connects from a cursor and collects the text frames, then the meta frame's cursor */
async function resume(cursor: number, which = id): Promise<{ text: string; meta: number }> {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty/${which}/connect?cursor=${cursor}`);
	ws.binaryType = "arraybuffer";
	let text = "";
	let meta = -1;
	await new Promise<void>((ok, fail) => {
		ws.onmessage = (e) => {
			if (typeof e.data === "string") text += e.data;
			else {
				meta = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer).subarray(1))).cursor;
				// a running terminal stays open: the meta frame ends the replay
				if (which !== id) ws.close();
			}
		};
		ws.onclose = () => ok();
		ws.onerror = () => fail(new Error("websocket error"));
		setTimeout(() => fail(new Error("no close within 10 s")), 10_000);
	});
	return { text, meta };
}

test("a14: a cursor in output no longer kept replays the whole retained tail, then the meta frame", async () => {
	expect(FULL.length).toBeGreaterThan(HEAD + TAIL);
	const whole = await resume(0);
	// the terminal's own output, as kept: the head, then the tail after the gap
	expect(whole.text.startsWith(FULL.slice(0, HEAD))).toBe(true);
	const tail = FULL.slice(FULL.length - TAIL);
	expect(whole.text.endsWith(tail)).toBe(true);
	expect(whole.meta).toBe(FULL.length);

	const old = await resume(200_000);
	console.log(`resume from 200000 of ${FULL.length}: ${old.text.length} chars replayed (the retained tail is ${TAIL}), meta cursor ${old.meta}`);
	expect(old.text).toBe(tail);
	expect(old.meta).toBe(FULL.length);

	// in the kept head: the rest of the head, then the tail
	const early = await resume(1000);
	expect(early.text).toBe(FULL.slice(1000, HEAD) + tail);

	// in the kept tail: exactly from there
	const late = FULL.length - 5000;
	expect((await resume(late)).text).toBe(FULL.slice(late));
}, 60_000);

test("a14: the same on a terminal still running", async () => {
	await Bun.sleep(1500);
	const r = await resume(200_000, live);
	// a running terminal may add bytes of its own after the script's lines; what comes back is the retained tail
	// of everything written up to the meta cursor
	const extra = r.meta - FULL.length;
	if (extra) console.log(`the running terminal wrote ${extra} characters past the script's: ${JSON.stringify(r.text.slice(-extra))}`);
	expect(extra).toBeGreaterThanOrEqual(0);
	expect(r.text.length).toBe(TAIL);
	expect(r.text.startsWith(FULL.slice(FULL.length - TAIL + extra))).toBe(true);
}, 30_000);
