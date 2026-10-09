import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ToolEnv, ToolResult } from "../src/types.ts";

/** a scratch working directory and spill dir under the system temp dir */
export function scratch(label: string): ToolEnv & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `cmx2-tools-${label}-`)));
	return { root, cwd: root, spillDir: join(root, ".spill") };
}

export function textOf(r: ToolResult): string {
	return r.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([len, body, crc]);
}

/** a real png of one colour with a stripe, any size, built without an image library */
export function makePng(width: number, height: number): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // rgb
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set(x % 97 < 8 ? [200, 40, 40] : [40, 120, 200], 1 + x * 3);
	const raw = Buffer.alloc(row.length * height);
	for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
