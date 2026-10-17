import { afterAll, afterEach, expect, test } from "bun:test";
import { webcrawlTool, webfetchTool, websearchTool } from "../src/deferred.ts";
import { formatHits, isPrivateUrl, pickSearch, runSearch } from "../src/web.ts";
import { scratch, textOf } from "./helpers.ts";

type Seen = { method: string; path: string; headers: Record<string, string>; query: Record<string, string>; body?: any };
/** one fake server for every backend; it records what each was sent. `tavilyDown` makes tavily answer 429 */
const seen: Seen[] = [];
let tavilyDown = false;
const api = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const u = new URL(req.url);
		const body = req.method === "POST" ? await req.json() : undefined;
		seen.push({ method: req.method, path: u.pathname, headers: req.headers.toJSON(), query: Object.fromEntries(u.searchParams), body });
		const auth = req.headers.get("authorization");
		const keyless = req.headers.get("x-tavily-access-mode") === "keyless";
		const tavilyAuthed = () => (tavilyDown ? Response.json({ detail: { error: "slow down" } }, { status: 429, headers: { "retry-after": "30" } }) : auth === "Bearer tvly-good" || (keyless && !auth) ? undefined : Response.json({ detail: { error: "Unauthorized" } }, { status: 401 }));
		if (req.method === "POST" && u.pathname === "/search") {
			const bad = tavilyAuthed();
			if (bad) return bad;
			return Response.json({ query: body.query, results: [{ title: "Tavily hit", url: "https://t.test/a", content: "about it", published_date: "2026-10-01" }] });
		}
		if (req.method === "POST" && u.pathname === "/extract") {
			const bad = tavilyAuthed();
			if (bad) return bad;
			return Response.json({ results: [{ url: body.urls[0], raw_content: "# Rendered\n\nbody from js" }], failed_results: [] });
		}
		if (req.method === "POST" && (u.pathname === "/map" || u.pathname === "/crawl")) {
			if (auth !== "Bearer tvly-good") return Response.json({ detail: { error: "Unauthorized" } }, { status: 401 });
			const urls = ["https://docs.test/", "https://docs.test/auth"];
			return Response.json({ base_url: "docs.test", results: u.pathname === "/map" ? urls : urls.map((url) => ({ url, raw_content: `text of ${url}` })) });
		}
		if (u.pathname === "/res/v1/web/search") {
			return Response.json({ web: { results: [{ title: "Brave <strong>hit</strong>", url: "https://b.test/a", description: "the <strong>best</strong> &amp; more", extra_snippets: ["second"] }] } });
		}
		if (u.pathname === "/search") {
			return Response.json({ results: [1, 2, 3].map((i) => ({ title: `S${i}`, url: `https://s.test/${i}`, content: `c${i}` })) });
		}
		if (u.pathname === "/mcp") {
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa hit\nURL: https://e.test/a\nText: x" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		}
		if (u.pathname === "/page") return new Response("<p>local page</p>", { headers: { "content-type": "text/html" } });
		return new Response("gone", { status: 404 });
	},
});
const base = `http://127.0.0.1:${api.port}`;
/** auto mode reaches tavily and exa through their env overrides, pointed at the fake */
const saved = { t: process.env.CMX2_TAVILY_URL, e: process.env.CMX2_WEBSEARCH_URL, k: process.env.TAVILY_API_KEY, x: process.env.EXA_API_KEY, b: process.env.BRAVE_API_KEY };
process.env.CMX2_TAVILY_URL = base;
process.env.CMX2_WEBSEARCH_URL = `${base}/mcp`;
for (const k of ["TAVILY_API_KEY", "EXA_API_KEY", "BRAVE_API_KEY"]) delete process.env[k];
afterEach(() => {
	tavilyDown = false;
});
afterAll(() => {
	api.stop(true);
	const put = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
	put("CMX2_TAVILY_URL", saved.t);
	put("CMX2_WEBSEARCH_URL", saved.e);
	put("TAVILY_API_KEY", saved.k);
	put("EXA_API_KEY", saved.x);
	put("BRAVE_API_KEY", saved.b);
});
const signal = () => AbortSignal.timeout(5000);
const last = (f: (s: Seen) => boolean) => seen.findLast(f)!;

test("pickSearch: the profile's provider wins, else the first key in the environment (tavily, exa, brave), else keyless tavily", () => {
	expect(pickSearch({}, {})).toEqual({ provider: "tavily", auto: true });
	expect(pickSearch({}, { EXA_API_KEY: "e", TAVILY_API_KEY: "t" })).toEqual({ provider: "tavily", key: "t", auto: true });
	expect(pickSearch({}, { EXA_API_KEY: "e", BRAVE_API_KEY: "b" })).toEqual({ provider: "exa", key: "e", auto: true });
	expect(pickSearch({ provider: "brave" }, { TAVILY_API_KEY: "t", BRAVE_API_KEY: "b" })).toEqual({ provider: "brave", key: "b" });
	expect(pickSearch({ provider: "tavily", key: () => "from-profile" }, { TAVILY_API_KEY: "t" })).toEqual({ provider: "tavily", key: "from-profile" });
	expect(pickSearch({ provider: "tavily", key: () => undefined }, { TAVILY_API_KEY: "t" })).toEqual({ provider: "tavily", key: "t" });
	expect(pickSearch({ provider: "exa" }, {})).toEqual({ provider: "exa" });
});

test("default search: tavily keyless with plain settings, no key sent", async () => {
	const r = await runSearch({}, "q0", 8, signal());
	const sent = last((s) => s.body?.query === "q0");
	expect(sent.headers["x-tavily-access-mode"]).toBe("keyless");
	expect(sent.headers.authorization).toBeUndefined();
	expect(sent.body).toEqual({ query: "q0", max_results: 8 });
	expect(r).toMatchObject({ provider: "tavily", results: [{ url: "https://t.test/a" }] });
	expect(r.fallback).toBeUndefined();
});

test("default search: keyless tavily rate limited falls back to keyless exa and says why", async () => {
	tavilyDown = true;
	const r = await runSearch({}, "q-fallback", 5, signal());
	expect(r.provider).toBe("exa");
	expect(r.fallback).toMatch(/tavily search failed: 429 \(rate limited.*retry after 30 s.*app\.tavily\.com/);
	expect(last((s) => s.path === "/mcp").body.params.arguments.query).toBe("q-fallback");
});

test("a provider the profile names does not fall back", async () => {
	tavilyDown = true;
	await expect(runSearch({ provider: "tavily" }, "q", 3, signal())).rejects.toThrow(/tavily search failed: 429/);
});

test("tavily with a key: bearer key, search fields from the profile, hits typed and formatted", async () => {
	const r = await runSearch({ provider: "tavily", key: () => "tvly-good", url: base, search: { search_depth: "advanced", chunks_per_source: 3 } }, "q1", 5, signal());
	const sent = last((s) => s.body?.query === "q1");
	expect(sent.headers.authorization).toBe("Bearer tvly-good");
	expect(sent.headers["x-tavily-access-mode"]).toBeUndefined();
	expect(sent.body).toEqual({ query: "q1", max_results: 5, search_depth: "advanced", chunks_per_source: 3 });
	expect(r.results).toEqual([{ title: "Tavily hit", url: "https://t.test/a", text: "about it", published: "2026-10-01" }]);
	expect(r.text).toBe("Title: Tavily hit\nURL: https://t.test/a\nPublished: 2026-10-01\nText: about it");
});

test("a refused key names the fix and never the key", async () => {
	const err = await runSearch({ provider: "tavily", key: () => "tvly-wrong", url: base }, "q", 3, signal()).catch((e) => String(e));
	expect(err).toMatch(/tavily search failed: 401 \(the key was refused/);
	expect(err).not.toContain("tvly-wrong");
});

test("brave: subscription token header, count, tags stripped, snippets joined; no key fails before any request", async () => {
	const r = await runSearch({ provider: "brave", key: () => "bsa", url: base }, "q2", 4, signal());
	const sent = last((s) => s.query.q === "q2");
	expect(sent.headers["x-subscription-token"]).toBe("bsa");
	expect(sent.query.count).toBe("4");
	expect(r.results[0]).toEqual({ title: "Brave hit", url: "https://b.test/a", text: "the best & more\nsecond" });
	const before = seen.length;
	await expect(runSearch({ provider: "brave", url: base }, "q", 3, signal())).rejects.toThrow(/BRAVE_API_KEY/);
	expect(seen.length).toBe(before);
});

test("searxng: json format, results capped to the count asked for", async () => {
	const r = await runSearch({ provider: "searxng", url: base }, "q3", 2, signal());
	expect(last((s) => s.query.q === "q3").query.format).toBe("json");
	expect(r.results.map((h) => h.url)).toEqual(["https://s.test/1", "https://s.test/2"]);
	await expect(runSearch({ provider: "searxng" }, "q", 2, signal())).rejects.toThrow(/web.url/);
});

test("the websearch tool reports which provider answered, and a fallback", async () => {
	const env = scratch("websearch");
	const r = await websearchTool(env, { provider: "exa", url: `${base}/mcp` }).execute("c", { query: "q4", results: 50 });
	expect(last((s) => s.body?.params?.arguments?.query === "q4").body.params.arguments.numResults).toBe(20);
	expect(textOf(r)).toContain("Title: Exa hit");
	expect(r.details).toMatchObject({ provider: "exa", results: [{ title: "Exa hit", url: "https://e.test/a" }] });
	tavilyDown = true;
	const f = await websearchTool(env).execute("c", { query: "q5" });
	expect(f.details).toMatchObject({ provider: "exa", fallback: expect.stringContaining("429") });
});

test("webfetch: local by default; with fetch provider, public pages go through tavily extract and private ones stay local", async () => {
	const env = scratch("webfetch");
	const before = seen.filter((s) => s.path === "/extract").length;
	const local = await webfetchTool(env, { provider: "tavily", key: () => "tvly-good", url: base }).execute("c", { url: `${base}/page` });
	expect(local.details).toMatchObject({ via: "local", status: 200 });
	const read = await webfetchTool(env, { provider: "tavily", key: () => "tvly-good", url: base, fetch: "provider" }).execute("c", { url: "https://spa.test/app" });
	expect(textOf(read)).toContain("(read by tavily)");
	expect(textOf(read)).toContain("body from js");
	expect(read.details).toMatchObject({ via: "tavily", url: "https://spa.test/app" });
	expect(last((s) => s.path === "/extract").body).toEqual({ urls: ["https://spa.test/app"], format: "markdown" });
	const priv = await webfetchTool(env, { provider: "tavily", key: () => "tvly-good", url: base, fetch: "provider" }).execute("c", { url: `${base}/page` });
	expect(priv.details).toMatchObject({ via: "local" });
	expect(seen.filter((s) => s.path === "/extract").length).toBe(before + 1);
});

test("webcrawl: map lists urls, content reads pages, a key is required, private hosts refused", async () => {
	const env = scratch("webcrawl");
	const opts = { provider: "tavily" as const, key: () => "tvly-good", url: base, crawl: true };
	const map = await webcrawlTool(env, opts).execute("c", { url: "https://docs.test", instructions: "auth pages", limit: 500 });
	expect(last((s) => s.path === "/map").body).toEqual({ url: "https://docs.test/", max_depth: 1, limit: 100, instructions: "auth pages" });
	expect(textOf(map)).toContain("2 pages from docs.test (urls only");
	expect(map.details).toMatchObject({ content: false, urls: ["https://docs.test/", "https://docs.test/auth"] });
	const crawl = await webcrawlTool(env, opts).execute("c", { url: "https://docs.test", content: true, depth: 2 });
	expect(last((s) => s.path === "/crawl").body).toMatchObject({ max_depth: 2, limit: 20, format: "markdown" });
	expect(textOf(crawl)).toContain("## https://docs.test/auth\n\ntext of https://docs.test/auth");
	await expect(webcrawlTool(env, { ...opts, key: () => undefined }).execute("c", { url: "https://docs.test" })).rejects.toThrow(/needs a tavily key/);
	await expect(webcrawlTool(env, opts).execute("c", { url: "http://192.168.1.10/wiki" })).rejects.toThrow(/cannot reach/);
});

test("isPrivateUrl: loopback, private ranges, single-label and local names", () => {
	for (const u of ["http://localhost:3000", "http://127.0.0.1", "http://10.1.2.3", "http://172.20.0.1", "http://192.168.0.5", "http://[::1]:8080", "http://nas.local", "http://intranet", "http://api.internal"]) expect(isPrivateUrl(new URL(u))).toBe(true);
	for (const u of ["https://example.com", "https://8.8.8.8", "http://172.32.0.1", "https://docs.tavily.com"]) expect(isPrivateUrl(new URL(u))).toBe(false);
});

test("formatHits leaves out what a hit does not carry", () => {
	expect(formatHits([{ title: "a", url: "https://a" }, { title: "b", url: "https://b", text: " t " }])).toBe("Title: a\nURL: https://a\n\nTitle: b\nURL: https://b\nText: t");
});
