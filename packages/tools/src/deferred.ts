import { Type } from "typebox";
import { clip, clipNote } from "./limits.ts";
import { text, type Tool, defineTool, type ToolEnv } from "./types.ts";
import { crawlSite, extractPage, isPrivateUrl, runSearch, type WebOptions } from "./web.ts";

/** deferred tools: declared to the model only after tool_search loads them, so the prefix never carries them */

/** html reduced to its readable text */
function htmlText(body: string): string {
	return body
		.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\n{3,}/g, "\n\n");
}

export function webfetchTool(env: ToolEnv, web: WebOptions = {}): Tool {
	return defineTool({
		name: "webfetch",
		label: "webfetch",
		description: "fetch a url over http(s) and return the body as text (html reduced to its readable text), up to 2000 lines.",
		parameters: Type.Object({
			url: Type.String({ description: "http or https url" }),
			timeout: Type.Optional(Type.Number({ description: "seconds, default 30" })),
		}),
		async execute(_id, params, signal) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`${params.url} is not a url`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https urls, got ${url.protocol}`);
			const timeout = AbortSignal.timeout(Math.min(Math.max(1, params.timeout ?? 30), 120) * 1000);
			const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
			// the profile can send public pages through tavily extract (it renders javascript); private ones are always read here
			let note = "";
			if (web.fetch === "provider" && !isPrivateUrl(url)) {
				try {
					const page = await extractPage(web, url.href, both);
					const c = clip(page.text.trim(), { keep: "head", spillDir: env.spillDir, label: "webfetch" });
					return {
						content: [text(`200 ${page.url} (read by tavily)\n\n${c.text}${clipNote(c, "the first")}`)],
						details: { status: 200, url: page.url, contentType: "text/markdown", truncated: c.truncated, via: "tavily" },
					};
				} catch (e) {
					if (both.aborted) throw e;
					note = ` (${e instanceof Error ? e.message : String(e)}; fetched directly instead)`;
				}
			}
			const res = await fetch(url, { signal: both, redirect: "follow" });
			const type = res.headers.get("content-type") ?? "";
			let body = await res.text();
			if (type.includes("html")) body = htmlText(body);
			const c = clip(body.trim(), { keep: "head", spillDir: env.spillDir, label: "webfetch" });
			return {
				content: [text(`${res.status} ${url.href}${note}\n\n${c.text}${clipNote(c, "the first")}`)],
				details: { status: res.status, url: url.href, contentType: type, truncated: c.truncated, via: "local" },
				isError: !res.ok,
			};
		},
	});
}

export interface SearchResult {
	title: string;
	url: string;
}

export { mcpText, websearchUrl } from "./web.ts";

export function websearchTool(env: ToolEnv, web: WebOptions = {}): Tool {
	return defineTool({
		name: "websearch",
		label: "websearch",
		description: "search the web and get back the top pages with their titles, urls and the relevant text. webfetch reads one page in full.",
		parameters: Type.Object({
			query: Type.String({ description: "what to search for, as you would type it" }),
			results: Type.Optional(Type.Number({ description: "how many pages, default 8, up to 20" })),
		}),
		async execute(_id, params, signal) {
			const timeout = AbortSignal.timeout(25_000);
			const n = Math.min(Math.max(1, Math.floor(params.results ?? 8)), 20);
			const found = await runSearch(web, params.query, n, signal ? AbortSignal.any([signal, timeout]) : timeout);
			const results: SearchResult[] = found.results.map((r) => ({ title: r.title, url: r.url }));
			const details = { query: params.query, provider: found.provider, results, ...(found.fallback ? { fallback: found.fallback } : {}) };
			if (!found.text.trim()) return { content: [text(`no results for "${params.query}"`)], details: { ...details, truncated: false } };
			const c = clip(found.text, { keep: "head", spillDir: env.spillDir, label: "websearch" });
			return { content: [text(c.text + clipNote(c, "the first"))], details: { ...details, truncated: c.truncated } };
		},
	});
}

/** a site's pages through tavily map and crawl; declared only when the profile turns it on */
export function webcrawlTool(env: ToolEnv, web: WebOptions = {}): Tool {
	return defineTool({
		name: "webcrawl",
		label: "webcrawl",
		description:
			"list the pages of a website, or read many of them at once (docs sites, changelogs). without content it returns the urls it found; with content, each page's text. webfetch reads one known page.",
		parameters: Type.Object({
			url: Type.String({ description: "where to start, e.g. https://docs.example.com" }),
			content: Type.Optional(Type.Boolean({ description: "also return each page's text (costs more); default false, urls only" })),
			instructions: Type.Optional(Type.String({ description: "what to look for, in plain words, e.g. pages about authentication" })),
			limit: Type.Optional(Type.Number({ description: "most pages, default 20, up to 100" })),
			depth: Type.Optional(Type.Number({ description: "how many links away from the start, default 1, up to 3" })),
		}),
		async execute(_id, params, signal) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`${params.url} is not a url`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https urls, got ${url.protocol}`);
			if (isPrivateUrl(url)) throw new Error(`webcrawl reads public sites through tavily, which cannot reach ${url.hostname}; use webfetch for it`);
			const timeout = AbortSignal.timeout(150_000);
			const args = {
				url: url.href,
				content: params.content ?? false,
				limit: Math.min(Math.max(1, Math.floor(params.limit ?? 20)), 100),
				depth: Math.min(Math.max(1, Math.floor(params.depth ?? 1)), 3),
				...(params.instructions ? { instructions: params.instructions } : {}),
			};
			const r = await crawlSite(web, args, signal ? AbortSignal.any([signal, timeout]) : timeout);
			const body = args.content ? r.pages.map((p) => `## ${p.url}\n\n${(p.text ?? "").trim()}`).join("\n\n") : r.pages.map((p) => p.url).join("\n");
			const head = `${r.pages.length} pages from ${r.base}${args.content ? "" : " (urls only; content: true reads them)"}`;
			const c = clip(body, { keep: "head", spillDir: env.spillDir, label: "webcrawl" });
			return {
				content: [text(`${head}\n\n${c.text}${clipNote(c, "the first")}`)],
				details: { url: url.href, base: r.base, content: args.content, urls: r.pages.map((p) => p.url), truncated: c.truncated },
			};
		},
	});
}

export interface DeferredEntry {
	name: string;
	description: string;
}

/**
 * tool_search over the deferred catalog. a match is loaded into the session (the engine declares it with
 * a native tool addition, after the cached prefix) and callable from the next response.
 */
export function toolSearchTool(catalog: () => DeferredEntry[], load: (names: string[]) => string[]): Tool {
	return defineTool({
		name: "tool_search",
		label: "tool_search",
		description: "find and load tools that are not in your list yet. matches the query (words or a regex) against tool names and descriptions; matching tools become callable from your next response.",
		parameters: Type.Object({
			query: Type.String({ description: "words or a regex, e.g. fetch url" }),
		}),
		async execute(_id, params) {
			const entries = catalog();
			let re: RegExp | undefined;
			try {
				re = new RegExp(params.query, "i");
			} catch {}
			const words = params.query.toLowerCase().split(/\s+/).filter(Boolean);
			const hits = entries.filter((e) => {
				const hay = `${e.name} ${e.description}`.toLowerCase();
				return re?.test(hay) || words.some((w) => hay.includes(w));
			});
			if (hits.length === 0) {
				return { content: [text(`no tools match "${params.query}". available to load: ${entries.map((e) => e.name).join(", ") || "none"}`)], details: { loaded: [] } };
			}
			const loaded = load(hits.map((h) => h.name));
			const lines = hits.map((h) => `${h.name}: ${h.description}${loaded.includes(h.name) ? "" : " (already loaded)"}`);
			return { content: [text(`loaded, callable from your next response:\n${lines.join("\n")}`)], details: { loaded } };
		},
	});
}
