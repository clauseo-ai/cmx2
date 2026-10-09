/**
 * requests that start together on a cold prefix race the cache write: an entry can be read only once the
 * request writing it has begun answering, so four identical requests at once, or 200 ms apart, all wrote
 * the whole prefix. siblings spawned in one step share the system prompt and
 * tools, so without this each paid the full write. the first request on a cold prefix leads; the others
 * wait for its first event (or `maxWaitMs`), then go. once a request on the prefix has answered, the
 * prefix counts as warm for the ttl and nothing waits.
 */
export class PrefixGate {
	private readonly warmUntil = new Map<string, number>();
	private readonly leading = new Map<string, Promise<void>>();

	constructor(
		private readonly maxWaitMs = 10_000,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * resolves when a request on `key` may go, with a release the caller runs at the request's first
	 * event (`answered: true`) or when it ends without one. followers never lead, so a failed leader
	 * costs them one wait at most.
	 */
	async enter(key: string, ttlMs: number, signal?: AbortSignal): Promise<{ waitedMs: number; release: (answered: boolean) => void }> {
		const noop = () => {};
		if ((this.warmUntil.get(key) ?? 0) > this.now()) return { waitedMs: 0, release: noop };
		const lead = this.leading.get(key);
		if (lead) {
			const t0 = this.now();
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				lead,
				new Promise<void>((r) => {
					timer = setTimeout(r, this.maxWaitMs);
				}),
				...(signal ? [new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))] : []),
			]);
			clearTimeout(timer);
			return { waitedMs: this.now() - t0, release: noop };
		}
		let done!: () => void;
		this.leading.set(
			key,
			new Promise<void>((r) => {
				done = r;
			}),
		);
		let released = false;
		return {
			waitedMs: 0,
			release: (answered) => {
				if (released) return;
				released = true;
				if (answered) this.warmUntil.set(key, this.now() + ttlMs);
				this.leading.delete(key);
				done();
			},
		};
	}
}

/** one gate per daemon: siblings are separate sessions in one process */
export const prefixGate = new PrefixGate();
