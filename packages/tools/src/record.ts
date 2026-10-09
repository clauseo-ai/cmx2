/**
 * how a tool call is recorded on a part: its title, and its details kept to a size a part can carry.
 * one title function for a direct call (the store's projection) and a helper call inside `run` (the
 * nested record), so a tail reads the same either way.
 */

const last = (path: unknown): string | undefined => (typeof path === "string" && path ? path.split("/").filter(Boolean).pop() : undefined);

/** what a tool row is called in a client: the command for shell, the path for file tools, the agent for the agent verbs, else the tool */
export function toolTitle(tool: string, input: any, details?: any): string {
	if (tool === "shell" && typeof input?.command === "string") return input.command;
	if (tool === "spawn") {
		const agents: any[] = Array.isArray(details?.agents) ? details.agents : [];
		const n = agents.length || (typeof input?.pool?.n === "number" ? input.pool.n : 1);
		if (n > 1) return `pool of ${n} agents`;
		const name = agents[0]?.name ?? last(details?.path) ?? input?.name;
		return typeof name === "string" && name ? `agent ${name}` : "agent";
	}
	if (tool === "wait") return typeof input?.correlation_id === "string" && input.correlation_id ? `wait for ${input.correlation_id}` : "wait for agents";
	if (tool === "message") {
		const to = last(details?.to) ?? (typeof input?.to === "string" ? input.to : undefined);
		return to ? `note to ${to}` : "note";
	}
	if (tool === "agents" && input?.action && input.action !== "list") return typeof input.target === "string" && input.target ? `${input.action} ${last(input.target) ?? input.target}` : String(input.action);
	if (typeof input?.path === "string") return input.path;
	if (typeof input?.pattern === "string") return input.pattern;
	return tool;
}

/** a title as one short line: a heredoc command or a long path never swells the part that carries it */
export function titleLine(title: string, max = 200): string {
	const line = title.split("\n", 1)[0]!;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const len = (v: unknown) => JSON.stringify(v).length;

/** a value worth keeping when an answer is cut: a number, a flag, null, or a string short enough to be an id, a path or a name */
const SMALL_STRING = 256;
const small = (v: unknown) => v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= SMALL_STRING);

/**
 * what is left of a details object that does not fit in `cap` characters of json, most important first:
 * the marker `truncated: true` (the tool's own `truncated`, a read's or a grep's, is replaced by it), the
 * top-level scalars (ids, paths, counts; a long string is left out), then each array of identified things
 * (the agents a spawn started) reduced to `{ id, path, name }` per element, so a pool of sixteen still
 * names its members, and each plain object (an edit's filediff) reduced to its small fields, so its counts
 * stay when its patch goes. what does not fit is left out whole; the result never passes `cap`.
 * `flat` keeps the top-level scalars only.
 */
export function shrinkDetails(details: unknown, cap: number, opts: { flat?: boolean } = {}): Record<string, unknown> {
	const keep: Record<string, unknown> = { truncated: true };
	if (!details || typeof details !== "object" || Array.isArray(details)) return keep;
	let size = len(keep);
	const put = (k: string, v: unknown) => {
		const add = len(k) + len(v) + 2;
		if (size + add > cap) return;
		keep[k] = v;
		size += add;
	};
	const fields = Object.entries(details).filter(([k]) => k !== "truncated");
	for (const [k, v] of fields) if (small(v)) put(k, v);
	if (opts.flat) return keep;
	for (const [k, v] of fields) {
		if (Array.isArray(v)) {
			if (v.length && v.every((e) => e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")) {
				put(k, v.map((e) => Object.fromEntries(["id", "path", "name"].filter((f) => small((e as Record<string, unknown>)[f])).map((f) => [f, (e as Record<string, unknown>)[f]]))));
			}
		} else if (v && typeof v === "object") {
			// the object's own `truncated` would be untrue once its bulk is gone; the marker above says the answer was cut
			const some = Object.fromEntries(Object.entries(v).filter(([f, x]) => f !== "truncated" && small(x)));
			if (Object.keys(some).length) put(k, some);
		}
	}
	return keep;
}

/**
 * a helper call's own answer as its nested record keeps it: a spawn's agents lose the brief and the last
 * report they carry (the transcript has them), and an answer still over `cap` is shrunk
 */
export function nestedDetails(tool: string, details: unknown, cap: number): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || !Object.keys(details).length) return undefined;
	let d = details as Record<string, unknown>;
	if (tool === "spawn" && Array.isArray(d.agents)) d = { ...d, agents: d.agents.map((a) => (a && typeof a === "object" ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "lastTask" && k !== "lastReport")) : a)) };
	return JSON.stringify(d).length <= cap ? d : shrinkDetails(d, cap);
}
