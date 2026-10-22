import { randomBytes } from "node:crypto";
import { AsideError, type EngineSession } from "@cmx2/engine/session";
import { type BtwRow, btwInfo, type Store } from "@cmx2/store";

/**
 * btw: side questions about a session. each is answered by the session's own engine (EngineSession.aside, a
 * request that reads the session's prompt cache) and kept in its own table, so it never reaches the transcript,
 * the projection, a fork or a compaction. this module owns their life: asked, streaming, finished, dismissed,
 * promoted; the server wires its routes and events.
 */

/** what a btw left running by a stopped daemon says when the next one starts */
export const BTW_RESTARTED = "the daemon restarted before it answered";
/** and one the daemon was stopping under */
export const BTW_SHUTDOWN = "the daemon stopped before it answered";

export type Btw = ReturnType<typeof btwInfo>;

export interface BtwHost {
	store: Store;
	publish(directory: string, type: "btw.updated", properties: { sessionID: string; btw: Btw }): void;
	/** streamed answer text: unlogged, coalesced like message deltas */
	delta(directory: string, properties: { sessionID: string; btwID: string; delta: string }): void;
	/** the session's directory (its scope on the event stream) */
	directoryOf(sessionID: string): string;
	/** the session's engine, loaded if it is not */
	open(sessionID: string): Promise<EngineSession>;
	/** the session's totals moved */
	totalsChanged(sessionID: string): void;
	/** puts a user message into the session: a steer when a turn runs, a prompt otherwise. returns its id */
	send(sessionID: string, text: string, btwID: string): Promise<string>;
}

type Running = { sessionID: string; directory: string; answer: string; ctl: AbortController; why?: string };

export class BtwError extends Error {
	constructor(
		readonly status: 404 | 409,
		message: string,
	) {
		super(message);
		this.name = status === 404 ? "NotFoundError" : "ConflictError";
	}
}

export function btwId(): string {
	return `btw_${Date.now().toString(16)}${randomBytes(7).toString("hex")}`;
}

/** the user message a promoted btw becomes: the question and the answer, said plainly to be a btw the user asked */
export function promotedText(b: Pick<BtwRow, "text" | "answer">): string {
	return `btw, i asked this on the side while you worked, and it was answered from this conversation.\n\nmy question:\n${b.text}\n\nthe answer:\n${b.answer}`;
}

export class Btws {
	private running = new Map<string, Running>();
	private promoting = new Set<string>();

	constructor(private readonly host: BtwHost) {}

	/** at start: btws a stopped daemon left running become errors, and clients hear it */
	heal(): number {
		const rows = this.host.store.failRunningBtws(BTW_RESTARTED, Date.now());
		for (const r of rows) this.updated(r);
		return rows.length;
	}

	private info(r: BtwRow): Btw {
		return btwInfo(r, this.running.get(r.id)?.answer);
	}

	private updated(r: BtwRow) {
		const directory = this.running.get(r.id)?.directory ?? this.host.directoryOf(r.session_id);
		this.host.publish(directory, "btw.updated", { sessionID: r.session_id, btw: this.info(r) });
	}

	private find(sessionID: string, id: string): BtwRow {
		const r = this.host.store.btw(id);
		if (!r || r.session_id !== sessionID) throw new BtwError(404, `no btw ${id} on session ${sessionID}`);
		return r;
	}

	/** a session's btws, oldest first; a running one carries its answer so far */
	list(sessionID: string): Btw[] {
		return this.host.store.btws(sessionID).map((r) => this.info(r));
	}

	/** running btws as clients see them, for a resumed stream's seam */
	streaming(): Array<{ directory: string; sessionID: string; btw: Btw }> {
		const out: Array<{ directory: string; sessionID: string; btw: Btw }> = [];
		for (const [id, run] of this.running) {
			const r = this.host.store.btw(id);
			if (r) out.push({ directory: run.directory, sessionID: run.sessionID, btw: this.info(r) });
		}
		return out;
	}

	/** asks: the row is written and announced, the answer runs beside whatever the session is doing */
	async ask(sessionID: string, text: string): Promise<Btw> {
		const s = await this.host.open(sessionID);
		const id = btwId();
		const directory = this.host.directoryOf(sessionID);
		this.host.store.putBtw({ id, session_id: sessionID, text, after_message_id: this.host.store.lastMessageId(sessionID) ?? null, created_at: Date.now(), model: s.modelRef });
		const run: Running = { sessionID, directory, answer: "", ctl: new AbortController() };
		this.running.set(id, run);
		const row = this.host.store.btw(id)!;
		this.updated(row);
		void this.answer(s, id, text, run);
		return this.info(row);
	}

	private async answer(s: EngineSession, id: string, text: string, run: Running) {
		let fin: Parameters<Store["finishBtw"]>[1];
		try {
			const r = await s.aside(text, {
				signal: run.ctl.signal,
				onDelta: (delta) => {
					run.answer += delta;
					this.host.delta(run.directory, { sessionID: run.sessionID, btwID: id, delta });
				},
			});
			fin = { status: "done", answer: r.text, completed_at: Date.now(), model: `${r.model.providerID}/${r.model.modelID}`, ...spent(r.usage) };
		} catch (e) {
			const message = run.why ?? (e instanceof Error ? e.message : String(e));
			const usage = e instanceof AsideError ? e.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			fin = { status: "error", answer: e instanceof AsideError ? e.text : run.answer, error: short(message), completed_at: Date.now(), ...spent(usage) };
		}
		this.running.delete(id);
		try {
			if (this.host.store.finishBtw(id, fin)) {
				const r = this.host.store.btw(id);
				if (r) this.host.publish(run.directory, "btw.updated", { sessionID: run.sessionID, btw: btwInfo(r) });
				if (fin.cost || fin.tokens_input || fin.tokens_output || fin.tokens_cache_read || fin.tokens_cache_write) this.host.totalsChanged(run.sessionID);
			}
		} catch (e) {
			console.error(`cmx2: recording btw ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** hides a btw; a running one stops. a second call is a no-op that answers the same btw */
	dismiss(sessionID: string, id: string): Btw {
		this.find(sessionID, id);
		if (this.host.store.dismissBtw(id, Date.now())) {
			const run = this.running.get(id);
			const r = this.host.store.btw(id)!;
			this.updated(r);
			if (run) this.stopRun(run, "dismissed before it answered");
		}
		return this.info(this.host.store.btw(id)!);
	}

	/** puts a done btw into the thread as a user message marked with its id */
	async promote(sessionID: string, id: string): Promise<{ messageID: string }> {
		const r = this.find(sessionID, id);
		if (r.status !== "done") throw new BtwError(409, `btw ${id} is ${r.status}; only an answered btw can be promoted`);
		if (r.promoted_message_id || this.promoting.has(id)) throw new BtwError(409, `btw ${id} was promoted already${r.promoted_message_id ? ` (message ${r.promoted_message_id})` : ""}`);
		this.promoting.add(id);
		try {
			const messageID = await this.host.send(sessionID, promotedText(r), id);
			// a message that landed while it was sent has set its id already (landed)
			if (this.host.store.promoteBtw(id, messageID) || this.host.store.btw(id)?.promoted_message_id) this.updated(this.host.store.btw(id)!);
			return { messageID: this.host.store.btw(id)?.promoted_message_id ?? messageID };
		} finally {
			this.promoting.delete(id);
		}
	}

	/** a promoted btw's message landed in the transcript: a steer's provisional id gives way to the landed one */
	landed(id: string, messageID: string) {
		const r = this.host.store.btw(id);
		if (!r || r.promoted_message_id === messageID) return;
		if (r.promoted_message_id ? this.host.store.repointBtw(id, messageID) : this.host.store.promoteBtw(id, messageID)) this.updated(this.host.store.btw(id)!);
	}

	private stopRun(run: Running, why: string) {
		run.why ??= why;
		run.ctl.abort();
	}

	/** the session was archived: its running btws stop */
	stopSession(sessionID: string, why = "the session was archived before it answered") {
		for (const run of this.running.values()) if (run.sessionID === sessionID) this.stopRun(run, why);
	}

	/** the daemon is stopping: every running btw stops and is recorded as an error */
	async stopAll() {
		const ids = [...this.running.keys()];
		for (const run of this.running.values()) this.stopRun(run, BTW_SHUTDOWN);
		// each records its end once its request has unwound; a moment, not a wait on the provider
		for (let i = 0; i < 20 && ids.some((id) => this.running.has(id)); i++) await Bun.sleep(25);
	}

	get count(): number {
		return this.running.size;
	}
}

function spent(u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) {
	return { tokens_input: u.input, tokens_output: u.output, tokens_cache_read: u.cacheRead, tokens_cache_write: u.cacheWrite, cost: u.cost };
}

/** an error as a card shows it: one line, lowercase, short */
function short(message: string): string {
	const line = message.replace(/\s+/g, " ").trim();
	const s = line.length > 300 ? `${line.slice(0, 297)}...` : line;
	return s.charAt(0).toLowerCase() + s.slice(1);
}
