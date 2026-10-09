/**
 * a process's output, kept as the first `head` bytes and the last `tail` bytes with absolute byte
 * cursors. the middle of a long run is dropped on purpose (cmx held 64 × 1 MiB per pty and helped the
 * daemon to a gigabyte); a reader that asks for dropped bytes is told how many it missed.
 */

export interface Slice {
	bytes: Uint8Array;
	/** absolute offset of the first byte in `bytes` */
	start: number;
	/** bytes between the requested cursor and `start` that are no longer retained */
	dropped: number;
}

export class OutputBuffer {
	/** every byte ever written; the cursor after the latest byte */
	total = 0;
	private head: Uint8Array;
	private headLen = 0;
	/** tail chunks, oldest first; the first chunk starts `skip` bytes in */
	private chunks: Uint8Array[] = [];
	private skip = 0;
	private tailLen = 0;

	constructor(
		private readonly headMax: number,
		private readonly tailMax: number,
	) {
		this.head = new Uint8Array(0);
	}

	write(bytes: Uint8Array) {
		if (bytes.length === 0) return;
		let rest = bytes;
		if (this.headLen < this.headMax) {
			const n = Math.min(this.headMax - this.headLen, rest.length);
			if (this.head.length < this.headLen + n) {
				const grown = new Uint8Array(Math.min(this.headMax, Math.max(this.headLen + n, this.head.length * 2, 4096)));
				grown.set(this.head.subarray(0, this.headLen));
				this.head = grown;
			}
			this.head.set(rest.subarray(0, n), this.headLen);
			this.headLen += n;
			rest = rest.subarray(n);
		}
		this.total += bytes.length;
		if (rest.length === 0) return;
		// copied: callers reuse their buffers
		this.chunks.push(rest.slice());
		this.tailLen += rest.length;
		while (this.tailLen > this.tailMax) {
			const first = this.chunks[0]!;
			const avail = first.length - this.skip;
			const over = this.tailLen - this.tailMax;
			if (avail <= over) {
				this.chunks.shift();
				this.skip = 0;
				this.tailLen -= avail;
			} else {
				this.skip += over;
				this.tailLen -= over;
			}
		}
	}

	/** where the retained tail starts; equal to the head's end when nothing was dropped */
	get tailStart(): number {
		return this.total - this.tailLen;
	}

	/**
	 * contiguous bytes from `cursor` (clamped to what is retained), at most `limit`. a read never
	 * spans the gap between head and tail: the next read from the returned end reports the gap.
	 */
	read(cursor: number, limit: number): Slice {
		const want = Math.max(0, Math.min(cursor, this.total));
		if (want < this.headLen) {
			const end = Math.min(this.headLen, want + limit);
			let bytes = this.head.subarray(want, end);
			// no gap between head and tail: keep going into the tail
			if (end === this.headLen && this.tailStart === this.headLen && bytes.length < limit) {
				const more = this.tailBytes(this.headLen, limit - bytes.length);
				if (more.length) bytes = concat([bytes, more]);
			}
			return { bytes, start: want, dropped: 0 };
		}
		const start = Math.max(want, this.tailStart);
		return { bytes: this.tailBytes(start, limit), start, dropped: start - want };
	}

	private tailBytes(from: number, limit: number): Uint8Array {
		const parts: Uint8Array[] = [];
		let pos = this.tailStart;
		let need = limit;
		for (let i = 0; i < this.chunks.length && need > 0; i++) {
			const c = i === 0 ? this.chunks[0]!.subarray(this.skip) : this.chunks[i]!;
			const cEnd = pos + c.length;
			if (cEnd > from) {
				const s = Math.max(0, from - pos);
				const piece = c.subarray(s, Math.min(c.length, s + need));
				parts.push(piece);
				need -= piece.length;
			}
			pos = cEnd;
		}
		return parts.length === 1 ? parts[0]! : concat(parts);
	}

	/** bytes held in memory, for the budget */
	get retained(): number {
		return this.headLen + this.tailLen;
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const n = parts.reduce((a, p) => a + p.length, 0);
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/**
 * how many trailing bytes of `bytes` belong to a utf-8 sequence that is not complete yet, so a
 * reader can stop before it and pick the character up whole on the next read.
 */
export function incompleteTail(bytes: Uint8Array): number {
	const n = bytes.length;
	for (let back = 1; back <= Math.min(3, n); back++) {
		const b = bytes[n - back]!;
		if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead
		const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
		return len > back ? back : 0;
	}
	return 0;
}
