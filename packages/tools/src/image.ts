import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text, type ImagePart, type TextPart } from "./types.ts";

/**
 * images on their way to a model: dimensions read from the header only (no decoder in the daemon),
 * and a host-side resize through the platform's converter when an image is over the edge or byte
 * limit. anthropic caps an edge at 8000 px, and at 2000 px once a request holds several images;
 * 1900 leaves a margin, and a session never knows how many images it will collect.
 *
 * heic and heif (an iphone's photo format) are taken in here and nowhere past it: neither anthropic nor
 * openai reads them, so every one is decoded to a jpeg, fitted, turned upright and stripped of its
 * metadata before it is anything a model or a transcript sees. `sniffImage` stays the list of what a
 * model reads; `sniffHeic` is the list of what this file converts.
 */

/** longest edge an image keeps; images are resized down to it */
export const MAX_EDGE = 1900;
/** raw bytes an image may have (anthropic's 5 MB cap applies to the base64, which is 4/3 larger) */
export const MAX_IMAGE_BYTES = 3_750_000;
/**
 * a png heavier than this is tried as a jpeg (screenshots history piles up; a request dies on total
 * size). jpeg would flatten transparency, so a png that may have alpha (an alpha channel or a tRNS
 * chunk) is converted only when imagemagick confirms every pixel is opaque. the jpeg is kept only
 * when it is at most REENCODE_KEEP of the png, so flat ui screenshots that compress well stay png.
 */
export const REENCODE_ABOVE = 500_000;
const REENCODE_KEEP = 0.7;
const JPEG_QUALITY = 90;

export interface Dimensions {
	width: number;
	height: number;
}

const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif" };

/** the types a heic photo travels under (the sequence types are a burst or a live photo; the first frame is the photo) */
export function isHeicMime(mime: string): boolean {
	const m = mime.toLowerCase();
	return m === "image/heic" || m === "image/heif" || m === "image/heic-sequence" || m === "image/heif-sequence";
}

/** the image mime for a file name, by extension */
export function imageMimeOf(path: string): string | undefined {
	const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1];
	return ext ? EXT_MIME[ext] : undefined;
}

/** the image type the bytes really are, from their magic numbers */
export function sniffImage(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return "image/webp";
	}
	return undefined;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
/** avif and its av1 profile brands (MA1A, MA1B): the same container with another codec */
const AVIF_BRANDS = new Set(["avif", "avis", "MA1A", "MA1B"]);
/** brands that name hevc itself; mif1 and msf1 only say "heif container", which avif carries too */
const HEVC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);

/**
 * whether the bytes are a heic or heif image: an iso bmff `ftyp` box at offset 4 whose major brand is one
 * of heic, heix, hevc, hevx, heim, heis, mif1 or msf1, or whose compatible brands name hevc. a file that
 * carries an avif brand is avif (same container, different codec) and is not claimed. kept apart from
 * `sniffImage`: that one is what a model reads, and what the engine lets into a request.
 */
export function sniffHeic(bytes: Uint8Array): "image/heic" | undefined {
	if (bytes.length < 16 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return undefined;
	const size = view(bytes).getUint32(0);
	if (size < 16) return undefined;
	const end = Math.min(size, bytes.length, 512);
	const brand = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
	const major = brand(8);
	const compatible: string[] = [];
	for (let i = 16; i + 4 <= end; i += 4) compatible.push(brand(i));
	if (AVIF_BRANDS.has(major) || compatible.some((b) => AVIF_BRANDS.has(b))) return undefined;
	if (HEIC_BRANDS.has(major) || compatible.some((b) => HEVC_BRANDS.has(b))) return "image/heic";
	return undefined;
}

export function readDimensions(bytes: Uint8Array, mime: string): Dimensions | undefined {
	const m = mime.toLowerCase();
	if (m === "image/png") return png(bytes);
	if (m === "image/jpeg" || m === "image/jpg") return jpeg(bytes);
	if (m === "image/gif") return gif(bytes);
	if (m === "image/webp") return webp(bytes);
	return undefined;
}

function view(b: Uint8Array) {
	return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function png(b: Uint8Array): Dimensions | undefined {
	// signature, then the IHDR chunk: length, type, width, height. both are checked before the offsets
	// are trusted, so bytes that only claim to be a png never produce garbage dimensions
	if (b.length < 24 || sniffImage(b) !== "image/png") return undefined;
	if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return undefined;
	return { width: view(b).getUint32(16), height: view(b).getUint32(20) };
}

function jpeg(b: Uint8Array): Dimensions | undefined {
	// walk the markers to the first SOFn frame
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
	const v = view(b);
	let i = 2;
	while (i + 1 < b.length) {
		if (b[i] !== 0xff) return undefined;
		let marker = b[i + 1]!;
		while (marker === 0xff && i + 2 < b.length) {
			i++;
			marker = b[i + 1]!;
		}
		i += 2;
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
		if (i + 2 > b.length) return undefined;
		const len = v.getUint16(i);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (i + 7 > b.length) return undefined;
			return { height: v.getUint16(i + 3), width: v.getUint16(i + 5) };
		}
		i += len;
	}
	return undefined;
}

function gif(b: Uint8Array): Dimensions | undefined {
	if (b.length < 10 || sniffImage(b) !== "image/gif") return undefined;
	return { width: view(b).getUint16(6, true), height: view(b).getUint16(8, true) };
}

function webp(b: Uint8Array): Dimensions | undefined {
	if (b.length < 30 || sniffImage(b) !== "image/webp") return undefined;
	const v = view(b);
	const tag = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
	if (tag === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
	if (tag === "VP8L") {
		if (b[20] !== 0x2f) return undefined;
		const x = v.getUint32(21, true);
		return { width: (x & 0x3fff) + 1, height: ((x >> 14) & 0x3fff) + 1 };
	}
	if (tag === "VP8X") return { width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
	return undefined;
}

/** a turn and a mirror: a quarter turn clockwise (0, 90, 180 or 270), then a flip. sips applies a flip before a turn whatever the order it is given, so a converter is given one of the two at a time */
export interface Transform {
	rotate: 0 | 90 | 180 | 270;
	flip?: "horizontal" | "vertical";
}

export interface ConvertOptions {
	/** longest edge to shrink to (never enlarges); no resampling when undefined */
	max?: number;
	format: "png" | "jpeg";
	quality?: number;
	/** turn the pixels (a jpeg whose exif orientation says it is not upright) */
	transform?: Transform;
	/** the source is a heic and the converter decodes it itself: its pixels come out upright and its exif is left out */
	heic?: boolean;
	/** kill the tool after this long, when sooner than the default */
	timeoutMs?: number;
}

export type Converter = { name: string; argv: (src: string, dst: string, opts: ConvertOptions) => string[] };

let converter: Converter | null | undefined;

/** put a converter in (or, with undefined, look for the host's again); for tests */
export function setImageConverter(c: Converter | undefined): void {
	converter = c;
}

/** how long one spawned image tool may run before it is killed; a bad image must never hold a session (0.8.6) */
export const imageTimeouts = {
	/** one spawned tool */
	toolMs: 45_000,
	/** the whole of one heic photo, every tool it needs and every decoder tried: a hostile file may not hold a prompt for three tool timeouts */
	heicMs: 60_000,
	probeMs: 10_000,
};

function magickArgv(bin: string): Converter["argv"] {
	return (src, dst, { max, format, quality, transform, heic }) => [
		bin,
		src,
		// libheif applies a photo's rotation itself; -auto-orient finishes for builds that do not, and the exif
		// is dropped so nothing downstream turns the pixels a second time
		...(heic ? ["-auto-orient", "+profile", "exif"] : []),
		...(max === undefined ? [] : ["-resize", `${max}x${max}>`]),
		...(transform ? [...(transform.rotate ? ["-rotate", String(transform.rotate)] : []), ...(transform.flip === "horizontal" ? ["-flop"] : transform.flip === "vertical" ? ["-flip"] : [])] : []),
		...(format === "jpeg" ? ["-quality", String(quality ?? JPEG_QUALITY), "-sampling-factor", "4:4:4"] : []),
		dst,
	];
}

/** one spawned tool, killed when it overruns; true when it exited 0. a tool that is missing, aborts or hangs is just false */
async function runTool(argv: string[], timeoutMs: number): Promise<boolean> {
	// bun reads timeout 0 as "no timeout" and a negative one throws, so a spent allowance never reaches the spawn
	if (!(timeoutMs > 0)) return false;
	try {
		const p = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
		return (await p.exited) === 0;
	} catch {
		return false;
	}
}

/** the host's image converter: sips on macos, imagemagick elsewhere; null when there is none */
export function imageConverter(): Converter | null {
	// "none" is not remembered: a host that installs imagemagick starts resizing without a restart
	if (converter) return converter;
	if (process.platform === "darwin" && Bun.which("sips")) {
		converter = {
			name: "sips",
			argv: (src, dst, { max, format, quality, transform }) => [
				"sips",
				...(max === undefined ? [] : ["--resampleHeightWidthMax", String(max)]),
				...(transform ? [...(transform.rotate ? ["--rotate", String(transform.rotate)] : []), ...(transform.flip ? ["--flip", transform.flip] : [])] : []),
				"-s",
				"format",
				format,
				...(format === "jpeg" ? ["-s", "formatOptions", String(quality ?? JPEG_QUALITY)] : []),
				src,
				"--out",
				dst,
			],
		};
	} else if (Bun.which("magick")) {
		converter = { name: "magick", argv: magickArgv("magick") };
	} else if (Bun.which("convert")) {
		converter = { name: "convert", argv: magickArgv("convert") };
	} else {
		converter = null;
	}
	return converter;
}

export type ResizedImage =
	| {
			ok: true;
			data: string;
			mime: string;
			width?: number;
			height?: number;
			bytes: number;
			resized: boolean;
			original?: Dimensions;
			/** set when a heavy png was re-encoded as a jpeg; bytes is the png it replaced */
			reencoded?: { from: "image/png"; bytes: number };
			/** set when a heic was decoded to this jpeg; bytes is the heic it replaced, via the tool that decoded it */
			converted?: { from: "image/heic"; bytes: number; via: string };
	  }
	| { ok: false; placeholder: string; original?: Dimensions; bytes: number };

/** one run of a converter over bytes; exported for tests */
export async function convert(c: Converter, bytes: Uint8Array, mime: string, opts: ConvertOptions): Promise<Uint8Array | undefined> {
	const id = randomUUID();
	const inExt = Object.entries(EXT_MIME).find(([, m]) => m === mime)?.[0] ?? "img";
	const src = join(tmpdir(), `cmx2-image-${id}.${inExt}`);
	const dst = join(tmpdir(), `cmx2-image-${id}-out.${opts.format === "png" ? "png" : "jpg"}`);
	try {
		writeFileSync(src, bytes);
		if (!(await runTool(c.argv(src, dst, opts), Math.min(opts.timeoutMs ?? Infinity, imageTimeouts.toolMs)))) return undefined;
		return new Uint8Array(readFileSync(dst));
	} catch {
		return undefined;
	} finally {
		rmSync(src, { force: true });
		rmSync(dst, { force: true });
	}
}

/** what turns a jpeg upright, by the exif orientation (2 to 8) it carries; 1 needs nothing */
const ORIENTATION_TRANSFORMS: Record<number, Transform> = {
	2: { rotate: 0, flip: "horizontal" },
	3: { rotate: 180 },
	4: { rotate: 0, flip: "vertical" },
	5: { rotate: 90, flip: "horizontal" },
	6: { rotate: 90 },
	7: { rotate: 90, flip: "vertical" },
	8: { rotate: 270 },
};

function tiffOrientation(b: Uint8Array, at: number): number {
	// at is the start of the tiff header inside an Exif segment: byte order, 42, offset of the first directory
	if (at + 8 > b.length) return 1;
	const little = b[at] === 0x49 && b[at + 1] === 0x49;
	if (!little && !(b[at] === 0x4d && b[at + 1] === 0x4d)) return 1;
	const v = view(b);
	const ifd = at + v.getUint32(at + 4, little);
	if (ifd + 2 > b.length) return 1;
	const n = v.getUint16(ifd, little);
	for (let i = 0; i < n && ifd + 2 + (i + 1) * 12 <= b.length; i++) {
		const e = ifd + 2 + i * 12;
		if (v.getUint16(e, little) === 0x0112) {
			const o = v.getUint16(e + 8, little);
			return o >= 1 && o <= 8 ? o : 1;
		}
	}
	return 1;
}

/**
 * a jpeg without its metadata: the exif block (camera, time and the gps position), xmp, photoshop and every other
 * app segment go; the jfif header and the icc color profile stay (a p3 photo keeps its colors), and anything
 * after the end of image goes. the orientation the exif held is returned, since the pixels do not show it.
 * undefined when the bytes do not walk as a jpeg, so a caller never keeps half a file.
 */
export function stripJpegMetadata(b: Uint8Array): { bytes: Uint8Array; orientation: number } | undefined {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
	const v = view(b);
	const chunks: Uint8Array[] = [b.subarray(0, 2)];
	let orientation = 1;
	let i = 2;
	for (;;) {
		if (i + 2 > b.length || b[i] !== 0xff) return undefined;
		const marker = b[i + 1]!;
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd9) {
			chunks.push(b.subarray(i, i + 2));
			break;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			chunks.push(b.subarray(i, i + 2));
			i += 2;
			continue;
		}
		if (i + 4 > b.length) return undefined;
		const len = v.getUint16(i + 2);
		if (len < 2 || i + 2 + len > b.length) return undefined;
		const seg = b.subarray(i, i + 2 + len);
		const head = String.fromCharCode(...b.subarray(i + 4, i + 4 + 6));
		const app = marker >= 0xe0 && marker <= 0xef;
		// comments are kept: a decoder writes its own (if any), and nothing a camera recorded (exif, xmp, photoshop, maker notes) lives in one
		const keep = !app || marker === 0xe0 || marker === 0xee || (marker === 0xe2 && head.startsWith("ICC_PR"));
		if (marker === 0xe1 && head === "Exif\0\0") orientation = tiffOrientation(b, i + 10);
		if (keep) chunks.push(seg);
		i += 2 + len;
		if (marker === 0xda) {
			// entropy-coded data runs to the next marker; a stuffed 0xff, a restart marker or fill is not one
			let j = i;
			while (j < b.length) {
				if (b[j] !== 0xff) {
					j++;
					continue;
				}
				const n = b[j + 1];
				if (n === undefined) return undefined;
				if (n === 0 || (n >= 0xd0 && n <= 0xd7)) j += 2;
				else if (n === 0xff) j++;
				else break;
			}
			if (j >= b.length) return undefined;
			chunks.push(b.subarray(i, j));
			i = j;
		}
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return { bytes: out, orientation };
}

/**
 * the stored size of a heic photo: the biggest image-spatial-extents property in its meta box (the photo, not
 * a thumbnail or one tile of a grid). stored means before the rotation a phone's photo carries, so a portrait
 * one reads wider than tall; only its longest edge is used. undefined when the boxes do not say.
 */
export function heicSize(b: Uint8Array): Dimensions | undefined {
	const v = view(b);
	let best: Dimensions | undefined;
	const walk = (start: number, end: number, path: string[]) => {
		for (let i = start; i + 8 <= end; ) {
			let size = v.getUint32(i);
			const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
			let head = 8;
			if (size === 1 && i + 16 <= end) {
				size = Number(v.getBigUint64(i + 8));
				head = 16;
			} else if (size === 0) size = end - i;
			if (size < head || i + size > end) return;
			const body = i + head;
			if (path.length === 0 && type === "meta") walk(body + 4, i + size, ["meta"]);
			else if (path.length === 1 && type === "iprp") walk(body, i + size, ["meta", "iprp"]);
			else if (path.length === 2 && type === "ipco") walk(body, i + size, ["meta", "iprp", "ipco"]);
			else if (path.length === 3 && type === "ispe" && body + 12 <= i + size) {
				const width = v.getUint32(body + 4);
				const height = v.getUint32(body + 8);
				if (!best || width * height > best.width * best.height) best = { width, height };
			}
			i += size;
		}
	};
	walk(0, b.length, []);
	return best;
}

/** a way to read heic on this host: `decode` yields a jpeg, or undefined when the tool fails */
export interface HeicDecoder {
	name: string;
	/** the jpeg shows the photo upright already; otherwise its exif orientation says how to turn it */
	upright: boolean;
	/** `max` is the edge to fit to and `size` the photo's stored size when its boxes say; a decoder may leave fitting to the caller; `timeoutMs` is what is left of the photo's budget */
	decode(bytes: Uint8Array, max: number, size?: Dimensions, timeoutMs?: number): Promise<Uint8Array | undefined>;
}

/** libheif's own command line (heif-dec, or heif-convert before 1.17): writes full size, so the converter fits it */
export function heifCliDecoder(bin: string, name = bin.split("/").pop()!): HeicDecoder {
	return {
		name,
		upright: true,
		async decode(bytes, _max, _size, timeoutMs = Infinity) {
			const dir = mkdtempSync(join(tmpdir(), "cmx2-heic-"));
			try {
				writeFileSync(join(dir, "in.heic"), bytes);
				if (!(await runTool([bin, "-q", String(JPEG_QUALITY), join(dir, "in.heic"), join(dir, "out.jpg")], Math.min(timeoutMs, imageTimeouts.toolMs)))) return undefined;
				// a file with several top-level images is written as out-1.jpg, out-2.jpg, and no flag I could confirm asks for the primary
				// alone. the first is taken: for a camera photo that is the shot (a burst's other frames, a live photo's video and a depth map
				// are not extra stills to show), and if a file ever orders them otherwise the model sees another frame of the same shot
				const written = readdirSync(dir).filter((f) => /^out(-\d+)?\.jpe?g$/.test(f)).sort();
				const file = written.includes("out.jpg") ? "out.jpg" : written[0];
				return file ? new Uint8Array(readFileSync(join(dir, file))) : undefined;
			} catch {
				return undefined;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

/** imagemagick as a heic decoder: one pass reads, turns upright, fits and writes a jpeg without its exif */
export function magickHeicDecoder(bin: string): HeicDecoder {
	const mc: Converter = { name: bin, argv: magickArgv(bin) };
	return { name: bin, upright: true, decode: (bytes, max, _size, timeoutMs) => convert(mc, bytes, "image/heic", { max, format: "jpeg", quality: JPEG_QUALITY, heic: true, timeoutMs }) };
}

/**
 * whether imagemagick's `-list format` output lists HEIC as readable. imagemagick 7 prints a module column
 * (`HEIC* HEIC      rw+   Apple ...`); imagemagick 6 on some distributions leaves it empty
 * (`HEIC*            r--   Apple ...`); a format that is listed but cannot be read has mode `-w-` or `---`
 */
export function listsHeic(listing: string): boolean {
	return /^\s*HEIC\*?\s+(?:\S+\s+)?r[w-][+-]\s/m.test(listing);
}

/** imagemagick reads heic only when it was built with libheif and the coder loads, which `-list format` tells */
async function magickReadsHeic(bin: string): Promise<boolean> {
	try {
		const p = Bun.spawn([bin, "-list", "format"], { stdout: "pipe", stderr: "ignore", timeout: imageTimeouts.probeMs, killSignal: "SIGKILL" });
		const out = await new Response(p.stdout).text();
		return (await p.exited) === 0 && listsHeic(out);
	} catch {
		return false;
	}
}

/** what `hostHeicDecoders` found, once it found one; or a list a test put in */
let heicDecoders: HeicDecoder[] | undefined;
let overridden = false;
let probing: Promise<HeicDecoder[]> | undefined;
/** moves when a test replaces the list, so a probe that was already running cannot overwrite it or clear a newer one */
let generation = 0;

async function probeHost(): Promise<HeicDecoder[]> {
	const found: HeicDecoder[] = [];
	const c = imageConverter();
	if (c?.name === "sips") {
		// sips resamples to the edge it is given even when that enlarges, so it is only given one for a photo that is over it
		found.push({
			name: "sips",
			upright: false,
			decode: (bytes, max, size, timeoutMs) => convert(c, bytes, "image/heic", { ...(size && Math.max(size.width, size.height) > max ? { max } : {}), format: "jpeg", quality: JPEG_QUALITY, timeoutMs }),
		});
	}
	for (const bin of ["magick", "convert"]) {
		if (!Bun.which(bin) || !(await magickReadsHeic(bin))) continue;
		found.push(magickHeicDecoder(bin));
		break;
	}
	for (const bin of ["heif-dec", "heif-convert"]) {
		const path = Bun.which(bin);
		if (path) found.push(heifCliDecoder(path, bin));
	}
	return found;
}

let probe = probeHost;

/**
 * the decoders this host has, in the order they are tried: sips on macos (it reads heic itself), imagemagick when
 * it lists HEIC, then libheif's tools. a list with something in it is kept; an empty one is not, so a host that
 * installs a decoder after the first heic photo reads the next one without a restart (a daemon on a fleet is not
 * restarted for that), and calls that arrive together share one probe.
 */
export function hostHeicDecoders(): Promise<HeicDecoder[]> {
	if (heicDecoders && (overridden || heicDecoders.length)) return Promise.resolve(heicDecoders);
	if (!probing) {
		const mine = generation;
		const p: Promise<HeicDecoder[]> = probe()
			.then((list) => {
				if (mine === generation && list.length) heicDecoders = list;
				return list;
			})
			.finally(() => {
				if (probing === p) probing = undefined;
			});
		probing = p;
	}
	return probing;
}

/** replace what `hostHeicDecoders` finds (an empty list stays empty), or forget it (undefined) to probe again; for tests */
export function setHeicDecoders(list: HeicDecoder[] | undefined): void {
	heicDecoders = list;
	overridden = !!list;
	probing = undefined;
	generation++;
}

/** replace how the host is probed, or put the real probe back (undefined); for tests */
export function setHeicProbe(fn: (() => Promise<HeicDecoder[]>) | undefined): void {
	probe = fn ?? probeHost;
	setHeicDecoders(undefined);
}

const NO_HEIC_DECODER =
	"this host cannot read heic: install heif-dec or heif-convert with an hevc decoder (libheif-examples and libheif-plugin-libde265 on debian 13 and ubuntu 24.04 and later; elsewhere libheif's tools built with libde265) or an imagemagick built with heic support, then send the photo again";

/** a photo this many pixels over is refused before any tool is started on it: an hevc decode of it is gigabytes of memory */
const MAX_HEIC_PIXELS = 100_000_000;

/**
 * a heic photo as a jpeg the model can read: decoded by the first host tool that can, fitted to the edge and byte
 * limits, turned upright, and stripped of exif (camera, time, gps), xmp and the rest. a placeholder in plain words
 * when no tool reads it; never an exception. every spawned tool is killed when it overruns, the whole photo has one
 * budget, and a decoder that timed out ends the attempt (the file is the likely cause, not the tool).
 */
async function resizeHeic(bytes: Uint8Array, maxEdge: number): Promise<ResizedImage> {
	const started = Date.now();
	const left = () => imageTimeouts.heicMs - (Date.now() - started);
	const fail = (why: string, original?: Dimensions): ResizedImage => ({ ok: false, bytes: bytes.length, original, placeholder: `(image not attached: a heic photo, ${bytes.length} bytes; ${why})` });
	const secs = (ms: number) => `${ms < 10_000 ? (Math.max(ms, 0) / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
	/** a tool was stopped after `ms`, the time it was allowed */
	const tooSlow = (name: string, ms: number) => fail(`${name} took too long on it (stopped after ${secs(ms)}); a damaged or very large photo can do that`);
	/** nothing is left of the photo's budget to start `name` with */
	const outOfTime = (name: string) => fail(`${name} never started: the ${secs(imageTimeouts.heicMs)} this host gives one photo were used up; a damaged or very large photo can do that`);
	const size = heicSize(bytes);
	if (size && size.width * size.height > MAX_HEIC_PIXELS) {
		return fail(`it is ${size.width}x${size.height}, over ${MAX_HEIC_PIXELS / 1_000_000} megapixels, more than this host will decode; shrink it first`, size);
	}
	const decoders = await hostHeicDecoders();
	if (!decoders.length) return fail(NO_HEIC_DECODER);
	const c = imageConverter();
	const over = (d: Dimensions | undefined) => !!d && (d.width > maxEdge || d.height > maxEdge);
	/** the longest time one more tool may run, or 0 when the photo's budget is spent */
	const slice = () => Math.max(0, Math.min(imageTimeouts.toolMs, left()));
	/** one more converter run inside what is left of the budget: "slow" (with the time it had) when it had none or ran it out, undefined when it failed */
	const run = async (tool: Converter, input: Uint8Array, opts: ConvertOptions): Promise<Uint8Array | undefined | { slow: number }> => {
		const ms = slice();
		if (ms <= 0) return { slow: 0 };
		const t0 = Date.now();
		const out = await convert(tool, input, "image/jpeg", { ...opts, timeoutMs: ms });
		return !out && Date.now() - t0 >= ms - 100 ? { slow: ms } : out;
	};
	const stopped = (r: unknown, name: string): ResizedImage | undefined => {
		const slow = (r as { slow?: number } | undefined)?.slow;
		return slow === undefined ? undefined : slow > 0 ? tooSlow(name, slow) : outOfTime(name);
	};
	for (const d of decoders) {
		const timeoutMs = slice();
		if (timeoutMs <= 0) return outOfTime(d.name);
		const t0 = Date.now();
		let jpeg = await d.decode(bytes, maxEdge, size, timeoutMs);
		if (!jpeg || sniffImage(jpeg) !== "image/jpeg") {
			// a tool that ran its whole allowance was killed; the next would be given the same file
			if (Date.now() - t0 >= timeoutMs - 100) return tooSlow(d.name, timeoutMs);
			continue;
		}
		let shrunk = over(size);
		let before = size;
		const decoded = readDimensions(jpeg, "image/jpeg");
		if (over(decoded)) {
			if (!c) return fail(`${d.name} read it, but it is over the ${maxEdge} px limit and this host has no image converter to shrink it; install imagemagick`);
			const fitted = await run(c, jpeg, { max: maxEdge, format: "jpeg", quality: JPEG_QUALITY });
			const late = stopped(fitted, c.name);
			if (late) return late;
			if (!(fitted instanceof Uint8Array) || sniffImage(fitted) !== "image/jpeg") return fail(`${c.name} could not shrink what ${d.name} read`);
			jpeg = fitted;
			shrunk = true;
			// what the decoder wrote is the better "from": the stored size can be a thumbnail's or sideways
			before = decoded;
		}
		let stripped = stripJpegMetadata(jpeg);
		if (!stripped) continue;
		// a decoder that does not turn the photo leaves its orientation in the exif, which a model never reads
		const t = d.upright ? undefined : ORIENTATION_TRANSFORMS[stripped.orientation];
		if (t && c) {
			let turned: Uint8Array | undefined = jpeg;
			for (const step of [...(t.rotate ? [{ rotate: t.rotate }] : []), ...(t.flip ? [{ rotate: 0 as const, flip: t.flip }] : [])]) {
				const r = await run(c, turned, { format: "jpeg", quality: JPEG_QUALITY, transform: step });
				const late = stopped(r, c.name);
				if (late) return late;
				turned = r instanceof Uint8Array ? r : undefined;
				if (!turned) break;
			}
			const again = turned && sniffImage(turned) === "image/jpeg" ? stripJpegMetadata(turned) : undefined;
			if (!again) return fail(`${c.name} could not turn it upright`);
			stripped = again;
		}
		let out = stripped.bytes;
		if (out.length > MAX_IMAGE_BYTES && c) {
			// the edge is only given when the jpeg is over it: sips enlarges to whatever edge it is handed
			const lighter = await run(c, out, { ...(over(readDimensions(out, "image/jpeg")) ? { max: maxEdge } : {}), format: "jpeg", quality: 70 });
			const late = stopped(lighter, c.name);
			if (late) return late;
			const s = lighter instanceof Uint8Array && sniffImage(lighter) === "image/jpeg" ? stripJpegMetadata(lighter) : undefined;
			if (s) out = s.bytes;
		}
		if (out.length > MAX_IMAGE_BYTES) return fail(`${d.name} read it, but the jpeg is still ${out.length} bytes, over the ${MAX_IMAGE_BYTES} byte limit`);
		const dims = readDimensions(out, "image/jpeg");
		// the boxes give the stored size, before a phone's rotation; the caption shows it the way the photo is seen
		const original = shrunk && before ? (dims && before.width > before.height !== dims.width > dims.height && before.width !== before.height ? { width: before.height, height: before.width } : before) : undefined;
		return { ok: true, data: Buffer.from(out).toString("base64"), mime: "image/jpeg", width: dims?.width, height: dims?.height, bytes: out.length, resized: shrunk, ...(original ? { original } : {}), converted: { from: "image/heic", bytes: bytes.length, via: d.name } };
	}
	return fail(`${decoders.map((d) => d.name).join(", ")} could not decode it: the file may be damaged, libheif may have no hevc decoder (libheif-plugin-libde265 on debian 13 and ubuntu 24.04 and later), or the decoder may be broken`);
}

/**
 * whether a png might carry transparency: an alpha channel (IHDR color type 4 or 6) or a tRNS chunk
 * (which sits before the first IDAT). undefined when it is not a png at all.
 */
function pngMayHaveAlpha(b: Uint8Array): boolean | undefined {
	if (!png(b)) return undefined;
	if (b[25] === 4 || b[25] === 6) return true;
	const v = view(b);
	let i = 8;
	while (i + 8 <= b.length) {
		const len = v.getUint32(i);
		const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
		if (type === "tRNS") return true;
		if (type === "IDAT" || type === "IEND") return false;
		i += 12 + len;
	}
	return false;
}

/** whether every pixel of a png with an alpha channel is fully opaque; needs imagemagick, false without it */
async function pngIsOpaque(bytes: Uint8Array): Promise<boolean> {
	const magick = Bun.which("magick");
	if (!magick) return false;
	const src = join(tmpdir(), `cmx2-image-${randomUUID()}-opaque.png`);
	try {
		writeFileSync(src, bytes);
		const p = Bun.spawn([magick, "identify", "-format", "%[opaque]", src], { stdout: "pipe", stderr: "ignore", timeout: imageTimeouts.probeMs, killSignal: "SIGKILL" });
		const out = await new Response(p.stdout).text();
		return (await p.exited) === 0 && out.trim() === "True";
	} catch {
		return false;
	} finally {
		rmSync(src, { force: true });
	}
}

/**
 * an image the model can take: unchanged when it is inside both limits, resized through the host
 * converter when it is not, and a placeholder that says why when neither works. screenshots stay png
 * when they fit; anything still too heavy becomes jpeg, and so does a heavy png without alpha when
 * the jpeg is much smaller.
 */
export async function resizeImage(bytes: Uint8Array, mime: string, maxEdge = MAX_EDGE): Promise<ResizedImage> {
	const real = sniffImage(bytes);
	// heic is decided by its bytes, whatever the name or type said; it always leaves as a jpeg
	if (!real && sniffHeic(bytes)) return resizeHeic(bytes, maxEdge);
	if (!real) {
		return { ok: false, bytes: bytes.length, placeholder: `(image not attached: ${bytes.length} bytes that are not a png, jpeg, gif, webp or heic, although the type said ${mime})` };
	}
	const dims = readDimensions(bytes, real);
	// a png, gif or webp says its size in its first bytes; one that does not is broken, and a provider refuses
	// it on every request the transcript replays it in (a jpeg's size can sit behind markers this reader skips)
	if (!dims && real !== "image/jpeg") {
		return { ok: false, bytes: bytes.length, placeholder: `(image not attached: ${bytes.length} bytes that start like a ${real.slice(6)} but have no readable size)` };
	}
	const over = (d: Dimensions | undefined) => !!d && (d.width > maxEdge || d.height > maxEdge);
	const c = imageConverter();
	let out = bytes;
	let outMime = real;
	let resized = false;
	if (over(dims) || bytes.length > MAX_IMAGE_BYTES) {
		const size = dims ? `${dims.width}x${dims.height}, ` : "";
		if (!c) {
			return {
				ok: false,
				original: dims,
				bytes: bytes.length,
				placeholder: `(image not attached: ${size}${bytes.length} bytes is over the ${maxEdge} px or ${MAX_IMAGE_BYTES} byte limit, and this host has no image converter; install imagemagick to have images resized)`,
			};
		}
		let next = real === "image/jpeg" ? undefined : await convert(c, bytes, real, { max: maxEdge, format: "png" });
		if (!next || next.length > MAX_IMAGE_BYTES) next = await convert(c, bytes, real, { max: maxEdge, format: "jpeg", quality: JPEG_QUALITY });
		if (!next || next.length > MAX_IMAGE_BYTES) {
			return { ok: false, original: dims, bytes: bytes.length, placeholder: `(image not attached: ${size}${bytes.length} bytes, and ${c.name} could not bring it under the limit)` };
		}
		out = next;
		outMime = sniffImage(next) ?? "image/jpeg";
		resized = true;
	}
	let reencoded: { from: "image/png"; bytes: number } | undefined;
	if (c && outMime === "image/png" && out.length > REENCODE_ABOVE && (!pngMayHaveAlpha(out) || (await pngIsOpaque(out)))) {
		const jpg = await convert(c, out, "image/png", { format: "jpeg", quality: JPEG_QUALITY });
		if (jpg && sniffImage(jpg) === "image/jpeg" && jpg.length <= out.length * REENCODE_KEEP) {
			reencoded = { from: "image/png", bytes: out.length };
			out = jpg;
			outMime = "image/jpeg";
		}
	}
	const d = out === bytes ? dims : readDimensions(out, outMime);
	return { ok: true, data: Buffer.from(out).toString("base64"), mime: outMime, width: d?.width, height: d?.height, bytes: out.length, resized, ...(resized ? { original: dims } : {}), ...(reencoded ? { reencoded } : {}) };
}

/** a data url resized the same way, for photos clients attach to a prompt */
export async function resizeDataUrl(url: string, maxEdge = MAX_EDGE): Promise<ResizedImage | undefined> {
	const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
	if (!m || !m[1]!.startsWith("image/")) return undefined;
	return resizeImage(new Uint8Array(Buffer.from(m[2]!, "base64")), m[1]!, maxEdge);
}

/** the content parts for one image: a caption and the image, or the placeholder when it could not be sent */
export async function imageParts(bytes: Uint8Array, mime: string, label: string): Promise<Array<TextPart | ImagePart>> {
	const r = await resizeImage(bytes, mime);
	if (!r.ok) return [text(`image ${label}: ${r.placeholder}`)];
	const dims = r.width && r.height ? `${r.width}x${r.height}` : "unknown size";
	const note = (r.resized && r.original ? `, resized from ${r.original.width}x${r.original.height}` : "") + (r.reencoded ? `, jpeg from a ${r.reencoded.bytes} byte png` : "") + (r.converted ? `, jpeg from a ${r.converted.bytes} byte heic` : "");
	return [text(`image ${label} (${dims}, ${r.bytes} bytes${note})`), { type: "image", data: r.data, mimeType: r.mime }];
}
