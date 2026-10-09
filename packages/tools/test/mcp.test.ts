import { expect, test } from "bun:test";
import { mcpContent } from "../src/mcp.ts";
import { MAX_EDGE, readDimensions } from "../src/image.ts";
import type { ImagePart, TextPart } from "../src/types.ts";
import { makePng } from "./helpers.ts";

const { toLlmContent } = await import("@earendil-works/pi-mcp");
const call = (content: unknown[]) => ({ content }) as Parameters<typeof mcpContent>[0];
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

test("an mcp image over the edge limit comes back resized, with a caption that says where it is from", async () => {
	const parts = await mcpContent(call([{ type: "image", data: b64(makePng(2600, 1200)), mimeType: "image/png" }]), "shots", "capture", toLlmContent);
	expect(parts.length).toBe(2);
	expect((parts[0] as TextPart).text).toContain("image from mcp shots capture (");
	expect((parts[0] as TextPart).text).toContain("resized from 2600x1200");
	const img = parts[1] as ImagePart;
	const dims = readDimensions(new Uint8Array(Buffer.from(img.data, "base64")), img.mimeType)!;
	expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_EDGE);
});

test("an mcp image that is not an image comes back as a placeholder line, and text still passes", async () => {
	const parts = await mcpContent(
		call([
			{ type: "text", text: "taken" },
			{ type: "image", data: Buffer.from("definitely not a png").toString("base64"), mimeType: "image/png" },
		]),
		"shots",
		"capture",
		toLlmContent,
	);
	expect(parts.map((p) => p.type)).toEqual(["text", "text"]);
	expect((parts[0] as TextPart).text).toBe("taken");
	expect((parts[1] as TextPart).text).toContain("image from mcp shots capture: (image not attached");
});

test("a tool that returns nothing says so", async () => {
	const parts = await mcpContent(call([]), "shots", "capture", toLlmContent);
	expect((parts[0] as TextPart).text).toBe("(the tool returned nothing)");
});
