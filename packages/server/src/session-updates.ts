/**
 * session.created and session.updated, published without blocking the event loop on git and at most
 * once per tick for activity. a session row carries its directory's branch and dirty flag; when that is
 * not loaded and fresh, the event waits for git (run async) and then goes out with the session as it is
 * by then, so it carries the same data a synchronous git run would have. activity (a landed message, an
 * ask) marks the session and one session.updated goes out at the end of the tick. an update asked for
 * while one is already waiting is folded into it: the one that goes out reads the session last.
 */

export type SessionEvent = "session.created" | "session.updated";

export interface SessionUpdatesHost {
	/** the session's directory when its row needs git that is not fresh, else undefined; null when there is no such session */
	waitsOn(id: string): string | undefined | null;
	/** loads git for a directory; never rejects */
	load(directory: string): Promise<void>;
	/** publishes the event with the session's info read now */
	emit(type: SessionEvent, id: string): void;
}

/** how often an event waiting on git asks again when git went stale while it waited (an edit landed); then it goes out anyway */
const RETRIES = 3;

export class SessionUpdates {
	private tick = new Set<string>();
	private scheduled = false;
	private waiting = new Map<string, { created: boolean; updated: boolean; sent: Promise<void>; done: () => void }>();

	constructor(private host: SessionUpdatesHost) {}

	/** publishes now, or once git answers; the promise settles when the event has gone out (a reply can wait for it) */
	publish(type: SessionEvent, id: string): Promise<void> {
		const w = this.waiting.get(id);
		if (w) {
			if (type === "session.created") w.created = true;
			else w.updated = true;
			this.tick.delete(id);
			return w.sent;
		}
		if (type === "session.updated") this.tick.delete(id);
		const dir = this.host.waitsOn(id);
		if (dir === null) return Promise.resolve();
		if (dir === undefined) {
			this.host.emit(type, id);
			return Promise.resolve();
		}
		let done = () => {};
		const sent = new Promise<void>((r) => (done = r));
		this.waiting.set(id, { created: type === "session.created", updated: type === "session.updated", sent, done });
		void this.host.load(dir).then(() => this.drain(id, 1));
		return sent;
	}

	/** activity on a session: one session.updated at the end of this tick, however many times it is touched */
	touch(id: string) {
		this.tick.add(id);
		if (this.scheduled) return;
		this.scheduled = true;
		setImmediate(() => this.flush());
	}

	/** publishes what touch marked now (tests and shutdown) */
	flush() {
		this.scheduled = false;
		const ids = [...this.tick];
		this.tick.clear();
		for (const id of ids) void this.publish("session.updated", id);
	}

	/** sessions with an event waiting on git */
	get pending(): number {
		return this.waiting.size;
	}

	private drain(id: string, tries: number) {
		const w = this.waiting.get(id);
		if (!w) return;
		const dir = this.host.waitsOn(id);
		if (dir && tries < RETRIES) {
			void this.host.load(dir).then(() => this.drain(id, tries + 1));
			return;
		}
		this.waiting.delete(id);
		try {
			if (dir === null) return;
			if (w.created) this.host.emit("session.created", id);
			if (w.updated) this.host.emit("session.updated", id);
		} finally {
			w.done();
		}
	}
}
