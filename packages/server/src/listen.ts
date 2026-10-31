import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import type { Server, WebSocketHandler } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { acceptsGzip } from "./stream.ts";

const gzipAsync = promisify(gzip);

/**
 * the daemon's listener. `Bun.serve` drains a streaming response into native buffers whatever the
 * socket does, so one stalled event-stream subscriber can grow the daemon without bound (GOTCHAS: sync
 * and the listener). `node:http` reports the real backlog (`writableLength`) but cannot carry bun's
 * websockets. so the public port is a small tcp front: it reads the first request's headers and pipes
 * the connection raw to one of two loopback servers. websocket upgrades (the terminal) go to
 * `Bun.serve`; everything else goes to `node:http`, where event streams are written straight to the
 * response and every other request runs through the daemon's fetch handler. `pipe()` carries
 * backpressure across the hop, so a byte cap on the node response bounds what a slow peer can cost.
 *
 * except for event streams: the hop's four kernel buffers autotune (macos: up to 4 MB each,
 * `net.inet.tcp.autosndbufmax`/`autorcvbufmax`), and a burst to a peer that read nothing parked 5.6 MB
 * in them before node's `writableLength` moved, so the cap tripped late and the hold read the buffers
 * filling as the peer reading. a connection whose first request is an event stream is answered by the
 * front itself, on the public socket, whose `writableLength` is the daemon's whole share of the backlog;
 * its kernel send buffer is pinned, so what is parked past it is bounded by the peer's own receive buffer.
 * an event stream asked for later on a kept-alive connection still crosses the hop, whose buffers are
 * pinned as far as the front can reach (its own socket; node's side has no fd).
 */

const CRLF = Buffer.from("\r\n", "latin1");
/** a json answer over this many bytes is gzipped for a client whose accept-encoding takes gzip */
export const GZIP_MIN_BYTES = 1024;
/** rest answers trade a little ratio for less cpu than the default 6 (a transcript can be tens of MB) */
const GZIP_LEVEL = 4;

/** the loopback hop's buffers on the front's socket (loopback needs no window) */
const HOP_BUFFER_BYTES = 64 * 1024;
/** an event stream's kernel send buffer: a few round trips of frames on a slow link, not 4 MB of backlog */
const STREAM_SEND_BUFFER_BYTES = 256 * 1024;
/** the most of a frame handed to the public socket in one write */
const WRITE_SLICE_BYTES = 64 * 1024;

const sockopt = (() => {
	const darwin = process.platform === "darwin";
	if (!darwin && process.platform !== "linux") return undefined;
	try {
		const lib = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
			setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
		});
		// SOL_SOCKET, SO_SNDBUF, SO_RCVBUF; setting one turns its autotuning off
		const [level, snd, rcv] = darwin ? [0xffff, 0x1001, 0x1002] : [1, 7, 8];
		return { lib, level, snd, rcv, darwin };
	} catch {
		return undefined;
	}
})();

const unsentOut = new Int32Array(1);
const unsentLen = new Uint32Array([4]);
/**
 * the bytes a socket's kernel still holds for its peer (macos `SO_NWRITE`, linux `SIOCOUTQ`), read without the
 * event loop: while a burst holds the loop, a peer that reads drains it and one that does not leaves it full
 */
function kernelUnsent(sock: Socket): number | undefined {
	const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd;
	if (!sockopt || typeof fd !== "number" || fd < 0) return undefined;
	unsentLen[0] = 4;
	const rc = sockopt.darwin ? sockopt.lib.symbols.getsockopt(fd, 0xffff, 0x1024, ptr(unsentOut), ptr(unsentLen)) : sockopt.lib.symbols.ioctl(fd, 0x5411, ptr(unsentOut));
	return rc === 0 ? unsentOut[0] : undefined;
}

/** pins a socket's kernel send or receive buffer; does nothing where bun does not expose the fd */
function pinBuffer(sock: Socket, which: "snd" | "rcv", bytes: number) {
	const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd;
	if (!sockopt || typeof fd !== "number" || fd < 0) return;
	sockopt.lib.symbols.setsockopt(fd, sockopt.level, sockopt[which], ptr(new Int32Array([bytes])), 4);
}

/**
 * what the daemon writes an event stream to: a node response behind the hop, or the public socket itself.
 * `writableLength` is the backlog the daemon can see; `socket` is the hop's, for `cut`
 */
export interface StreamResponse {
	writeHead(status: number, headers: Record<string, string>): unknown;
	write(chunk: string | Uint8Array): unknown;
	readonly writableLength: number;
	on(event: "close", fn: () => void): unknown;
	end(): unknown;
	destroy(): unknown;
	readonly socket?: { remotePort?: number } | null;
	/** what the socket's kernel still holds for the peer, where it can be read */
	kernelUnsent?(): number | undefined;
}

/**
 * an event stream written straight to the public socket, in http/1.1 chunked framing, through a queue of its
 * own. bun's socket counts everything written while a write is pending as one batch that leaves
 * `writableLength` only when the last byte of it is out (4.4 MB stood still for 130 ms while a reader took
 * half a MB every 20 ms), so the stall clock would read a slow reader as silent. here one slice at a time is
 * handed to the socket and the rest waits in the queue, so the backlog falls as the peer takes it.
 */
class SocketResponse implements StreamResponse {
	readonly socket = undefined;
	private queue: Buffer[] = [];
	private queued = 0;
	private inFlight = 0;
	private ending = false;
	constructor(private readonly sock: Socket) {}
	get writableLength() {
		return this.queued + this.inFlight;
	}
	kernelUnsent() {
		return kernelUnsent(this.sock);
	}
	writeHead(status: number, headers: Record<string, string>) {
		const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, `date: ${new Date().toUTCString()}`];
		for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
		lines.push("transfer-encoding: chunked", "", "");
		this.push(Buffer.from(lines.join("\r\n"), "latin1"));
	}
	write(chunk: string | Uint8Array) {
		// an empty chunk is the end of a chunked body
		if (!chunk.length) return;
		if (typeof chunk === "string") return this.push(Buffer.from(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`));
		this.push(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`, "latin1"), chunk, CRLF]));
	}
	on(event: "close", fn: () => void) {
		this.sock.on(event, fn);
	}
	end() {
		if (this.ending) return;
		this.push(Buffer.from("0\r\n\r\n"));
		this.ending = true;
	}
	destroy() {
		this.queue = [];
		this.queued = 0;
		this.sock.destroy();
	}
	private push(bytes: Buffer) {
		if (this.ending || this.sock.destroyed) return;
		for (let at = 0; at < bytes.length; at += WRITE_SLICE_BYTES) this.queue.push(bytes.subarray(at, at + WRITE_SLICE_BYTES));
		this.queued += bytes.length;
		this.pump();
	}
	/** hands the socket the next slice once the last is out, small frames merged up to a slice */
	private pump() {
		if (this.inFlight || this.sock.destroyed) return;
		if (!this.queue.length) {
			if (this.ending) this.sock.end();
			return;
		}
		const take = [this.queue.shift()!];
		let size = take[0]!.length;
		while (this.queue.length && size + this.queue[0]!.length <= WRITE_SLICE_BYTES) {
			const next = this.queue.shift()!;
			take.push(next);
			size += next.length;
		}
		this.queued -= size;
		this.inFlight = size;
		this.sock.write(take.length === 1 ? take[0]! : Buffer.concat(take, size), () => {
			this.inFlight = 0;
			this.pump();
		});
	}
}

/**
 * the answers that pass back through the front on one hop connection, counted by their http/1.1 framing, so the front
 * knows when everything it forwarded has been answered to the last byte (a22): node's `finish` comes before the
 * bytes cross the hop. an answer framed any other way (no length and not chunked, so it runs to the close) leaves the
 * count unknown, and the connection's later streams stay on the hop.
 */
class Answers {
	/** the methods of the requests forwarded and not yet answered, oldest first: an answer to HEAD has no body */
	private methods: string[] = [];
	private buf: Buffer = Buffer.alloc(0);
	private state: "head" | "body" | "size" | "data" | "crlf" | "trailer" | "unknown" = "head";
	private left = 0;
	private waiter: (() => void) | undefined;
	asked(method: string) {
		this.methods.push(method);
	}
	/** every request forwarded has been answered, to the answer's last byte */
	get settled(): boolean {
		return this.state === "head" && this.methods.length === 0 && this.buf.length === 0;
	}
	/** the answers can no longer be counted */
	get unknown(): boolean {
		return this.state === "unknown";
	}
	/** calls `fn` once, after the chunk that settles the count (or makes it unknown) has been handled everywhere */
	whenSettled(fn: () => void) {
		this.waiter = fn;
	}
	take(chunk: Buffer) {
		this.count(chunk);
		const fn = this.waiter;
		if (fn && (this.settled || this.unknown)) {
			this.waiter = undefined;
			setImmediate(fn);
		}
	}
	private count(chunk: Buffer) {
		if (this.state === "unknown") return;
		let b = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		this.buf = Buffer.alloc(0);
		const wait = (limit: number) => {
			if (b.length > limit) this.state = "unknown";
			else this.buf = b;
		};
		while (b.length) {
			if (this.state === "head") {
				const at = b.indexOf("\r\n\r\n");
				if (at < 0) return wait(MAX_HEAD_BYTES);
				const head = b.subarray(0, at).toString("latin1");
				b = b.subarray(at + 4);
				const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
				// an interim answer (100 continue) comes before the final one and has no body
				if (code >= 100 && code < 200) continue;
				const method = this.methods.shift();
				if (!code || method === undefined) {
					this.state = "unknown";
					return;
				}
				if (method === "HEAD" || code === 204 || code === 304) continue;
				if (/^transfer-encoding:.*\bchunked\b/im.test(head)) {
					this.state = "size";
					continue;
				}
				const length = /^content-length:\s*(\d+)\s*$/im.exec(head);
				if (!length) {
					this.state = "unknown";
					return;
				}
				this.left = Number(length[1]);
				if (this.left > 0) this.state = "body";
			} else if (this.state === "body" || this.state === "data") {
				const n = Math.min(this.left, b.length);
				this.left -= n;
				b = b.subarray(n);
				if (this.left === 0) this.state = this.state === "body" ? "head" : "crlf";
			} else if (this.state === "crlf") {
				if (b.length < 2) return wait(2);
				b = b.subarray(2);
				this.state = "size";
			} else {
				// a chunk-size line, or a trailer line after the last chunk: the empty one ends the answer
				const eol = b.indexOf("\r\n");
				if (eol < 0) return wait(this.state === "size" ? 1024 : MAX_HEAD_BYTES);
				const line = b.subarray(0, eol).toString("latin1");
				b = b.subarray(eol + 2);
				if (this.state === "trailer") {
					if (!line) this.state = "head";
					continue;
				}
				const size = Number.parseInt(line, 16);
				if (Number.isNaN(size)) {
					this.state = "unknown";
					return;
				}
				if (size === 0) this.state = "trailer";
				else {
					this.left = size;
					this.state = "data";
				}
			}
		}
	}
}

/** an http/1.1 request head as a fetch request (the answer is chunked), or nothing when it does not parse */
function requestOfHead(head: string): Request | undefined {
	const [line, ...rest] = head.split("\r\n");
	const m = line?.match(/^([A-Z]+) (\S+) HTTP\/1\.1$/);
	if (!m || !m[2]!.startsWith("/")) return undefined;
	try {
		const headers = new Headers();
		for (const l of rest) {
			const at = l.indexOf(":");
			if (at <= 0) return undefined;
			headers.append(l.slice(0, at).trim(), l.slice(at + 1).trim());
		}
		return new Request(`http://${headers.get("host") ?? "127.0.0.1"}${m[2]}`, { method: m[1], headers });
	} catch {
		return undefined;
	}
}

/** a request head for an event stream, which the front answers itself */
const STREAM_HEAD = /^GET \/(global\/)?event[?\s]/;

/** how much of a connection's first request the front reads before it must decide where it goes */
const MAX_HEAD_BYTES = 64 * 1024;

export interface ListenOptions<W> {
	port: number;
	hostname: string;
	/** every request that is not an event stream or a websocket upgrade */
	fetch: (req: Request) => Promise<Response>;
	/**
	 * looks at a request's head (no body) before anything is read: a response to send at once (a refusal),
	 * or how many body bytes the request may carry. without it every body is read whole.
	 */
	/** streamBody: the handler reads the body as a stream (a big upload written to disk), not buffered; past maxBody the stream errors with BodyTooLarge */
	precheck?: (head: Request) => { response: Response } | { maxBody: number; streamBody?: boolean };
	/** takes an event stream and writes it to the response it is given (the public socket's, or node's behind the hop); false leaves the request to fetch */
	stream: (req: Request, res: StreamResponse) => boolean;
	/** bun's side: websocket upgrades, answered with undefined once upgraded */
	upgrade: (req: Request, server: Server<W>) => Response | undefined | Promise<Response>;
	websocket: WebSocketHandler<W>;
}

export interface Listener {
	hostname: string;
	port: number;
	/**
	 * drops the public connection behind a loopback one at once, by the loopback socket's port as the
	 * node side sees it (the peer's port). a graceful close would first deliver everything parked in the
	 * hop's socket buffers; a stream cut for falling behind should not grow by that much on its way out.
	 */
	cut(peerPort: number | undefined): void;
	stop(): Promise<void>;
}

export class BodyTooLarge extends Error {}

function headersOf(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (Array.isArray(v)) for (const x of v) headers.append(k, x);
		else if (v !== undefined) headers.set(k, v);
	}
	return headers;
}

const urlOf = (req: IncomingMessage) => `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;

/** a node request as a fetch request; its signal aborts when the peer goes away before the answer is done */
async function toRequest(req: IncomingMessage, res: ServerResponse, maxBody = Number.POSITIVE_INFINITY, streamBody = false): Promise<Request> {
	const headers = headersOf(req);
	const ctl = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ctl.abort();
	});
	if (streamBody && req.method !== "GET" && req.method !== "HEAD") {
		if (Number(req.headers["content-length"] ?? 0) > maxBody) throw new BodyTooLarge();
		const chunks = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
		let size = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(c) {
				const { done, value } = await chunks.next();
				if (done) return c.close();
				size += value.length;
				if (size > maxBody) return c.error(new BodyTooLarge());
				c.enqueue(value);
			},
			cancel() {
				req.resume();
			},
		});
		return new Request(urlOf(req), { method: req.method, headers, body, signal: ctl.signal, duplex: "half" } as RequestInit);
	}
	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		if (Number(req.headers["content-length"] ?? 0) > maxBody) throw new BodyTooLarge();
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of req as AsyncIterable<Buffer>) {
			size += c.length;
			if (size > maxBody) throw new BodyTooLarge();
			chunks.push(c);
		}
		body = Buffer.concat(chunks);
	}
	return new Request(urlOf(req), { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: ctl.signal });
}

/** a refusal written before the body was read: the connection closes after it, so the unread body goes nowhere */
async function refuseEarly(r: Response, res: ServerResponse) {
	const body = Buffer.from(await r.arrayBuffer());
	const headers: Record<string, string> = { connection: "close", "content-length": String(body.length) };
	r.headers.forEach((v, k) => {
		headers[k] = v;
	});
	res.writeHead(r.status, headers);
	res.end(body);
	res.once("finish", () => res.socket?.destroySoon?.());
}

/**
 * a json answer gzipped when the client takes gzip and the body is over GZIP_MIN_BYTES (standard content negotiation;
 * the decoded bytes are the same). the body is read whole to know its size, compressed off the main thread, and sent
 * with its compressed content-length, which the front's answer counting (Answers) needs. anything else is left as it is
 */
async function negotiated(req: IncomingMessage, r: Response): Promise<Response | { headers: Record<string, string>; body: Buffer; status: number }> {
	if (!r.body || r.headers.has("content-encoding") || !/^application\/json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return r;
	if (!acceptsGzip(req.headers["accept-encoding"] as string | undefined) || req.method === "HEAD") return r;
	const plain = Buffer.from(await r.arrayBuffer());
	const headers: Record<string, string> = {};
	r.headers.forEach((v, k) => {
		headers[k] = v;
	});
	if (plain.length <= GZIP_MIN_BYTES) return new Response(plain, { status: r.status, headers: r.headers });
	const body = await gzipAsync(plain, { level: GZIP_LEVEL });
	headers["content-encoding"] = "gzip";
	headers["content-length"] = String(body.length);
	headers.vary = headers.vary ? `${headers.vary}, accept-encoding` : "accept-encoding";
	return { headers, body, status: r.status };
}

/** a fetch response onto a node response, waiting for the peer whenever the socket is full */
async function writeResponse(answer: Response, res: ServerResponse, req?: IncomingMessage) {
	let r = answer;
	if (req) {
		const n = await negotiated(req, r);
		if (!(n instanceof Response)) {
			res.writeHead(n.status, n.headers);
			res.end(n.body);
			return;
		}
		r = n;
	}
	const headers: Record<string, string> = {};
	r.headers.forEach((v, k) => {
		headers[k] = v;
	});
	res.writeHead(r.status, headers);
	if (!r.body) {
		res.end();
		return;
	}
	const reader = r.body.getReader();
	res.on("close", () => void reader.cancel().catch(() => {}));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (res.destroyed) return;
			if (!res.write(value)) await new Promise<void>((ok) => (res.once("drain", ok), res.once("close", ok)));
		}
		res.end();
	} catch {
		res.destroy();
	}
}

export function listen<W>(opts: ListenOptions<W>): Listener {
	const ws = Bun.serve<W>({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		fetch: (req, server) => opts.upgrade(req, server),
		websocket: opts.websocket,
	});

	const http = createHttpServer((req, res) => {
		void (async () => {
			try {
				const verdict = opts.precheck?.(new Request(urlOf(req), { method: req.method, headers: headersOf(req) }));
				if (verdict && "response" in verdict) return void (await refuseEarly(verdict.response, res));
				const request = await toRequest(req, res, verdict?.maxBody, verdict && "streamBody" in verdict ? verdict.streamBody : false);
				if (opts.stream(request, res)) return;
				await writeResponse(await opts.fetch(request), res, req);
			} catch (e) {
				if (e instanceof BodyTooLarge) {
					return void (await refuseEarly(Response.json({ name: "PayloadTooLargeError", data: { message: "that request body is bigger than the daemon takes" } }, { status: 413 }), res));
				}
				console.error(`cmx2: request ${req.method} ${req.url} failed in the listener: ${e instanceof Error ? e.message : String(e)}`);
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ name: "UnknownError", data: { message: "the daemon could not answer this request" } }));
			}
		})();
	});
	// long turns answer late and event streams never end: no request or idle timeout here
	http.timeout = 0;
	http.requestTimeout = 0;
	http.keepAliveTimeout = 5_000;
	http.listen({ port: 0, host: "127.0.0.1", backlog: 4096 });
	const httpPort = (http.address() as { port: number }).port;

	const open = new Set<Socket>();
	/** the public socket behind each loopback connection, by the loopback socket's local port */
	const pairs = new Map<number, Socket>();
	const front = createNetServer((sock) => {
		sock.setNoDelay(true);
		open.add(sock);
		const head: Buffer[] = [];
		let size = 0;
		let up: Socket | undefined;
		// an error tears both sides down; a clean close ends the other side, so bytes still buffered for the peer are delivered
		const kill = () => {
			sock.destroy();
			up?.destroy();
		};
		sock.on("error", kill);
		sock.on("close", () => {
			open.delete(sock);
			up?.end();
		});
		const onData = (chunk: Buffer) => {
			head.push(chunk);
			size += chunk.length;
			const text = Buffer.concat(head).toString("latin1");
			if (!text.includes("\r\n\r\n") && size < MAX_HEAD_BYTES) return;
			sock.off("data", onData);
			sock.pause();
			const end = text.indexOf("\r\n\r\n");
			const websocket = /^upgrade:\s*websocket\s*$/im.test(end >= 0 ? text.slice(0, end) : text);
			// an event stream as the whole of what was sent: the front answers it on this socket, no hop (a22).
			// one the daemon declines (refused, unauthorized) goes over the hop for its answer like any request
			if (!websocket && end >= 0 && end + 4 === size && STREAM_HEAD.test(text)) {
				const req = requestOfHead(text.slice(0, end));
				if (req) {
					pinBuffer(sock, "snd", STREAM_SEND_BUFFER_BYTES);
					if (opts.stream(req, new SocketResponse(sock))) {
						// read on, discarding, so a peer that goes away is seen
						sock.on("data", () => {});
						sock.resume();
						return;
					}
				}
			}
			const port = websocket ? ws.port! : httpPort;
			// the requests after the first are framed as they pass (a head, then its content-length of body), so an
			// event stream asked for later on a kept-alive connection is answered here too (a22). a body framed any
			// other way (chunked, an upgrade, a head too big) leaves the rest of the connection to the hop unread
			let pending: Buffer = Buffer.alloc(0);
			let bodyLeft = 0;
			let opaque = websocket;
			let handedOver = false;
			/** the hop's answers as they pass back: an event stream is answered here only once all are through */
			const answers = new Answers();
			let draining = false;
			/** a request head is waiting for the hop to finish answering the ones before it */
			let waiting = false;
			const forward = (b: Buffer) => {
				if (!b.length || !up || up.destroyed || up.write(b) || draining) return;
				draining = true;
				sock.pause();
				up.once("drain", () => {
					draining = false;
					if (!waiting) sock.resume();
				});
			};
			const handOver = (text: string): boolean => {
				const req = requestOfHead(text);
				if (!req) return false;
				// every earlier answer has already been written to this socket, so the stream's bytes queue behind them
				if (!opts.stream(req, new SocketResponse(sock))) return false;
				handedOver = true;
				pinBuffer(sock, "snd", STREAM_SEND_BUFFER_BYTES);
				const hop = up;
				if (hop) {
					hop.unpipe(sock);
					hop.resume();
					hop.end();
					setTimeout(() => hop.destroy(), 2_000).unref?.();
				}
				return true;
			};
			const feed = (chunk: Buffer) => {
				if (handedOver) return;
				if (opaque) return forward(chunk);
				pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
				while (pending.length) {
					if (bodyLeft > 0) {
						const n = Math.min(bodyLeft, pending.length);
						forward(pending.subarray(0, n));
						pending = pending.subarray(n);
						bodyLeft -= n;
						continue;
					}
					// the next request goes to the hop only once it has answered every one before it, to the last byte:
					// bun's node:http cut a 400 KB answer short when the next request came in behind it (81 of 200 on
					// macos, main as well), and node's `finish` comes before the bytes cross the hop, so ending the hop to
					// answer a stream here lost a pipelining client's earlier answer (85 of 500). a pipelining client's
					// requests are answered in order either way
					if (!answers.settled && !answers.unknown) {
						if (!waiting) {
							waiting = true;
							sock.pause();
							answers.whenSettled(() => {
								waiting = false;
								if (!draining) sock.resume();
								feed(Buffer.alloc(0));
							});
						}
						return;
					}
					const at = pending.indexOf("\r\n\r\n");
					if (at < 0) {
						if (pending.length > MAX_HEAD_BYTES) {
							opaque = true;
							forward(pending);
							pending = Buffer.alloc(0);
						}
						return;
					}
					const text = pending.subarray(0, at).toString("latin1");
					// every earlier answer has passed back through here, so the stream can be answered on this socket
					if (answers.settled && at + 4 === pending.length && STREAM_HEAD.test(text) && handOver(text)) return;
					if (/^(transfer-encoding|upgrade):/im.test(text)) {
						opaque = true;
						forward(pending);
						pending = Buffer.alloc(0);
						return;
					}
					forward(pending.subarray(0, at + 4));
					answers.asked(text.slice(0, text.indexOf(" ")));
					pending = pending.subarray(at + 4);
					bodyLeft = Number(/^content-length:\s*(\d+)\s*$/im.exec(text)?.[1] ?? 0);
				}
			};
			// a burst of connections can overflow the loopback server's accept queue (128 on macos); the head
			// is still buffered here, so a refused connect is retried and the client never sees it
			const dial = (attempt: number) => {
				const target = connect(port, "127.0.0.1");
				up = target;
				open.add(target);
				let connected = false;
				target.on("error", () => {
					open.delete(target);
					if (handedOver) return;
					if (!connected && attempt < 40 && !sock.destroyed) setTimeout(() => dial(attempt + 1), Math.min(5 * (attempt + 1), 50));
					else kill();
				});
				target.on("connect", () => {
					connected = true;
					target.setNoDelay(true);
					pinBuffer(target, "rcv", HOP_BUFFER_BYTES);
					pinBuffer(target, "snd", HOP_BUFFER_BYTES);
					const local = target.localPort;
					if (local) pairs.set(local, sock);
					target.on("close", () => {
						open.delete(target);
						if (local) pairs.delete(local);
						if (!handedOver) sock.end();
					});
					// counted as they pass, beside the pipe; what waits on the count runs after the pipe has written the chunk
					if (!websocket) target.on("data", (c: Buffer) => answers.take(c));
					target.pipe(sock, { end: false });
					sock.on("data", feed);
					feed(Buffer.concat(head));
					if (!waiting) sock.resume();
				});
			};
			dial(0);
		};
		sock.on("data", onData);
	});
	front.on("error", (e) => console.error(`cmx2: listener: ${e.message}`));
	front.listen({ port: opts.port, host: opts.hostname, backlog: 4096 });
	const addr = front.address() as { port: number } | null;
	if (!addr) {
		ws.stop(true);
		http.close();
		front.close();
		throw Object.assign(new Error(`could not listen on ${opts.hostname}:${opts.port}; the port is taken or not allowed`), { code: "EADDRINUSE" });
	}

	return {
		hostname: opts.hostname,
		port: addr.port,
		cut(peerPort) {
			const sock = peerPort ? pairs.get(peerPort) : undefined;
			if (!sock) return;
			sock.destroy();
		},
		async stop() {
			front.close();
			for (const s of open) s.destroy();
			open.clear();
			http.closeAllConnections?.();
			await new Promise<void>((ok) => http.close(() => ok()));
			ws.stop(true);
		},
	};
}
