import type { Daemon } from "./daemon.ts";
import { fail } from "./util.ts";

/** a GET against the daemon that fails with words a person can act on */
export async function getJson<T>(d: Daemon, path: string, directory?: string): Promise<T> {
	const res = await fetch(`${d.base}${path}`, { headers: { ...d.headers, ...(directory ? { "x-cmx2-directory": encodeURIComponent(directory) } : {}) } }).catch(() => undefined);
	if (!res) fail(`no daemon answered on ${d.base}; start one with cmx2 serve, or pass --port`);
	if (res.status === 401) fail("the daemon wants a credential. set CMX2_SERVER_PASSWORD, or run cmx2 pair on this machine once");
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { data?: { message?: string } };
		fail(err.data?.message ?? `the daemon answered ${res.status} to GET ${path}`);
	}
	return (await res.json()) as T;
}
