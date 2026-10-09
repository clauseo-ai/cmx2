/**
 * files and documents: `GET /find/text`, `GET /file/status`, `vcs` on the session row,
 * and, through a real model on a real daemon, `file.edited`, the formatter and language-server errors in
 * a write's result, and a pdf attached to a prompt read as a document.
 *
 * the routes run on a daemon in this process (port 4837, no model) and always run. the model part runs on a cli
 * daemon on port 4832 and needs a provider key or profile and CMX2_LIVE_TESTS=1, else it is skipped and no daemon
 * starts. the live profile is the config dir in $CMX2_LIVE_PROFILE if set, else ~/.config/cmx2/cmx2.jsonc, else
 * ANTHROPIC_API_KEY from the env.
 *
 * run: bun test packages/server/test/files.test.ts (add CMX2_LIVE_TESTS=1 for the model part; a minute or two)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { DEFAULTS } from "@cmx2/engine/config";
import { Daemon, gitRepo, liveDescribe, liveNote, liveProfile, nonce, port } from "../../eval/src/harness.ts";
import { makePdf } from "../../eval/src/pdf.ts";
import { serve } from "../src/index.ts";

const N = nonce();
const SCRATCH = realpathSync((mkdirSync(`/tmp/cmx2-files-${N}`, { recursive: true }), `/tmp/cmx2-files-${N}`));

describe("routes, no model", () => {
	const repo = join(SCRATCH, "repo");
	let d: ReturnType<typeof serve>;
	let base = "";
	const get = async (path: string) => {
		const r = await fetch(base + path, { headers: { "x-cmx2-directory": repo } });
		return { status: r.status, headers: r.headers, json: await r.json() };
	};
	beforeAll(async () => {
		await gitRepo(repo, { "src/a.ts": "export const alpha = 1;\n// TODO: tidy\n", "src/b.ts": "export const beta = 'Beta';\n", "README.md": "# repo\n\nhéllo TODO\n" });
		const config = { ...structuredClone(DEFAULTS), sources: [] };
		d = serve({ config, port: port(4837), hostname: "127.0.0.1", dataDir: join(SCRATCH, "data-routes"), checkEvents: true, reload: () => config });
		base = `http://127.0.0.1:${d.server.port}`;
	});
	afterAll(() => d?.stop());

	test("find/text: ripgrep matches with utf-16 offsets, literal and glob narrow it, a bad regex is a typed 400", async () => {
		const all = (await get("/find/text?pattern=TODO")).json;
		expect(all.map((m: any) => `${m.path}:${m.line}`)).toEqual(["README.md:3", "src/a.ts:2"]);
		const readme = all.find((m: any) => m.path === "README.md");
		expect(readme.text.slice(readme.submatches[0].start, readme.submatches[0].end)).toBe("TODO");
		expect((await get("/find/text?pattern=TODO&glob=*.ts")).json.map((m: any) => m.path)).toEqual(["src/a.ts"]);
		expect((await get(`/find/text?pattern=${encodeURIComponent("alpha = (")}&literal=true`)).json).toEqual([]);
		const limited = await get("/find/text?pattern=e&limit=1");
		expect([limited.json.length, limited.headers.get("x-truncated")]).toEqual([1, "true"]);
		const bad = await get(`/find/text?pattern=${encodeURIComponent("(")}`);
		expect([bad.status, bad.json.name]).toEqual([400, "BadRequestError"]);
		console.log(`find/text: ${JSON.stringify(readme)}`);
	});

	test("file/status and vcs: the work tree's changes with line counts; the session row names the branch and whether it is dirty", async () => {
		const s = await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json", "x-cmx2-directory": repo }, body: JSON.stringify({ title: `it-vcs-${N}` }) })).json();
		expect(s.vcs).toEqual({ branch: "main", dirty: false });
		expect((await get("/file/status")).json).toEqual([]);
		writeFileSync(join(repo, "src/a.ts"), "export const alpha = 2;\n");
		writeFileSync(join(repo, "src/new.ts"), "one\ntwo\nthree\n");
		await $`git rm -q README.md`.cwd(repo).quiet();
		const st = (await get("/file/status")).json;
		console.log(`file/status: ${JSON.stringify(st)}`);
		expect(st).toEqual([
			{ path: "README.md", status: "deleted", added: 0, removed: 3 },
			{ path: "src/a.ts", status: "modified", added: 1, removed: 2 },
			{ path: "src/new.ts", status: "untracked", added: 3, removed: 0 },
		]);
		const nested = await (await fetch(`${base}/file/status`, { headers: { "x-cmx2-directory": join(repo, "src") } })).json();
		expect(nested.map((f: any) => f.path)).toEqual(["a.ts", "new.ts"]);
		expect((await get(`/file/status?directory=${encodeURIComponent(SCRATCH)}`)).status).toBe(400);
		// the row's cache is dropped when a turn ends or a file is edited; a fresh session in the same place sees it now
		const again = await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json", "x-cmx2-directory": join(repo, "src") }, body: "{}" })).json();
		expect(again.vcs).toEqual({ branch: "main", dirty: true });
		expect((await get(`/session/${s.id}`)).json.vcs.branch).toBe("main");
	});
});

liveNote("the model part of files.test.ts");
liveDescribe("a real daemon and a real provider", () => {
	const CONFIG = join(SCRATCH, "config");
	const proj = join(SCRATCH, "proj");
	let d: Daemon;
	beforeAll(async () => {
		liveProfile(CONFIG);
		await gitRepo(proj, { "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", noEmit: true } }), ".prettierrc": "{}\n", "calc.ts": "export function double(n: number): number {\n  return n * 2;\n}\n" });
		mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
		symlinkSync(join(import.meta.dir, "..", "..", "tools", "node_modules", ".bin", "prettier"), join(proj, "node_modules", ".bin", "prettier"));
		d = new Daemon({ port: port(4832), dataDir: join(SCRATCH, "data-real"), log: join(SCRATCH, "daemon.log"), env: { CMX2_CONFIG_DIR: CONFIG, CMX2_MODEL: "anthropic/claude-sonnet-5-5", CMX2_EFFORT: "low" } });
		await d.start();
	}, 30_000);
	afterAll(() => d?.stop());

	test(
		"a write by the model: file.edited, the formatter and the language server's errors in its result, the row turns dirty",
		async () => {
			const frames: any[] = [];
			const ctl = new AbortController();
			void (async () => {
				try {
					const res = await fetch(`${d.base}/global/event`, { signal: ctl.signal });
					const reader = res.body!.getReader();
					const dec = new TextDecoder();
					let buf = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buf += dec.decode(value, { stream: true });
						let i: number;
						while ((i = buf.indexOf("\n\n")) >= 0) {
							const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
							buf = buf.slice(i + 2);
							if (line) frames.push(JSON.parse(line.slice(6)).payload);
						}
					}
				} catch {}
			})();
			const id = (await d.api("/session", { directory: proj, title: `it-write-${N}` })).id;
			await d.api(`/session/${id}/prompt`, {
				text: 'use the write tool once to create use.ts with exactly this content and nothing else, then stop and tell me what the write tool reported:\nimport {double} from "./calc"\nconst a:string=double(2)\nconsole.log(a)',
			});
			await d.idle(id, 180_000);
			ctl.abort();
			const msgs = await d.api(`/session/${id}/message`);
			const write = msgs.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool" && p.tool === "write");
			console.log(`write result: ${JSON.stringify(write?.state.output)}`);
			expect(write.state.output).toContain("prettier reformatted the file");
			expect(write.state.output).toMatch(/typescript-language-server reports 1 error in this file now:\nuse\.ts:2:7: Type 'number' is not assignable to type 'string'/);
			expect(readFileSync(join(proj, "use.ts"), "utf8")).toBe('import { double } from "./calc";\nconst a: string = double(2);\nconsole.log(a);\n');
			const edited = frames.find((f) => f.type === "file.edited" && f.properties.sessionID === id);
			expect(edited?.properties.file).toBe(join(proj, "use.ts"));
			const updated = frames.filter((f) => f.type === "session.updated" && f.properties.sessionID === id).at(-1);
			expect(updated.properties.info.vcs).toEqual({ branch: "main", dirty: true });
			console.log(`file.edited ${JSON.stringify(edited.properties)}; last session.updated vcs ${JSON.stringify(updated.properties.info.vcs)}`);
		},
		240_000,
	);

	test(
		"a pdf attached to a prompt reaches the model as a document and is read",
		async () => {
			const word = `lantern-${N}`;
			const pdf = makePdf(["quarterly notes", `the password is ${word}`, "nothing else matters here"]);
			const id = (await d.api("/session", { directory: proj, title: `it-pdf-${N}` })).id;
			await d.api(`/session/${id}/prompt`, {
				parts: [
					{ type: "text", text: "what is the password in the attached pdf? answer with the password only." },
					{ type: "file", mime: "application/pdf", filename: "notes.pdf", url: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` },
				],
			});
			await d.idle(id, 180_000);
			const msgs = await d.api(`/session/${id}/message`);
			const part = msgs[0].parts.find((p: any) => p.type === "file");
			const answer = msgs.at(-1).parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
			const reqs = await d.api(`/session/${id}/requests`);
			console.log(`pdf: part ${part.mime} ${part.filename} ${part.size} bytes (data url ${part.url.length} chars); request gates ${JSON.stringify(reqs[0].gates)}; answer ${JSON.stringify(answer)}`);
			expect(part).toMatchObject({ mime: "application/pdf", filename: "notes.pdf" });
			expect(reqs[0].gates).toContain("documents:1");
			expect(answer).toContain(word);
		},
		240_000,
	);
});
