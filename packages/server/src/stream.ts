import { constants, crc32, deflateRawSync } from "node:zlib";

/**
 * the opt-in switches of an event stream (`/global/event`, `/event`): query parameters a client asks for,
 * so a client that asks for none gets today's stream byte for byte. boxbox asks for them; the tui, the cli,
 * the sdk and the eval do not.
 */
export interface StreamSwitches {
	/** merge each part's streamed text into batches this many ms long (`coalesce=100`) */
	coalesce?: number;
	/** send only these event types; heartbeats and stream.reset always pass (`types=a,b,c`) */
	types?: Set<string>;
	/** a resume sends only the latest state-carrying event per key (`compact=1`) */
	compact: boolean;
	/** gzip the stream (`gzip=1` and `Accept-Encoding: gzip`) */
	gzip: boolean;
}

/** the only batch window there is: boxbox's 100 ms. other values are not offered */
export const COALESCE_MS = 100;

/** the frames a type filter never holds back */
export const ALWAYS_SENT = new Set(["server.heartbeat", "stream.reset"]);

const on = (v: string | null) => v === "1" || v === "true";

/** whether a request's accept-encoding takes gzip (a `q=0` refuses it) */
export function acceptsGzip(header: string | null | undefined): boolean {
	if (!header) return false;
	for (const part of header.split(",")) {
		const [name, ...params] = part.trim().toLowerCase().split(";");
		if (name !== "gzip" && name !== "*") continue;
		const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
		return !q || Number(q.slice(2)) > 0;
	}
	return false;
}

/** the switches a stream request asks for; unknown values are ignored, as an old daemon ignores the parameters */
export function switchesOf(url: URL, headers: Headers): StreamSwitches {
	const s: StreamSwitches = { compact: on(url.searchParams.get("compact")), gzip: on(url.searchParams.get("gzip")) && acceptsGzip(headers.get("accept-encoding")) };
	if (url.searchParams.get("coalesce") === String(COALESCE_MS)) s.coalesce = COALESCE_MS;
	const types = url.searchParams.get("types");
	if (types) s.types = new Set(types.split(",").map((t) => t.trim()).filter(Boolean));
	return s;
}

/** whether a stream with these switches takes an event of this type */
export function wants(s: StreamSwitches | undefined, type: string): boolean {
	return !s?.types || s.types.has(type) || ALWAYS_SENT.has(type);
}

// ---------- the sink: plain, or gzip ----------

/** where a stream's bytes go: a socket (its backlog is real) or an in-process stream (tests, backlog 0) */
export interface RawSink {
	write(bytes: string | Uint8Array): void;
	/** bytes written that the peer has not taken yet */
	backlog(): number;
	/** what the socket's kernel still holds for the peer, read without the loop, where it can be */
	unsent?(): number | undefined;
	end(): void;
	destroy(): void;
}

/** a stream's frames on their way to a raw sink; backlog and taken count the bytes on the wire */
export interface Sink {
	write(text: string): void;
	/** bytes the peer has not taken yet, as the wire counts them */
	backlog(): number;
	/** bytes the peer has taken so far, as the wire counts them; only differences between two looks mean anything */
	taken(): number;
	unsent?(): number | undefined;
	end(): void;
	destroy(): void;
}

/** frames as they are: the bytes written are the frames' */
export function plainSink(raw: RawSink): Sink {
	let written = 0;
	return {
		write(text) {
			raw.write(text);
			written += Buffer.byteLength(text);
		},
		backlog: () => raw.backlog(),
		taken: () => written - raw.backlog(),
		unsent: raw.unsent ? () => raw.unsent?.() : undefined,
		end: () => raw.end(),
		destroy: () => raw.destroy(),
	};
}

/** deflate's window: a batch may point back this far into what came before it */
const WINDOW_BYTES = 32 * 1024;
/** frames held for one batch before it is compressed at once instead of at the end of the loop's turn */
const BATCH_BYTES = 64 * 1024;
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);

/**
 * one gzip stream per subscriber, flushed after every batch: the frames written in one turn of the event loop
 * (or 64 KB of them) are compressed together and sync-flushed, so a decoder gets every frame whole as soon as
 * its batch lands and nothing waits for more. each batch is deflated on its own with the last 32 KB of the
 * stream as its dictionary, which is exactly the decoder's window at that point, so the batches join into
 * one continuous deflate stream (pigz does the same). it runs synchronously, so the backlog is always the
 * compressed bytes on the socket plus at most one batch still to compress, and the stall cap counts what
 * the wire carries. the state kept between batches is the 32 KB window and a running crc. the end writes
 * deflate's last block and the gzip trailer, so a strict decoder sees a whole stream.
 */
export function gzipSink(raw: RawSink, level = 6): Sink {
	let pending: string[] = [];
	let pendingBytes = 0;
	let emitted = 0;
	let window: Buffer | undefined;
	let crc = 0;
	let size = 0;
	let started = false;
	let scheduled = false;
	let done = false;
	const flush = () => {
		if (!pendingBytes || done) return;
		const plain = Buffer.from(pending.length === 1 ? pending[0]! : pending.join(""));
		pending = [];
		pendingBytes = 0;
		const body = deflateRawSync(plain, { level, finishFlush: constants.Z_SYNC_FLUSH, ...(window ? { dictionary: window } : {}) });
		const out = started ? body : Buffer.concat([GZIP_HEADER, body]);
		started = true;
		crc = crc32(plain, crc);
		size = (size + plain.length) >>> 0;
		const joined = window ? Buffer.concat([window, plain]) : plain;
		window = Buffer.from(joined.subarray(Math.max(0, joined.length - WINDOW_BYTES)));
		raw.write(out);
		emitted += out.length;
	};
	return {
		write(text) {
			if (done) return;
			pending.push(text);
			pendingBytes += Buffer.byteLength(text);
			if (pendingBytes >= BATCH_BYTES) return flush();
			if (scheduled) return;
			scheduled = true;
			setImmediate(() => {
				scheduled = false;
				flush();
			});
		},
		backlog: () => raw.backlog() + pendingBytes,
		taken: () => emitted - raw.backlog(),
		unsent: raw.unsent ? () => raw.unsent?.() : undefined,
		end() {
			if (done) return;
			flush();
			// a stream closed before its first frame is still a whole gzip body: the header, then the end
			if (!started) raw.write(GZIP_HEADER);
			started = true;
			// a final fixed-huffman block with nothing in it, then crc32 and size, little-endian
			const trailer = Buffer.alloc(10);
			trailer[0] = 3;
			trailer.writeUInt32LE(crc >>> 0, 2);
			trailer.writeUInt32LE(size, 6);
			raw.write(trailer);
			done = true;
			raw.end();
		},
		destroy() {
			done = true;
			pending = [];
			pendingBytes = 0;
			raw.destroy();
		},
	};
}

// ---------- compact replay ----------

/** a state-carrying event: its key, and the fields of the state object a client keeps for that key */
export type StateOf = { key: string; fields: string[] };

/**
 * the state a state-carrying event carries, or nothing for any other event. events with the same key carry the same
 * state again, so a compact replay can skip the ones between the first and the last. a session's status is keyed by its
 * type too (busy, idle, retry), so a status is never skipped for a later one of another type: busy then idle both
 * stay, as a client alerts on the change. the fields let a skip be checked against clients that merge an update into
 * what they hold (the tui merges message info) rather than replace it
 */
export function stateOf(type: string, properties: string): StateOf | undefined {
	switch (type) {
		case "session.updated":
		case "session.status":
		case "message.updated":
		case "message.part.updated":
		case "project.updated":
			break;
		default:
			return undefined;
	}
	let p: Record<string, any>;
	try {
		p = JSON.parse(properties);
	} catch {
		return undefined;
	}
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const of = (key: string | undefined, o: unknown): StateOf | undefined => (key && o && typeof o === "object" && !Array.isArray(o) ? { key, fields: Object.keys(o) } : undefined);
	switch (type) {
		case "session.updated": {
			const id = str(p.info?.id) ?? str(p.sessionID);
			return of(id && `session.updated\0${id}`, p.info);
		}
		case "session.status": {
			const id = str(p.sessionID);
			const kind = str(p.status?.type);
			return of(id && kind && `session.status\0${id}\0${kind}`, p.status);
		}
		case "message.updated": {
			const id = str(p.info?.id);
			return of(id && `message\0${str(p.sessionID) ?? ""}\0${id}`, p.info);
		}
		case "message.part.updated": {
			const id = str(p.part?.id);
			return of(id && `part\0${str(p.sessionID) ?? ""}\0${str(p.part?.messageID) ?? ""}\0${id}`, p.part);
		}
		default: {
			const id = str(p.id);
			return of(id && `project\0${id}`, p);
		}
	}
}

/** the key of a state-carrying event, or nothing */
export function stateKey(type: string, properties: string): string | undefined {
	return stateOf(type, properties)?.key;
}

/**
 * which events a compact replay skips, from one pass over the rows it will replay (each row parsed once, here). for each
 * key the first and the last event stay: the first keeps a message's message.updated ahead of its parts and every key
 * where it first showed up in the full replay; the last carries the final state. an event between them is skipped when
 * the last has every field it had (a client that merges would otherwise keep a field from it). rows published after
 * the pass are never skipped, and skip nothing
 */
export class Supersession {
	/** per key, after its first event (always kept, so not remembered): the latest, and the ones between */
	private keys = new Map<string, { last?: { seq: number; fields: string[] }; between: { seq: number; fields: string[] }[] }>();
	private skipped?: Set<number>;
	/** rows are noted in seq order, before any `skip` */
	note(seq: number, type: string, properties: string) {
		const s = stateOf(type, properties);
		if (!s) return;
		const k = this.keys.get(s.key);
		if (!k) return void this.keys.set(s.key, { between: [] });
		if (k.last) k.between.push(k.last);
		k.last = { seq, fields: s.fields };
	}
	/** whether the replay skips this row; the first call settles the set and drops what the pass kept */
	skip(seq: number): boolean {
		if (!this.skipped) {
			this.skipped = new Set();
			for (const k of this.keys.values()) {
				if (!k.last) continue;
				const last = new Set(k.last.fields);
				for (const b of k.between) if (b.fields.every((f) => last.has(f))) this.skipped.add(b.seq);
			}
			this.keys.clear();
		}
		return this.skipped.has(seq);
	}
}
