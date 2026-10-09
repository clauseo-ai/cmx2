import { afterAll, expect, test } from "bun:test";
import { port } from "../../eval/src/harness.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@cmx2/engine/config";
import { Notifier, notifyCommand, notifyConfig } from "../src/notify.ts";
import { Pairing } from "../src/pair.ts";
import { blacklisted, REDACTED, redactConfig, variantEffort } from "../src/profile.ts";
import { serve } from "../src/index.ts";

/**
 * pairing (a12), the profile over http, the blacklist and named variants, and the desktop note, against
 * a daemon on a real socket (port 4837, shifted by CMX2_PORT_SHIFT). no model is called here; /init runs a real turn in m8.ts.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-ops-")));
const cfgDir = join(root, "config");
const data = join(root, "data");
mkdirSync(cfgDir);
const PROFILE = `// a profile with a comment that must survive a patch
{
  "model": "anthropic/claude-opus-5-5",
  "providers": {
    "anthropic": { "apiKey": "sk-literal-secret", "headers": { "x-team": "abc" }, "blacklist": ["*-fast", "claude-fable-5"] },
    "google": { "apiKey": "$GEMINI_API_KEY" }
  },
  "variants": { "anthropic/claude-opus-5-5": { "quick": { "effort": "low" }, "deep": { "effort": "high" } } }
}
`;
writeFileSync(join(cfgDir, "cmx2.jsonc"), PROFILE);
const prevDir = process.env.CMX2_CONFIG_DIR;
process.env.CMX2_CONFIG_DIR = cfgDir;
const config = loadConfig();
const daemon = serve({ config, port: port(4837), hostname: "127.0.0.1", dataDir: data, checkEvents: true });
const base = `http://127.0.0.1:${port(4837)}`;
afterAll(async () => {
	await daemon.stop();
	if (prevDir === undefined) delete process.env.CMX2_CONFIG_DIR;
	else process.env.CMX2_CONFIG_DIR = prevDir;
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

test("pairing: a one-time token becomes a bearer once; after that requests need one; revoke bites at once", async () => {
	// nothing paired yet: open, as before
	expect((await get("/global/health")).status).toBe(200);
	const pairing = new Pairing(data);
	const local = readFileSync(join(data, "auth", "local.token"), "utf8").trim();
	expect(statSync(join(data, "auth", "local.token")).mode & 0o777).toBe(0o600);
	const { token } = pairing.begin();
	const r = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "phone" }) });
	expect(r.status).toBe(200);
	const cred = (await r.json()) as { id: string; name: string; credential: string; scheme: string; contract: number };
	expect(cred).toMatchObject({ name: "phone", scheme: "Bearer" });
	console.log(`paired: ${cred.id} ${cred.name}, credential ${cred.credential.slice(0, 9)}… (${cred.credential.length} chars), contract ${cred.contract}`);
	// the same token again is refused
	const again = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
	expect(again.status).toBe(401);
	console.log(`token reused: ${again.status} ${((await again.json()) as { data: { message: string } }).data.message}`);
	// paired now: no credential is 401, the bearer and the local token pass
	const anon = await get("/session");
	expect(anon.status).toBe(401);
	console.log(`no credential: ${anon.status} ${((await anon.json()) as { data: { message: string } }).data.message}`);
	expect((await get("/session", { authorization: `Bearer ${cred.credential}` })).status).toBe(200);
	expect((await get("/session", { authorization: `Bearer ${local}` })).status).toBe(200);
	expect((await get("/session", { authorization: "Bearer cmx2_not-a-real-one" })).status).toBe(401);
	// the event stream honours it too
	const sse = await fetch(`${base}/global/event`, { headers: { authorization: `Bearer ${cred.credential}` } });
	expect(sse.status).toBe(200);
	await sse.body?.cancel();
	expect((await fetch(`${base}/global/event`)).status).toBe(401);
	// only hashes on disk
	expect(readFileSync(join(data, "auth", "credentials.json"), "utf8")).not.toContain(cred.credential);
	// revoke by id: the next request is 401, the local token still works, and with no client left it is open again
	expect(pairing.revoke(cred.id).map((c) => c.id)).toEqual([cred.id]);
	const after = await get("/session", { authorization: `Bearer ${cred.credential}` });
	expect(after.status).toBe(401);
	console.log(`after revoke: ${after.status}`);
	expect((await get("/session", { authorization: `Bearer ${local}` })).status).toBe(200);
	expect((await get("/session")).status).toBe(200);
});

test("pairing: an expired token is refused and spent", async () => {
	const pairing = new Pairing(data);
	const { token } = pairing.begin("late", Date.now() - 11 * 60_000);
	const r = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
	expect(r.status).toBe(401);
	expect(((await r.json()) as { data: { message: string } }).data.message).toContain("expired");
	const bad = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
	expect(bad.status).toBe(400);
});

test("GET /config: merged profile with literal keys and header values masked, env references kept", async () => {
	const r = await get("/config");
	expect(r.status).toBe(200);
	expect(r.headers.get("x-cmx2-seq")).toMatch(/:\d+$/);
	const c = (await r.json()) as any;
	expect(c.providers.anthropic.apiKey).toBe(REDACTED);
	expect(c.providers.anthropic.headers["x-team"]).toBe(REDACTED);
	expect(c.providers.google.apiKey).toBe("$GEMINI_API_KEY");
	expect(c.sources).toEqual(["cmx2.jsonc"]);
	expect(JSON.stringify(c)).not.toContain("sk-literal-secret");
	console.log(`GET /config providers: ${JSON.stringify(c.providers)}`);
});

test("PATCH /config: merge patch into cmx2.jsonc keeps comments, reloads, refuses masks and bad values", async () => {
	const r = await fetch(`${base}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ effort: "high", notify: true, providers: { google: null } }) });
	expect(r.status).toBe(200);
	const body = (await r.json()) as { changed: string[]; config: any };
	expect(body.changed.sort()).toEqual(["effort", "notify", "providers.google"]);
	expect(body.config.effort).toBe("high");
	expect(body.config.providers.google).toBeUndefined();
	const text = readFileSync(join(cfgDir, "cmx2.jsonc"), "utf8");
	expect(text).toContain("// a profile with a comment that must survive a patch");
	expect(text).toContain('"effort": "high"');
	expect(text).toContain("sk-literal-secret");
	// the running daemon took it
	expect(((await (await get("/config")).json()) as any).effort).toBe("high");
	const masked = await fetch(`${base}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: { anthropic: { apiKey: REDACTED } } }) });
	expect(masked.status).toBe(400);
	const wrong = await fetch(`${base}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ effort: "huge" }) });
	expect(wrong.status).toBe(400);
	console.log(`bad patch: ${((await wrong.json()) as { data: { message: string } }).data.message}`);
	// the refused patch left the file as it was
	expect(readFileSync(join(cfgDir, "cmx2.jsonc"), "utf8")).toBe(text);
});

test("the blacklist leaves the pickers and is refused; named variants list and pick an effort", async () => {
	const p = (await (await get("/config/providers")).json()) as { providers: Array<{ id: string; models: Record<string, { variants: Record<string, unknown> }> }> };
	const anthropic = p.providers.find((x) => x.id === "anthropic")!;
	const ids = Object.keys(anthropic.models);
	expect(ids).not.toContain("claude-fable-5");
	expect(ids.some((i) => i.endsWith("-fast"))).toBe(false);
	expect(ids).toContain("claude-opus-5-5");
	expect(anthropic.models["claude-opus-5-5"]!.variants).toMatchObject({ quick: { effort: "low" }, deep: { effort: "high" } });
	console.log(`anthropic models after the blacklist: ${ids.join(", ")}; opus variants: ${Object.keys(anthropic.models["claude-opus-5-5"]!.variants).join(", ")}`);
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const refused = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: work, model: "anthropic/claude-fable-5" }) });
	expect(refused.status).toBe(400);
	console.log(`blacklisted create: ${((await refused.json()) as { data: { message: string } }).data.message}`);
	expect(blacklisted(config, "anthropic/claude-opus-5-5-fast")).toBe(true);
	expect(variantEffort(config, "anthropic/claude-opus-5-5", "quick")).toBe("low");
	expect(variantEffort(config, "anthropic/claude-sonnet-5-5", "quick")).toBeUndefined();
});

test("a profile with a malformed blacklist or variant is refused with the fix", async () => {
	writeFileSync(join(cfgDir, "cmx2.jsonc"), `{ "variants": { "opus": { "x": { "effort": "huge" } } } }`);
	const r = await fetch(`${base}/global/reload`, { method: "POST" });
	expect(r.status).toBe(400);
	console.log(`bad variants: ${((await r.json()) as { data: { message: string } }).data.message}`);
	writeFileSync(join(cfgDir, "cmx2.jsonc"), PROFILE);
});

test("redaction masks secrets in mcp env and headers too", () => {
	const c = { ...config, mcp: { gh: { url: "https://x.example/mcp", headers: { authorization: "Bearer abc" } }, fs: { command: ["x"], env: { TOKEN: "t0k", HOME_REF: "$HOME" } } } };
	const r = redactConfig(c as never) as any;
	expect(r.mcp.gh.headers.authorization).toBe(REDACTED);
	expect(r.mcp.fs.env).toEqual({ TOKEN: REDACTED, HOME_REF: "$HOME" });
	expect(r.mcp.gh.url).toBe("https://x.example/mcp");
});

test("the desktop note: opt-in, only with nobody watching, one per session per quiet period", () => {
	expect(notifyConfig(undefined).desktop).toBe(false);
	expect(notifyConfig(true).desktop).toBe(true);
	expect(notifyConfig({ desktop: true }).desktop).toBe(true);
	let enabled = false;
	let watchers = 1;
	const sent: string[][] = [];
	const n = new Notifier({ enabled: () => enabled, watchers: () => watchers, titleOf: () => "fix the build", send: (a) => sent.push(a) });
	const ask = { sessionID: "ses_1", permission: "shell", patterns: ["rm -rf dist"] };
	expect(n.onEvent("permission.asked", ask, 0)).toBeUndefined();
	enabled = true;
	expect(n.onEvent("permission.asked", ask, 0)).toBeUndefined();
	watchers = 0;
	const note = n.onEvent("permission.asked", ask, 1000)!;
	expect(note).toMatchObject({ title: "cmx2 · fix the build", body: "wants permission for shell: rm -rf dist" });
	expect(n.onEvent("question.asked", { sessionID: "ses_1", questions: [{ question: "which port?" }] }, 2000)).toBeUndefined();
	expect(n.onEvent("question.asked", { sessionID: "ses_1", questions: [{ question: "which port?" }] }, 40_000)!.body).toBe("asks: which port?");
	expect(n.onEvent("session.updated", { sessionID: "ses_2" }, 50_000)).toBeUndefined();
	const argv = notifyCommand(note, "darwin", (c) => (c === "terminal-notifier" ? "/opt/homebrew/bin/terminal-notifier" : undefined))!;
	expect(argv.slice(0, 5)).toEqual(["/opt/homebrew/bin/terminal-notifier", "-title", "cmx2 · fix the build", "-message", "wants permission for shell: rm -rf dist"]);
	expect(notifyCommand(note, "darwin", () => undefined)![0]).toBe("osascript");
	expect(notifyCommand(note, "linux", (c) => (c === "notify-send" ? "/usr/bin/notify-send" : undefined))).toEqual(["/usr/bin/notify-send", "--app-name=cmx2", "cmx2 · fix the build", "wants permission for shell: rm -rf dist"]);
	expect(notifyCommand(note, "linux", () => undefined)).toBeUndefined();
	expect(sent.length).toBe(2);
});

test("/init is a built-in command a project file can replace", async () => {
	const work = join(root, "init-proj");
	mkdirSync(join(work, ".cmx2", "command"), { recursive: true });
	const list = (await (await get(`/command?directory=${encodeURIComponent(work)}`)).json()) as Array<{ name: string; description?: string; template: string }>;
	const init = list.find((c) => c.name === "init")!;
	expect(init.description).toContain("AGENTS.md");
	expect(init.template).toContain("write an AGENTS.md at the root of this project");
	writeFileSync(join(work, ".cmx2", "command", "init.md"), "---\ndescription: ours\n---\nour own init");
	await fetch(`${base}/global/reload`, { method: "POST" });
	const again = (await (await get(`/command?directory=${encodeURIComponent(work)}`)).json()) as Array<{ name: string; description?: string }>;
	expect(again.filter((c) => c.name === "init")).toEqual([expect.objectContaining({ description: "ours" })]);
});
