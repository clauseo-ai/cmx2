import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "./http.ts";

/**
 * `GET /file/content`: one file's bytes, for a favicon or a file preview. the content type comes from
 * the bytes first (an extensionless png is still a png) and from the extension only when the bytes say
 * nothing. a path is held to the directory after symlinks resolve, and a file over the cap is refused
 * from its size before a byte is read.
 */

/** the default and the ceiling for `max` */
export const CONTENT_MAX = 1024 * 1024;

export class FileNotFound extends HttpError {
	constructor(message: string) {
		super(404, "FileNotFoundError", message);
	}
}

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, text: string) => starts(b, [...text].map((c) => c.charCodeAt(0)), at);

/** an svg is text: skip a bom, whitespace, an xml prolog, comments and a doctype, then expect `<svg` */
function isSvg(b: Uint8Array): boolean {
	const head = new TextDecoder().decode(b.subarray(0, 16 * 1024)).replace(/^\ufeff/, "");
	const stripped = head.replace(/^(?:\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[^\]]*\])*>)+/i, "");
	return /^<svg[\s>/]/i.test(stripped);
}

/** the type the first bytes name, if they name one */
export function sniff(b: Uint8Array): string | undefined {
	if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
	if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
	if (ascii(b, 4, "ftyp") && (ascii(b, 8, "avif") || ascii(b, 8, "avis"))) return "image/avif";
	if (starts(b, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
	if (isSvg(b)) return "image/svg+xml";
	return undefined;
}

const BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".pdf": "application/pdf",
	".json": "application/json",
	".md": "text/markdown; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
};

/** neither bytes nor extension named a type: text when the start decodes as utf-8 with no nul, else opaque */
function plainOrOpaque(b: Uint8Array): string {
	const head = b.subarray(0, 4096);
	if (head.includes(0)) return "application/octet-stream";
	try {
		// a character cut in half by the 4096 boundary is not a reason to call the file binary
		new TextDecoder("utf-8", { fatal: true }).decode(b.length > head.length ? head.subarray(0, head.length - utf8Tail(head)) : head);
		return "text/plain; charset=utf-8";
	} catch {
		return "application/octet-stream";
	}
}

/** how many bytes at the end of a cut buffer belong to a character that was cut in half */
function utf8Tail(b: Uint8Array): number {
	for (let i = 1; i <= Math.min(3, b.length); i++) {
		const v = b[b.length - i]!;
		if ((v & 0xc0) === 0x80) continue;
		const need = v >= 0xf0 ? 4 : v >= 0xe0 ? 3 : v >= 0xc0 ? 2 : 1;
		return need > i ? i : 0;
	}
	return 0;
}

export function contentType(path: string, bytes: Uint8Array): string {
	return sniff(bytes) ?? BY_EXTENSION[extname(path).toLowerCase()] ?? plainOrOpaque(bytes);
}

export interface FileContent {
	bytes: Uint8Array<ArrayBuffer>;
	type: string;
	etag: string;
}

const inside = (root: string, p: string) => {
	const rel = relative(root, p);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/**
 * the file at `path` inside `directory` (already resolved). throws FileNotFound for a missing path, a
 * directory or anything that is not a regular file, 403 for a path that leaves the directory (by `..`
 * or by a symlink), 413 for a file over `max`. `ifNoneMatch` that still matches the bytes' hash answers notModified.
 * async, so a slow disk never holds the daemon.
 */
export async function readContent(directory: string, path: string, max: number, ifNoneMatch?: string | null): Promise<FileContent | { etag: string; notModified: true }> {
	if (!path) throw new HttpError(400, "BadRequestError", "path is required: a file relative to the directory");
	if (path.includes("\0")) throw new HttpError(400, "BadRequestError", "path has a nul byte");
	const named = resolve(directory, path);
	const forbidden = () => new HttpError(403, "ForbiddenError", `${path} is outside ${directory}; a file is read only from inside the directory it is asked of`);
	if (!inside(directory, named)) throw forbidden();
	let root: string;
	try {
		root = await realpath(directory);
		if (!(await stat(root)).isDirectory()) throw new FileNotFound(`${directory} is not a directory`);
	} catch (e) {
		if (e instanceof HttpError) throw e;
		throw new FileNotFound(`no such directory: ${directory}`);
	}
	let target: string;
	try {
		target = await realpath(named);
	} catch (e) {
		if ((e as { code?: string }).code === "EACCES") throw new HttpError(403, "ForbiddenError", `permission denied: ${path}`);
		throw new FileNotFound(`no file ${path}`);
	}
	if (!inside(root, target)) throw forbidden();
	// one descriptor decides everything: what it is, how big it is, and the bytes. no stat of the path
	// first (the file could be swapped between a stat and an open), no blocking on a fifo, no link followed
	let fh: Awaited<ReturnType<typeof open>>;
	try {
		fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === "EACCES" || code === "EPERM") throw new HttpError(403, "ForbiddenError", `permission denied: ${path}`);
		throw new FileNotFound(`no file ${path}`);
	}
	try {
		for (let attempt = 0; ; attempt++) {
			const before = await fh.stat();
			if (!before.isFile()) throw new FileNotFound(before.isDirectory() ? `${path} is a directory, not a file` : `${path} is not a regular file`);
			if (before.size > max) throw new HttpError(413, "FileTooLargeError", `${path} is ${before.size} bytes, over the ${max} byte limit`, { size: before.size, max });
			const bytes = await readToEnd(fh, before.size, max, path);
			// a file that grew or was rewritten while it was read is not what any one moment held: read it again.
			// a virtual file (size 0 in stat, bytes on read: /proc, /sys) has nothing to compare and is taken as read
			const after = await fh.stat();
			const stable = (after.size === bytes.length && after.mtimeMs === before.mtimeMs) || (before.size === 0 && after.size === 0);
			if (!stable) {
				if (attempt < 4) continue;
				throw new HttpError(409, "ConflictError", `${path} kept changing while it was read; ask again when it settles`);
			}
			// a hash of the bytes, quoted: the same bytes have the same etag on any host
			const etag = `"${createHash("sha1").update(bytes).digest("hex")}"`;
			if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) return { etag, notModified: true };
			return { bytes, type: contentType(target, bytes), etag };
		}
	} finally {
		await fh.close();
	}
}

/** the file from its start to its end, however long it turns out to be: over max bytes is a 413 as soon as the byte past max is read */
async function readToEnd(fh: Awaited<ReturnType<typeof open>>, size: number, max: number, path: string): Promise<Uint8Array<ArrayBuffer>> {
	let buf = new Uint8Array(Math.min(max + 1, Math.max(size + 1, 64 * 1024)));
	let n = 0;
	for (;;) {
		if (n === buf.length) {
			if (n > max) throw new HttpError(413, "FileTooLargeError", `${path} is over the ${max} byte limit`, { max });
			const bigger = new Uint8Array(Math.min(max + 1, buf.length * 2));
			bigger.set(buf);
			buf = bigger;
		}
		const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
		if (bytesRead === 0) break;
		n += bytesRead;
	}
	if (n > max) throw new HttpError(413, "FileTooLargeError", `${path} is over the ${max} byte limit`, { max });
	return buf.slice(0, n);
}
