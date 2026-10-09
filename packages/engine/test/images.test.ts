import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { COMPACTION_DEFAULTS, contextOf, contextWithSeq } from "../src/compaction.ts";
import { type Config, DEFAULTS } from "../src/config.ts";
import { classifyProviderError, mediaRefusal } from "../src/errors.ts";
import { checkedImages, type ContextImage, DROPPED_IMAGE, type DropLimits, dropBlocks, droppedUserImage, dropsOf, imageEdge, inventory, MAX_IMAGE_BASE64, NOT_AN_IMAGE, planDrop, planOversized, planUnreadable, requestBytes, UNREADABLE_IMAGE } from "../src/images.ts";
import { type EngineEvent, EngineSession } from "../src/session.ts";

/**
 * images in the context are held to a byte budget and the provider's request limit: the pure planner,
 * the transcript line that makes a drop the same live and on resume, the size refusals that recover by
 * dropping, and a session against a local stand-in for anthropic's wire format (as in retry.test.ts) that
 * reads screenshots until the budget drops the oldest. the real provider path is a dev daemon on the proxy.
 */

const MB = 1_000_000;

function img(over: Partial<ContextImage> & { at: number }): ContextImage {
	return { seq: over.at + 1, block: 1, bytes: MB, user: false, seen: true, ...over };
}

const limits = (over: Partial<DropLimits> = {}): DropLimits => ({ budget: 10 * MB, keepBytes: 4 * MB, maxImages: 600, highImages: 480, keepImages: 240, room: 27 * MB, ...over });

describe("planDrop", () => {
	test("under the budget nothing goes; past it the newest are kept up to the keep line and every older seen image goes", () => {
		const nine = Array.from({ length: 9 }, (_, i) => img({ at: i }));
		expect(planDrop(nine, "budget", limits())).toBeUndefined();
		const eleven = Array.from({ length: 11 }, (_, i) => img({ at: i }));
		const p = planDrop(eleven, "budget", limits())!;
		expect(p.reason).toBe("budget");
		expect(p.drop.map((i) => i.at)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(p.bytes).toEqual([11 * MB, 4 * MB]);
		expect(p.count).toEqual([11, 4]);
	});

	test("a turn's first request drops at three quarters of the budget; right after a compaction it drops past the keep line", () => {
		const eight = Array.from({ length: 8 }, (_, i) => img({ at: i }));
		expect(planDrop(eight, "budget", limits())).toBeUndefined();
		expect(planDrop(eight, "turn", limits())!.drop).toHaveLength(4);
		const five = eight.slice(0, 5);
		expect(planDrop(five, "turn", limits())).toBeUndefined();
		expect(planDrop(five, "compaction", limits())!.drop.map((i) => i.at)).toEqual([0]);
	});

	test("images the model has not seen and images the user attached stay; what stays counts against the keep line", () => {
		const imgs = [img({ at: 0 }), img({ at: 1, user: true }), ...Array.from({ length: 8 }, (_, i) => img({ at: 2 + i })), img({ at: 10, seen: false }), img({ at: 11, seen: false })];
		const p = planDrop(imgs, "budget", limits())!;
		// 12 MB: the two unseen and the user's image hold 3 MB of the 4 MB line, so one seen image stays
		expect(p.drop.map((i) => i.at)).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
		expect(p.drop.some((i) => i.user || !i.seen)).toBe(false);
	});

	test("what stays is the recent end: once an image does not fit, every older one goes, even a small one", () => {
		const imgs = [img({ at: 0, bytes: 0.1 * MB }), img({ at: 1, bytes: 6 * MB }), img({ at: 2, bytes: 3 * MB }), img({ at: 3, bytes: 2 * MB })];
		const p = planDrop(imgs, "budget", limits())!;
		expect(p.drop.map((i) => i.at)).toEqual([0, 1, 2]);
	});

	test("a request that would pass the provider's limit drops whatever the budget says, and the user's images only when the rest is not enough", () => {
		const imgs = [img({ at: 0, user: true, bytes: 5 * MB }), img({ at: 1, bytes: 2 * MB }), img({ at: 2, bytes: 2 * MB })];
		const off = limits({ budget: Number.POSITIVE_INFINITY, keepBytes: 2 * MB, room: 6 * MB });
		const p = planDrop(imgs, "budget", off)!;
		expect(p.reason).toBe("limit");
		expect(p.drop.map((i) => i.at)).toEqual([1, 2]);
		expect(p.bytes[1]).toBe(5 * MB);
		const tight = planDrop(imgs, "budget", { ...off, room: 4 * MB })!;
		expect(tight.drop.map((i) => i.at)).toEqual([0, 1]);
		expect(tight.bytes[1]).toBeLessThanOrEqual(4 * MB);
	});

	test("with the budget off only the provider's limits drop", () => {
		const imgs = Array.from({ length: 20 }, (_, i) => img({ at: i }));
		const off = limits({ budget: Number.POSITIVE_INFINITY, keepBytes: 10 * MB, room: 25 * MB });
		for (const mode of ["budget", "turn", "compaction"] as const) expect(planDrop(imgs, mode, off)).toBeUndefined();
		expect(planDrop(imgs, "budget", { ...off, room: 15 * MB })!.reason).toBe("limit");
	});

	test("the provider's image count is a limit too, and a routine trigger at 80%", () => {
		const many = Array.from({ length: 81 }, (_, i) => img({ at: i, bytes: 1000 }));
		const p = planDrop(many, "budget", limits({ maxImages: 100, highImages: 80, keepImages: 40 }))!;
		expect(p.count).toEqual([81, 40]);
	});

	test("after a refusal everything but the newest image may go; an image over the per-image cap always goes", () => {
		const imgs = [img({ at: 0, user: true }), img({ at: 1, seen: false }), img({ at: 2, seen: false })];
		const p = planDrop(imgs, "rejected", limits({ keepBytes: 0.5 * MB }))!;
		expect(p.reason).toBe("rejected");
		expect(p.drop.map((i) => i.at)).toEqual([0, 1]);
		const heavy = [img({ at: 0, bytes: MAX_IMAGE_BASE64 + 1 }), img({ at: 1 })];
		expect(planDrop(heavy, "budget", limits())!.drop.map((i) => i.at)).toEqual([0]);
	});

	test("an image whose message is not in the transcript yet is never named", () => {
		const imgs = Array.from({ length: 11 }, (_, i) => img({ at: i, seq: i === 0 ? undefined : i + 1 }));
		expect(planDrop(imgs, "budget", limits())!.drop.some((i) => i.seq === undefined)).toBe(false);
	});

	/** a session's steps as planDrop sees them: one new screenshot a step, the one before it now seen */
	function steps(n: number, l: DropLimits, opts: { shot: number; protectedImages?: ContextImage[] }): number {
		let live: ContextImage[] = [...(opts.protectedImages ?? [])];
		let drops = 0;
		for (let k = 0; k < n; k++) {
			live = [...live.map((i) => ({ ...i, seen: true })), img({ at: 100 + k, bytes: opts.shot, seen: false })];
			const p = planDrop(live, "budget", l);
			if (!p) continue;
			drops++;
			live = live.filter((i) => !p.drop.includes(i));
		}
		return drops;
	}

	test("a limit drop leaves room for more than one more image, so a small request limit does not drop every step", () => {
		// the session passes keepBytes as the keep share of min(budget, room): 40% of 4.5 MB here
		const room = 4.5 * MB;
		const drops = steps(30, limits({ room, keepBytes: room * 0.4 }), { shot: 0.3 * MB });
		expect(drops).toBeGreaterThan(0);
		expect(drops).toBeLessThanOrEqual(4);
	});

	test("images a drop may not take, over the budget on their own, make drops wait for a real batch instead of one screenshot a step", () => {
		const users = Array.from({ length: 13 }, (_, i) => img({ at: i, user: true }));
		// 13 MB the routine drop cannot touch: screenshots go ten at a time (3 MB, half of budget minus keep)
		expect(steps(30, limits(), { shot: 0.3 * MB, protectedImages: users })).toBe(2);
	});
});

describe("the context with drops applied", () => {
	const shot = (id: string, data: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `image /tmp/${id}.png (10x10, 4 bytes)` }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 1 });
	const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `/tmp/${id}.png` } }], stopReason: "toolUse", timestamp: 1 });

	test("inventory marks what the model has answered after, and requestBytes counts the base64", () => {
		const msgs: any[] = [{ role: "system", content: "sys" }, { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png", filename: "mock.png" }] }, call("a"), shot("a", "BBBBBBBB"), call("b"), shot("b", "CC")];
		const inv = inventory(msgs, (m) => msgs.indexOf(m) + 1);
		expect(inv.map((i) => [i.at, i.seq, i.block, i.bytes, i.user, i.seen])).toEqual([
			[1, 2, 1, 4, true, true],
			[3, 4, 1, 8, false, true],
			[5, 6, 1, 2, false, false],
		]);
		// an errored reply does not count as having seen what came before it
		const errored = [...msgs, { role: "assistant", content: [], stopReason: "error", timestamp: 1 }];
		expect(inventory(errored, () => 1).map((i) => i.seen)).toEqual([true, true, false]);
		expect(requestBytes(msgs)).toBeGreaterThan(14);
	});

	test("a request never carries bytes that are no image, and carries the type the bytes say", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");
		const ok = shot("a", png);
		expect(checkedImages(ok as never)).toBe(ok as never);
		const garbage = checkedImages(shot("b", "thelastof19linesshownfulloutputat") as never) as any;
		expect(garbage.content[1]).toEqual({ type: "text", text: NOT_AN_IMAGE });
		expect(garbage.content[0].text).toContain("image /tmp/b.png");
		const mislabelled = checkedImages(shot("c", jpeg) as never) as any;
		expect(mislabelled.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: jpeg });
		const user = { role: "user", content: [{ type: "image", data: "!!!!", mimeType: "image/png" }] };
		expect((checkedImages(user as never) as any).content[0].text).toBe(NOT_AN_IMAGE);
		const assistant = { role: "assistant", content: [{ type: "text", text: "x" }] };
		expect(checkedImages(assistant as never)).toBe(assistant as never);
	});

	test("after an unreadable image, the images since the last reply go; with none, every image", () => {
		const imgs = [img({ at: 0 }), img({ at: 1 }), img({ at: 2, seen: false }), img({ at: 3, seen: false, seq: undefined })];
		const p = planUnreadable(imgs)!;
		expect(p.reason).toBe("unreadable");
		expect(p.drop.map((i) => i.at)).toEqual([2]);
		expect(planUnreadable(imgs.slice(0, 2))!.drop.map((i) => i.at)).toEqual([0, 1]);
		expect(planUnreadable([])).toBeUndefined();
	});

	test("a many-image refusal takes the images over 2000 px, read from their headers", () => {
		const header = (w: number, h: number) => {
			const b = Buffer.alloc(33);
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
			b.write("IHDR", 12, "latin1");
			b.writeUInt32BE(w, 16);
			b.writeUInt32BE(h, 20);
			return b.toString("base64");
		};
		expect(imageEdge(header(2600, 1200))).toBe(2600);
		expect(imageEdge(header(1900, 1200))).toBe(1900);
		expect(imageEdge("bm90IGFuIGltYWdl")).toBeUndefined();
		const imgs = [img({ at: 0 }), img({ at: 1 }), img({ at: 2 })];
		const edges = [1900, 2600, 1200];
		const p = planOversized(imgs, (i) => edges[i.at])!;
		expect(p.drop.map((i) => i.at)).toEqual([1]);
		expect(planOversized(imgs, () => 1900)).toBeUndefined();
	});

	test("dropBlocks swaps only images for the marker; the user's says which file", () => {
		const r = dropBlocks(shot("a", "BBBB") as never, new Map([[0, "budget"], [1, "budget"]] as const)) as any;
		expect(r.content[0].text).toBe("image /tmp/a.png (10x10, 4 bytes)");
		expect(r.content[1]).toEqual({ type: "text", text: DROPPED_IMAGE });
		const u = dropBlocks({ role: "user", content: [{ type: "image", data: "A", mimeType: "image/png", filename: "mock.png" }] } as never, new Map([[0, "limit"]] as const)) as any;
		expect(u.content[0].text).toBe(droppedUserImage("mock.png"));
		const same = shot("a", "BBBB");
		expect(dropBlocks(same as never, new Map([[3, "budget"]] as const))).toBe(same as never);
		const bad = dropBlocks(shot("a", "BBBB") as never, new Map([[1, "unreadable"]] as const)) as any;
		expect(bad.content[1].text).toBe(UNREADABLE_IMAGE);
	});

	test("a drop line applies wherever its messages land: plain, after a compaction, and through a revert", () => {
		const all: any[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "go" },
			call("a"),
			shot("a", "AAAA"),
			call("b"),
			shot("b", "BBBB"),
			{ role: "drop", images: [[4, 1]], reason: "budget", bytes: [8, 4], count: [2, 1], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 1 },
		];
		expect(dropsOf(all).get(4)).toEqual(new Map([[1, "budget"]]));
		const plain = contextOf(all) as any[];
		expect(plain.some((m) => m.role === "drop")).toBe(false);
		expect(plain[3].content[1].text).toBe(DROPPED_IMAGE);
		expect(plain[5].content[1].type).toBe("image");
		// copies carry the position of the message they stand for
		const withSeq = contextWithSeq(all);
		expect(withSeq[3]!.seq).toBe(4);
		expect((withSeq[3]!.m as any).content[1].text).toBe(DROPPED_IMAGE);

		const compacted = [...all, { role: "compaction", summary: "## goal\n- x", state: "s", tailFrom: 3, cleared: [], trigger: "auto", tokensBefore: 1, usage: {}, model: "m", summaryMs: 0, prefire: false, timestamp: 1 }];
		const c = contextOf(compacted) as any[];
		expect(c.find((m) => m.toolCallId === "a").content[1].text).toBe(DROPPED_IMAGE);
		expect(c.find((m) => m.toolCallId === "b").content[1].type).toBe("image");

		// a revert that takes the drop line back does not bring the image back
		const reverted = [...all, { role: "revert", from: 7, timestamp: 1 }];
		expect((contextOf(reverted) as any[])[3].content[1].text).toBe(DROPPED_IMAGE);
	});
});

describe("size refusals", () => {
	const vertex = '400 [{"error":{"code":400,"message":"The message size (30585366 bytes) exceeds 30.000MB limit.","status":"FAILED_PRECONDITION"}}]';
	test("vertex's byte limit, anthropic's 413 and gemini's payload size read as bytes; image counts as count; one image as image; other 400s as nothing", () => {
		const cases: Array<[string, string | undefined]> = [
			[vertex, "bytes"],
			['413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', "bytes"],
			["413 Request Entity Too Large", "bytes"],
			['400 {"error":{"code":400,"message":"Request payload size exceeds the limit: 20971520 bytes.","status":"INVALID_ARGUMENT"}}', "bytes"],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"too many images and documents: 101 + 0 > 100"}}', "count"],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"Too much media: 0 document pages + 103 images > 100"}}', "count"],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}', "image"],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 7378876 bytes > 5242880 bytes"}}', "image"],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1204511 tokens > 1000000 maximum"}}', undefined],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.name: String should match pattern"}}', undefined],
			['400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"},"request_id":"req_vrtx_011CfdFRxH87xCCC9fod65qw"}', "unreadable"],
			['429 {"type":"error","error":{"type":"rate_limit_error","message":"Request too large for model in organization on tokens per min (TPM)"}}', undefined],
		];
		for (const [raw, kind] of cases) expect([raw, mediaRefusal(raw)]).toEqual([raw, kind as never]);
	});

	test("the vertex refusal is a typed overflow with vertex's own words as the detail (its body is a json array)", () => {
		const t = classifyProviderError({ provider: "anthropic", model: "claude-opus-5-5", errorMessage: vertex });
		expect(t.name).toBe("ContextOverflowError");
		expect(t.kind).toBe("context_overflow");
		expect(t.detail).toBe("The message size (30585366 bytes) exceeds 30.000MB limit.");
		expect(t.message).toBe("the request is over anthropic/claude-opus-5-5's size limit (too many bytes or images)");
		// a bracket before the json does not hide the body
		const bracketed = classifyProviderError({ provider: "anthropic", model: "m", errorMessage: 'Error [proxy]: {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.name: String should match pattern"}}' });
		expect(bracketed.detail).toBe("tools.0.name: String should match pattern");
	});
});

// ---------- a session reading screenshots against a local stand-in for the provider ----------

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
function sseText(text: string): string {
	return [
		start,
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
}
let callN = 0;
function sseSnap(): string {
	const id = `toolu_snap_${++callN}`;
	return [
		start,
		ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "snap", input: {} } }),
		ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
		ev("content_block_stop", { type: "content_block_stop", index: 0 }),
		ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }),
		ev("message_stop", { type: "message_stop" }),
	].join("");
}

const imagesIn = (body: any) => JSON.stringify(body?.messages ?? []).split('"type":"image"').length - 1;
const markersIn = (body: any) => JSON.stringify(body?.messages ?? []).split("image dropped from context").length - 1;

/** what the stand-in answers: a script of snaps then text, a summary for a compaction, or a size refusal (vertex's bytes or anthropic's count) when a request carries more images than `refuseOver` */
let script: Array<"snap" | "text"> = [];
let refuseOver = Number.POSITIVE_INFINITY;
let refuseWith: "bytes" | "count" = "bytes";
const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;
const SUMMARY = `## goal\n- take screenshots and describe them\n\n## constraints and preferences\n- (none)\n\n## done\n- took the screenshots the user asked for\n\n## in progress\n- (none)\n\n## blocked\n- (none)\n\n## key decisions\n- one screenshot per step\n\n## ruled out\n- (none)\n\n## live state\n- (none)\n\n## next steps\n- describe the newest screenshot when asked\n\n## critical context\n- the screenshots are /tmp/shot-N.png, numbered in the order they were taken; each is 1200x900 and about 200 kB, and the newest is the one to describe next. older ones may have left the context; reading the file again brings one back\n\n## relevant files\n- /tmp/shot-1.png onward: the screenshots, newest last`;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json().catch(() => null);
			requests.push(body);
			if (imagesIn(body) > refuseOver) {
				if (refuseWith === "count") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `too many images and documents: ${imagesIn(body)} + 0 > ${refuseOver}` } }), { status: 400, headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify([{ error: { code: 400, message: "The message size (30585366 bytes) exceeds 30.000MB limit.", status: "FAILED_PRECONDITION" } }]), { status: 400, headers: { "content-type": "application/json" } });
			}
			const blocks = JSON.stringify(body?.messages ?? []).match(/"type":"base64","media_type":"[^"]+","data":"[^"]{0,24}/g) ?? [];
			const unreadable = blocks.some((b) => !b.endsWith('"data":"') && !b.split('"data":"')[1]!.startsWith("iVBORw0KGg")) || JSON.stringify(body ?? "").includes("QkFESU1BR0U");
			if (unreadable) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Could not process image" } }), { status: 400, headers: { "content-type": "application/json" } });
			const tail = JSON.stringify(body?.messages?.slice(-2) ?? "");
			if (tail.includes("the context is about to be compacted")) return new Response(sseText(SUMMARY), { headers: { "content-type": "text/event-stream" } });
			const next = script.shift() ?? "text";
			return new Response(next === "snap" ? sseSnap() : sseText("done"), { headers: { "content-type": "text/event-stream" } });
		},
	});
});

afterAll(() => server.stop(true));

/** png's signature, so the request guard takes the bytes for an image */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakePng = (n: number, seed: number) => Buffer.from(new Uint8Array(n).map((_, i) => (i < 8 ? PNG_MAGIC[i]! : (i * 31 + seed * 7) & 255))).toString("base64");

/** what the next screenshots are: a png, bytes that are no image at all (the boxbox icon session), or a png the provider cannot read */
let snapKind: "png" | "garbage" | "corrupt" = "png";

/** a screenshot tool: each call returns a caption and ~270 kB of base64 that is different every time */
let shots = 0;
const snap = {
	name: "snap",
	label: "snap",
	description: "take a screenshot",
	parameters: Type.Object({}),
	async execute() {
		const n = ++shots;
		const data = snapKind === "garbage" ? "thelastof19linesshownfulloutputat" : snapKind === "corrupt" ? `${fakePng(12, n)}QkFESU1BR0U` : fakePng(200_000, n);
		return { content: [{ type: "text" as const, text: `image /tmp/shot-${n}.png (1200x900, 200000 bytes)` }, { type: "image" as const, data, mimeType: "image/png" }], details: {} };
	},
};

function config(images: Config["images"]): Config {
	return {
		...structuredClone(DEFAULTS),
		model: "anthropic/claude-sonnet-5-5",
		effort: "low",
		permission: "allow",
		providers: { anthropic: { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-key" } },
		compaction: { ...COMPACTION_DEFAULTS, auto: false },
		images,
		sources: [],
	};
}

async function session(images: Config["images"], dataDir = mkdtempSync(join(tmpdir(), "cmx2-images-data-")), id?: string) {
	const events: EngineEvent[] = [];
	const s = await EngineSession.create({
		...(id ? { id, resume: {} } : {}),
		cwd: mkdtempSync(join(tmpdir(), "cmx2-images-")),
		config: config(images),
		dataDir,
		extraTools: [snap as never],
		onEvent: (e) => events.push(e),
		onStep: () => {},
	});
	return { s, events, dataDir };
}

describe("a session that reads screenshots", () => {
	test("past the budget the oldest seen screenshots drop in one batch, the prompt stays append-only after it, and a resume rebuilds the same context", async () => {
		const { s, events, dataDir } = await session({ budget: 1_000_000, keep: 0.4 });
		script = ["snap", "snap", "snap", "snap", "snap", "snap", "text"];
		requests.length = 0;
		await s.prompt("take six screenshots");
		await s.idle();
		expect(requests).toHaveLength(7);
		const drops = events.filter((e) => e.type === "session.images_dropped");
		// 4 x 270 kB passes 1 MB on the fifth request: the three seen ones go, the unseen fourth stays
		expect(drops).toHaveLength(1);
		expect(drops[0]!.properties).toMatchObject({ reason: "budget", dropped: 3, imagesBefore: 4, imagesAfter: 1 });
		expect(requests.map(imagesIn)).toEqual([0, 1, 2, 3, 1, 2, 3]);
		expect(requests.map(markersIn)).toEqual([0, 0, 0, 0, 3, 3, 3]);
		// after the drop every request starts with the one before it, so the cache entry it wrote is read. a
		// breakpoint turns string content into its one-block form; both render the same prompt
		const strip = (m: any) => JSON.stringify(typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m).replace(/,"cache_control":\{"type":"ephemeral"(,"ttl":"1h")?\}/g, "");
		for (const k of [5, 6]) {
			const prev = requests[k - 1].messages.map(strip);
			expect(requests[k].messages.slice(0, prev.length).map(strip)).toEqual(prev);
		}
		// the request log carries the sizes
		const sizes = s.requests.map((r) => r.image_bytes);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(1_100_000);
		expect(s.requests.at(-1)!.bytes).toBeGreaterThan(s.requests.at(-1)!.image_bytes);

		const lines = readFileSync(join(dataDir, "sessions", `${s.id}.jsonl`), "utf8").trim().split("\n");
		expect(lines.filter((l) => l.includes('"role":"drop"'))).toHaveLength(1);
		// the transcript still has every screenshot
		expect(lines.join("\n").split('"type":"image"').length - 1).toBe(6);
		const live = JSON.stringify(s.messages);
		s.dispose();
		const again = await session({ budget: 1_000_000, keep: 0.4 }, dataDir, s.id);
		expect(JSON.stringify(again.s.messages)).toBe(live);

		// a second drop after the resume names the transcript's own positions: the next turn starts at 800 kB of
		// seen screenshots, past three quarters of the budget, so it drops before its first request
		script = ["snap", "snap", "text"];
		requests.length = 0;
		await again.s.prompt("two more");
		await again.s.idle();
		const second = again.events.filter((e) => e.type === "session.images_dropped");
		expect(second.map((e) => e.properties.reason)).toEqual(["turn"]);
		expect(second[0]!.properties).toMatchObject({ dropped: 2, imagesBefore: 3, imagesAfter: 1 });
		expect(requests.map(imagesIn)).toEqual([1, 2, 3]);
		const relive = JSON.stringify(again.s.messages);
		again.s.dispose();
		const third = await session({ budget: 1_000_000, keep: 0.4 }, dataDir, s.id);
		expect(JSON.stringify(third.s.messages)).toBe(relive);
		third.s.dispose();
	}, 30_000);

	/** a turn, then the recovery turn a refusal starts, both settled */
	async function settle(s: EngineSession, events: EngineEvent[], until: string) {
		await s.idle();
		for (let i = 0; i < 50 && !events.some((e) => e.type === until); i++) await Bun.sleep(20);
		await Bun.sleep(50);
		await s.idle();
	}

	test("a request the provider refuses for its size drops every image but the newest and the task goes on in a new turn", async () => {
		const { s, events } = await session({ budget: false, keep: 0.4 });
		script = ["snap", "snap", "snap", "text", "text"];
		refuseOver = 2;
		refuseWith = "bytes";
		requests.length = 0;
		await s.prompt("take three screenshots");
		await settle(s, events, "session.images_dropped");
		refuseOver = Number.POSITIVE_INFINITY;
		const error = events.find((e) => e.type === "session.error")?.properties.error as any;
		expect(error?.name).toBe("ContextOverflowError");
		const drop = events.find((e) => e.type === "session.images_dropped")!;
		expect(drop.properties).toMatchObject({ reason: "rejected", imagesBefore: 3, imagesAfter: 1 });
		// the limit the session holds to came down from the 20 MB a gateway endpoint gets
		expect(drop.properties.requestLimit as number).toBeLessThan(20_000_000);
		expect(requests.map(imagesIn)).toEqual([0, 1, 2, 3, 1]);
		const last = requests.at(-1);
		expect(JSON.stringify(last.messages)).toContain("over the provider's size limit, so older images left the context");
		expect((s.messages.at(-1) as any).content[0].text).toBe("done");
		s.dispose();
	}, 30_000);

	test("a refusal for the image count lowers the count, not the byte limit", async () => {
		const { s, events } = await session({ budget: false, keep: 0.4 });
		script = ["snap", "snap", "snap", "text", "text"];
		refuseOver = 2;
		refuseWith = "count";
		requests.length = 0;
		await s.prompt("take three screenshots");
		await settle(s, events, "session.images_dropped");
		refuseOver = Number.POSITIVE_INFINITY;
		const drop = events.find((e) => e.type === "session.images_dropped")!;
		expect(drop.properties).toMatchObject({ reason: "rejected", imagesBefore: 3, imagesAfter: 1, requestLimit: 20_000_000 });
		expect(requests.map(imagesIn)).toEqual([0, 1, 2, 3, 1]);
		s.dispose();
	}, 30_000);

	test("a refusal with nothing left to drop stops instead of looping", async () => {
		const { s, events } = await session({ budget: false, keep: 0.4 });
		script = ["snap", "text"];
		refuseOver = 0;
		refuseWith = "bytes";
		requests.length = 0;
		await s.prompt("take one screenshot");
		await settle(s, events, "never");
		refuseOver = Number.POSITIVE_INFINITY;
		// the only image is the newest, which a refusal never takes; compaction is off here, so the session stops
		expect(requests.map(imagesIn)).toEqual([0, 1]);
		expect(events.some((e) => e.type === "session.images_dropped")).toBe(false);
		expect(s.state).toBe("idle");
		s.dispose();
	}, 30_000);

	test("images the user attached stay while the screenshots around them drop", async () => {
		const { s, events } = await session({ budget: 1_000_000, keep: 0.4 });
		script = ["snap", "snap", "snap", "text"];
		requests.length = 0;
		const photo = fakePng(200_000, 999);
		await s.prompt([
			{ type: "text", text: "match this mock, taking three screenshots" },
			{ type: "image", data: photo, mimeType: "image/png", filename: "mock.png" } as never,
		]);
		await s.idle();
		const drop = events.find((e) => e.type === "session.images_dropped")!;
		// the mock and the newest screenshot hold 533 kB of the 400 kB keep line, so both seen screenshots go
		expect(drop.properties).toMatchObject({ reason: "budget", dropped: 2, imagesBefore: 4, imagesAfter: 2 });
		const after = requests.at(-1);
		expect(JSON.stringify(after.messages)).toContain(photo.slice(0, 64));
		expect(JSON.stringify(after.messages)).not.toContain("the user attached");
		s.dispose();
	}, 30_000);

	test("bytes that are no image never reach the provider: the boxbox icon session goes on instead of failing every request", async () => {
		const { s, events } = await session({ budget: 1_000_000, keep: 0.4 });
		snapKind = "garbage";
		script = ["snap", "text"];
		requests.length = 0;
		await s.prompt("attach the sheet");
		await s.idle();
		snapKind = "png";
		expect(events.some((e) => e.type === "session.error")).toBe(false);
		expect(requests.map(imagesIn)).toEqual([0, 0]);
		expect(JSON.stringify(requests[1].messages)).toContain(NOT_AN_IMAGE);
		expect((s.messages.at(-1) as any).content[0].text).toBe("done");
		s.dispose();
	}, 30_000);

	test("an image the provider cannot read leaves with the images since its last reply, and the task goes on", async () => {
		const { s, events, dataDir } = await session({ budget: 1_000_000, keep: 0.4 });
		snapKind = "png";
		script = ["snap", "text"];
		requests.length = 0;
		await s.prompt("one good screenshot");
		await s.idle();
		snapKind = "corrupt";
		script = ["snap", "text", "text"];
		await s.prompt("now the broken one");
		await settle(s, events, "session.images_dropped");
		snapKind = "png";
		const error = events.find((e) => e.type === "session.error")?.properties.error as any;
		expect(error?.name).toBe("ProviderError");
		expect(error?.data?.message).toContain("could not read an image");
		const drop = events.find((e) => e.type === "session.images_dropped")!;
		// the good screenshot rode a request the provider answered, so only the new one goes
		expect(drop.properties).toMatchObject({ reason: "unreadable", dropped: 1, imagesBefore: 2, imagesAfter: 1 });
		const last = requests.at(-1);
		expect(JSON.stringify(last.messages)).toContain(UNREADABLE_IMAGE);
		expect(JSON.stringify(last.messages)).not.toContain("QkFESU1BR0U");
		expect(imagesIn(last)).toBe(1);
		expect((s.messages.at(-1) as any).content[0].text).toBe("done");
		const live = JSON.stringify(s.messages);
		s.dispose();
		const again = await session({ budget: 1_000_000, keep: 0.4 }, dataDir, s.id);
		expect(JSON.stringify(again.s.messages)).toBe(live);
		again.s.dispose();
	}, 30_000);

	test("a tool that keeps returning an image the provider cannot read stops after three recoveries", async () => {
		const { s, events } = await session({ budget: 1_000_000, keep: 0.4 });
		snapKind = "corrupt";
		script = Array.from({ length: 12 }, () => "snap" as const);
		requests.length = 0;
		await s.prompt("keep trying");
		for (let i = 0; i < 100 && !events.some((e) => e.type === "session.warning"); i++) await Bun.sleep(20);
		await Bun.sleep(50);
		await s.idle();
		snapKind = "png";
		script = [];
		expect(events.filter((e) => e.type === "session.images_dropped")).toHaveLength(3);
		expect(events.find((e) => e.type === "session.warning")?.properties.message).toContain("still refuses the request");
		// the first turn and three recovery turns, each a screenshot and a refusal
		expect(requests).toHaveLength(8);
		s.dispose();
	}, 30_000);

	test("a compaction drops what is over the keep line in the same rewrite, and a resume rebuilds it", async () => {
		const { s, events, dataDir } = await session({ budget: 1_000_000, keep: 0.4 });
		script = ["snap", "snap", "snap", "text"];
		requests.length = 0;
		await s.prompt("take three screenshots");
		await s.idle();
		// 800 kB: under the budget, so nothing dropped yet
		expect(events.some((e) => e.type === "session.images_dropped")).toBe(false);
		expect(await s.compact()).toBe(true);
		const drop = events.find((e) => e.type === "session.images_dropped")!;
		expect(drop.properties.reason).toBe("compaction");
		const live = JSON.stringify(s.messages);
		expect(live.split('"type":"image"').length - 1).toBeLessThanOrEqual(1);
		s.dispose();
		const again = await session({ budget: 1_000_000, keep: 0.4 }, dataDir, s.id);
		expect(JSON.stringify(again.s.messages)).toBe(live);
		again.s.dispose();
	}, 30_000);
});
