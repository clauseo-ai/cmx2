import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	deferredTools,
	hotTools,
	type ProcHost,
	type ProcRead,
	type ProcSpawn,
	type ProcSummary,
	type RunDetails,
	runOnlyTools,
	type Tool,
	type ToolEnv,
	type ToolResult,
} from "@cmx2/tools";
import { type GateOptions, gateCall, nestedCall } from "../src/calls.ts";
import { rulesFromConfig } from "../src/permission.ts";

/**
 * the gate and the nested call the session uses, driven without a model: real tools, real files, real
 * processes, the same two functions a turn goes through.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-calls-")));

/**
 * a process host over Bun.spawn, just enough for the run helpers: real processes and real terminals.
 * the daemon's own registry (ownership, notify, reaping) lives in packages/procs.
 */
class ScratchProcs implements ProcHost {
	private procs = new Map<string, { p: ReturnType<typeof Bun.spawn>; out: string; s: ProcSummary }>();
	private n = 0;
	spawn(o: ProcSpawn): ProcSummary {
		const id = `proc_${++this.n}`;
		const entry = { out: "" } as { p: ReturnType<typeof Bun.spawn>; out: string; s: ProcSummary };
		const append = (d: Uint8Array) => {
			entry.out += new TextDecoder().decode(d);
			entry.s.cursor = Buffer.byteLength(entry.out);
		};
		const opts = { cwd: o.cwd ?? root, env: { ...process.env, PS1: "$ ", ...o.env } } as Record<string, unknown>;
		if (o.tty) opts.terminal = { cols: o.cols ?? 100, rows: o.rows ?? 30, data: (_t: unknown, d: Uint8Array) => append(d) };
		else Object.assign(opts, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const p = Bun.spawn(["bash", "--norc", "--noprofile", "-c", o.command], opts as never);
		entry.p = p;
		entry.s = { id, pid: p.pid, command: o.command, cwd: String(opts.cwd), title: o.title ?? o.command, tty: !!o.tty, status: "running", exitCode: null, cursor: 0, ports: [], origin: "model", startedAt: Date.now(), ...(o.keep ? { keep: o.keep } : {}) };
		if (!o.tty) for (const s of [p.stdout, p.stderr]) void (async () => { for await (const c of s as unknown as AsyncIterable<Uint8Array>) append(c); })();
		void p.exited.then((code) => Object.assign(entry.s, { status: "exited", exitCode: code }));
		this.procs.set(id, entry);
		return entry.s;
	}
	write(id: string, data: string) {
		const e = this.procs.get(id)!;
		if (e.s.tty) (e.p as unknown as { terminal: { write(d: string): void } }).terminal.write(data);
		else (e.p.stdin as import("bun").FileSink).write(data);
	}
	async read(id: string, o: { cursor?: number; limit?: number; wait_ms?: number } = {}): Promise<ProcRead> {
		const e = this.procs.get(id)!;
		const from = o.cursor ?? 0;
		const t0 = Date.now();
		let last = e.s.cursor;
		while (o.wait_ms && Date.now() - t0 < o.wait_ms) {
			await Bun.sleep(100);
			if (e.s.cursor > from && e.s.cursor === last) break;
			last = e.s.cursor;
		}
		const data = Buffer.from(e.out).subarray(from, from + (o.limit ?? 50_000)).toString();
		return { data, cursor: from + Buffer.byteLength(data), start: from, dropped: 0, status: e.s.status, exitCode: e.s.exitCode };
	}
	kill(id: string) {
		this.procs.get(id)?.p.kill("SIGKILL");
	}
	list() {
		return [...this.procs.values()].map((e) => e.s);
	}
}

const procs = new ScratchProcs();
afterAll(() => {
	for (const p of procs.list()) procs.kill(p.id);
});

function harness(permission: Parameters<typeof rulesFromConfig>[0], ask?: GateOptions["ask"]) {
	const env: ToolEnv = { cwd: root, spillDir: join(root, ".spill"), procs };
	const gate: GateOptions = { cwd: root, rules: () => rulesFromConfig(permission), ...(ask ? { ask } : {}) };
	let tools: Tool[] = [];
	const extra = [...deferredTools(env), ...runOnlyTools(env)];
	const lookup = (name: string) => tools.find((t) => t.name === name) ?? extra.find((t) => t.name === name);
	tools = hotTools(env, (tool, args, signal) => nestedCall(gate, lookup, tool, args, signal), async () => []);
	const run = (code: string) => tools.find((t) => t.name === "run")!.execute("call_run", { code }) as Promise<ToolResult<RunDetails>>;
	return { run, gate, lookup };
}

function png(w: number, h: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((1 + w * 3) * h, 90);
	for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
writeFileSync(join(root, "c.ts"), "const c = 3;\n");
writeFileSync(
	join(root, "sum.test.ts"),
	'import { expect, test } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\ntest("subtracts", () => expect(3 - 1).toBe(1));\ntest("multiplies", () => expect(2 * 3).toBe(6));\n',
);

test("one script: three reads, a grep, the tests, one denied call caught; only the failures come back", async () => {
	const { run } = harness({ "*": "allow", shell: { "*": "allow", "rm *": "deny" } });
	const r = await run(`
		const files = await Promise.all(["a.ts", "b.ts", "c.ts"].map((path) => fs.read({ path })));
		const exported = await search.grep({ pattern: "^export", glob: "*.ts" });
		const tests = await shell.exec({ command: "bun test sum.test.ts 2>&1" });
		let cleanup;
		try { await shell.exec({ command: "rm -rf build" }); cleanup = "ran"; } catch (e) { cleanup = "refused: " + e.message; }
		const failures = tests.output.split("\\n").filter((l) => l.includes("(fail)")).map((l) => l.trim());
		return { read: files.length, exported: exported.hits.map((h) => h.path), exit: tests.exit_code, failures, cleanup };
	`);
	const d = r.details;
	console.log("run result:", (r.content[0] as { text: string }).text);
	console.log("nested permission decisions:");
	for (const n of d.nested) console.log(`  ${n.helper.padEnd(12)} ${n.tool.padEnd(6)} ${String(n.permission).padEnd(6)} ${n.rule ?? ""} ${n.ok ? "ok" : `failed: ${n.error}`}`);
	const value = JSON.parse((r.content.at(-1) as { text: string }).text);
	// ripgrep searches in parallel, so hits come back in either order
	expect({ ...value, exported: [...value.exported].sort() }).toMatchObject({ read: 3, exported: ["a.ts", "b.ts"], exit: 1, failures: [expect.stringContaining("subtracts")] });
	expect(value.cleanup).toStartWith("refused: a permission rule blocks this call (shell rm *: deny)");
	expect(d.calls).toBe(6);
	expect(d.nested.map((n) => n.permission)).toEqual(["allow", "allow", "allow", "allow", "allow", "deny"]);
	expect(d.nested.at(-1)).toMatchObject({ helper: "shell.exec", ok: false, rule: "shell rm *: deny" });
	expect(d.nested[4]).toMatchObject({ helper: "shell.exec", ok: false, rule: "shell *: allow" });
	expect(r.isError).toBe(false);
}, 60_000);

test("asks are answered per nested call: once runs, reject refuses, the script keeps going", async () => {
	const answers: string[] = [];
	const { run } = harness({ "*": "allow", shell: { "*": "allow", "git push *": "ask", "curl *": "ask" } }, async (check) => {
		answers.push(check.patterns[0]!);
		return { reply: check.patterns[0]!.startsWith("git") ? "once" : "reject" };
	});
	const r = await run(`
		const pushed = await shell.exec({ command: "git push --dry-run 2>/dev/null; echo pushed" });
		let fetched = "no";
		try { await shell.exec({ command: "curl -s example.invalid" }); fetched = "yes"; } catch (e) { fetched = e.message; }
		return { pushed: pushed.output.trim(), fetched };
	`);
	expect(answers).toEqual(["git push --dry-run 2>/dev/null; echo pushed", "curl -s example.invalid"]);
	expect(r.details.nested.map((n) => `${n.permission} ${n.rule}`)).toEqual(["ask:once shell git push *: ask", "ask:reject shell curl *: ask"]);
	expect(JSON.parse((r.content.at(-1) as { text: string }).text)).toMatchObject({ pushed: "pushed", fetched: "the user rejected permission to use this specific tool call." });
}, 30_000);

test("images from nested calls are attached host-side, resized, not piped through the script", async () => {
	writeFileSync(join(root, "shot.png"), png(2600, 1400));
	const { run } = harness({ "*": "allow" });
	const r = await run(`const caption = await fs.read({ path: "shot.png" }); text(caption); return { chars: caption.length };`);
	const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
	expect(img).toBeDefined();
	expect(r.details.attachments).toBe(1);
	const bytes = Buffer.from(img!.data, "base64");
	expect(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBeLessThanOrEqual(1900);
	expect((r.content[0] as { text: string }).text).toContain("resized from 2600x1400");
	expect(JSON.parse((r.content.find((c) => c.type === "text" && c.text.startsWith("{")) as { text: string }).text).chars).toBeLessThan(200);
}, 30_000);

test("pty and job helpers: a terminal answers typed input, typing is checked like shell, a job runs in the background", async () => {
	const { run } = harness({ "*": "allow", shell: { "*": "allow", "rm *": "deny" } });
	const r = await run(`
		const t = await pty.spawn({ command: "bash --norc --noprofile -i" });
		await pty.write({ id: t.id, data: "echo answer-$((6*7))\\n" });
		const out = await pty.read({ id: t.id, wait_ms: 3000 });
		let typed = "ran";
		try { await pty.write({ id: t.id, data: "rm -rf /tmp/nothing-here\\n" }); } catch (e) { typed = e.message; }
		const job = await shell.spawn({ command: "sleep 0.2; echo job-done", notify: { on_exit: true } });
		const listed = (await pty.list()).map((p) => p.id);
		await pty.kill({ id: t.id });
		return { tty: t.tty, answered: out.data.includes("answer-42"), typed, job: job.tty, listed: listed.length };
	`);
	const value = JSON.parse((r.content.at(-1) as { text: string }).text);
	expect(value).toMatchObject({ tty: true, answered: true, job: false, listed: 2 });
	expect(value.typed).toContain("shell rm *: deny");
	expect(r.details.nested.find((n) => n.helper === "pty.write" && !n.ok)).toMatchObject({ permission: "deny" });
}, 30_000);

test("the gate: tools with no check of their own, path checks outside the directory, no client to ask", async () => {
	const base = { cwd: root, rules: () => rulesFromConfig({ "*": "allow", external_directory: "ask" }) };
	expect((await gateCall(base, "run", { code: "1" }, "c")).decision).toEqual({ permission: "none" });
	expect((await gateCall(base, "read", { path: "a.ts" }, "c")).decision).toEqual({ permission: "allow", rule: "* *: allow" });
	const outside = await gateCall(base, "read", { path: "/etc/hosts" }, "c");
	expect(outside.decision.permission).toBe("ask:reject");
	expect(outside.refused).toContain("no client is connected to ask");
	const { lookup } = harness({ "*": "allow" });
	const bad = await nestedCall(base, lookup, "read", { nope: 1 }, undefined);
	expect(bad.isError).toBe(true);
	expect(bad.result.content[0]).toMatchObject({ text: expect.stringContaining("invalid arguments") });
});

test("fs.edit inside run takes old_str and new_str, and a nested call to bash runs shell", async () => {
	writeFileSync(join(root, "alias.txt"), "one\n");
	const { run, lookup } = harness({ "*": "allow" });
	const r = await run(`return await fs.edit({ path: "alias.txt", old_str: "one", new_str: "two" });`);
	expect(r.isError).toBeFalsy();
	expect(await Bun.file(join(root, "alias.txt")).text()).toBe("two\n");
	const base = { cwd: root, rules: () => rulesFromConfig({ "*": "allow" }) };
	const sh = await nestedCall(base, lookup, "bash", { command: "echo via-bash" }, undefined);
	expect(sh.isError).toBe(false);
	expect(JSON.stringify(sh.result.content)).toContain("via-bash");
});
