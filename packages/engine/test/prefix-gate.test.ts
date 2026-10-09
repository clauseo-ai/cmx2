import { expect, test } from "bun:test";
import { PrefixGate } from "../src/prefix-gate.ts";

test("on a cold prefix the first request leads and a second waits for its first event", async () => {
	const gate = new PrefixGate(5_000);
	const lead = await gate.enter("opus:abc", 300_000);
	expect(lead.waitedMs).toBe(0);
	let went = false;
	const follower = gate.enter("opus:abc", 300_000).then((g) => {
		went = true;
		return g;
	});
	await Bun.sleep(50);
	expect(went).toBe(false);
	lead.release(true);
	const f = await follower;
	expect(went).toBe(true);
	expect(f.waitedMs).toBeGreaterThanOrEqual(40);
	// warm now: nothing waits, and nobody leads
	const later = await gate.enter("opus:abc", 300_000);
	expect(later.waitedMs).toBe(0);
	const again = await gate.enter("opus:abc", 300_000);
	expect(again.waitedMs).toBe(0);
});

test("another prefix does not wait, a leader that never answers holds followers for the cap only, and warmth expires with the ttl", async () => {
	let now = 1_000;
	const gate = new PrefixGate(80, () => now);
	const a = await gate.enter("opus:a", 300_000);
	const b = await gate.enter("opus:b", 300_000);
	expect(b.waitedMs).toBe(0);
	const t0 = performance.now();
	await gate.enter("opus:a", 300_000);
	expect(performance.now() - t0).toBeGreaterThanOrEqual(70);
	// a failed leader does not mark the prefix warm; the next request leads again
	a.release(false);
	const next = await gate.enter("opus:a", 300_000);
	next.release(true);
	now += 299_000;
	expect((await gate.enter("opus:a", 300_000)).waitedMs).toBe(0);
	now += 2_000;
	const cold = await gate.enter("opus:a", 300_000);
	let went = false;
	gate.enter("opus:a", 300_000).then(() => (went = true));
	await Bun.sleep(20);
	expect(went).toBe(false);
	cold.release(true);
	b.release(true);
});
