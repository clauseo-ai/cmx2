#!/usr/bin/env bun
/**
 * drives the tui once, end to end, over a real pty against a real daemon, and writes screen dumps.
 * not part of `bun test` (it spends real model turns). usage:
 *
 *   bun packages/tui/test/drive.ts --port 4862 --dir <project> --data <daemon data dir> --out <file>
 *
 * the daemon must already run on --port. the project should carry a `.cmx2/cmx2.jsonc` that makes
 * the shell ask (`{"permission": {"bash": "ask"}}`) so the permission dialog shows.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { KEY, Pty } from "./pty.ts";

const { values } = parseArgs({ options: { port: { type: "string" }, dir: { type: "string" }, data: { type: "string" }, out: { type: "string" }, model: { type: "string" } } });
const out = values.out ?? "/tmp/cmx2-m8/tui-drive.out";
const cli = join(import.meta.dir, "../../cli/src/index.ts");
writeFileSync(out, `tui drive ${new Date().toISOString()} port ${values.port} dir ${values.dir}\n`);
const t0 = Date.now();
const log = (s: string) => {
	const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
	console.log(line);
	appendFileSync(out, `${line}\n`);
};
const dump = (title: string, screen: string) => {
	const block = `\n===== ${title} =====\n${screen}\n===== end ${title} =====\n`;
	console.log(block);
	appendFileSync(out, block);
};

const p = new Pty(["bun", cli, "tui", "--port", values.port!], { cwd: values.dir!, env: { CMX2_DATA_DIR: values.data }, cols: 100, rows: 40 });
const ok: string[] = [];
const bad: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
	log(`step: ${name}`);
	try {
		await fn();
		ok.push(name);
	} catch (e) {
		bad.push(name);
		log(`FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
const idle = (s: string) => /· idle( · |\s*$)/m.test(s);
const send = async (text: string, key = KEY.enter) => {
	await p.type(text);
	await Bun.sleep(150);
	p.write(key);
};

try {
	await step("first screen, themed", async () => {
		const s = await p.waitFor("ctrl+p model", 15_000);
		await Bun.sleep(1000);
		dump("first screen", p.text());
		const truecolor = /\x1b\[38;2;\d+;\d+;\d+m/.test(p.raw);
		log(`first screen carries truecolor theme sequences: ${truecolor}; status line: ${s.split("\n").at(-1)}`);
		if (!truecolor) throw new Error("no theme colours in the output");
	});

	await step("model picker", async () => {
		p.write(KEY.ctrl("p"));
		await p.waitFor("╭─ model");
		dump("model picker", p.text());
		await p.type(values.model ?? "sonnet-5-5");
		await Bun.sleep(300);
		dump("model picker filtered", p.text());
		p.write(KEY.enter);
		await p.waitFor("from the next turn");
		dump("after picking the model", p.text());
	});

	await step("agent picker", async () => {
		p.write(KEY.ctrl("r"));
		await p.waitFor("╭─ agent");
		dump("agent picker", p.text());
		p.write(KEY.esc);
		await p.waitFor((s) => !s.includes("╭─ agent"));
	});

	await step("effort picker", async () => {
		p.write(KEY.ctrl("o"));
		await p.waitFor("╭─ effort");
		dump("effort picker", p.text());
		await p.type("low");
		await Bun.sleep(200);
		p.write(KEY.enter);
		await p.waitFor("effort low");
		dump("after picking effort low", p.text());
	});

	await step("a real answer streaming", async () => {
		await send("read notes.txt with the read tool and tell me the codeword in a sentence of about forty words.");
		let mid = "";
		await p.waitFor((s) => {
			if (!mid && s.includes("working") && /read/.test(s)) mid = s;
			return s.toLowerCase().includes("marmalade") && idle(s);
		}, 120_000);
		if (mid) dump("while working", mid);
		dump("answer done", p.text());
	});

	await step("refused effort shows the daemon's words", async () => {
		p.write(KEY.ctrl("o"));
		await p.waitFor("╭─ effort");
		await p.type("max");
		await Bun.sleep(200);
		p.write(KEY.enter);
		const s = await p.waitFor(/refused|effort max/, 10_000);
		dump("effort max on sonnet 5.5", s);
	});

	await step("permission dialog answered", async () => {
		await send("run the shell command `echo hello-from-shell` with the shell tool (not run) and tell me exactly what it printed.");
		const s = await p.waitFor("wants to", 120_000);
		dump("permission dialog", s);
		p.write(KEY.enter);
		await p.waitFor((x) => x.includes("hello-from-shell") && !x.includes("wants to") && idle(x), 120_000);
		dump("after allowing once", p.text());
	});

	await step("question dialog answered", async () => {
		await send("use the question tool to ask me which colour i prefer, with exactly two options: red and blue. then tell me which one i picked, in one short sentence.");
		const s = await p.waitFor("asks", 120_000);
		dump("question dialog", s);
		p.write(KEY.down);
		await Bun.sleep(200);
		dump("question dialog, blue highlighted", p.text());
		p.write(KEY.enter);
		await p.waitFor((x) => !x.includes("╭─") && /blue/i.test(x.split("\n").slice(-12).join("\n")) && idle(x), 120_000);
		dump("after answering blue", p.text());
	});

	await step("steer and queue during a busy turn", async () => {
		await send("call the read tool on notes.txt, then the glob tool for *.txt, then read notes.txt once more, one call at a time, then write a 150 word story about a lighthouse keeper.");
		await p.waitFor("working", 60_000);
		await send("name the lighthouse keeper ada.");
		await p.waitFor((x) => x.includes("steering: it lands at the next tool boundary"), 20_000);
		dump("steer sent", p.text());
		await send("after the story, reply with just the words queued-ok.", KEY.altEnter);
		await p.waitFor((x) => x.includes("queued: it runs when this turn ends") && x.includes("› queued after the story"), 20_000);
		dump("queued message shown", p.text());
		const mid = await p.waitFor((x) => /\bAda\b/.test(x) && /· working/.test(x), 120_000).catch(() => "");
		if (mid) dump("story streaming", mid);
		await p.waitFor((x) => /queued-ok/i.test(x.split("\n").slice(-8).join("\n")) && idle(x), 240_000);
		dump("after the story and the queued turn", p.text());
		const all = p.raw;
		log(`story names ada: ${/\bada\b/i.test(all)}`);
	});

	await step("agent tree after a subagent", async () => {
		await send("spawn one subagent named scout with the brief: reply with only the word ready. wait for its report, then tell me what it said.");
		await p.waitFor(/agents \d\/\d/, 120_000);
		p.write(KEY.ctrl("t"));
		const s = await p.waitFor("╭─ agents", 10_000);
		dump("agent tree while it runs", s);
		p.write(KEY.esc);
		await p.waitFor((x) => /ready/i.test(x.split("\n").slice(-10).join("\n")) && idle(x), 180_000);
		p.write(KEY.ctrl("t"));
		dump("agent tree after the report", await p.waitFor("╭─ agents", 10_000));
		p.write(KEY.esc);
	});

	await step("64 columns", async () => {
		p.resize(64, 30);
		await Bun.sleep(1500);
		const s = p.text();
		dump("at 64 columns", s);
		const wide = s.split("\n").filter((l) => l.length > 64);
		if (wide.length) throw new Error(`${wide.length} lines wider than 64`);
	});

	await step("ctrl+c twice quits", async () => {
		p.write(KEY.ctrl("c"));
		await p.waitFor("ctrl+c again", 5000);
		p.write(KEY.ctrl("c"));
		const code = await Promise.race([p.proc.exited, Bun.sleep(5000).then(() => "still running")]);
		log(`tui exit: ${code}`);
		if (code !== 0) throw new Error(`exit ${code}`);
	});
} finally {
	log(`passed ${ok.length}: ${ok.join(", ")}`);
	log(`failed ${bad.length}: ${bad.join(", ") || "none"}`);
	await p.close().catch(() => {});
	process.exit(bad.length ? 1 : 0);
}
