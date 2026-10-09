import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFrame, EVENT_VERSIONS } from "@cmx2/client";
import { OUT, outputs } from "../src/generate.ts";
import { EVENTS, ROUTES } from "../src/manifest.ts";

test("the client package and openapi on disk match the manifest (run bun run contract after editing it)", () => {
	for (const [rel, body] of Object.entries(outputs())) expect(readFileSync(join(OUT, rel), "utf8")).toBe(body);
});

test("every route has a unique operation id and every event a description", () => {
	const ops = ROUTES.map((r) => r.operationId);
	expect(new Set(ops).size).toBe(ops.length);
	const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
	expect(new Set(keys).size).toBe(keys.length);
	for (const [type, def] of Object.entries(EVENTS)) {
		expect(def.description.length).toBeGreaterThan(10);
		expect(type).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
	}
	expect(Object.keys(EVENT_VERSIONS).sort()).toEqual(Object.keys(EVENTS).sort());
});

test("the generated decoder reads both streams and reports what it does not know", () => {
	const bare = decodeFrame(JSON.stringify({ id: "e1", type: "session.idle", properties: { sessionID: "ses_1" } }));
	expect(bare).toMatchObject({ ok: true, event: { type: "session.idle" } });
	const wrapped = decodeFrame(JSON.stringify({ directory: "/w", project: "/w", payload: { id: "e2", type: "server.heartbeat", properties: {} } }));
	expect(wrapped).toMatchObject({ ok: true, directory: "/w", event: { type: "server.heartbeat" } });
	expect(decodeFrame(JSON.stringify({ payload: { id: "e3", type: "future.thing", properties: {} } }))).toEqual({ ok: false, reason: "unknown-type", type: "future.thing" });
	expect(decodeFrame("{")).toEqual({ ok: false, reason: "json" });
	expect(decodeFrame(JSON.stringify({ payload: { type: 3 } }))).toEqual({ ok: false, reason: "shape" });
});

test("openapi is 3.1 with a discriminated event union and every route", () => {
	const doc = JSON.parse(outputs()["openapi.json"]!);
	expect(doc.openapi).toBe("3.1.0");
	expect(Object.keys(doc.components.schemas.Event.discriminator.mapping).length).toBe(Object.keys(EVENTS).length);
	const ops = Object.values(doc.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
	expect(ops.sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
});

test("a8: openapi declares 409 where it can happen, Part and SessionStatus are discriminated unions, the prompt's 202 names queued", () => {
	const doc = JSON.parse(outputs()["openapi.json"]!);
	for (const [path, method] of [
		["/session/{sessionID}/message", "post"],
		["/session/{sessionID}/command", "post"],
		["/session/{sessionID}/message/{messageID}", "delete"],
		["/session/{sessionID}/prompt", "post"],
		["/permission/{requestID}/reply", "post"],
		["/question/{requestID}/reply", "post"],
	] as const) {
		expect(doc.paths[path][method].responses["409"]).toBeDefined();
	}
	expect(doc.paths["/session/{sessionID}/message"].post.responses["202"]).toBeDefined();
	const part = doc.components.schemas.Part;
	expect(part.discriminator.propertyName).toBe("type");
	expect(Object.keys(part.discriminator.mapping).sort()).toEqual(["compaction", "file", "patch", "reasoning", "step-finish", "step-start", "subtask", "text", "tool"]);
	expect(doc.components.schemas.SessionStatus.discriminator).toMatchObject({ propertyName: "type", mapping: { idle: expect.any(String), busy: expect.any(String), retry: expect.any(String) } });
	expect(doc.components.schemas.ToolState.discriminator.propertyName).toBe("status");
	expect(doc.paths["/session/{sessionID}/prompt"].post.responses["202"].content["application/json"].schema.properties.queued).toBeDefined();
	expect(doc.paths["/session/{sessionID}/message"].get.responses["200"].headers["x-cmx2-seq"]).toBeDefined();
});
