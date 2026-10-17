import { expect, test } from "bun:test";
import { runTool } from "../src/run.ts";
import type { NestedCall } from "../src/types.ts";

/** a script that times out tells the call it is waiting on to stop; a script that ends normally leaves its calls alone */

/** a shell call that runs until told to stop, then answers the way the shell tool does when it is killed */
function hangingShell() {
	const seen: { aborted: boolean; settled: boolean } = { aborted: false, settled: false };
	const call: NestedCall = (_tool, _args, signal) =>
		new Promise((resolve) => {
			const done = () => {
				seen.aborted = true;
				seen.settled = true;
				const r = { exit_code: null, output: "", timed_out: false };
				resolve({ result: { content: [{ type: "text", text: "(aborted)" }], details: r, structuredContent: r }, isError: true, decision: { permission: "allow" } });
			};
			if (signal?.aborted) return done();
			signal?.addEventListener("abort", done, { once: true });
		});
	return { call, seen };
}

test("a timed-out script stops the shell call it was waiting on", async () => {
	const { call, seen } = hangingShell();
	const t0 = performance.now();
	const r = await runTool(call, { timeoutMs: 300 }).execute("t", { code: 'await shell.exec({ command: "sleep 600" });' });
	expect(r.isError).toBe(true);
	expect(JSON.stringify(r.content)).toContain("timed out after 300 ms");
	await new Promise((ok) => setTimeout(ok, 20));
	expect(seen.aborted).toBe(true);
	expect(performance.now() - t0).toBeLessThan(5_000);
});

test("a script that returns leaves an unawaited call running", async () => {
	const { call, seen } = hangingShell();
	const r = await runTool(call, { timeoutMs: 5_000 }).execute("t", { code: 'shell.exec({ command: "sleep 600" }); return "back";' });
	expect(r.isError).toBe(false);
	await new Promise((ok) => setTimeout(ok, 50));
	expect(seen.aborted).toBe(false);
});

test("the caller's abort still reaches the call", async () => {
	const { call, seen } = hangingShell();
	const ctl = new AbortController();
	const pending = runTool(call, { timeoutMs: 5_000 }).execute("t", { code: 'await shell.exec({ command: "sleep 600" });' }, ctl.signal);
	await new Promise((ok) => setTimeout(ok, 100));
	ctl.abort();
	await pending;
	expect(seen.aborted).toBe(true);
});
