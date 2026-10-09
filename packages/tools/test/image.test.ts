import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { readTool } from "../src/fs.ts";
import { imageConverter, imageParts, MAX_EDGE, readDimensions, REENCODE_ABOVE, resizeDataUrl, resizeImage, sniffImage } from "../src/image.ts";
import { shellTool, type ShellResult } from "../src/shell.ts";
import type { ImagePart } from "../src/types.ts";
import { makePng, scratch, textOf } from "./helpers.ts";

test("dimensions come from the header; bytes that only claim to be a png get none", () => {
	const png = makePng(640, 480);
	expect(sniffImage(png)).toBe("image/png");
	expect(readDimensions(png, "image/png")).toEqual({ width: 640, height: 480 });
	expect(readDimensions(new TextEncoder().encode("not an image at all, just text"), "image/png")).toBeUndefined();
});

test("a small image passes through untouched", async () => {
	const png = makePng(300, 200);
	const r = await resizeImage(png, "image/png");
	expect(r).toMatchObject({ ok: true, resized: false, mime: "image/png", width: 300, height: 200 });
});

test("a big image is resized host-side to the edge limit", async () => {
	expect(imageConverter()).not.toBeNull();
	const png = makePng(4000, 3000);
	const r = await resizeImage(png, "image/png");
	if (!r.ok) throw new Error(r.placeholder);
	console.log(`resized with ${imageConverter()!.name}: 4000x3000 ${png.length} bytes -> ${r.width}x${r.height} ${r.bytes} bytes ${r.mime}`);
	expect(r.resized).toBe(true);
	expect(Math.max(r.width!, r.height!)).toBeLessThanOrEqual(MAX_EDGE);
	expect(r.original).toEqual({ width: 4000, height: 3000 });
	const back = readDimensions(new Uint8Array(Buffer.from(r.data, "base64")), r.mime);
	expect(back).toEqual({ width: r.width!, height: r.height! });
});

test("a data url photo from a client is resized the same way", async () => {
	const url = `data:image/png;base64,${Buffer.from(makePng(2600, 1200)).toString("base64")}`;
	const r = await resizeDataUrl(url);
	expect(r?.ok).toBe(true);
	if (r?.ok) expect(Math.max(r.width!, r.height!)).toBeLessThanOrEqual(MAX_EDGE);
	expect(await resizeDataUrl("data:text/plain;base64,aGk=")).toBeUndefined();
});

test("read of a big image returns a resized image part", async () => {
	const env = scratch("readimg");
	writeFileSync(join(env.cwd, "shot.png"), makePng(3000, 2000));
	const r = await readTool(env).execute("c", { path: "shot.png" });
	const img = r.content.find((c) => c.type === "image") as ImagePart;
	expect(img).toBeDefined();
	const dims = readDimensions(new Uint8Array(Buffer.from(img.data, "base64")), img.mimeType)!;
	expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_EDGE);
	expect(textOf(r)).toContain("resized from 3000x2000");
});

test("an image a command writes and names in its output arrives as an image part", async () => {
	const env = scratch("shellimg");
	writeFileSync(join(env.cwd, "old.png"), makePng(10, 10));
	const src = join(env.cwd, "src.png");
	writeFileSync(src, makePng(2400, 1600));
	// old.png is listed but was not written by the command; out/shot.png was
	await Bun.sleep(1100);
	const r = await shellTool(env).execute("c", { command: `mkdir -p out && cp src.png out/shot.png && echo "saved screenshot to out/shot.png (see old.png)"` });
	const s = r.structuredContent as ShellResult;
	expect(s.images).toEqual([join(env.cwd, "out/shot.png")]);
	const imgs = r.content.filter((c) => c.type === "image") as ImagePart[];
	expect(imgs.length).toBe(1);
	const dims = readDimensions(new Uint8Array(Buffer.from(imgs[0]!.data, "base64")), imgs[0]!.mimeType)!;
	expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_EDGE);
});

/** a png of a smooth gradient with a little noise: heavy as png, light as jpeg. colorType 2 is rgb, 6 is rgba (alpha 255 everywhere, or 128 on the left half when transparent) */
function noisyPng(width: number, height: number, colorType: 2 | 6, transparent = false): Uint8Array {
	const px = colorType === 6 ? 4 : 3;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = colorType;
	const stride = 1 + width * px;
	const raw = Buffer.alloc(stride * height);
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return (seed >> 16) % 7;
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = y * stride + 1 + x * px;
			raw[o] = ((x * 255) / width + rnd()) & 255;
			raw[o + 1] = ((y * 255) / height + rnd()) & 255;
			raw[o + 2] = (((x + y) * 127) / (width + height) + rnd()) & 255;
			if (px === 4) raw[o + 3] = transparent && x < width / 2 ? 128 : 255;
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

test("a heavy rgb png becomes a jpeg of the same size, and the caption says so", async () => {
	if (!imageConverter()) return;
	const png = noisyPng(900, 700, 2);
	expect(png.length).toBeGreaterThan(REENCODE_ABOVE);
	const r = await resizeImage(png, "image/png");
	if (!r.ok) throw new Error(r.placeholder);
	console.log(`reencoded with ${imageConverter()!.name}: ${png.length} bytes png -> ${r.bytes} bytes ${r.mime}`);
	expect(r.mime).toBe("image/jpeg");
	expect(r.resized).toBe(false);
	expect(r.reencoded).toEqual({ from: "image/png", bytes: png.length });
	expect(r.bytes).toBeLessThanOrEqual(png.length * 0.7);
	expect(readDimensions(new Uint8Array(Buffer.from(r.data, "base64")), r.mime)).toEqual({ width: 900, height: 700 });
	const parts = await imageParts(png, "image/png", "shot");
	expect((parts[0] as { text: string }).text).toContain(`900x700, ${r.bytes} bytes, jpeg from a ${png.length} byte png)`);
	expect((parts[1] as ImagePart).mimeType).toBe("image/jpeg");
});

test("a heavy rgba png with real transparency stays png", async () => {
	if (!imageConverter()) return;
	const png = noisyPng(900, 700, 6, true);
	expect(png.length).toBeGreaterThan(REENCODE_ABOVE);
	const r = await resizeImage(png, "image/png");
	expect(r).toMatchObject({ ok: true, mime: "image/png", resized: false, bytes: png.length });
	expect((r as { reencoded?: unknown }).reencoded).toBeUndefined();
});

test("a heavy rgba png whose alpha is unused becomes a jpeg when imagemagick can check it", async () => {
	if (!imageConverter()) return;
	const png = noisyPng(900, 700, 6);
	expect(png.length).toBeGreaterThan(REENCODE_ABOVE);
	const r = await resizeImage(png, "image/png");
	if (!Bun.which("magick")) {
		// nothing can vouch for the alpha, so the png is left alone
		expect(r).toMatchObject({ ok: true, mime: "image/png", bytes: png.length });
		return;
	}
	expect(r).toMatchObject({ ok: true, mime: "image/jpeg", width: 900, height: 700, reencoded: { from: "image/png", bytes: png.length } });
	if (r.ok) expect(r.bytes).toBeLessThanOrEqual(png.length * 0.7);
});

test("a png under the re-encode threshold is left alone", async () => {
	const png = noisyPng(100, 80, 2);
	expect(png.length).toBeLessThan(REENCODE_ABOVE);
	const r = await resizeImage(png, "image/png");
	expect(r).toMatchObject({ ok: true, mime: "image/png", resized: false, bytes: png.length });
});

test("bytes that are not an image come back as a placeholder, whatever the mime says", async () => {
	const r = await resizeImage(new TextEncoder().encode("<html>nope</html>"), "image/png");
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.placeholder).toContain("not a png, jpeg, gif, webp or heic");
	const parts = await imageParts(new TextEncoder().encode("garbage"), "image/jpeg", "bad.jpg");
	expect(parts.length).toBe(1);
	expect((parts[0] as { text: string }).text).toContain("image bad.jpg: (image not attached");
});

test("a png whose header says no size comes back as a placeholder, not an image a provider refuses forever", async () => {
	// the signature and nothing a reader can size: what a decoded spill notice behind a png signature looks like
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
	const r = await resizeImage(bytes, "image/png");
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.placeholder).toContain("start like a png but have no readable size");
});
