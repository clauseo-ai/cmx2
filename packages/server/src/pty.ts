import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { incompleteTail, type ProcInfo, type Procs } from "@cmx2/procs";

/**
 * terminals over the wire, in cmx's shape: pty info objects, and the `/pty/:id/connect` websocket
 * that replays output from a cursor and then streams it live. output goes out as text frames, and
 * after the replay one binary frame (byte 0, then json `{cursor}`) says where the stream stands.
 * input arrives as text frames and is written to the terminal as typed; resizing is a PUT.
 *
 * cursors on this wire count utf-16 code units (what a browser's `.length` counts), as cmx's did;
 * the process registry counts bytes. a ledger per terminal maps one onto the other at chunk
 * boundaries, so a client that resumes lands exactly where it left off even after emoji and box
 * drawing characters.
 */

export function ptyJson(p: ProcInfo) {
	return {
		id: p.id,
		title: p.title,
		command: p.command,
		args: [] as string[],
		cwd: p.cwd,
		status: p.status,
		pid: p.pid,
		origin: p.origin === "user" ? ("tui" as const) : ("model" as const),
	};
}

/** `/pty/shells`: the login shells this host lists, the user's own first */
export function shells() {
	const listed = existsSync("/etc/shells")
		? readFileSync("/etc/shells", "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.startsWith("/"))
		: [];
	const mine = process.env.SHELL;
	const all = [...new Set([...(mine ? [mine] : []), ...listed])];
	return all.map((path) => ({ path, name: basename(path), acceptable: existsSync(path) }));
}

/** checkpoints kept per terminal; older ones fall behind the retained tail anyway */
const MAX_CHECKPOINTS = 4096;

class Ledger {
	chars = 0;
	bytes = 0;
	/** [chars, bytes] at chunk boundaries that end on a whole character, oldest first */
	points: Array<[number, number]> = [[0, 0]];
	private decoder = new TextDecoder("utf-8");

	add(chunk: Uint8Array) {
		this.chars += this.decoder.decode(chunk, { stream: true }).length;
		this.bytes += chunk.length;
		const pending = incompleteTail(chunk);
		if (pending === 0) {
			this.points.push([this.chars, this.bytes]);
			if (this.points.length > MAX_CHECKPOINTS) this.points.splice(1, this.points.length - MAX_CHECKPOINTS);
		}
	}

	/** the byte to replay from for a char cursor, and how many chars of that replay to drop */
	locate(chars: number): { byte: number; skip: number } {
		let best: [number, number] = [0, 0];
		for (let i = this.points.length - 1; i >= 0; i--) {
			const p = this.points[i]!;
			if (p[0] <= chars) {
				best = p;
				break;
			}
		}
		return { byte: best[1], skip: chars - best[0] };
	}
}

export interface TermSocketData {
	ptyID: string;
	cursor: number | undefined;
	detach?: () => void;
	decoder?: TextDecoder;
	/** set when the socket closes as soon as its queued frames are sent */
	closing?: string;
}

/** text frames go out in pieces this size, as cmx sent them */
const FRAME_CHARS = 64 * 1024;

export class Terminals {
	private ledgers = new Map<string, { ledger: Ledger; stop: () => void }>();
	private sockets = new Map<string, Set<Bun.ServerWebSocket<TermSocketData>>>();

	constructor(private readonly procs: Procs) {}

	/** starts counting a terminal's output from its first byte; call when it is created */
	track(id: string) {
		if (this.ledgers.has(id)) return;
		const ledger = new Ledger();
		const stop = this.procs.attach(id, 0, (chunk) => ledger.add(chunk));
		this.ledgers.set(id, { ledger, stop });
	}

	/**
	 * the terminal exited or was deleted: its sockets close. an exited terminal keeps its ledger, so a client
	 * resuming it later still gets cursors in the same count (a14); a deleted one drops it
	 */
	forget(id: string, code = 1000, reason = "the terminal exited", keepLedger = false) {
		if (!keepLedger) {
			this.ledgers.get(id)?.stop();
			this.ledgers.delete(id);
		}
		for (const ws of this.sockets.get(id) ?? []) {
			try {
				ws.close(code, reason);
			} catch {}
		}
		this.sockets.delete(id);
	}

	/** `?cursor=`: a safe integer of at least -1; anything else replays everything retained */
	static cursorOf(raw: string | null): number | undefined {
		if (raw === null || raw === "") return undefined;
		const n = Number(raw);
		return Number.isSafeInteger(n) && n >= -1 ? n : undefined;
	}

	open(ws: Bun.ServerWebSocket<TermSocketData>) {
		const id = ws.data.ptyID;
		if (!this.procs.get(id)) {
			ws.close(1011, "no such terminal");
			return;
		}
		this.track(id);
		const { ledger } = this.ledgers.get(id)!;
		const set = this.sockets.get(id) ?? new Set();
		set.add(ws);
		this.sockets.set(id, set);

		const cursor = ws.data.cursor;
		let from: { byte: number; skip: number };
		if (cursor === -1) from = { byte: ledger.bytes, skip: 0 };
		else if (cursor === undefined) from = { byte: 0, skip: 0 };
		else from = ledger.locate(Math.min(cursor, ledger.chars));

		let decoder = new TextDecoder("utf-8");
		ws.data.decoder = decoder;
		let skip = from.skip;
		let replaying = true;
		let replay = "";
		/** the byte the next chunk should start at; a chunk that starts later came after bytes the registry dropped */
		let expected = from.byte;
		const send = (text: string) => {
			for (let i = 0; i < text.length; i += FRAME_CHARS) ws.send(text.slice(i, i + FRAME_CHARS));
		};
		ws.data.detach = this.procs.attach(id, from.byte, (bytes, end) => {
			let chunk = bytes;
			const start = end - chunk.length;
			if (start > expected) {
				// a14: the cursor fell in output that is no longer kept, so the skip (counted from a checkpoint before
				// the gap) means nothing now: the replay is everything retained from here, whole, from the next character
				skip = 0;
				decoder = new TextDecoder("utf-8");
				ws.data.decoder = decoder;
				let lead = 0;
				while (lead < chunk.length && (chunk[lead]! & 0xc0) === 0x80) lead++;
				chunk = chunk.subarray(lead);
			}
			expected = end;
			let text = decoder.decode(chunk, { stream: true });
			if (skip > 0) {
				const cut = Math.min(skip, text.length);
				text = text.slice(cut);
				skip -= cut;
			}
			if (!text) return;
			if (replaying) replay += text;
			else send(text);
		});
		// attach replays synchronously, so everything up to here is the replay and the rest is live
		replaying = false;
		if (replay) send(replay);
		const meta = new TextEncoder().encode(JSON.stringify({ cursor: ledger.chars }));
		const frame = new Uint8Array(meta.length + 1);
		frame.set(meta, 1);
		ws.send(frame);
		const info = this.procs.get(id);
		if (info?.status === "exited") this.closeWhenSent(ws, "the terminal exited");
	}

	/** closes once every queued frame has gone out: a close with frames still queued would drop the end of the replay (a14) */
	private closeWhenSent(ws: Bun.ServerWebSocket<TermSocketData>, reason: string) {
		if (ws.getBufferedAmount() > 0) ws.data.closing = reason;
		else ws.close(1000, reason);
	}

	/** the socket took what was queued */
	drain(ws: Bun.ServerWebSocket<TermSocketData>) {
		if (ws.data.closing !== undefined && ws.getBufferedAmount() === 0) ws.close(1000, ws.data.closing);
	}

	message(ws: Bun.ServerWebSocket<TermSocketData>, msg: string | Buffer) {
		const text = typeof msg === "string" ? msg : new TextDecoder("utf-8", { fatal: false }).decode(msg);
		if (!text) return;
		try {
			this.procs.write(ws.data.ptyID, text);
		} catch {
			ws.close(1011, "the terminal is gone");
		}
	}

	close(ws: Bun.ServerWebSocket<TermSocketData>) {
		ws.data.detach?.();
		this.sockets.get(ws.data.ptyID)?.delete(ws);
	}

	/** live sockets, for the memory endpoint */
	get connected(): number {
		let n = 0;
		for (const s of this.sockets.values()) n += s.size;
		return n;
	}
}
