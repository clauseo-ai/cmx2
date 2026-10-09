import { ROUTES, type RouteDef } from "@cmx2/contract";
import { Value } from "typebox/value";

/** every error leaves the daemon as `{name, data: {message}}` with a status that means something */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly name: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export const badRequest = (message: string, extra?: Record<string, unknown>) => new HttpError(400, "BadRequestError", message, extra);
export const notFound = (message: string) => new HttpError(404, "NotFoundError", message);

const byOp = new Map<string, RouteDef>(ROUTES.map((r) => [r.operationId, r]));

export function route(operationId: string): RouteDef {
	const r = byOp.get(operationId);
	if (!r) throw new Error(`no route ${operationId} in the manifest`);
	return r;
}

/** the subschema at a json pointer, walking object properties and array items */
function at(schema: any, pointer: string): any {
	let s = schema;
	for (const seg of pointer.split("/").slice(1)) {
		if (!s) return undefined;
		s = s.properties?.[seg] ?? (s.type === "array" ? s.items : undefined);
	}
	return s;
}

function firstError(schema: unknown, value: unknown): string {
	const e = [...Value.Errors(schema as never, value)][0] as { instancePath?: string; message?: string } | undefined;
	if (!e) return "does not match the schema";
	const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, ".") : "body";
	const sub = at(schema, e.instancePath ?? "");
	const consts = sub?.anyOf?.every((x: any) => x.const !== undefined) ? sub.anyOf.map((x: any) => x.const) : sub?.const !== undefined ? [sub.const] : undefined;
	if (consts) return `${where} must be one of ${consts.join(", ")}`;
	return `${where} ${e.message ?? "is invalid"}`;
}

/** parses and checks a request body against the route's schema in the manifest */
export async function bodyOf<T = Record<string, any>>(req: Request, operationId: string): Promise<T> {
	const schema = route(operationId).body;
	let v: unknown = {};
	const raw = await req.text();
	if (raw.trim()) {
		try {
			v = JSON.parse(raw);
		} catch {
			throw badRequest("the body must be json");
		}
	}
	if (schema && !Value.Check(schema, v)) throw badRequest(`${firstError(schema, v)}. see openapi.json for ${operationId}`);
	return v as T;
}

/** checks query params against the route's schema; unknown params pass (clients send extras) */
export function queryOf(url: URL, operationId: string): Record<string, string> {
	const q = Object.fromEntries(url.searchParams);
	const schema = route(operationId).query as { properties?: Record<string, unknown> } | undefined;
	if (!schema?.properties) return q;
	for (const [k, s] of Object.entries(schema.properties)) {
		if (q[k] !== undefined && !Value.Check(s as never, q[k])) throw badRequest(`query ${k} ${firstError(s, q[k]).replace(/^body /, "")}`);
	}
	return q;
}

export function intParam(v: string | undefined, name: string, opts: { min?: number; max?: number; fallback: number }): number {
	if (v === undefined || v === "") return opts.fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || (opts.min !== undefined && n < opts.min)) throw badRequest(`${name} must be a whole number${opts.min !== undefined ? ` of at least ${opts.min}` : ""}`);
	return opts.max !== undefined ? Math.min(n, opts.max) : n;
}

export function errorResponse(e: HttpError): Response {
	return Response.json({ name: e.name, data: { message: e.message, ...e.extra } }, { status: e.status });
}
