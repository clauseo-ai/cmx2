import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * the session transcript on disk: one json line per message, append-only, the first line a header.
 * the leading system message (prompt and tool declarations) is the recorded prefix; a resume replays
 * it byte for byte instead of rendering a new one.
 */
export interface TranscriptHeader {
	type: "header";
	version: 1;
	id: string;
	cwd: string;
	created: number;
	/** prompt profile that rendered the recorded system message */
	profile: string;
}

export interface LoadedTranscript {
	header: TranscriptHeader;
	messages: any[];
	/** lines that did not parse (a torn final write after a crash); skipped, reported */
	skipped: number;
}

export class Transcript {
	/** messages in the file, so the latest one's position is its projection id */
	count = 0;
	/** file size after this process's last read or write; a different size on disk means another process wrote */
	bytes = 0;

	constructor(readonly path: string) {}

	create(header: TranscriptHeader) {
		mkdirSync(dirname(this.path), { recursive: true });
		if (existsSync(this.path)) throw new Error(`${this.path} already exists; refusing to overwrite a transcript`);
		writeFileSync(this.path, `${JSON.stringify(header)}\n`);
		this.bytes = statSync(this.path).size;
	}

	/** appends one message and returns its position (1-based) */
	append(message: unknown): number {
		appendFileSync(this.path, `${JSON.stringify({ type: "message", message })}\n`);
		this.bytes = statSync(this.path).size;
		return ++this.count;
	}

	/** true when the file changed under this process (another daemon ran a turn) */
	changedOnDisk(): boolean {
		try {
			return statSync(this.path).size !== this.bytes;
		} catch {
			return false;
		}
	}

	load(): LoadedTranscript {
		if (!existsSync(this.path)) throw new Error(`no transcript at ${this.path}`);
		const raw = readFileSync(this.path, "utf8");
		this.bytes = Buffer.byteLength(raw);
		const lines = raw.split("\n");
		let header: TranscriptHeader | undefined;
		const messages: any[] = [];
		let skipped = 0;
		for (const line of lines) {
			if (!line) continue;
			let row: any;
			try {
				row = JSON.parse(line);
			} catch {
				skipped++;
				continue;
			}
			if (row.type === "header") header = row;
			else if (row.type === "message") messages.push(row.message);
		}
		if (!header) throw new Error(`${this.path} has no header line; it is not a cmx2 transcript`);
		this.count = messages.length;
		return { header, messages, skipped };
	}
}
