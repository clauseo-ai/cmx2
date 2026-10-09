import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_BYTES, MAX_LINES } from "./types.ts";

export interface Clipped {
	text: string;
	truncated: boolean;
	totalLines: number;
	/** full output on disk when truncated */
	spillPath?: string;
}

/**
 * keeps the model-facing text inside the shared limits. `keep: "tail"` keeps the end (command output,
 * where the failure usually is); `"head"` keeps the start (file and search listings).
 */
export function clip(full: string, opts: { keep: "head" | "tail"; spillDir?: string; label: string }): Clipped {
	const lines = full.split("\n");
	const totalLines = lines.length;
	if (lines.length <= MAX_LINES && Buffer.byteLength(full) <= MAX_BYTES) return { text: full, truncated: false, totalLines };
	let picked = opts.keep === "head" ? lines.slice(0, MAX_LINES) : lines.slice(-MAX_LINES);
	let out = picked.join("\n");
	while (Buffer.byteLength(out) > MAX_BYTES && picked.length > 1) {
		picked = opts.keep === "head" ? picked.slice(0, Math.floor(picked.length * 0.8)) : picked.slice(Math.ceil(picked.length * 0.2));
		out = picked.join("\n");
	}
	return { text: out, truncated: true, totalLines, spillPath: spill(opts.spillDir, opts.label, full) };
}

/** writes the full output to the spill dir and returns its path; nothing without a dir */
export function spill(dir: string | undefined, label: string, full: string): string | undefined {
	if (!dir) return undefined;
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`);
	writeFileSync(path, full);
	return path;
}

export function clipNote(c: Clipped, shown: string): string {
	if (!c.truncated) return "";
	return `\n\n(${shown} of ${c.totalLines} lines shown${c.spillPath ? `; full output at ${c.spillPath}, read it with offset and limit` : ""})`;
}
