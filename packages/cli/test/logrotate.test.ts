import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_KEEP, LOG_MAX_BYTES, rotateLog } from "../src/logrotate.ts";

test("serve.log rotates past 10 MB and keeps three older copies", () => {
	expect([LOG_MAX_BYTES, LOG_KEEP]).toEqual([10 * 1024 * 1024, 3]);
	const log = join(mkdtempSync(join(tmpdir(), "cmx2-logrotate-")), "serve.log");
	writeFileSync(log, "small\n");
	expect(rotateLog(log, 100)).toBe(false);
	for (let i = 1; i <= 5; i++) {
		writeFileSync(log, `round ${i} `.padEnd(200, "x"));
		expect(rotateLog(log, 100)).toBe(true);
		expect(statSync(log).size).toBe(0);
	}
	expect(readFileSync(`${log}.1`, "utf8")).toStartWith("round 5");
	expect(readFileSync(`${log}.2`, "utf8")).toStartWith("round 4");
	expect(readFileSync(`${log}.3`, "utf8")).toStartWith("round 3");
	expect(existsSync(`${log}.4`)).toBe(false);
});

test("an append-mode writer goes on at the start of the truncated file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-logrotate-"));
	const log = join(dir, "serve.log");
	// the shell's >> opens for append, as launchd and systemd's append: do
	const p = Bun.spawn(["sh", "-c", `for i in $(seq 1 40); do printf 'line %03d %0200d\\n' $i 0; sleep 0.02; done >> ${log}`]);
	await Bun.sleep(400);
	expect(rotateLog(log, 1000)).toBe(true);
	await p.exited;
	const after = readFileSync(log, "utf8");
	// no hole of zero bytes where the old content was: the writer appended at the new end
	expect(after.startsWith("line ")).toBe(true);
	expect(after.includes("\0")).toBe(false);
	expect(readFileSync(`${log}.1`, "utf8").startsWith("line 001")).toBe(true);
});
