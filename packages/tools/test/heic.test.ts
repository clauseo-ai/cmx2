/**
 * heic and heif intake: the sniffer and gates run everywhere; conversion needs a host that can read heic
 * (sips on macos, imagemagick built with libheif, or libheif's tools) and says so when it cannot.
 *
 * the fixtures in test/fixtures/heic are real heic files (hevc in a heif container, written by apple's
 * imageio): a 64x48 picture, top left red, top right green, bottom left blue, bottom right yellow, stored
 * with each of the eight exif orientations. o6 is what an iphone held upright writes (an irot box) and
 * also carries a camera make and model and a gps position (the greenwich observatory), so a stripped
 * result is told from one that kept them.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTool } from "../src/fs.ts";
import { convert, heicSize, heifCliDecoder, hostHeicDecoders, imageConverter, imageMimeOf, imageParts, imageTimeouts, isHeicMime, listsHeic, magickHeicDecoder, MAX_EDGE, readDimensions, resizeDataUrl, resizeImage, setHeicDecoders, setHeicProbe, setImageConverter, sniffHeic, sniffImage, stripJpegMetadata, type HeicDecoder } from "../src/image.ts";
import { makePng, scratch, textOf } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures/heic");
const fixture = (n: number) => new Uint8Array(readFileSync(join(FIXTURES, `o${n}.heic`)));
const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");

const decoders = await hostHeicDecoders();

const TIMEOUTS = { ...imageTimeouts };
afterEach(() => {
	setHeicDecoders(decoders);
	setImageConverter(undefined);
	Object.assign(imageTimeouts, TIMEOUTS);
});

/** imagemagick's command on this host: magick (7), or convert and identify (6) */
const IM = Bun.which("magick") ? { run: ["magick"], identify: ["magick", "identify"] } : Bun.which("convert") ? { run: ["convert"], identify: ["identify"] } : undefined;
// a tool on the path is not a tool that decodes (ubuntu's heif-convert reads nothing until its hevc plugin is installed),
// so conversion tests run only when this host really turns the first fixture into a jpeg
const decodes = await (async () => {
	const r = await resizeImage(fixture(1), "image/heic");
	return r.ok;
})();
const heic = decodes ? test : test.skip;
const heicWithPixels = decodes && (IM || (process.platform === "darwin" && Bun.which("sips"))) ? test : test.skip;
if (!decodes) console.log(`heic conversion tests skipped: this host has no heic decoder that decodes (tried: ${decoders.map((d) => d.name).join(", ") || "none found"}; needs sips, an imagemagick built with libheif, or heif-dec or heif-convert with an hevc decoder)`);

/** an ftyp box: size, "ftyp", the major brand, a minor version, then the compatible brands */
function ftyp(major: string, ...compatible: string[]): Uint8Array {
	const b = Buffer.alloc(16 + compatible.length * 4 + 8);
	b.writeUInt32BE(16 + compatible.length * 4, 0);
	b.write("ftyp", 4, "latin1");
	b.write(major, 8, "latin1");
	compatible.forEach((c, i) => b.write(c, 16 + i * 4, "latin1"));
	return new Uint8Array(b);
}

test("heic is told by its ftyp box, not by its name", () => {
	for (let o = 1; o <= 8; o++) expect(sniffHeic(fixture(o))).toBe("image/heic");
	for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]) expect(sniffHeic(ftyp(brand))).toBe("image/heic");
	// a major brand that only says "iso media" is heic when a compatible brand names hevc
	expect(sniffHeic(ftyp("isom", "mp41", "heic"))).toBe("image/heic");
	expect(sniffHeic(ftyp("mif1", "miaf", "heic"))).toBe("image/heic");
});

test("avif, mp4, other images and short or empty bytes are not heic", () => {
	expect(sniffHeic(ftyp("avif", "mif1", "miaf"))).toBeUndefined();
	expect(sniffHeic(ftyp("avis"))).toBeUndefined();
	// the container brand alone is not enough: avif says mif1 too, and an avif file may list heic nowhere
	expect(sniffHeic(ftyp("mif1", "avif", "miaf"))).toBeUndefined();
	expect(sniffHeic(ftyp("isom", "mp41"))).toBeUndefined();
	expect(sniffHeic(ftyp("M4A ", "mp42"))).toBeUndefined();
	expect(sniffHeic(makePng(4, 4))).toBeUndefined();
	expect(sniffHeic(new Uint8Array())).toBeUndefined();
	expect(sniffHeic(ftyp("heic").subarray(0, 12))).toBeUndefined();
	// a box that claims to be shorter than a ftyp
	const short = new Uint8Array(ftyp("heic"));
	short[3] = 8;
	expect(sniffHeic(short)).toBeUndefined();
});

test("the stored size of a heic comes from its boxes", () => {
	// the fixtures are stored 64x48 whatever their orientation says; a longer file with grid tiles reports the whole photo
	for (let o = 1; o <= 8; o++) expect(heicSize(fixture(o))).toEqual({ width: 64, height: 48 });
	expect(heicSize(ftyp("heic"))).toBeUndefined();
	expect(heicSize(makePng(4, 4))).toBeUndefined();
	expect(heicSize(fixture(1).subarray(0, 60))).toBeUndefined();
});

test("a model reads png, jpeg, gif and webp: sniffImage does not call heic one of them", () => {
	expect(sniffImage(fixture(1))).toBeUndefined();
});

test("heic and heif are images by extension and by type", () => {
	expect(imageMimeOf("IMG_0001.HEIC")).toBe("image/heic");
	expect(imageMimeOf("photo.heif")).toBe("image/heif");
	expect(imageMimeOf("photo.heic.txt")).toBeUndefined();
	for (const m of ["image/heic", "image/heif", "IMAGE/HEIC", "image/heic-sequence", "image/heif-sequence"]) expect(isHeicMime(m)).toBe(true);
	for (const m of ["image/avif", "image/jpeg", "application/octet-stream", ""]) expect(isHeicMime(m)).toBe(false);
});

/** a jpeg built by hand: jfif, exif (orientation, and a gps pointer), xmp, photoshop, an icc profile, a multi-picture block, then pixels */
function jpegWith(opts: { little?: boolean; orientation?: number; trailing?: boolean } = {}): Uint8Array {
	const seg = (marker: number, body: Buffer) => {
		const len = Buffer.alloc(2);
		len.writeUInt16BE(body.length + 2);
		return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
	};
	const little = opts.little ?? false;
	const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 12);
	tiff.write(little ? "II" : "MM", 0, "latin1");
	const u16 = (v: number, at: number) => (little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
	const u32 = (v: number, at: number) => (little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
	u16(42, 2);
	u32(8, 4);
	u16(1, 8);
	u16(0x0112, 10);
	u16(3, 12);
	u32(1, 14);
	u16(opts.orientation ?? 6, 18);
	tiff.write("gps-position-here", 26, "latin1");
	const sof = Buffer.from([8, 0, 2, 0, 2, 1, 1, 0x11, 0]);
	// entropy data with a stuffed 0xff, a restart marker and a fill byte, which are not segment markers
	const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78]);
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
			seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])),
			seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>private</x:xmpmeta>", "latin1")),
			seg(0xed, Buffer.from("Photoshop 3.0\0 caption", "latin1")),
			seg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01profile-bytes", "latin1")),
			seg(0xe2, Buffer.from("MPF\0multi-picture", "latin1")),
			seg(0xfe, Buffer.from("a comment", "latin1")),
			seg(0xc0, sof),
			seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
			scan,
			Buffer.from([0xff, 0xd9]),
			...(opts.trailing ? [Buffer.from("a second picture or a gain map")] : []),
		]),
	);
}

test("stripping a jpeg removes exif, xmp and photoshop data and keeps the picture and its color profile", () => {
	const r = stripJpegMetadata(jpegWith({ orientation: 6, trailing: true }))!;
	expect(r.orientation).toBe(6);
	const s = ascii(r.bytes);
	for (const gone of ["Exif", "gps-position-here", "xmpmeta", "Photoshop", "MPF", "second picture"]) expect(s).not.toContain(gone);
	for (const kept of ["JFIF", "ICC_PROFILE", "a comment"]) expect(s).toContain(kept);
	// the scan survives byte for byte, ends at the end of image, and the result is still a jpeg that sniffs and measures
	expect(Array.from(r.bytes.subarray(-13))).toEqual([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78, 0xff, 0xd9]);
	expect(sniffImage(r.bytes)).toBe("image/jpeg");
	expect(readDimensions(r.bytes, "image/jpeg")).toEqual({ width: 2, height: 2 });
	// a second strip changes nothing
	expect(stripJpegMetadata(r.bytes)!.bytes).toEqual(r.bytes);
});

test("the orientation reads in either byte order, and is 1 without one", () => {
	expect(stripJpegMetadata(jpegWith({ little: true, orientation: 8 }))!.orientation).toBe(8);
	expect(stripJpegMetadata(jpegWith({ little: false, orientation: 3 }))!.orientation).toBe(3);
	expect(stripJpegMetadata(jpegWith({ orientation: 9 }))!.orientation).toBe(1);
	expect(stripJpegMetadata(stripJpegMetadata(jpegWith())!.bytes)!.orientation).toBe(1);
});

test("bytes that do not walk as a jpeg are not stripped", () => {
	expect(stripJpegMetadata(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined();
	const whole = jpegWith();
	expect(stripJpegMetadata(whole.subarray(0, 30))).toBeUndefined();
	expect(stripJpegMetadata(whole.subarray(0, whole.length - 2))).toBeUndefined();
});

type Color = "red" | "green" | "blue" | "yellow" | "?";

/** the colors at the middle of a jpeg's four quadrants (top left, top right, bottom left, bottom right) and its size, read by whichever tool the host has */
async function quadrants(jpeg: Uint8Array): Promise<{ colors: Color[]; width: number; height: number }> {
	const dir = join(scratch("quad").root);
	const src = join(dir, "q.jpg");
	writeFileSync(src, jpeg);
	let width = 0;
	let height = 0;
	let at: (x: number, y: number) => [number, number, number];
	if (IM) {
		const ppm = join(dir, "q.ppm");
		expect((await Bun.spawn([...IM.run, src, "-depth", "8", ppm]).exited)).toBe(0);
		const b = readFileSync(ppm);
		const head = b.subarray(0, 40).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
		width = Number(head[1]);
		height = Number(head[2]);
		const data = b.subarray(head[0].length);
		at = (x, y) => [data[(y * width + x) * 3]!, data[(y * width + x) * 3 + 1]!, data[(y * width + x) * 3 + 2]!];
	} else {
		const bmp = join(dir, "q.bmp");
		expect((await Bun.spawn(["sips", "-s", "format", "bmp", src, "--out", bmp], { stdout: "ignore" }).exited)).toBe(0);
		const b = readFileSync(bmp);
		width = b.readInt32LE(18);
		const h = b.readInt32LE(22);
		height = Math.abs(h);
		const stride = (width * 3 + 3) & ~3;
		at = (x, y) => {
			const row = h < 0 ? y : height - 1 - y;
			const o = b.readUInt32LE(10) + row * stride + x * 3;
			return [b[o + 2]!, b[o + 1]!, b[o]!];
		};
	}
	const name = ([r = 0, g = 0, b = 0]: number[]): Color => (r > 150 && g < 110 && b < 110 ? "red" : g > 140 && r < 110 && b < 110 ? "green" : b > 150 && r < 110 && g < 110 ? "blue" : r > 150 && g > 150 && b < 110 ? "yellow" : "?");
	const colors = [at(Math.floor(width / 4), Math.floor(height / 4)), at(Math.floor((width * 3) / 4), Math.floor(height / 4)), at(Math.floor(width / 4), Math.floor((height * 3) / 4)), at(Math.floor((width * 3) / 4), Math.floor((height * 3) / 4))].map(name);
	return { colors, width, height };
}

/** what each orientation shows once upright, from the picture's own corners: red, green / blue, yellow */
const UPRIGHT: Record<number, { colors: Color[]; width: number; height: number }> = {
	1: { colors: ["red", "green", "blue", "yellow"], width: 64, height: 48 },
	2: { colors: ["green", "red", "yellow", "blue"], width: 64, height: 48 },
	3: { colors: ["yellow", "blue", "green", "red"], width: 64, height: 48 },
	4: { colors: ["blue", "yellow", "red", "green"], width: 64, height: 48 },
	5: { colors: ["red", "blue", "green", "yellow"], width: 48, height: 64 },
	6: { colors: ["blue", "red", "yellow", "green"], width: 48, height: 64 },
	7: { colors: ["yellow", "green", "blue", "red"], width: 48, height: 64 },
	8: { colors: ["green", "yellow", "red", "blue"], width: 48, height: 64 },
};

heicWithPixels("a heic photo comes out as an upright jpeg, whichever of the eight orientations it was stored with", async () => {
	const via = new Set<string>();
	for (let o = 1; o <= 8; o++) {
		const r = await resizeImage(fixture(o), "image/heic");
		if (!r.ok) throw new Error(`o${o}: ${r.placeholder}`);
		expect(r.mime).toBe("image/jpeg");
		expect(r.converted).toMatchObject({ from: "image/heic", bytes: fixture(o).length });
		via.add(r.converted!.via);
		const jpeg = new Uint8Array(Buffer.from(r.data, "base64"));
		expect(sniffImage(jpeg)).toBe("image/jpeg");
		const q = await quadrants(jpeg);
		expect({ o, ...q }).toEqual({ o, ...UPRIGHT[o]! });
		expect({ w: r.width, h: r.height }).toEqual({ w: q.width, h: q.height });
	}
	console.log(`all eight orientations upright through ${[...via].join(", ")}`);
});

heic("a converted photo carries no camera, time or gps: the exif is gone from the bytes", async () => {
	const src = ascii(fixture(6));
	// the fixture has them, so an empty result means something
	expect(src).toContain("iPhone 15 Pro");
	expect(src).toContain("Apple");
	const r = await resizeImage(fixture(6), "image/heic");
	if (!r.ok) throw new Error(r.placeholder);
	const out = new Uint8Array(Buffer.from(r.data, "base64"));
	const s = ascii(out);
	for (const gone of ["Exif", "iPhone", "Apple", "2026:10:05"]) expect(s).not.toContain(gone);
	// no app1 segment of any kind, and no orientation left to turn it a second time
	const stripped = stripJpegMetadata(out)!;
	expect(stripped.bytes.length).toBe(out.length);
	expect(stripped.orientation).toBe(1);
	if (IM) {
		const dir = scratch("gps").root;
		writeFileSync(join(dir, "o.jpg"), out);
		const p = Bun.spawn([...IM.identify, "-verbose", join(dir, "o.jpg")], { stdout: "pipe" });
		const verbose = await new Response(p.stdout).text();
		await p.exited;
		expect(verbose).not.toMatch(/exif:GPS/i);
		expect(verbose).not.toMatch(/exif:Make/i);
	}
});

heic("heic is taken by its bytes: the wrong type or a wrong name does not matter", async () => {
	for (const mime of ["image/heif", "image/png", "application/octet-stream", "image/heic-sequence"]) {
		const r = await resizeImage(fixture(1), mime);
		expect(r).toMatchObject({ ok: true, mime: "image/jpeg" });
	}
});

heic("a data url of a heic photo is converted like any other image", async () => {
	const url = `data:image/heic;base64,${Buffer.from(fixture(6)).toString("base64")}`;
	const r = await resizeDataUrl(url);
	expect(r).toMatchObject({ ok: true, mime: "image/jpeg", width: 48, height: 64 });
});

heic("the caption says the jpeg came from a heic, and read returns the same", async () => {
	const parts = await imageParts(fixture(6), "image/heic", "IMG_0001.HEIC");
	expect(parts[0]).toMatchObject({ type: "text" });
	expect((parts[0] as { text: string }).text).toBe(`image IMG_0001.HEIC (48x64, ${Buffer.from((parts[1] as { data: string }).data, "base64").length} bytes, jpeg from a ${fixture(6).length} byte heic)`);
	expect(parts[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

	const env = scratch("readheic");
	writeFileSync(join(env.cwd, "IMG_0002.HEIC"), fixture(6));
	// a heic that was renamed to .jpg is still read by what it is
	writeFileSync(join(env.cwd, "renamed.jpg"), fixture(1));
	const r = await readTool(env).execute("c", { path: "IMG_0002.HEIC" });
	expect(r.content.find((c) => c.type === "image")).toMatchObject({ mimeType: "image/jpeg" });
	expect(textOf(r)).toContain("jpeg from a");
	expect(textOf(r)).toContain("heic");
	const renamed = await readTool(env).execute("c", { path: "renamed.jpg" });
	expect(renamed.content.find((c) => c.type === "image")).toMatchObject({ mimeType: "image/jpeg" });
	expect(textOf(renamed)).toContain("jpeg from a");
});

const onMac = process.platform === "darwin" && !!Bun.which("sips") ? test : test.skip;

onMac("a big heic is fitted to the edge limit and the byte limit", async () => {
	// a 4000x3000 photo, written as heic by sips from a png
	const dir = scratch("bigheic").root;
	writeFileSync(join(dir, "big.png"), makePng(4000, 3000));
	expect(await Bun.spawn(["sips", "-s", "format", "heic", join(dir, "big.png"), "--out", join(dir, "big.heic")], { stdout: "ignore" }).exited).toBe(0);
	const big = new Uint8Array(readFileSync(join(dir, "big.heic")));
	expect(sniffHeic(big)).toBe("image/heic");
	const r = await resizeImage(big, "image/heic");
	if (!r.ok) throw new Error(r.placeholder);
	console.log(`4000x3000 heic ${big.length} bytes -> ${r.width}x${r.height} ${r.bytes} bytes ${r.mime}`);
	expect(r.mime).toBe("image/jpeg");
	expect(Math.max(r.width!, r.height!)).toBeLessThanOrEqual(MAX_EDGE);
	expect(r.bytes).toBeLessThanOrEqual(3_750_000);
});

/** a stand-in for libheif's command line: a shell script that does what a decoder does, or fails in the way a broken one does */
function stub(label: string, body: string): string {
	const dir = scratch(label).root;
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "heif-dec");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** a jpeg to hand back from a stub decoder; needs the host's converter to make one */
async function someJpeg(width: number, height: number): Promise<Uint8Array | undefined> {
	const c = imageConverter();
	if (!c) return undefined;
	const dir = scratch("somejpeg").root;
	writeFileSync(join(dir, "s.png"), makePng(width, height));
	const p = Bun.spawn(c.argv(join(dir, "s.png"), join(dir, "s.jpg"), { format: "jpeg" }), { stdout: "ignore", stderr: "ignore" });
	await p.exited;
	return new Uint8Array(readFileSync(join(dir, "s.jpg")));
}

test("libheif's command line is called with a quality, a source and a target, and its jpeg is fitted when it is big", async () => {
	const jpeg = await someJpeg(2600, 1800);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	const dir = scratch("jpegfile").root;
	writeFileSync(join(dir, "decoded.jpg"), jpeg);
	// like heif-dec: -q <n> in out, and a file with several images writes out-1.jpg and out-2.jpg
	const bin = stub("cli", `[ "$1" = "-q" ] || exit 2\n[ -f "$3" ] || exit 3\ncp ${join(dir, "decoded.jpg")} "\${4%.jpg}-1.jpg"\ncp ${join(dir, "decoded.jpg")} "\${4%.jpg}-2.jpg"`);
	setHeicDecoders([heifCliDecoder(bin)]);
	const r = await resizeImage(fixture(1), "image/heic");
	if (!r.ok) throw new Error(r.placeholder);
	expect(r.converted).toMatchObject({ from: "image/heic", via: "heif-dec" });
	expect(r.mime).toBe("image/jpeg");
	expect(Math.max(r.width!, r.height!)).toBeLessThanOrEqual(MAX_EDGE);
	expect(r.width! / r.height!).toBeCloseTo(2600 / 1800, 1);
});

test("a decoder that fails, writes nothing or writes junk leaves a plain placeholder, not an exception", async () => {
	for (const body of ["exit 1", "exit 0", "echo not a jpeg > \"$4\"", "kill -ABRT $$"]) {
		setHeicDecoders([heifCliDecoder(stub("fail", body), "heif-dec")]);
		const r = await resizeImage(fixture(1), "image/heic");
		expect(r.ok).toBe(false);
		if (r.ok) continue;
		expect(r.placeholder).toContain("image not attached");
		expect(r.placeholder).toContain(`a heic photo, ${fixture(1).length} bytes`);
		expect(r.placeholder).toContain("heif-dec could not decode it");
		expect(r.placeholder).toContain("libheif-plugin-libde265");
	}
});

test("a decoder that hangs is killed at the timeout", async () => {
	imageTimeouts.toolMs = 400;
	setHeicDecoders([heifCliDecoder(stub("hang", "sleep 30"), "heif-dec")]);
	const t = Date.now();
	const r = await resizeImage(fixture(1), "image/heic");
	const took = Date.now() - t;
	expect(r.ok).toBe(false);
	expect(took).toBeLessThan(5000);
});

test("a host with no heic decoder says what to install", async () => {
	setHeicDecoders([]);
	const r = await resizeImage(fixture(1), "image/heic");
	expect(r.ok).toBe(false);
	if (r.ok) return;
	expect(r.placeholder).toContain("(image not attached: a heic photo,");
	expect(r.placeholder).toContain("this host cannot read heic");
	expect(r.placeholder).toContain("libheif");
	expect(r.placeholder).toContain("heif-dec");
	// the house voice: no em or en dashes, lowercase start
	expect(r.placeholder).not.toMatch(/[\u2013\u2014]/);
	const parts = await imageParts(fixture(1), "image/heic", "IMG_9.HEIC");
	expect(parts).toHaveLength(1);
	expect((parts[0] as { text: string }).text).toStartWith("image IMG_9.HEIC: (image not attached");
});

test("a decoder is tried after another one that failed", async () => {
	const jpeg = await someJpeg(200, 100);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	const dir = scratch("second").root;
	writeFileSync(join(dir, "d.jpg"), jpeg);
	setHeicDecoders([heifCliDecoder(stub("first", "exit 1"), "first"), heifCliDecoder(stub("second", `cp ${join(dir, "d.jpg")} "$4"`), "second")]);
	const r = await resizeImage(fixture(1), "image/heic");
	expect(r).toMatchObject({ ok: true, converted: { via: "second" } });
});

test("bytes that call themselves heic but are not one are refused as not an image", async () => {
	const r = await resizeImage(new TextEncoder().encode("not a heic file, just some words"), "image/heic");
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.placeholder).toContain("not a png, jpeg, gif, webp or heic, although the type said image/heic");
});

const withMagick = IM ? test : test.skip;

withMagick("imagemagick's heic pass turns a photo upright by its orientation and leaves no exif", async () => {
	// this host's magick may not read heic (it needs libheif), so the pass is run on a jpeg that carries an orientation
	// and a camera make: the same arguments, the same turn and the same dropped exif
	const dir = scratch("magickpass").root;
	const grid = ["(", "-size", "32x24", "xc:red", "-size", "32x24", "xc:#1ec81e", "+append", ")", "(", "-size", "32x24", "xc:blue", "-size", "32x24", "xc:yellow", "+append", ")", "-append"];
	expect(await Bun.spawn([...IM!.run, ...grid, join(dir, "plain.jpg")], { stdout: "ignore" }).exited).toBe(0);
	const plain = new Uint8Array(readFileSync(join(dir, "plain.jpg")));
	// an exif segment with orientation 6 (rotate 90 clockwise) and a make, put in after the start of image
	const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 5);
	tiff.write("MM", 0, "latin1");
	tiff.writeUInt16BE(42, 2);
	tiff.writeUInt32BE(8, 4);
	tiff.writeUInt16BE(1, 8);
	tiff.writeUInt16BE(0x0112, 10);
	tiff.writeUInt16BE(3, 12);
	tiff.writeUInt32BE(1, 14);
	tiff.writeUInt16BE(6, 18);
	tiff.write("Apple", 26, "latin1");
	const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
	const len = Buffer.alloc(2);
	len.writeUInt16BE(body.length + 2);
	const tagged = new Uint8Array(Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, plain.subarray(2)]));
	expect(ascii(tagged)).toContain("Apple");
	expect(stripJpegMetadata(tagged)!.orientation).toBe(6);
	const out = await magickHeicDecoder(IM!.run[0]!).decode(tagged, 1900);
	if (!out) throw new Error("magick did not write a jpeg");
	expect(ascii(out)).not.toContain("Apple");
	expect(stripJpegMetadata(out)!.orientation).toBe(1);
	expect(await quadrants(out)).toEqual({ colors: ["blue", "red", "yellow", "green"], width: 48, height: 64 });
});


test("imagemagick's format list is read for HEIC in the shapes 7 and 6 print it", () => {
	const head7 = "   Format  Module    Mode  Description\n-------------------------------------------------------------------------------\n";
	expect(listsHeic(head7 + "      HEIC* HEIC      rw+   Apple High efficiency Image Format\n")).toBe(true);
	expect(listsHeic(head7 + "      HEIC  HEIC      r--   Apple High efficiency Image Format\n")).toBe(true);
	// imagemagick 6 on ubuntu: no module column
	expect(listsHeic("   Format  Mode  Description\n-------------------------------------------------------------------------------\n      HEIC* r--   Apple High efficiency Image Format (1.17.6)\n")).toBe(true);
	expect(listsHeic("      HEIC            r--   Apple High efficiency Image Format\n")).toBe(true);
	// listed but not readable, or not listed at all
	expect(listsHeic(head7 + "      HEIC* HEIC      ---   Apple High efficiency Image Format\n")).toBe(false);
	expect(listsHeic(head7 + "      HEIC            -w-   Apple High efficiency Image Format\n")).toBe(false);
	expect(listsHeic(head7 + "      HEIF* HEIC      rw+   Apple High efficiency Image Format\n      JPEG* JPEG      rw-   Joint Photographic Experts Group JFIF format\n")).toBe(false);
	expect(listsHeic("")).toBe(false);
	// a description that mentions heic is not a format
	expect(listsHeic("      FOO   FOO       rw+   like HEIC r--   but not\n")).toBe(false);
});

/** a decoder that hands back a fixed jpeg and counts its calls */
function counting(jpeg: Uint8Array): HeicDecoder & { calls: number } {
	const d = { name: "counting", upright: true, calls: 0, async decode() { d.calls++; return jpeg; } };
	return d;
}

test("a host with no decoder is probed again for the next photo, and photos that arrive together share one probe", async () => {
	const jpeg = await someJpeg(200, 100);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	const decoder = counting(jpeg);
	let probes = 0;
	let installed = false;
	setHeicProbe(async () => {
		probes++;
		await Bun.sleep(30);
		return installed ? [decoder] : [];
	});
	// three photos at once, nothing installed: one probe, three placeholders that say what to install
	const first = await Promise.all([1, 2, 3].map(() => resizeImage(fixture(1), "image/heic")));
	expect(probes).toBe(1);
	for (const r of first) expect(r.ok === false && r.placeholder.includes("libheif-plugin-libde265")).toBe(true);
	// an empty answer is not kept: the next photo probes again, and still finds nothing
	await resizeImage(fixture(1), "image/heic");
	expect(probes).toBe(2);
	// the user installs a decoder, no restart: the next photo is read, and the one after does not probe at all
	installed = true;
	expect(await resizeImage(fixture(1), "image/heic")).toMatchObject({ ok: true, converted: { via: "counting" } });
	expect(probes).toBe(3);
	expect(await resizeImage(fixture(1), "image/heic")).toMatchObject({ ok: true });
	expect(probes).toBe(3);
	expect(decoder.calls).toBe(2);
	setHeicProbe(undefined);
});

test("a decoder that times out ends the attempt: the next decoder is not given the same file", async () => {
	imageTimeouts.toolMs = 400;
	const second = counting(new Uint8Array());
	setHeicDecoders([heifCliDecoder(stub("hang1", "sleep 30"), "first"), heifCliDecoder(stub("hang2", "sleep 30"), "second"), second]);
	const t = Date.now();
	const r = await resizeImage(fixture(1), "image/heic");
	const took = Date.now() - t;
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.placeholder).toContain("first took too long on it");
		expect(r.placeholder).not.toMatch(/[\u2013\u2014]/);
	}
	// one timeout, not three
	expect(took).toBeLessThan(1500);
	expect(second.calls).toBe(0);
});

test("one budget covers a whole photo, whatever each tool is allowed", async () => {
	imageTimeouts.heicMs = 500;
	setHeicDecoders([heifCliDecoder(stub("budget", "sleep 30"), "slow")]);
	const t = Date.now();
	const r = await resizeImage(fixture(1), "image/heic");
	expect(Date.now() - t).toBeLessThan(2500);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.placeholder).toContain("slow took too long on it");
});

test("a photo over 100 megapixels is refused before any tool is started", async () => {
	const huge = new Uint8Array(fixture(1));
	const at = Buffer.from(huge).indexOf("ispe");
	expect(at).toBeGreaterThan(0);
	const v = new DataView(huge.buffer);
	v.setUint32(at + 8, 20000);
	v.setUint32(at + 12, 10000);
	expect(heicSize(huge)).toEqual({ width: 20000, height: 10000 });
	const decoder = counting(new Uint8Array());
	setHeicDecoders([decoder]);
	const r = await resizeImage(huge, "image/heic");
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.placeholder).toContain("20000x10000, over 100 megapixels");
		expect(r.placeholder).toContain("shrink it first");
		expect(r.original).toEqual({ width: 20000, height: 10000 });
	}
	expect(decoder.calls).toBe(0);
	// just under it goes through to a decoder
	v.setUint32(at + 8, 10000);
	v.setUint32(at + 12, 9999);
	await resizeImage(huge, "image/heic");
	expect(decoder.calls).toBe(1);
});

test("a shrunk heic says what it was resized from", async () => {
	const jpeg = await someJpeg(2600, 1800);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	setHeicDecoders([counting(jpeg)]);
	const r = await resizeImage(fixture(1), "image/heic");
	if (!r.ok) throw new Error(r.placeholder);
	expect(r).toMatchObject({ resized: true, original: { width: 2600, height: 1800 }, converted: { from: "image/heic" } });
	const parts = await imageParts(fixture(1), "image/heic", "IMG_1.HEIC");
	expect((parts[0] as { text: string }).text).toMatch(/^image IMG_1\.HEIC \(1900x1315, \d+ bytes, resized from 2600x1800, jpeg from a \d+ byte heic\)$/);
});

/** a small seeded generator, so a failing input can be found again */
function seeded(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** the input with a few bytes changed, a stretch cut, or some inserted */
function mutate(src: Uint8Array, rnd: () => number): Uint8Array {
	let b = Array.from(src);
	const edits = 1 + Math.floor(rnd() * 4);
	for (let i = 0; i < edits; i++) {
		const kind = rnd();
		const at = Math.floor(rnd() * Math.max(1, b.length));
		if (kind < 0.5) b[at] = Math.floor(rnd() * 256);
		else if (kind < 0.7) b = b.slice(0, at);
		else if (kind < 0.85) b.splice(at, Math.floor(rnd() * 8));
		else b.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => Math.floor(rnd() * 256)));
	}
	return new Uint8Array(b);
}

test("fuzz: the jpeg walker, the heic size reader and the sniffer never throw on bad bytes, and what they return holds", () => {
	const rnd = seeded(20261005);
	const jpegs = [jpegWith({ orientation: 6, trailing: true }), jpegWith({ little: true, orientation: 8 })];
	let walked = 0;
	for (let i = 0; i < 20000; i++) {
		const j = mutate(jpegs[i % jpegs.length]!, rnd);
		const r = stripJpegMetadata(j);
		if (!r) continue;
		walked++;
		expect(r.bytes[0]).toBe(0xff);
		expect(r.bytes[1]).toBe(0xd8);
		expect(r.bytes.at(-2)).toBe(0xff);
		expect(r.bytes.at(-1)).toBe(0xd9);
		expect(r.bytes.length).toBeLessThanOrEqual(j.length);
		expect(r.orientation).toBeGreaterThanOrEqual(1);
		expect(r.orientation).toBeLessThanOrEqual(8);
	}
	// the mutations leave a good share walking, so the loop above checked something
	expect(walked).toBeGreaterThan(2000);
	for (let i = 0; i < 20000; i++) {
		const h = mutate(fixture(1 + (i % 8)), rnd);
		const d = heicSize(h);
		if (d) {
			expect(Number.isInteger(d.width) && Number.isInteger(d.height)).toBe(true);
			expect(d.width).toBeGreaterThanOrEqual(0);
		}
		sniffHeic(h);
		sniffHeic(h.subarray(0, Math.floor(rnd() * 40)));
		const noise = new Uint8Array(8 + Math.floor(rnd() * 64)).map(() => Math.floor(rnd() * 256));
		noise.set([0x66, 0x74, 0x79, 0x70], 4);
		sniffHeic(noise);
	}
});


/** a decoder that answers after a pause, with the jpeg it is given */
function slowDecoder(jpeg: Uint8Array, ms: number): HeicDecoder {
	return {
		name: "slowpoke",
		upright: true,
		async decode() {
			await Bun.sleep(ms);
			return jpeg;
		},
	};
}

/** a converter that never finishes in time, whatever it is asked */
const HANGING_CONVERTER = { name: "sleepy", argv: () => ["sh", "-c", "sleep 5"] };

test("a spent budget does not switch the next tool's timeout off", async () => {
	const jpeg = await someJpeg(2600, 1800);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	// the decoder answers after 350 ms of a 300 ms budget; the fit that follows has nothing left, and must not run for its own 5 s
	imageTimeouts.heicMs = 300;
	setHeicDecoders([slowDecoder(jpeg, 350)]);
	setImageConverter(HANGING_CONVERTER);
	try {
		const t = Date.now();
		const r = await resizeImage(fixture(1), "image/heic");
		const took = Date.now() - t;
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.placeholder).toContain("sleepy never started");
			expect(r.placeholder).toContain("used up");
		}
		expect(took).toBeLessThan(2000);
	} finally {
		setImageConverter(undefined);
	}
});

test("a converter step that overruns the time left is stopped, and the copy names the time it was given", async () => {
	const jpeg = await someJpeg(2600, 1800);
	if (!jpeg) return console.log("skipped: no image converter to make the stand-in's jpeg");
	imageTimeouts.toolMs = 400;
	setHeicDecoders([slowDecoder(jpeg, 0)]);
	setImageConverter(HANGING_CONVERTER);
	try {
		const t = Date.now();
		const r = await resizeImage(fixture(1), "image/heic");
		expect(Date.now() - t).toBeLessThan(2000);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.placeholder).toContain("sleepy took too long on it (stopped after 0.4 s)");
	} finally {
		setImageConverter(undefined);
	}
});

test("a tool is never spawned with no time to run in", async () => {
	// a spawn with timeout 0 would run unbounded in bun; the guard is in the one place that spawns
	const t = Date.now();
	setImageConverter(HANGING_CONVERTER);
	try {
		const out = await convert(HANGING_CONVERTER, fixture(1), "image/jpeg", { format: "jpeg", timeoutMs: 0 });
		expect(out).toBeUndefined();
		expect(await convert(HANGING_CONVERTER, fixture(1), "image/jpeg", { format: "jpeg", timeoutMs: -5 })).toBeUndefined();
		expect(await convert(HANGING_CONVERTER, fixture(1), "image/jpeg", { format: "jpeg", timeoutMs: Number.NaN })).toBeUndefined();
	} finally {
		setImageConverter(undefined);
	}
	expect(Date.now() - t).toBeLessThan(1000);
});

test("a probe that was running when the list was replaced neither overwrites it nor clears the newer probe", async () => {
	const a = counting(new Uint8Array());
	const b = counting(new Uint8Array());
	let probes = 0;
	const gates: Array<() => void> = [];
	setHeicProbe(
		() =>
			new Promise<HeicDecoder[]>((resolve) => {
				probes++;
				gates.push(() => resolve([a]));
			}),
	);
	// a probe starts, then the list is replaced under it: its answer must not land on top
	const first = hostHeicDecoders();
	setHeicDecoders([b]);
	gates[0]!();
	expect(await first).toEqual([a]);
	expect(await hostHeicDecoders()).toEqual([b]);
	// a probe starts, the list is forgotten, a second probe starts; the first one finishing leaves the second in flight to be shared
	setHeicDecoders(undefined);
	const old = hostHeicDecoders();
	setHeicDecoders(undefined);
	const newer = hostHeicDecoders();
	expect(probes).toBe(3);
	gates[1]!();
	await old;
	const third = hostHeicDecoders();
	expect(probes).toBe(3);
	gates[2]!();
	expect(await newer).toEqual([a]);
	expect(await third).toEqual([a]);
	setHeicProbe(undefined);
});

test("av1 profile brands are avif too", () => {
	expect(sniffHeic(ftyp("mif1", "MA1A", "miaf"))).toBeUndefined();
	expect(sniffHeic(ftyp("mif1", "miaf", "MA1B"))).toBeUndefined();
});
