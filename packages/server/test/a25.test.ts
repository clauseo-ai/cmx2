/**
 * contract version 5, additive: `GET /session?before=` pages by `<updated_at>:<id>`, the keyset
 * the listing orders by, so sessions that share one updated time are neither dropped nor repeated at a page
 * edge, and a run of ties longer than `limit` can be walked. the bare `<updated_at>` form a version 5 client
 * sends still works. a daemon in this process over a store seeded before it starts.
 *
 * run: bun test packages/server/test/a25.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { Store } from "@cmx2/store";
import { nonce, port } from "../../eval/src/harness.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-a25-"));
const DATA = join(SCRATCH, `a25-${nonce()}`, "data");
const WORK = join(SCRATCH, "work");
mkdirSync(DATA, { recursive: true });
mkdirSync(WORK, { recursive: true });
const BASE = `http://127.0.0.1:${port(4832)}`;

// 30 sessions: 18 share one updated time (a bulk import), 8 another, 4 each their own
const SHAPE: number[] = [...Array(18).fill(9000), ...Array(8).fill(8000), 7000, 6000, 5000, 4000];
const IDS = SHAPE.map((_, i) => `ses_${String(i).padStart(3, "0")}`);
const EXPECTED = IDS.map((id, i) => ({ id, t: SHAPE[i]! })).sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1)).map((r) => r.id);

let d: ReturnType<typeof serve>;
beforeAll(() => {
	const store = new Store(join(DATA, "cmx2.db"));
	IDS.forEach((id, i) => store.putSession({ id, directory: WORK, title: `a25 ${i}`, model: "anthropic/m", session_file: null, created_at: 1000 + i, updated_at: SHAPE[i]! }));
	store.db.close();
	const c = { ...structuredClone(DEFAULTS), sources: [] };
	d = serve({ config: c, port: port(4832), hostname: "127.0.0.1", dataDir: DATA, checkEvents: true, reload: () => c });
});
afterAll(async () => {
	await d.stop();
});

async function list(query: string) {
	const res = await fetch(`${BASE}/session?${query}`, { headers: { "x-cmx2-directory": WORK } });
	return { status: res.status, ids: res.ok ? ((await res.json()) as any[]).map((s) => s.id as string) : [], cursor: res.headers.get("x-next-cursor"), body: res.ok ? undefined : await res.json() };
}

/** every page of a walk, following the cursor header as a client does */
async function walk(limit: number, extra = "") {
	const seen: string[] = [];
	const pages: string[][] = [];
	let before = "";
	for (let i = 0; i < 100; i++) {
		const r = await list(`limit=${limit}${extra}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
		expect(r.status).toBe(200);
		pages.push(r.ids);
		seen.push(...r.ids);
		if (!r.cursor) break;
		before = r.cursor;
	}
	return { seen, pages };
}

describe("a25: /session pages by updated_at and id", () => {
	test("the header answers <updated_at>:<id> of the last row", async () => {
		const r = await list("limit=5");
		expect(r.ids).toEqual(EXPECTED.slice(0, 5));
		expect(r.cursor).toBe(`9000:${EXPECTED[4]}`);
	});

	test("a walk by the cursor header sees every session once, at any page size, including a tie run longer than the page", async () => {
		for (const limit of [1, 2, 5, 7, 18, 29, 30]) {
			const { seen } = await walk(limit);
			expect(seen).toEqual(EXPECTED);
		}
	});

	test("a walk with filters keeps the same keyset", async () => {
		const { seen } = await walk(4, "&roots=true");
		expect(seen).toEqual(EXPECTED);
	});

	test("the bare updated time still pages strictly older, as a version 5 client sends it", async () => {
		const first = await list("limit=5");
		const bare = Number(first.cursor!.split(":")[0]);
		const next = await list(`limit=100&before=${bare}`);
		// the old form skips every row that shares the cursor's time: that is the drop the keyset fixes, kept for old clients
		expect(next.ids).toEqual(EXPECTED.filter((id) => SHAPE[IDS.indexOf(id)]! < bare));
	});

	test("a keyed before is exact: the row after it, ties included", async () => {
		const r = await list(`limit=3&before=9000:${EXPECTED[3]}`);
		expect(r.ids).toEqual(EXPECTED.slice(4, 7));
		// an id that is no row still lands in order
		const between = await list("limit=2&before=8000:ses_999");
		expect(between.ids).toEqual(EXPECTED.filter((id) => SHAPE[IDS.indexOf(id)] === 8000).slice(0, 2));
	});

	test("a malformed before is a 400, not an unfiltered list", async () => {
		for (const bad of ["abc", "9000:", ":ses_1", "-1:ses_1", "9000.5"]) {
			const r = await list(`before=${encodeURIComponent(bad)}`);
			expect(r.status).toBe(400);
		}
	});
});
