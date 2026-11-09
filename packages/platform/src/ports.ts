/**
 * listening tcp ports by pid on windows, from netstat. lsof is not there, and netstat ships with every windows. the
 * state column is localized ("LISTENING", "ABHÖREN"), so a row counts as listening when its foreign address is the
 * unspecified one (`0.0.0.0:0` or `[::]:0`), which only a listening socket has.
 */

/** pid to the tcp ports it listens on, from `netstat -ano` output (ipv4 and ipv6 rows alike) */
export function parseNetstat(text: string): Map<number, Set<number>> {
	const out = new Map<number, Set<number>>();
	for (const line of text.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4 || parts[0]!.toUpperCase() !== "TCP") continue;
		const local = parts[1]!;
		const foreign = parts[2]!;
		if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
		const pid = Number(parts[parts.length - 1]);
		const m = local.match(/:(\d+)$/);
		if (!m || !Number.isInteger(pid) || pid <= 0) continue;
		let set = out.get(pid);
		if (!set) out.set(pid, (set = new Set()));
		set.add(Number(m[1]));
	}
	return out;
}

/**
 * every listening tcp port on the machine by pid (windows). "failed" when netstat could not start, "slow" when it
 * did not answer within the timeout (it is killed), so a failed look never reads as "listens on nothing"
 */
export async function windowsListeners(o: { timeoutMs?: number; netstat?: string } = {}): Promise<Map<number, Set<number>> | "missing" | "failed" | "slow"> {
	const exe = o.netstat ?? "netstat";
	const timeoutMs = o.timeoutMs ?? 5000;
	let procs: Array<ReturnType<typeof Bun.spawn>>;
	try {
		procs = ["TCP", "TCPv6"].map((p) => Bun.spawn([exe, "-ano", "-p", p], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true }));
	} catch {
		return Bun.which(exe) ? "failed" : "missing";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<undefined>((done) => {
		timer = setTimeout(() => {
			for (const p of procs) {
				try {
					p.kill("SIGKILL");
				} catch {}
			}
			done(undefined);
		}, timeoutMs);
	});
	const work = Promise.all(
		procs.map(async (p) => {
			const text = await new Response(p.stdout as ReadableStream<Uint8Array>).text();
			await p.exited;
			return text;
		}),
	).catch(() => undefined);
	const texts = await Promise.race([work, deadline]);
	clearTimeout(timer);
	if (texts === undefined || procs.some((p) => p.signalCode)) return "slow";
	return parseNetstat(texts.join("\n"));
}

/** the image name of a pid (windows), from tasklist; undefined when there is no such process */
export async function windowsImageName(pid: number, timeoutMs = 2000): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const p = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
		timer = setTimeout(() => p.kill(), timeoutMs);
		const text = await new Response(p.stdout).text();
		const m = text.match(/^"([^"]+)","(\d+)"/m);
		return m && Number(m[2]) === pid ? m[1] : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
