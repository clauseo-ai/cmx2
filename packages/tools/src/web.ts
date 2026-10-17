/**
 * the web backends behind websearch, webfetch and webcrawl. each is one http call, no mcp handshake and no
 * sdk. search: tavily (keyless or keyed), exa (its hosted mcp endpoint, keyless or keyed), brave, or a
 * searxng instance. fetch: a plain local fetch, or tavily extract when the profile asks for it. crawl: tavily
 * map and crawl, with a key, when the profile turns it on.
 *
 * with no `web` entry the first key in the environment picks the provider (TAVILY_API_KEY, EXA_API_KEY,
 * BRAVE_API_KEY); with none, search goes to tavily's free keyless mode and falls back to keyless exa when
 * that fails. https://docs.tavily.com/documentation/keyless
 */

export const SEARCH_PROVIDERS = ["tavily", "exa", "brave", "searxng"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/** the environment variable each provider's key is read from when the profile names none; also the auto order */
export const SEARCH_ENV_KEYS: Record<SearchProviderName, string | undefined> = {
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
	brave: "BRAVE_API_KEY",
	searxng: undefined,
};

/** providers that answer without a key */
const KEYLESS: ReadonlySet<SearchProviderName> = new Set(["tavily", "exa", "searxng"]);

/** what the engine hands the web tools: the profile's choice, with the key looked up only when a call runs */
export interface WebOptions {
	/** a provider, or undefined (`auto`) to pick by which key the environment holds; key, url and search apply only with a provider */
	provider?: SearchProviderName;
	/** the profile's key for the provider, resolved; undefined falls back to the provider's env var */
	key?: () => string | undefined;
	/** the endpoint: a searxng instance, exa's mcp url, or another base url for tavily or brave */
	url?: string;
	/** extra search request fields (tavily `search_depth`, brave `country`, exa `livecrawl`) */
	search?: Record<string, unknown>;
	/** `provider` reads pages through tavily extract (public urls only); `local` (the default) fetches them here */
	fetch?: "local" | "provider";
	/** declare webcrawl (tavily map and crawl; needs a key) */
	crawl?: boolean;
}

export interface SearchHit {
	title: string;
	url: string;
	/** the relevant text the provider sent with the hit */
	text?: string;
	published?: string;
}

export interface SearchAnswer {
	provider: SearchProviderName;
	results: SearchHit[];
	/** what the model reads */
	text: string;
	/** set when the first provider failed and another answered: what went wrong */
	fallback?: string;
}

interface Query {
	query: string;
	results: number;
	key?: string;
	url?: string;
	params: Record<string, unknown>;
	signal: AbortSignal;
}

/** which provider runs and with what key: the profile's provider, else the first key in the environment, else keyless tavily */
export function pickSearch(opts: WebOptions = {}, env: Record<string, string | undefined> = process.env): { provider: SearchProviderName; key?: string; auto?: true } {
	const keyFor = (p: SearchProviderName) => {
		const v = SEARCH_ENV_KEYS[p];
		return v ? env[v] || undefined : undefined;
	};
	if (opts.provider) {
		const key = opts.key?.() || keyFor(opts.provider);
		return { provider: opts.provider, ...(key ? { key } : {}) };
	}
	for (const p of SEARCH_PROVIDERS) {
		const key = keyFor(p);
		if (key) return { provider: p, key, auto: true };
	}
	return { provider: "tavily", auto: true };
}

/** exa's hosted mcp endpoint: no key needed, a key lifts the rate limit, CMX2_WEBSEARCH_URL points elsewhere */
export function websearchUrl(env: Record<string, string | undefined> = process.env, key = env.EXA_API_KEY): string {
	if (env.CMX2_WEBSEARCH_URL) return env.CMX2_WEBSEARCH_URL;
	return key ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}` : "https://mcp.exa.ai/mcp";
}

/** the text of an mcp tools/call answer, sent as json or as server-sent events */
export function mcpText(body: string): string | undefined {
	const parse = (s: string): string | undefined => {
		let r: any;
		try {
			r = JSON.parse(s);
		} catch {
			return undefined;
		}
		if (r.error) throw new Error(`search failed: ${r.error.message ?? JSON.stringify(r.error)}`);
		return (r.result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n") || undefined;
	};
	if (body.trimStart().startsWith("{")) return parse(body);
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const t = parse(line.slice(6));
		if (t) return t;
	}
	return undefined;
}

/** hits as the model reads them, the same layout exa answers in */
export function formatHits(hits: SearchHit[]): string {
	return hits
		.map((h) => [`Title: ${h.title}`, `URL: ${h.url}`, ...(h.published ? [`Published: ${h.published}`] : []), ...(h.text ? [`Text: ${h.text.trim().replace(/\n{3,}/g, "\n\n")}`] : [])].join("\n"))
		.join("\n\n");
}

const stripTags = (s: string) =>
	s
		.replace(/<[^>]+>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");

const TAVILY_KEY_HINT = "get a free key (1,000 credits a month) at https://app.tavily.com and export TAVILY_API_KEY";
const SWITCH_HINT = "set web.provider in cmx2.jsonc to another provider, or give this one a key";

/** a failed answer as an error that names the status and the provider's own words, never the key */
async function failure(what: string, res: Response, hint: string): Promise<Error> {
	const body = (await res.text().catch(() => "")).slice(0, 300);
	const wait = res.headers.get("retry-after");
	const limited = res.status === 429 || res.status === 432 || res.status === 433;
	const why = res.status === 401 || res.status === 403 ? `the key was refused; ${hint}` : limited ? `rate limited or out of credits${wait ? `, retry after ${wait} s` : ""}; ${hint}` : "";
	return new Error(`${what} failed: ${res.status}${why ? ` (${why})` : ""} ${body}`.trim());
}

/** tavily's auth: the key as a bearer token, or the keyless header */
function tavilyHeaders(key: string | undefined): Record<string, string> {
	return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : { "x-tavily-access-mode": "keyless" }) };
}

/** tavily's api: the profile's url, else CMX2_TAVILY_URL (a proxy, or a fake in tests), else tavily's own */
const tavilyBase = (url?: string) => (url ?? process.env.CMX2_TAVILY_URL ?? "https://api.tavily.com").replace(/\/+$/, "");

async function tavily(q: Query): Promise<SearchAnswer> {
	const res = await fetch(`${tavilyBase(q.url)}/search`, {
		method: "POST",
		headers: tavilyHeaders(q.key),
		body: JSON.stringify({ query: q.query, max_results: q.results, ...q.params }),
		signal: q.signal,
	});
	if (!res.ok) throw await failure("tavily search", res, q.key ? SWITCH_HINT : `tavily's keyless mode is rate limited; ${TAVILY_KEY_HINT}`);
	const r = (await res.json()) as { answer?: string; results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
	const results: SearchHit[] = (r.results ?? [])
		.filter((h) => h.url)
		.map((h) => ({ title: h.title ?? h.url!, url: h.url!, ...(h.content ? { text: h.content } : {}), ...(h.published_date ? { published: h.published_date } : {}) }));
	const text = (r.answer ? `Answer: ${r.answer}\n\n` : "") + formatHits(results);
	return { provider: "tavily", results, text };
}

async function exa(q: Query): Promise<SearchAnswer> {
	const url = q.url ?? websearchUrl(process.env, q.key);
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: q.query, type: "auto", numResults: q.results, livecrawl: "fallback", ...q.params } },
		}),
		signal: q.signal,
	});
	if (!res.ok) throw await failure("exa search", res, q.key ? SWITCH_HINT : `keyless exa is shared and rate limited; ${TAVILY_KEY_HINT}, or set EXA_API_KEY`);
	const text = mcpText(await res.text()) ?? "";
	const results: SearchHit[] = [];
	for (const m of text.matchAll(/^Title: (.*)\nURL: (\S+)/gm)) results.push({ title: m[1]!.trim(), url: m[2]! });
	return { provider: "exa", results, text };
}

async function brave(q: Query): Promise<SearchAnswer> {
	if (!q.key) throw new Error("search failed: brave needs a key; set BRAVE_API_KEY or web.apiKey in cmx2.jsonc");
	const u = new URL(`${(q.url ?? "https://api.search.brave.com").replace(/\/+$/, "")}/res/v1/web/search`);
	u.searchParams.set("q", q.query);
	u.searchParams.set("count", String(q.results));
	for (const [k, v] of Object.entries(q.params)) u.searchParams.set(k, String(v));
	const res = await fetch(u, { headers: { accept: "application/json", "x-subscription-token": q.key }, signal: q.signal });
	if (!res.ok) throw await failure("brave search", res, SWITCH_HINT);
	const r = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; extra_snippets?: string[]; age?: string }> } };
	const results: SearchHit[] = (r.web?.results ?? [])
		.filter((h) => h.url)
		.map((h) => {
			const text = [h.description, ...(h.extra_snippets ?? [])]
				.filter(Boolean)
				.map((s) => stripTags(s!))
				.join("\n");
			return { title: stripTags(h.title ?? h.url!), url: h.url!, ...(text ? { text } : {}), ...(h.age ? { published: h.age } : {}) };
		});
	return { provider: "brave", results, text: formatHits(results) };
}

async function searxng(q: Query): Promise<SearchAnswer> {
	if (!q.url) throw new Error("search failed: searxng needs web.url in cmx2.jsonc, the base url of your instance (with json output enabled in its settings.yml)");
	const u = new URL(`${q.url.replace(/\/+$/, "")}/search`);
	u.searchParams.set("q", q.query);
	u.searchParams.set("format", "json");
	for (const [k, v] of Object.entries(q.params)) u.searchParams.set(k, String(v));
	const res = await fetch(u, { headers: { accept: "application/json", ...(q.key ? { authorization: `Bearer ${q.key}` } : {}) }, signal: q.signal });
	if (!res.ok) throw await failure("searxng search", res, res.status === 403 ? "enable json under search.formats in the instance's settings.yml" : "check web.url");
	const r = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }> };
	const results: SearchHit[] = (r.results ?? [])
		.filter((h) => h.url)
		.slice(0, q.results)
		.map((h) => ({ title: h.title ?? h.url!, url: h.url!, ...(h.content ? { text: h.content } : {}), ...(h.publishedDate ? { published: h.publishedDate } : {}) }));
	return { provider: "searxng", results, text: formatHits(results) };
}

const BACKENDS: Record<SearchProviderName, (q: Query) => Promise<SearchAnswer>> = { tavily, exa, brave, searxng };

/** one search through the picked provider; keyless tavily picked by default falls back to keyless exa */
export async function runSearch(opts: WebOptions, query: string, results: number, signal: AbortSignal): Promise<SearchAnswer> {
	const { provider, key, auto } = pickSearch(opts);
	const own = opts.provider === provider;
	const q: Query = { query, results, signal, params: (own && opts.search) || {}, ...(key ? { key } : {}), ...(own && opts.url ? { url: opts.url } : {}) };
	if (!(auto && provider === "tavily" && !key)) return BACKENDS[provider](q);
	try {
		return await tavily(q);
	} catch (e) {
		if (signal.aborted) throw e;
		const why = e instanceof Error ? e.message : String(e);
		try {
			return { ...(await exa(q)), fallback: why };
		} catch (e2) {
			throw new Error(`search failed on both keyless providers. ${why}. ${e2 instanceof Error ? e2.message : String(e2)}`);
		}
	}
}

/** true for urls a hosted reader cannot reach: loopback, private and link-local addresses, single-label and .local/.internal hosts */
export function isPrivateUrl(url: URL): boolean {
	const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
	if (!h.includes(".") && !h.includes(":")) return true;
	const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	if (h.includes(":")) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
	return false;
}

export interface Extracted {
	url: string;
	text: string;
}

/** one page through tavily extract, as markdown; throws with tavily's reason when it could not read it */
export async function extractPage(opts: WebOptions, url: string, signal: AbortSignal): Promise<Extracted> {
	const { key } = pickSearch({ ...opts, provider: "tavily" });
	const res = await fetch(`${tavilyBase(opts.provider === "tavily" ? opts.url : undefined)}/extract`, {
		method: "POST",
		headers: tavilyHeaders(key),
		body: JSON.stringify({ urls: [url], format: "markdown" }),
		signal,
	});
	if (!res.ok) throw await failure("tavily extract", res, key ? SWITCH_HINT : `tavily's keyless mode is rate limited; ${TAVILY_KEY_HINT}`);
	const r = (await res.json()) as { results?: Array<{ url?: string; raw_content?: string }>; failed_results?: Array<{ url?: string; error?: string }> };
	const page = r.results?.[0];
	if (!page?.raw_content) throw new Error(`tavily extract could not read it: ${r.failed_results?.[0]?.error ?? "no content"}`);
	return { url: page.url ?? url, text: page.raw_content };
}

export interface CrawlAnswer {
	base: string;
	/** every url found; with content, the pages read */
	pages: Array<{ url: string; text?: string }>;
}

/** a site through tavily map (urls only) or crawl (urls and their text); needs a key */
export async function crawlSite(
	opts: WebOptions,
	args: { url: string; content: boolean; instructions?: string; limit: number; depth: number },
	signal: AbortSignal,
): Promise<CrawlAnswer> {
	const { key } = pickSearch({ ...opts, provider: "tavily" });
	if (!key) throw new Error(`webcrawl needs a tavily key (map and crawl have no keyless mode); ${TAVILY_KEY_HINT}`);
	const body = { url: args.url, max_depth: args.depth, limit: args.limit, ...(args.instructions ? { instructions: args.instructions } : {}), ...(args.content ? { format: "markdown" } : {}) };
	const res = await fetch(`${tavilyBase(opts.provider === "tavily" ? opts.url : undefined)}/${args.content ? "crawl" : "map"}`, {
		method: "POST",
		headers: tavilyHeaders(key),
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw await failure(`tavily ${args.content ? "crawl" : "map"}`, res, SWITCH_HINT);
	const r = (await res.json()) as { base_url?: string; results?: Array<string | { url?: string; raw_content?: string }> };
	const pages = (r.results ?? [])
		.map((x) => (typeof x === "string" ? { url: x } : { url: x.url ?? "", ...(x.raw_content ? { text: x.raw_content } : {}) }))
		.filter((p) => p.url);
	return { base: r.base_url ?? args.url, pages };
}
