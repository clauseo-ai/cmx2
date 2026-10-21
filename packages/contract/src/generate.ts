#!/usr/bin/env bun
/**
 * generates the client package and the openapi document from the manifest.
 *   bun packages/contract/src/generate.ts          write packages/client/{src/events.ts,src/client.ts,openapi.json}
 *   bun packages/contract/src/generate.ts --check  exit 1 when the files on disk differ from a fresh generation
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as M from "./manifest.ts";

const HEADER = "// generated from packages/contract/src/manifest.ts by packages/contract/src/generate.ts. edit the manifest, then run `bun run contract`.\n";

/** shared schemas get a name in both outputs; everything else is inlined */
const NAMED: Array<[string, unknown]> = [
	["SessionStatusIdle", M.SessionStatusIdle],
	["SessionStatusBusy", M.SessionStatusBusy],
	["SessionStatusRetry", M.SessionStatusRetry],
	["SessionStatus", M.SessionStatus],
	["ToolStatePending", M.ToolStatePending],
	["ToolStateRunning", M.ToolStateRunning],
	["ToolStateCompleted", M.ToolStateCompleted],
	["ToolStateError", M.ToolStateError],
	["ToolState", M.ToolState],
	["TextPart", M.TextPart],
	["ReasoningPart", M.ReasoningPart],
	["ToolPart", M.ToolPart],
	["FilePart", M.FilePart],
	["CompactionPart", M.CompactionPart],
	["StepStartPart", M.StepStartPart],
	["StepFinishPart", M.StepFinishPart],
	["PatchPart", M.PatchPart],
	["SubtaskPart", M.SubtaskPart],
	["FileDiff", M.FileDiff],
	["SessionInfo", M.SessionInfo],
	["MessageInfo", M.MessageInfo],
	["Part", M.Part],
	["PermissionRequest", M.PermissionRequest],
	["QuestionOption", M.QuestionOption],
	["QuestionInfo", M.QuestionInfo],
	["QuestionRequest", M.QuestionRequest],
	["StepRow", M.StepRow],
	["ErrorBody", M.ErrorBody],
	["PtyInfo", M.PtyInfo],
	["ProcessInfo", M.ProcessInfo],
	["McpStatus", M.McpStatus],
];
const nameOf = new Map<unknown, string>(NAMED.map(([n, s]) => [s, n]));

function key(k: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function doc(s: any, indent: string): string {
	return s?.description ? `/** ${String(s.description).replace(/\*\//g, "* /")} */\n${indent}` : "";
}

function ts(s: any, indent = "", top = false): string {
	const named = nameOf.get(s);
	if (named && !top) return named;
	if (s.const !== undefined) return JSON.stringify(s.const);
	if (s.anyOf) return s.anyOf.map((x: unknown) => ts(x, indent)).join(" | ");
	switch (s.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return `Array<${ts(s.items, indent)}>`;
		case "object": {
			if (s.patternProperties) return `Record<string, ${ts(Object.values(s.patternProperties)[0], indent)}>`;
			const req = new Set<string>(s.required ?? []);
			const inner = `${indent}\t`;
			const lines = Object.entries(s.properties ?? {}).map(([k, v]) => `${inner}${doc(v, inner)}${key(k)}${req.has(k) ? "" : "?"}: ${ts(v, inner)};`);
			if (s.additionalProperties === true) lines.push(`${inner}[key: string]: unknown;`);
			return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<string, never>";
		}
	}
	return "unknown";
}

export function eventsTs(): string {
	const out: string[] = [HEADER, `export const CONTRACT_VERSION = ${M.CONTRACT_VERSION};\n`];
	for (const [name, s] of NAMED) out.push(`${doc(s, "")}export type ${name} = ${ts(s, "", true)};\n`);
	out.push("/** every event the daemon publishes, by type */");
	out.push("export interface EventMap {");
	for (const [type, def] of Object.entries(M.EVENTS)) out.push(`\t/** ${def.description} (v${def.version}) */\n\t${JSON.stringify(type)}: ${ts(def.properties, "\t")};`);
	out.push("}\n");
	out.push("export type EventType = keyof EventMap;");
	out.push("/** a payload, discriminated on `type` */");
	out.push("/** logged events carry seq and epoch (the id is <epoch>:<seq>); server frames, deltas and streaming resends carry neither */");
	out.push("export type Event = { [K in EventType]: { id: string; type: K; properties: EventMap[K]; seq?: number; epoch?: string } }[EventType];");
	out.push("/** a /global/event frame; server frames carry no directory */");
	out.push("export interface GlobalFrame {\n\tdirectory?: string;\n\tproject?: string;\n\tworkspace?: string;\n\tpayload: Event;\n}\n");
	out.push(`export const EVENT_VERSIONS: Record<EventType, number> = ${JSON.stringify(Object.fromEntries(Object.entries(M.EVENTS).map(([t, d]) => [t, d.version])), null, "\t")};\n`);
	out.push(`export function isEventType(type: unknown): type is EventType {
	return typeof type === "string" && Object.hasOwn(EVENT_VERSIONS, type);
}

/** narrows a payload to one event type */
export function isEvent<K extends EventType>(e: { type?: unknown } | undefined, type: K): e is { id: string; type: K; properties: EventMap[K] } {
	return e?.type === type;
}

export type Decoded =
	| { ok: true; directory?: string; project?: string; event: Event }
	| { ok: false; reason: "json" | "shape" | "unknown-type"; type?: string };

/**
 * decodes one sse data line from either stream: a bare payload (/event) or an envelope (/global/event).
 * an unknown type is reported, never thrown, so a newer daemon cannot break an older client.
 */
export function decodeFrame(data: string): Decoded {
	let v: any;
	try {
		v = JSON.parse(data);
	} catch {
		return { ok: false, reason: "json" };
	}
	const payload = v && typeof v === "object" && "payload" in v ? v.payload : v;
	if (!payload || typeof payload !== "object" || typeof payload.type !== "string" || typeof payload.properties !== "object") return { ok: false, reason: "shape" };
	if (!isEventType(payload.type)) return { ok: false, reason: "unknown-type", type: payload.type };
	return {
		ok: true,
		...(typeof v.directory === "string" ? { directory: v.directory } : {}),
		...(typeof v.project === "string" ? { project: v.project } : {}),
		event: payload as Event,
	};
}
`);
	return out.join("\n");
}

function paramNames(path: string): string[] {
	return [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

export function clientTs(): string {
	const out: string[] = [HEADER, `import { type Decoded, decodeFrame, type ${NAMED.map(([n]) => n).join(", type ")} } from "./events.ts";\n`];
	out.push(`export interface ClientOptions {
	/** e.g. http://127.0.0.1:4097 */
	baseUrl: string;
	/** basic auth password (CMX2_SERVER_PASSWORD on the daemon) */
	password?: string;
	/** basic auth user, default cmx2 */
	user?: string;
	/** default directory for scoped routes (sent as x-cmx2-directory) */
	directory?: string;
	/** a fetch implementation; pass the daemon's in-process handler to test without a socket */
	fetch?: (request: Request) => Promise<Response>;
}

/** a non-2xx answer: the daemon's typed error body */
export class Cmx2Error extends Error {
	constructor(
		readonly status: number,
		readonly name: string,
		readonly data: { message: string; [key: string]: unknown },
	) {
		super(data.message);
	}
}

export interface CallOptions {
	directory?: string;
	signal?: AbortSignal;
	/** event streams: resume after this cursor (<epoch>:<seq>), sent as Last-Event-ID */
	lastEventId?: string;
}

export interface Page<T> {
	data: T;
	/** the x-next-cursor header, when the route pages that way */
	next?: string;
	/** the x-cmx2-seq header on reads: the cursor of the last event this state includes */
	seq?: string;
}

export interface BytesOptions extends CallOptions {
	/** an etag from an earlier answer: if it still holds the daemon answers 304 and the result has notModified and no data */
	ifNoneMatch?: string;
}

/** a file's bytes with the content type and etag the daemon sent; notModified (and no data) after a 304 */
export type FileBytes = { data: Uint8Array; contentType: string; etag?: string; notModified?: undefined } | { notModified: true; etag?: string; data?: undefined; contentType?: undefined };

/** one decoded frame and the sse id it came with (logged events only) */
export type StreamFrame = Decoded & { cursor?: string };

function sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<{ id?: string; data: string }> {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					buf += decoder.decode(value, { stream: true });
					let at: number;
					while ((at = buf.indexOf("\\n\\n")) >= 0) {
						const block = buf.slice(0, at);
						buf = buf.slice(at + 2);
						const lines = block.split("\\n");
						const data = lines
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).replace(/^ /, ""))
							.join("\\n");
						const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
						if (data) yield { ...(id ? { id } : {}), data };
					}
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}
`);
	out.push("export function createClient(opts: ClientOptions) {");
	out.push(`	const doFetch = opts.fetch ?? ((r: Request) => fetch(r));
	const base = opts.baseUrl.replace(/\\/$/, "");
	function headers(directory?: string): Record<string, string> {
		const h: Record<string, string> = {};
		if (opts.password) h.authorization = \`Basic \${btoa(\`\${opts.user ?? "cmx2"}:\${opts.password}\`)}\`;
		const d = directory ?? opts.directory;
		if (d) h["x-cmx2-directory"] = encodeURIComponent(d);
		return h;
	}
	async function call<T>(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown, o: CallOptions = {}): Promise<Page<T>> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
		const url = \`\${base}\${path}\${qs.size ? \`?\${qs}\` : ""}\`;
		const h = headers(o.directory);
		if (body !== undefined) h["content-type"] = "application/json";
		const res = await doFetch(new Request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal }));
		const text = await res.text();
		const json = text ? JSON.parse(text) : undefined;
		if (!res.ok) throw new Cmx2Error(res.status, json?.name ?? "UnknownError", json?.data ?? { message: text || res.statusText });
		const next = res.headers.get("x-next-cursor") ?? undefined;
		const seq = res.headers.get("x-cmx2-seq") ?? undefined;
		return { data: json as T, ...(next ? { next } : {}), ...(seq ? { seq } : {}) };
	}
	/** a route whose answer is a file's bytes: the bytes with the type and etag they came with; a 304 has no bytes */
	async function callBytes(path: string, query: Record<string, unknown> | undefined, o: BytesOptions = {}): Promise<FileBytes> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
		const h = headers(o.directory);
		if (o.ifNoneMatch) h["if-none-match"] = o.ifNoneMatch;
		const res = await doFetch(new Request(\`\${base}\${path}\${qs.size ? \`?\${qs}\` : ""}\`, { headers: h, signal: o.signal }));
		const etag = res.headers.get("etag") ?? undefined;
		if (res.status === 304) return { notModified: true, ...(etag ? { etag } : {}) };
		if (!res.ok) {
			const text = await res.text();
			let json: { name?: string; data?: { message: string; [key: string]: unknown } } | undefined;
			try {
				json = text ? JSON.parse(text) : undefined;
			} catch {}
			throw new Cmx2Error(res.status, json?.name ?? "UnknownError", json?.data ?? { message: text || res.statusText });
		}
		return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream", ...(etag ? { etag } : {}) };
	}
	async function* stream(path: string, o: CallOptions = {}): AsyncIterable<StreamFrame> {
		const h: Record<string, string> = { ...headers(o.directory), accept: "text/event-stream" };
		if (o.lastEventId) h["last-event-id"] = o.lastEventId;
		const res = await doFetch(new Request(\`\${base}\${path}\`, { headers: h, signal: o.signal }));
		if (!res.ok || !res.body) throw new Cmx2Error(res.status, "StreamError", { message: \`event stream answered \${res.status}\` });
		for await (const f of sseLines(res.body)) yield { ...decodeFrame(f.data), ...(f.id ? { cursor: f.id } : {}) };
	}
	return {`);
	for (const r of M.ROUTES) {
		const params = paramNames(r.path);
		const args: string[] = [];
		if (params.length) args.push(`params: { ${params.map((p) => `${p}: string`).join("; ")} }`);
		if (r.response === "websocket") continue;
		if (r.response === "sse") {
			out.push(`\t\t/** ${r.summary} */\n\t\t${r.operationId}: (o?: CallOptions) => stream(${JSON.stringify(r.path)}, o),`);
			continue;
		}
		if (r.bytes) {
			args.push(`query: ${ts(r.query, "\t\t")}`, "o?: BytesOptions");
			out.push(`\t\t/** ${r.summary} */\n\t\t${r.operationId}: (${args.join(", ")}) => callBytes(${JSON.stringify(r.path)}, query, o),`);
			continue;
		}
		if (r.body) args.push(`body: ${ts(r.body, "\t\t")}`);
		if (r.query) args.push(`query: ${ts(r.query, "\t\t")}${(r.query as { required?: string[] }).required?.length ? "" : " = {}"}`);
		args.push("o?: CallOptions");
		const path = params.length ? `\`${r.path.replace(/:(\w+)/g, (_m, p) => `\${encodeURIComponent(params.${p})}`)}\`` : JSON.stringify(r.path);
		out.push(
			`\t\t/** ${r.summary} */\n\t\t${r.operationId}: (${args.join(", ")}) =>\n\t\t\tcall<${ts(r.response, "\t\t\t")}>(${JSON.stringify(r.method)}, ${path}, ${r.query ? "query" : "undefined"}, ${r.body ? "body" : "undefined"}, o),`,
		);
	}
	out.push("\t};\n}\n\nexport type Client = ReturnType<typeof createClient>;\n");
	return out.join("\n");
}

function strip(s: unknown): unknown {
	return JSON.parse(JSON.stringify(s));
}

/** json schema with named shared schemas swapped for $refs */
function withRefs(s: any, top?: string): any {
	const named = nameOf.get(s);
	if (named && named !== top) return { $ref: `#/components/schemas/${named}` };
	// a union whose members are named objects sharing a literal key is a discriminated union
	if (Array.isArray(s?.anyOf) && s.anyOf.length > 1 && s.anyOf.every((m: unknown) => nameOf.has(m))) {
		const key = ["type", "status"].find((k) => s.anyOf.every((m: any) => m.properties?.[k]?.const !== undefined));
		if (key) {
			const refs = s.anyOf.map((m: unknown) => `#/components/schemas/${nameOf.get(m)}`);
			return {
				...(s.description ? { description: s.description } : {}),
				oneOf: refs.map(($ref: string) => ({ $ref })),
				discriminator: { propertyName: key, mapping: Object.fromEntries(s.anyOf.map((m: any, i: number) => [m.properties[key].const, refs[i]])) },
			};
		}
	}
	if (Array.isArray(s)) return s.map((x) => withRefs(x));
	if (s && typeof s === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(s)) out[k] = withRefs(v);
		return out;
	}
	return s;
}

export function openapi(): string {
	const schemas: Record<string, unknown> = {};
	for (const [name, s] of NAMED) schemas[name] = strip(withRefs(s, name));
	const eventNames: string[] = [];
	for (const [type, def] of Object.entries(M.EVENTS)) {
		const name = `Event_${type.replace(/\W+/g, "_")}`;
		eventNames.push(name);
		schemas[name] = {
			type: "object",
			description: def.description,
			"x-cmx2-version": def.version,
			required: ["id", "type", "properties"],
			properties: {
				id: { type: "string" },
				type: { const: type, type: "string" },
				properties: strip(withRefs(def.properties)),
				seq: { type: "integer", description: "logged events only: the event's place in the log; the sse id is <epoch>:<seq>" },
				epoch: { type: "string", description: "logged events only: names the store the seq belongs to" },
			},
		};
	}
	schemas.Event = {
		oneOf: eventNames.map((n) => ({ $ref: `#/components/schemas/${n}` })),
		discriminator: { propertyName: "type", mapping: Object.fromEntries(Object.keys(M.EVENTS).map((t, i) => [t, `#/components/schemas/${eventNames[i]}`])) },
	};
	schemas.GlobalFrame = {
		type: "object",
		required: ["payload"],
		properties: { directory: { type: "string" }, project: { type: "string" }, workspace: { type: "string" }, payload: { $ref: "#/components/schemas/Event" } },
	};
	const paths: Record<string, Record<string, unknown>> = {};
	for (const r of M.ROUTES) {
		const p = r.path.replace(/:(\w+)/g, "{$1}");
		const parameters: unknown[] = paramNames(r.path).map((n) => ({ name: n, in: "path", required: true, schema: { type: "string" } }));
		if (r.query) {
			const q = strip(r.query) as any;
			for (const [n, s] of Object.entries(q.properties ?? {})) parameters.push({ name: n, in: "query", required: (q.required ?? []).includes(n), schema: s });
		}
		if (r.scoped) parameters.push({ name: "x-cmx2-directory", in: "header", required: false, schema: { type: "string" }, description: "the directory to scope to; x-opencode-directory is accepted too" });
		const ok =
			r.response === "websocket"
				? { description: `websocket upgrade (101). ${r.summary}` }
				: r.bytes
				? { description: "the file's bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } }, ...(r.headers ? { headers: Object.fromEntries(Object.entries(r.headers).map(([h, d]) => [h, { description: d, schema: { type: "string" } }])) } : {}) }
				: r.response === "sse"
				? { description: "server-sent events", content: { "text/event-stream": { schema: { $ref: r.path === "/global/event" ? "#/components/schemas/GlobalFrame" : "#/components/schemas/Event" } } } }
				: {
						description: "ok",
						content: { "application/json": { schema: strip(withRefs(r.response)) } },
						...(r.headers ? { headers: Object.fromEntries(Object.entries(r.headers).map(([h, d]) => [h, { description: d, schema: { type: "string" } }])) } : {}),
					};
		const err = { description: "error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } };
		paths[p] ??= {};
		paths[p][r.method.toLowerCase()] = {
			operationId: r.operationId,
			summary: r.summary,
			...(parameters.length ? { parameters } : {}),
			...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: strip(withRefs(r.body)) } } } } : {}),
			responses: {
				[String(r.status ?? 200)]: ok,
				...(r.also ? { [String(r.also.status)]: { description: r.also.description, content: { "application/json": { schema: strip(withRefs(r.also.response)) } } } } : {}),
				...(r.bytes ? { "304": { description: "not modified: the etag matched if-none-match; no body" } } : {}),
				"400": err,
				"401": err,
				"404": err,
				...Object.fromEntries((r.errors ?? []).map((code) => [String(code), { ...err, description: code === 409 ? "BusyError (a turn is running) or ConflictError (already settled, imported history, a used client id)" : "error" }])),
			},
		};
	}
	const doc = {
		openapi: "3.1.0",
		info: { title: "cmx2 daemon", version: String(M.CONTRACT_VERSION), description: `generated from packages/contract/src/manifest.ts. ${M.ENCODING}` },
		components: { schemas, securitySchemes: { basic: { type: "http", scheme: "basic", description: "user cmx2 (opencode accepted during cutover), password CMX2_SERVER_PASSWORD" } } },
		security: [{ basic: [] }],
		paths,
	};
	return `${JSON.stringify(doc, null, "\t")}\n`;
}

export const OUT = join(import.meta.dir, "../../client");
export function outputs(): Record<string, string> {
	return { "src/events.ts": eventsTs(), "src/client.ts": clientTs(), "openapi.json": openapi() };
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	let stale = 0;
	for (const [rel, body] of Object.entries(outputs())) {
		const path = join(OUT, rel);
		let current = "";
		try {
			current = readFileSync(path, "utf8");
		} catch {}
		if (current === body) continue;
		if (check) {
			console.error(`${rel} is out of date with the manifest; run bun run contract`);
			stale++;
		} else {
			writeFileSync(path, body);
			console.log(`wrote packages/client/${rel}`);
		}
	}
	if (stale) process.exit(1);
}
