import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLockHeld, RunLocks } from "../src/lock.ts";

test("one holder per session across processes; the kernel frees it when the holder dies", async () => {
	const data = mkdtempSync(join(tmpdir(), "cmx2-lock-"));
	const holder = Bun.spawn(
		["bun", "-e", `import { RunLocks } from ${JSON.stringify(join(import.meta.dir, "../src/lock.ts"))}; new RunLocks(${JSON.stringify(data)}, 4999).acquire("ses_x"); console.log("held"); await Bun.sleep(60000);`],
		{ stdout: "pipe" },
	);
	const reader = holder.stdout.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");

	const mine = new RunLocks(data);
	let err: unknown;
	try {
		mine.acquire("ses_x");
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(RunLockHeld);
	expect((err as RunLockHeld).holder).toMatchObject({ pid: holder.pid, port: 4999 });
	expect((err as Error).message).toContain(`pid ${holder.pid}`);
	mine.acquire("ses_other");

	holder.kill("SIGKILL");
	await holder.exited;
	mine.acquire("ses_x");
	expect(mine.holds("ses_x")).toBe(true);
	mine.releaseAll();
});

test("within one process a second holder is refused too, and release lets the next one in", () => {
	const data = mkdtempSync(join(tmpdir(), "cmx2-lock-"));
	const a = new RunLocks(data);
	const b = new RunLocks(data);
	a.acquire("ses_y");
	a.acquire("ses_y");
	expect(() => b.acquire("ses_y")).toThrow(RunLockHeld);
	a.release("ses_y");
	b.acquire("ses_y");
	b.release("ses_y");
});
