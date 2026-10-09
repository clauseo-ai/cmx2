/**
 * a prompt's file parts accept heic and heif where they accept png, jpeg, gif and webp: the gate lets them
 * through to the resize step, which hands the model a jpeg. the conversion tests use the real resize and skip
 * on a host that cannot read heic; the gate tests use a recording resize and run everywhere.
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resizeImage, sniffImage } from "@cmx2/tools";
import { blocksOf, type Resize } from "../src/parts.ts";

const PHOTO = join(import.meta.dir, "fixtures/photo.heic");
const bytes = new Uint8Array(readFileSync(PHOTO));
const dataUrl = (mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-heic-parts-")));
copyFileSync(PHOTO, join(cwd, "IMG_0001.HEIC"));
writeFileSync(join(cwd, "notes.txt"), "plain text");

/** a resize that records what it was handed and returns a jpeg-shaped answer */
function recorder() {
	const seen: Array<{ mime: string; length: number }> = [];
	const resize: Resize = async (b, mime) => {
		seen.push({ mime, length: b.length });
		return { data: "AAAA", mime: "image/jpeg" };
	};
	return { seen, resize };
}

const real: Resize = async (b, mime) => {
	const r = await resizeImage(b, mime);
	return r.ok ? { data: r.data, mime: r.mime } : { placeholder: r.placeholder };
};
// a tool on the path is not a tool that decodes: run the real-resize tests only where the fixture really converts
const readable = (await resizeImage(bytes, "image/heic")).ok ? test : test.skip;

test("a data url part typed image/heic or image/heif reaches the resize step as an image", async () => {
	for (const mime of ["image/heic", "image/heif", "IMAGE/HEIC", "image/heic-sequence"]) {
		const { seen, resize } = recorder();
		const blocks = await blocksOf({ parts: [{ type: "file", mime, filename: "p.heic", url: dataUrl(mime) }] }, cwd, resize);
		expect(seen).toEqual([{ mime: mime.toLowerCase(), length: bytes.length }]);
		expect(blocks).toMatchObject([{ type: "image", data: "AAAA", mimeType: "image/jpeg", filename: "p.heic" }]);
	}
});

test("a heic photo sent without a type is told by its bytes", async () => {
	for (const url of [`data:;base64,${Buffer.from(bytes).toString("base64")}`, dataUrl("application/octet-stream")]) {
		const { seen, resize } = recorder();
		const blocks = await blocksOf({ parts: [{ type: "file", url }] }, cwd, resize);
		expect(seen).toEqual([{ mime: "image/heic", length: bytes.length }]);
		expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
	}
});

test("an untyped file that is not heic is still not an image", async () => {
	const { seen, resize } = recorder();
	const blocks = await blocksOf({ text: "hi", parts: [{ type: "file", filename: "blob", url: "data:application/octet-stream;base64,AAECAwQF" }] }, cwd, resize);
	expect(seen).toEqual([]);
	expect(blocks[1]).toMatchObject({ type: "text", synthetic: true });
	expect((blocks[1] as { text: string }).text).toContain("not a kind the model can read");
});

test("a file part with a heic path and type reaches the resize step", async () => {
	const { seen, resize } = recorder();
	const blocks = await blocksOf({ parts: [{ type: "file", mime: "image/heic", filename: "IMG_0001.HEIC", url: `file://${join(cwd, "IMG_0001.HEIC")}` }] }, cwd, resize);
	expect(seen).toEqual([{ mime: "image/heic", length: bytes.length }]);
	expect(blocks).toMatchObject([{ type: "image", data: "AAAA", mimeType: "image/jpeg", filename: "IMG_0001.HEIC" }]);
});

readable("through the real resize a heic data url and a heic file both become jpeg blocks", async () => {
	const blocks = await blocksOf(
		{
			parts: [
				{ type: "file", mime: "image/heic", filename: "a.heic", url: dataUrl("image/heic") },
				{ type: "file", mime: "image/heic", filename: "IMG_0001.HEIC", url: `file://${join(cwd, "IMG_0001.HEIC")}` },
			],
		},
		cwd,
		real,
	);
	expect(blocks).toHaveLength(2);
	for (const b of blocks) {
		expect(b).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		const jpeg = new Uint8Array(Buffer.from((b as { data: string }).data, "base64"));
		expect(sniffImage(jpeg)).toBe("image/jpeg");
	}
});

test("a file part with a heic path and no type, or a type that is not an image, is read as heic by its first bytes", async () => {
	for (const mime of [undefined, "application/octet-stream", "text/plain"]) {
		const { seen, resize } = recorder();
		const blocks = await blocksOf({ parts: [{ type: "file", ...(mime ? { mime } : {}), filename: "IMG_0001.HEIC", url: `file://${join(cwd, "IMG_0001.HEIC")}` }] }, cwd, resize);
		expect(seen).toEqual([{ mime: "image/heic", length: bytes.length }]);
		expect(blocks).toMatchObject([{ type: "image", data: "AAAA", mimeType: "image/jpeg", filename: "IMG_0001.HEIC" }]);
	}
	// the name does not matter either
	copyFileSync(PHOTO, join(cwd, "photo-without-extension"));
	const { seen, resize } = recorder();
	await blocksOf({ parts: [{ type: "file", url: `file://${join(cwd, "photo-without-extension")}` }] }, cwd, resize);
	expect(seen).toHaveLength(1);
});

test("an untyped path that is not heic is still a mention, and a directory or a missing path never reaches the resize step", async () => {
	const { seen, resize } = recorder();
	const blocks = await blocksOf(
		{
			parts: [
				{ type: "file", url: `file://${join(cwd, "notes.txt")}` },
				{ type: "file", url: `file://${cwd}` },
				{ type: "file", url: `file://${join(cwd, "gone.heic")}` },
			],
		},
		cwd,
		resize,
	);
	expect(seen).toEqual([]);
	expect(blocks.map((b) => (b as { text: string }).text)).toEqual([
		expect.stringContaining("plain text"),
		expect.stringContaining("<directory"),
		expect.stringContaining("no longer exists"),
	]);
});

readable("through the real resize an untyped file: heic becomes a jpeg block", async () => {
	const blocks = await blocksOf({ parts: [{ type: "file", filename: "IMG_0001.HEIC", url: `file://${join(cwd, "IMG_0001.HEIC")}` }] }, cwd, real);
	expect(blocks).toMatchObject([{ type: "image", mimeType: "image/jpeg" }]);
	expect(sniffImage(new Uint8Array(Buffer.from((blocks[0] as { data: string }).data, "base64")))).toBe("image/jpeg");
});
