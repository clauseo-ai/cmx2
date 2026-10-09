import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { UserBlock } from "@cmx2/engine/session";
import { isHeicMime, sniffHeic } from "@cmx2/tools";
import { badRequest } from "./http.ts";

/**
 * a prompt's parts as clients send them (cmx's shape: text, and file parts with a data url for
 * photos or a file url for `@` mentions) turned into the blocks a user message carries. photos are
 * resized on this host before they reach the model; mentioned files are read here and ride as
 * synthetic text, so the model sees their content without a tool call.
 */

export interface PartInput {
	type: string;
	text?: string;
	mime?: string;
	filename?: string;
	url?: string;
	synthetic?: boolean;
}

export type Resize = (bytes: Uint8Array, mime: string) => Promise<{ data: string; mime: string } | { placeholder: string }>;

/** a pdf larger than this rides as its extracted text only (anthropic takes up to 32 MB per request) */
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** what a mentioned file may put into one message; the rest is a read away */
const MENTION_MAX_BYTES = 50 * 1024;
const MENTION_MAX_LINES = 2000;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** an image the model can be given, or one `resize` converts to one (heic and heif become jpeg) */
const isImageMime = (mime: string) => IMAGE_MIMES.has(mime) || isHeicMime(mime);

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } {
	const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
	if (!m) throw badRequest("a file part's data url is malformed; send data:<mime>;base64,<data>");
	const body = m[3] ?? "";
	const bytes = m[2] ? Uint8Array.from(Buffer.from(body, "base64")) : new TextEncoder().encode(decodeURIComponent(body));
	return { mime: m[1] || "application/octet-stream", bytes };
}

/** the first bytes of a regular file, or undefined for anything else (a directory, a fifo, a file that will not open) */
function headOf(abs: string, n: number): Uint8Array | undefined {
	try {
		if (!statSync(abs).isFile()) return undefined;
		const fd = openSync(abs, "r");
		try {
			const buf = Buffer.alloc(n);
			return new Uint8Array(buf.subarray(0, readSync(fd, buf, 0, n, 0)));
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function fileUrlPath(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname);
	} catch {
		throw badRequest(`${url} is not a file url`);
	}
}

function shown(cwd: string, abs: string): string {
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
}

function mentioned(cwd: string, abs: string): string {
	const name = shown(cwd, abs);
	if (!existsSync(abs)) return `<file path="${name}">\n(the file no longer exists)\n</file>`;
	const st = statSync(abs);
	if (st.isDirectory()) {
		const entries = readdirSync(abs, { withFileTypes: true })
			.filter((e) => !e.name.startsWith("."))
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			.sort()
			.slice(0, 500);
		return `<directory path="${name}">\n${entries.join("\n")}\n</directory>`;
	}
	const raw = readFileSync(abs);
	if (raw.subarray(0, 8000).includes(0)) return `<file path="${name}">\n(binary, ${st.size} bytes; not inlined)\n</file>`;
	let text = raw.toString("utf8");
	let note = "";
	const lines = text.split("\n");
	if (lines.length > MENTION_MAX_LINES || Buffer.byteLength(text) > MENTION_MAX_BYTES) {
		let kept = lines.slice(0, MENTION_MAX_LINES);
		while (Buffer.byteLength(kept.join("\n")) > MENTION_MAX_BYTES && kept.length > 1) kept = kept.slice(0, Math.floor(kept.length * 0.8));
		text = kept.join("\n");
		note = `\n(first ${kept.length} of ${lines.length} lines; read the rest with offset ${kept.length + 1})`;
	}
	return `<file path="${name}">\n${text}${note}\n</file>`;
}

function pdfText(bytes: Uint8Array, filename: string): string {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-pdf-"));
	try {
		const src = join(dir, "in.pdf");
		writeFileSync(src, bytes);
		const r = spawnSync("pdftotext", ["-layout", src, "-"], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
		if (r.error || r.status !== 0) return `<file path="${filename}">\n(a pdf, ${bytes.length} bytes; this host has no pdftotext to read it, so only its name came through)\n</file>`;
		const text = r.stdout.length > MENTION_MAX_BYTES ? `${r.stdout.slice(0, MENTION_MAX_BYTES)}\n(cut at 50 KB)` : r.stdout;
		return `<file path="${filename}">\n${text}\n</file>`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** the blocks of one user message; throws a typed 400 when there is nothing to send */
export async function blocksOf(body: { text?: string; parts?: PartInput[] }, cwd: string, resize: Resize): Promise<UserBlock[]> {
	const blocks: UserBlock[] = [];
	if (typeof body.text === "string" && body.text.trim()) blocks.push({ type: "text", text: body.text });
	for (const p of body.parts ?? []) {
		if (p.type === "text") {
			if (typeof p.text === "string" && p.text.length) blocks.push({ type: "text", text: p.text, ...(p.synthetic ? { synthetic: true } : {}) });
			continue;
		}
		if (p.type !== "file") continue;
		if (!p.url) throw badRequest("a file part needs a url (data: for uploads, file: for paths)");
		const filename = p.filename ?? "attachment";
		if (p.url.startsWith("data:")) {
			const { mime, bytes } = decodeDataUrl(p.url);
			let type = (p.mime || mime).toLowerCase();
			// a browser that cannot name a heic photo sends it untyped; its bytes say what it is
			if (!isImageMime(type) && sniffHeic(bytes)) type = "image/heic";
			if (isImageMime(type)) {
				const r = await resize(bytes, type);
				if ("placeholder" in r) blocks.push({ type: "text", text: r.placeholder, synthetic: true });
				else blocks.push({ type: "image", data: r.data, mimeType: r.mime, filename } as UserBlock);
			} else if (type === "application/pdf") {
				// the pdf rides whole for models that read documents; its extracted text is what the rest read
				const document = bytes.length <= DOCUMENT_MAX_BYTES ? { data: Buffer.from(bytes).toString("base64"), mimeType: "application/pdf", filename } : undefined;
				blocks.push({ type: "text", text: pdfText(bytes, filename), synthetic: true, ...(document ? { document } : {}) });
			} else if (type.startsWith("text/") || type === "application/json") {
				blocks.push({ type: "text", text: `<file path="${filename}">\n${new TextDecoder().decode(bytes)}\n</file>`, synthetic: true });
			} else {
				blocks.push({ type: "text", text: `<file path="${filename}">\n(${type}, ${bytes.length} bytes; not a kind the model can read)\n</file>`, synthetic: true });
			}
			continue;
		}
		if (p.url.startsWith("file:")) {
			const abs = fileUrlPath(p.url);
			let mime = (p.mime ?? "").toLowerCase();
			// a path sent without a type, or typed as something else, is a heic photo when its first bytes say so
			if (!isImageMime(mime) && existsSync(abs)) {
				const head = headOf(abs, 512);
				if (head && sniffHeic(head)) mime = "image/heic";
			}
			if (isImageMime(mime) && existsSync(abs)) {
				const r = await resize(readFileSync(abs), mime);
				if ("placeholder" in r) blocks.push({ type: "text", text: r.placeholder, synthetic: true });
				else blocks.push({ type: "image", data: r.data, mimeType: r.mime, filename: shown(cwd, abs) } as UserBlock);
			} else {
				blocks.push({ type: "text", text: mentioned(cwd, abs), synthetic: true });
			}
			continue;
		}
		throw badRequest(`file part urls must be data: or file:, got ${p.url.slice(0, 40)}`);
	}
	if (!blocks.some((b) => b.type === "image" || (b.type === "text" && b.text.trim()))) throw badRequest('send the message as {"parts": [{"type": "text", "text": "..."}]}');
	return blocks;
}

/** the text a client typed, for event excerpts and command matching */
export function typedText(blocks: UserBlock[]): string {
	return blocks
		.filter((b): b is Extract<UserBlock, { type: "text" }> => b.type === "text" && !b.synthetic)
		.map((b) => b.text)
		.join("\n");
}
