/**
 * a23 and a26 gate driver: a real daemon on a dev port (never 4096), the real provider path, one thinking turn.
 * the turn's events are recorded with their arrival times and checked against the version 5 contract
 * (contract version 5): every streamed part announced before its deltas, reasoning deltas with
 * contiguous offsets, final parts with time; a part's final published when its block ends (the reasoning's
 * before the text is announced, its time.end no later than the text's time.start, the step's end publishing
 * the same part again); in-flight reads taken at the announcement, mid-thinking and right after the reasoning
 * ended (the part reads final once its block has ended); a stream resumed at each gets the part whole, before
 * any delta to it, and a part still streaming continues at the length it was resent with.
 *   bun packages/eval/src/a23.ts [--port 4832] [--model anthropic/claude-sonnet-5-5] [--effort high] [--prompt "..."] [--base-url http://127.0.0.1:4841]
 * --base-url points the anthropic provider at another messages api, such as boxbox's bench model
 * (`bun bench/model.ts --port 4841`, prompt "[bench:think 12 400]": twelve thinking words, one every 400 ms).
 * a model that does not think on the prompt fails the run (it says so); nothing is mocked.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daemon, gitRepo, nonce, port } from "./harness.ts";

const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1]! : fallback;
};
const PORT = Number(arg("port", String(port(4832))));
const MODEL = arg("model", "anthropic/claude-opus-5-5");
const EFFORT = arg("effort", "high");
const BASE = arg("base-url", "");
const PROMPT = arg("prompt", "how many positive integers below 300 are divisible by 3 or 7 but not by 21? work it out in your head, check it a second way, then answer in one short sentence. do not use any tools.");

const scratch = `/tmp/cmx2-a23-${nonce()}`;
const config = join(scratch, "config");
const repo = join(scratch, "repo");
mkdirSync(config, { recursive: true });
// the user's profile when there is one (the proxy path), else whatever the environment gives the daemon
const owner = join(homedir(), ".config", "cmx2", "cmx2.jsonc");
if (BASE) writeFileSync(join(config, "cmx2.jsonc"), JSON.stringify({ providers: { anthropic: { baseUrl: BASE, apiKey: "bench-ignores-this" } } }));
else if (existsSync(owner)) copyFileSync(owner, join(config, "cmx2.jsonc"));
else writeFileSync(join(config, "cmx2.jsonc"), "{}\n");
await gitRepo(repo, { "README.md": "# a23\n" });

const d = new Daemon({ port: PORT, dataDir: join(scratch, "data"), log: join(scratch, "daemon.log"), env: { CMX2_CONFIG_DIR: config, CMX2_MODEL: MODEL, CMX2_EFFORT: EFFORT } });
let failed = 0;
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed++;
};

type Frame = { at: number; id?: string; p: any };

/** an sse tap that keeps each frame with when it arrived */
function tap(headers: Record<string, string> = {}) {
	const frames: Frame[] = [];
	const ctl = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${d.base}/global/event`, { headers: d.headers(headers), signal: ctl.signal });
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const data = block.split("\n").find((l) => l.startsWith("data: "));
					if (!data) continue;
					const j = JSON.parse(data.slice(6));
					frames.push({ at: performance.now(), ...(block.startsWith("id: ") ? { id: block.split("\n")[0]!.slice(4) } : {}), p: j.payload ?? j });
				}
			}
		} catch {}
	})();
	return { frames, close: () => ctl.abort() };
}

async function until(pred: () => boolean, what: string, ms = 180_000) {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

try {
	await d.start();
	console.log(`daemon pid ${d.pid} on ${PORT}, data ${scratch}/data; model ${MODEL}, effort ${EFFORT}`);
	const health = await d.api("/global/health");
	console.log(`health: version ${health.version}, contract ${health.contract}`);
	check(health.contract === 5, "contract version 5");

	const live = tap();
	await until(() => live.frames.length > 0, "the stream");
	const id = (await d.api("/session", { directory: repo, title: `it-a23-${nonce()}` })).id as string;
	const t0 = performance.now();
	const epoch0 = Date.now();
	await d.api(`/session/${id}/prompt`, { text: PROMPT });
	const mine = () => live.frames.filter((f) => f.p.properties?.sessionID === id || f.p.properties?.info?.sessionID === id);
	const announced = () => new Map(mine().filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming).map((f) => [f.p.properties.part.id as string, f.p.properties.part as any]));

	// three moments around each message's thinking: the instant its reasoning part is announced (nothing streamed yet), once words have
	// arrived, and right after the reasoning's final arrived (its block has ended; the reply is starting or streaming)
	type Read = { label: string; messageID: string; at: number; seq: string; json: any; one: any; tap: ReturnType<typeof tap> };
	const reads: Read[] = [];
	const taken = new Set<string>();
	const readNow = async (label: string, messageID: string) => {
		const at = performance.now();
		const res = await d.raw(`/session/${id}/message?limit=5`);
		const json = await res.json();
		const seq = res.headers.get("x-cmx2-seq")!;
		const one = await d.api(`/session/${id}/message/${json.at(-1).info.id}`);
		reads.push({ label, messageID, at, seq, json, one, tap: tap({ "last-event-id": seq }) });
	};
	const settled = () => mine().some((f) => f.p.type === "session.idle");
	const watch = async () => {
		for (const [pid, p] of announced()) {
			if (p.type !== "reasoning") continue;
			const stage = async (name: string, label: string, when: () => boolean) => {
				if (!when() || taken.has(`${pid}:${name}`) || settled()) return;
				taken.add(`${pid}:${name}`);
				await readNow(label, p.messageID);
			};
			const fin = () => mine().some((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === pid && !f.p.properties.part.streaming);
			const words = () => mine().filter((f) => f.p.type === "message.part.delta" && f.p.properties.partID === pid).length;
			await stage("a", "at the announcement", () => true);
			await stage("b", "once words had streamed", () => words() >= 3 && !fin());
			await stage("c", "right after the reasoning's final arrived", fin);
		}
	};
	await until(() => announced().size > 0 || settled(), "the first part");
	const sawReasoning = [...announced().values()].some((p) => p.type === "reasoning");
	while (!settled()) {
		await watch();
		await Bun.sleep(10);
	}
	await Bun.sleep(300);
	live.close();
	for (const r of reads) r.tap.close();

	// ---- the recording ----
	const msgs = mine().filter((f) => f.p.type.startsWith("message."));
	const msgOf = (f: Frame) => (f.p.type === "message.updated" ? f.p.properties.info.id : f.p.type === "message.part.updated" ? f.p.properties.part.messageID : f.p.properties.messageID);
	// the message under test: the first assistant message that streamed reasoning and then text (else the first that streamed reasoning)
	const annByMessage = new Map<string, any[]>();
	for (const p of announced().values()) annByMessage.set(p.messageID, [...(annByMessage.get(p.messageID) ?? []), p]);
	const reasonThenText = (ps: any[]) => ps.some((r, i) => r.type === "reasoning" && ps.slice(i + 1).some((t) => t.type === "text"));
	const mid = ([...annByMessage].find(([, ps]) => reasonThenText(ps))?.[0] ?? [...annByMessage].find(([, ps]) => ps.some((p) => p.type === "reasoning"))?.[0] ?? msgs.find((f) => f.p.type === "message.updated" && f.p.properties.info.role === "assistant")?.p.properties.info.id) as string | undefined;
	const rec = msgs.filter((f) => msgOf(f) === mid);
	const ms = (f: Frame) => String(Math.round(f.at - t0)).padStart(6);
	console.log(`\nthe assistant message ${mid}: events with arrival times (ms after the prompt was sent); deltas of one part in a run are one row`);
	let run: { part: string; first: Frame; last: Frame; n: number; chars: number; next: number; contiguous: boolean; at: number[] } | undefined;
	const flush = () => {
		if (!run) return;
		console.log(`  ${String(Math.round(run.first.at - t0)).padStart(6)}..${String(Math.round(run.last.at - t0)).padEnd(6)}  no seq   message.part.delta    ${run.part.slice(-2)} x${run.n}  offsets 0..${run.next}  ${run.contiguous ? "contiguous" : "GAP"}  (${announced().get(run.part)?.type}) at ms ${run.at.slice(0, 16).join(" ")}${run.at.length > 16 ? " ..." : ""}`);
		run = undefined;
	};
	for (const f of rec) {
		const pr = f.p.properties;
		if (f.p.type === "message.part.delta") {
			if (run && run.part !== pr.partID) flush();
			if (!run) run = { part: pr.partID, first: f, last: f, n: 0, chars: 0, next: 0, contiguous: true, at: [] };
			run.contiguous &&= pr.offset === run.next;
			run.n++;
			run.at.push(Math.round(f.at - t0));
			run.last = f;
			run.next = pr.offset + pr.delta.length;
			continue;
		}
		flush();
		const seq = f.id ? `seq ${f.id.split(":")[1]!.padEnd(5)}` : "no seq   ";
		const what =
			f.p.type === "message.updated"
				? `${pr.info.role} ${pr.info.time.completed ? `completed ${pr.info.finish ?? ""}` : "created"}`
				: pr.part.type === "tool"
					? `${pr.part.id.slice(-2)} tool ${pr.part.tool} ${pr.part.state?.status}`
					: `${pr.part.id.slice(-2)} ${pr.part.type} ${pr.part.streaming ? "streaming" : "final"} text ${JSON.stringify(String(pr.part.text).slice(0, 48))}${String(pr.part.text).length > 48 ? `... (${String(pr.part.text).length} chars)` : ""} time ${JSON.stringify(pr.part.time)}`;
		console.log(`  ${ms(f)}         ${seq} ${f.p.type.padEnd(21)} ${what}`);
	}
	flush();

	const allDeltas = msgs.filter((f) => f.p.type === "message.part.delta");
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const isFinal = (f: Frame) => f.p.type === "message.part.updated" && !f.p.properties.part.streaming && (f.p.properties.part.type === "text" || f.p.properties.part.type === "reasoning");
	const finalFrames = (partID: string) => msgs.filter((f) => isFinal(f) && f.p.properties.part.id === partID);
	const lastFinal = (partID: string) => finalFrames(partID).at(-1)?.p.properties.part;

	console.log("\nchecks:");
	check(!!mid, "an assistant message streamed");
	check(sawReasoning, "the model thought: a reasoning part was announced");
	const ann = [...announced().values()].filter((p) => p.messageID === mid);
	check(ann.length >= 1 && ann.every((p) => p.text === "" && p.streaming === true && typeof p.time?.start === "number"), `every part announced empty, streaming, with time.start (${ann.map((p) => p.type).join(", ")})`);
	const deltas = rec.filter((f) => f.p.type === "message.part.delta");
	const first = new Map<string, number>();
	for (const f of rec) if (f.p.type === "message.part.updated" && f.p.properties.part.streaming && !first.has(f.p.properties.part.id)) first.set(f.p.properties.part.id, rec.indexOf(f));
	check(deltas.every((f) => first.has(f.p.properties.partID) && first.get(f.p.properties.partID)! < rec.indexOf(f)), "every delta came after its part's announcement");
	check(rec.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.streaming).every((f) => f.id !== undefined), "announcements are logged and numbered");
	check(deltas.every((f) => f.id === undefined), "deltas carry no seq");
	const offsets = new Map<string, number>();
	let contiguous = true;
	for (const f of deltas) {
		contiguous &&= f.p.properties.offset === (offsets.get(f.p.properties.partID) ?? 0);
		offsets.set(f.p.properties.partID, f.p.properties.offset + f.p.properties.delta.length);
	}
	check(contiguous, "offsets are contiguous per part");
	const order = ann.map((p) => Number(p.id.split("_").at(-1)));
	check(order.every((n, i) => i === 0 || n > order[i - 1]!), `announced in content order (positions ${order.join(", ")})`);
	check(ann.every((p) => finalFrames(p.id).length === 2), "each part's final is published twice: when its block ends, and when the step does");
	const textFinals = ann.map((p) => lastFinal(p.id)).filter(Boolean);
	check(textFinals.length === ann.length && textFinals.every((p, i) => p.id === ann[i]!.id && p.streaming === undefined && p.time.start === ann[i]!.time.start && p.time.end >= p.time.start), "each part's final carries time {start, end}, start as announced, no streaming");
	check(ann.every((p) => same(finalFrames(p.id)[0]?.p.properties.part, finalFrames(p.id)[1]?.p.properties.part)), "the step's end publishes each part again: the same text, the same time.end");
	check(ann.every((p) => finalFrames(p.id).every((f) => f.id !== undefined)), "finals are logged and numbered");
	check(textFinals.every((p) => offsets.get(p.id) === undefined || p.text.length === offsets.get(p.id)), "each final's text is as long as the deltas that built it");
	check(ann.every((p) => !rec.some((f) => f.p.type === "message.part.delta" && f.p.properties.partID === p.id && rec.indexOf(f) > rec.indexOf(finalFrames(p.id)[0]!))), "no delta reached a part after its final");
	const stored = (await d.api(`/session/${id}/message`)).find((m: any) => m.info.id === mid);
	check(stored.parts.every((p: any) => p.streaming === undefined) && same(stored.parts.filter((p: any) => p.type === "text" || p.type === "reasoning"), textFinals), "the store returns the same parts, with time, on a read after the turn");

	// a26: the reasoning's final arrives when its block ended, before the text is announced and before its first delta
	const rAnn = ann.find((p) => p.type === "reasoning");
	const tAnn = ann.find((p) => p.type === "text" && Number(p.id.split("_").at(-1)) > Number(rAnn?.id.split("_").at(-1)));
	if (rAnn) {
		const rEarly = finalFrames(rAnn.id)[0]!;
		const rLate = finalFrames(rAnn.id)[1]!;
		const lag = (f: Frame) => Math.round(epoch0 + (f.at - t0) - f.p.properties.part.time.end);
		console.log(`\nthe reasoning part ${rAnn.id.slice(-2)}: time {start ${rEarly.p.properties.part.time.start - epoch0}, end ${rEarly.p.properties.part.time.end - epoch0}} ms after the prompt (the daemon's clock);`);
		console.log(`  its final arrived at ${ms(rEarly).trim()} ms (seq ${rEarly.id?.split(":")[1]}), ${lag(rEarly)} ms after time.end; published again at the step's end, ${ms(rLate).trim()} ms (seq ${rLate.id?.split(":")[1]}), ${lag(rLate)} ms after time.end`);
		check(lag(rEarly) < 1000 && rEarly.at < rLate.at, "the reasoning's final was published when its block ended, not with the step (it arrived within a second of time.end, ahead of the step's end)");
		if (tAnn) {
			const tAnnFrame = rec.find((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === tAnn.id && f.p.properties.part.streaming)!;
			const tFirst = rec.find((f) => f.p.type === "message.part.delta" && f.p.properties.partID === tAnn.id);
			console.log(`  the text part ${tAnn.id.slice(-2)}: announced at ${ms(tAnnFrame).trim()} ms (seq ${tAnnFrame.id?.split(":")[1]}), time.start ${tAnn.time.start - epoch0}; its first delta at ${tFirst ? ms(tFirst).trim() : "none"} ms`);
			check(rec.indexOf(rEarly) < rec.indexOf(tAnnFrame) && Number(rEarly.id!.split(":")[1]) < Number(tAnnFrame.id!.split(":")[1]), "the reasoning's final (numbered) came before the text's announcement");
			check(!!tFirst && rec.indexOf(rEarly) < rec.indexOf(tFirst) && rEarly.at <= tFirst.at, "the reasoning's final arrived before the text's first delta");
			check(rEarly.p.properties.part.time.end <= tAnn.time.start, "the reasoning's time.end is no later than the text's time.start");
			check(rec.indexOf(rLate) > rec.indexOf(rec.filter((f) => f.p.type === "message.part.delta").at(-1)!), "the step-end final came after the last delta");
		} else {
			check(false, "no text part followed the thinking in this message (the model called a tool or ended); rerun, or give a prompt that answers in words");
		}
	}

	for (const r of reads) {
		const last = r.json.at(-1);
		const part = last.parts[0];
		if (last.info.id !== r.messageID) {
			console.log(`\nread ${r.label} (${r.messageID.slice(-5)}): the session had moved on to ${last.info.id.slice(-5)} by the read; not checked`);
			continue;
		}
		const finalOfPart = part ? lastFinal(part.id) : undefined;
		const stepEnded = last.parts.some((p: any) => p.type === "tool") || last.info.time.completed !== undefined;
		console.log(`\nread ${r.label} of message ${r.messageID.slice(-5)}${r.messageID === mid ? " (the message under test)" : ""}, ${Math.round(r.at - t0)} ms after the prompt (x-cmx2-seq ${r.seq})${stepEnded ? ", after the step had ended (the stored message)" : ", while the message streams"}:`);
		console.log(`  GET /session/${id}/message?limit=5 -> last message ${last.info.id.slice(-5)} role ${last.info.role} completed ${last.info.time.completed ?? "no"}; parts ${JSON.stringify(last.parts.map((p: any) => ({ id: p.id.slice(-2), type: p.type, streaming: p.streaming, time: p.time, chars: p.text?.length, tool: p.tool })))}`);
		console.log(`  GET /session/${id}/message/${r.one.info.id.slice(-5)} -> parts ${JSON.stringify(r.one.parts.map((p: any) => ({ id: p.id.slice(-2), type: p.type, streaming: p.streaming, chars: p.text?.length })))}`);
		console.log(`  the reasoning text: ${JSON.stringify(part.text.length > 90 ? `${part.text.slice(0, 90)}...` : part.text)} (${part.text.length} chars)`);
		const frames = r.tap.frames;
		const rs = frames.filter((f) => f.p.type === "message.part.updated" && f.p.properties.part.id === part.id);
		const firstDelta = frames.findIndex((f) => f.p.type === "message.part.delta" && f.p.properties.partID === part.id);
		console.log(`  resumed from ${r.seq}: frames ${frames.map((f) => (f.p.type === "message.part.delta" ? `delta@${f.p.properties.offset}` : f.p.type === "message.part.updated" ? `${f.p.properties.part.type}:${f.p.properties.part.streaming ? "streaming" : "final"}[${f.p.properties.part.text?.length ?? "-"}]${f.id ? "#" + f.id.split(":")[1] : ""}` : f.p.type.replace("message.", ""))).slice(0, 14).join(", ")}${frames.length > 14 ? ", ..." : ""}`);
		check(part.type === "reasoning" && typeof part.time?.start === "number" && part.time.start === announced().get(part.id)?.time.start, "the read returned the typed reasoning part with the time.start it was announced with");
		check(r.one.parts[0].type === "reasoning" && r.one.parts[0].text.startsWith(part.text), "GET message/:id reads the same part");
		if (part.streaming) {
			check(!!finalOfPart && finalOfPart.text.startsWith(part.text) && allDeltas.filter((f) => f.p.properties.partID === part.id && f.p.properties.offset < part.text.length).map((f) => f.p.properties.delta).join("") === part.text, "streaming: its text so far is a prefix of the final text and exactly the deltas below its length");
			check(rs.length >= 1 && rs[0]!.id === undefined && rs[0]!.p.properties.part.streaming === true && rs[0]!.p.properties.part.text.startsWith(part.text) && (firstDelta < 0 || frames.indexOf(rs[0]!) < firstDelta), "the resume resent the reasoning part whole, unnumbered, ahead of any delta");
			check(firstDelta < 0 || frames[firstDelta]!.p.properties.offset === rs[0]!.p.properties.part.text.length, "the first delta after the resend continues at its length");
		} else {
			check(part.streaming === undefined && typeof part.time.end === "number" && part.time.end >= part.time.start, "ended: the read returned the reasoning part final, with time {start, end}, not streaming");
			check(same(part, finalOfPart), "ended: it is exactly the final the stream carried (same text, same time)");
			// a read taken after its step ended, resumed at a cursor past the step's finals, owes nothing: the log replay starts after them
			check(firstDelta < 0 && rs.every((f) => same(f.p.properties.part, part)) && (stepEnded || rs.length >= 1), stepEnded ? "the resume (past the step's finals) did not reopen the part: no delta, and any copy of it is the final" : "the resume brought the part whole and final (not streaming), and no delta ever came to it");
			console.log(`  the resent part: ${rs[0] ? `${rs[0].id ? "numbered (replayed from the log)" : "unnumbered (resent from the in-flight state)"}, streaming ${rs[0].p.properties.part.streaming ?? "absent"}` : "none"}`);
		}
	}
} catch (e) {
	console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
	failed++;
} finally {
	await d.stop();
}
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}; scratch ${scratch} (daemon log ${scratch}/daemon.log.err)`);
process.exit(failed ? 1 : 0);
