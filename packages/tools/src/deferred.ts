import { Type } from "typebox";
import { clip, clipNote } from "./limits.ts";
import { text, type Tool, defineTool, type ToolEnv } from "./types.ts";

/** deferred tools: declared to the model only after tool_search loads them, so the prefix never carries them */

export function webfetchTool(env: ToolEnv): Tool {
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
			const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "follow" });
			const type = res.headers.get("content-type") ?? "";
			let body = await res.text();
			if (type.includes("html")) {
				body = body
					.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
					.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
					.replace(/<[^>]+>/g, "")
					.replace(/&nbsp;/g, " ")
					.replace(/&amp;/g, "&")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/\n{3,}/g, "\n\n");
			}
			const c = clip(body.trim(), { keep: "head", spillDir: env.spillDir, label: "webfetch" });
			return {
				content: [text(`${res.status} ${url.href}\n\n${c.text}${clipNote(c, "the first")}`)],
				details: { status: res.status, url: url.href, contentType: type, truncated: c.truncated },
				isError: !res.ok,
			};
		},
	});
}

export interface SearchResult {
	title: string;
	url: string;
}

/** exa's hosted mcp endpoint: no key needed, EXA_API_KEY lifts the rate limit, CMX2_WEBSEARCH_URL points elsewhere */
export function websearchUrl(env = process.env): string {
	if (env.CMX2_WEBSEARCH_URL) return env.CMX2_WEBSEARCH_URL;
	return env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(env.EXA_API_KEY)}` : "https://mcp.exa.ai/mcp";
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

export function websearchTool(env: ToolEnv): Tool {
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
			const res = await fetch(websearchUrl(), {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "web_search_exa", arguments: { query: params.query, type: "auto", numResults: Math.min(Math.max(1, Math.floor(params.results ?? 8)), 20), livecrawl: "fallback" } },
				}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			const body = await res.text();
			if (!res.ok) throw new Error(`search failed: ${res.status} ${body.slice(0, 300)}`);
			const found = mcpText(body);
			if (!found) return { content: [text(`no results for "${params.query}"`)], details: { query: params.query, results: [] as SearchResult[], truncated: false } };
			const results: SearchResult[] = [];
			for (const m of found.matchAll(/^Title: (.*)\nURL: (\S+)/gm)) results.push({ title: m[1]!.trim(), url: m[2]! });
			const c = clip(found, { keep: "head", spillDir: env.spillDir, label: "websearch" });
			return { content: [text(c.text + clipNote(c, "the first"))], details: { query: params.query, results, truncated: c.truncated } };
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
