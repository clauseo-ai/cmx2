import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * reads a session bundle (a json file of up to hundreds of megabytes) without holding it in memory: one pass finds where
 * each top-level value starts and ends, then the caller parses the small ones whole, walks the messages array one element
 * at a time and decodes the transcript string in pieces cut at its line ends. json's structural bytes are ascii, so the
 * scan works on utf-8 bytes directly.
 */

const WINDOW = 1024 * 1024;
const GC_EVERY = 4 * 1024 * 1024;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

export class BundleError extends Error {}

const cut = () => new BundleError("that bundle is cut short or is not json; it should be what a cmx2 export wrote");

export interface Range {
	start: number;
	end: number;
}

export class BundleReader {
	readonly size: number;
	private fd: number;
	private buf = Buffer.allocUnsafe(WINDOW);
	private at = 0;
	private len = 0;

	constructor(path: string) {
		this.fd = openSync(path, "r");
		this.size = fstatSync(this.fd).size;
	}

	close() {
		closeSync(this.fd);
	}

	private fill(pos: number) {
		this.at = pos;
		this.len = pos < this.size ? readSync(this.fd, this.buf, 0, WINDOW, pos) : 0;
	}

	/** the byte at pos, or -1 past the end */
	byte(pos: number): number {
		if (pos >= this.size) return -1;
		if (pos < this.at || pos >= this.at + this.len) this.fill(pos);
		return this.buf[pos - this.at]!;
	}

	private sinceGc = 0;

	/**
	 * a tight synchronous loop over hundreds of megabytes leaves its parsed strings for a gc that does not run until the
	 * loop yields, so the heap grows with the file; a collection every 4 MB read keeps it flat (measured on a 256 MB bundle: 95 MB peak at 2 MB, 103 at 4, 115 at 8, about 300 with none)
	 */
	private collect(len: number) {
		this.sinceGc += len;
		if (this.sinceGc < GC_EVERY) return;
		this.sinceGc = 0;
		(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
	}

	/** one buffer reused for every read of a value, so the scan does not leave a buffer behind per message for the gc */
	private scratch = Buffer.allocUnsafe(WINDOW);

	/** the bytes of [start, end), in the shared scratch buffer: valid until the next slice */
	slice(start: number, end: number): Buffer {
		const len = end - start;
		if (this.scratch.length < len) this.scratch = Buffer.allocUnsafe(Math.max(len, this.scratch.length * 2));
		const b = this.scratch.subarray(0, len);
		this.collect(len);
		let off = 0;
		while (off < len) {
			const n = readSync(this.fd, b, off, len - off, start + off);
			if (n <= 0) throw cut();
			off += n;
		}
		return b;
	}

	parse(r: Range): unknown {
		try {
			return JSON.parse(this.slice(r.start, r.end).toString("utf8"));
		} catch {
			throw cut();
		}
	}

	skipWs(pos: number): number {
		let p = pos;
		for (;;) {
			const c = this.byte(p);
			if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return p;
			p++;
		}
	}

	/** pos is an opening quote; the position after its closing quote. linear: each search starts where the last one ended */
	private skipString(pos: number): number {
		let p = pos + 1;
		for (;;) {
			if (p >= this.size) throw cut();
			if (p < this.at || p >= this.at + this.len) this.fill(p);
			const view = this.buf.subarray(0, this.len);
			let local = p - this.at;
			let q = -2;
			for (;;) {
				if (q !== -1 && q < local) q = view.indexOf(QUOTE, local);
				const b = view.indexOf(BACKSLASH, local);
				if (b < 0 || (q >= 0 && q < b)) {
					if (q >= 0) return this.at + q + 1;
					local = this.len;
					break;
				}
				// a backslash escapes the byte after it
				local = b + 2;
				if (local >= this.len) break;
			}
			p = this.at + local;
		}
	}

	/** pos is the first byte of a value; the position after it */
	skipValue(pos: number): number {
		const c = this.byte(pos);
		if (c === QUOTE) return this.skipString(pos);
		if (c === 0x7b || c === 0x5b) {
			let depth = 0;
			let p = pos;
			for (;;) {
				const x = this.byte(p);
				if (x < 0) throw cut();
				if (x === QUOTE) {
					p = this.skipString(p);
					continue;
				}
				if (x === 0x7b || x === 0x5b) depth++;
				else if (x === 0x7d || x === 0x5d) {
					depth--;
					if (depth === 0) return p + 1;
				}
				p++;
			}
		}
		let p = pos;
		for (;;) {
			const x = this.byte(p);
			if (x < 0 || x === 0x2c || x === 0x7d || x === 0x5d || x === 0x20 || x === 0x0a || x === 0x0d || x === 0x09) break;
			p++;
		}
		if (p === pos) throw cut();
		return p;
	}

	/** the top-level object's keys and where each value lies */
	top(): Map<string, Range> {
		const out = new Map<string, Range>();
		let p = this.skipWs(0);
		if (this.byte(p) !== 0x7b) throw cut();
		p = this.skipWs(p + 1);
		if (this.byte(p) === 0x7d) return out;
		for (;;) {
			if (this.byte(p) !== QUOTE) throw cut();
			const kEnd = this.skipString(p);
			if (kEnd - p > 256) throw cut();
			const key = JSON.parse(this.slice(p, kEnd).toString("utf8")) as string;
			p = this.skipWs(kEnd);
			if (this.byte(p) !== 0x3a) throw cut();
			const start = this.skipWs(p + 1);
			const end = this.skipValue(start);
			out.set(key, { start, end });
			p = this.skipWs(end);
			const c = this.byte(p);
			if (c === 0x7d) break;
			if (c !== 0x2c) throw cut();
			p = this.skipWs(p + 1);
		}
		if (this.skipWs(p + 1) !== this.size) throw cut();
		return out;
	}

	/** each element of the array at r, parsed, one at a time */
	*elements(r: Range): Generator<unknown> {
		if (this.byte(r.start) !== 0x5b) throw cut();
		let p = this.skipWs(r.start + 1);
		if (this.byte(p) === 0x5d) return;
		for (;;) {
			const end = this.skipValue(p);
			yield this.parse({ start: p, end });
			p = this.skipWs(end);
			const c = this.byte(p);
			if (c === 0x5d) return;
			if (c !== 0x2c) throw cut();
			p = this.skipWs(p + 1);
		}
	}

	/**
	 * the string at r, decoded in pieces that end at a line end (an escaped \n), handed over a line at a time; the last
	 * line has no newline when the text did not end with one. a piece grows past `piece` bytes only for a longer line
	 */
	*lines(r: Range, piece = WINDOW): Generator<string> {
		if (this.byte(r.start) !== QUOTE || this.byte(r.end - 1) !== QUOTE) throw cut();
		let p = r.start + 1;
		const end = r.end - 1;
		let carry = "";
		while (p < end) {
			let want = Math.min(piece, end - p);
			let raw = this.slice(p, p + want);
			let stop = raw.length;
			if (p + want < end) {
				for (;;) {
					const at = lastLineEnd(raw);
					if (at > 0) {
						stop = at;
						break;
					}
					if (p + want >= end) break;
					want = Math.min(want * 2, end - p);
					raw = this.slice(p, p + want);
					stop = raw.length;
				}
			}
			let text: string;
			try {
				text = JSON.parse(`"${raw.subarray(0, stop).toString("utf8")}"`) as string;
			} catch {
				throw cut();
			}
			p += stop;
			const parts = (carry + text).split("\n");
			carry = parts.pop()!;
			for (const l of parts) yield `${l}\n`;
		}
		if (carry) yield carry;
	}
}

/** the offset just after the last escaped \n in raw that is a real escape (an even run of backslashes before it), or -1 */
function lastLineEnd(raw: Buffer): number {
	let i = raw.length - 1;
	for (;;) {
		i = raw.lastIndexOf(0x6e, i);
		if (i < 1) return -1;
		if (raw[i - 1] === BACKSLASH) {
			let k = 0;
			for (let j = i - 1; j >= 0 && raw[j] === BACKSLASH; j--) k++;
			if (k % 2 === 1) return i + 1;
		}
		i--;
	}
}
