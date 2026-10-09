import { expect, test } from "bun:test";
import { isWaitingShell, pollOnly } from "../src/poll.ts";

test("waiting shell lines: sleeps and retry loops count, a single check or real work does not", () => {
	expect(isWaitingShell("sleep 5")).toBe(true);
	expect(isWaitingShell("sleep 2 && curl -s localhost:3000/health")).toBe(true);
	expect(isWaitingShell("until curl -sf localhost:3000; do sleep 1; done")).toBe(true);
	expect(isWaitingShell("while ! nc -z localhost 3000; do sleep 0.5; done")).toBe(true);
	expect(isWaitingShell("curl -s localhost:3000/health")).toBe(false);
	expect(isWaitingShell("bun test && sleep 1")).toBe(false);
	expect(isWaitingShell("npm run build")).toBe(false);
});

test("a step is poll-only when every call waits", () => {
	expect(pollOnly([{ name: "shell", arguments: { command: "sleep 3" } }])).toBe(1);
	expect(pollOnly([{ name: "shell", arguments: { command: "sleep 3" } }, { name: "read", arguments: { path: "a" } }])).toBe(0);
	expect(pollOnly([{ name: "run", arguments: { code: "while (true) { const r = await pty.read({ id, wait_ms: 1000 }); }" }, nested: [{ helper: "pty.read" }] }])).toBe(1);
	expect(pollOnly([{ name: "run", arguments: { code: "await fs.read({path:'a'})" }, nested: [{ helper: "fs.read" }] }])).toBe(0);
	expect(pollOnly([])).toBe(0);
	expect(pollOnly([{ name: "shell", arguments: { command: "sleep 4 && echo done", background: true, notify: { on_exit: true } } }])).toBe(0);
});
