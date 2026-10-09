import { spawn, spawnSync } from "node:child_process";

/**
 * a desktop notification when a session needs the user (a permission ask or a question) and no
 * client is watching the event stream. opt-in: `"notify": true` in cmx2.jsonc (or `{ "desktop": true }`).
 * macos uses terminal-notifier when it is installed and osascript otherwise; linux uses notify-send.
 * a machine with none of them stays quiet.
 */

export interface NotifyConfig {
	desktop: boolean;
}

/** the profile's `notify` key: `true`, `false`, or `{ desktop }`; anything else is off */
export function notifyConfig(raw: unknown): NotifyConfig {
	if (raw === true) return { desktop: true };
	if (raw && typeof raw === "object" && (raw as { desktop?: unknown }).desktop === true) return { desktop: true };
	return { desktop: false };
}

export interface Note {
	title: string;
	body: string;
	/** notifications with the same group replace each other (terminal-notifier) */
	group: string;
}

type Sender = (argv: string[]) => void;

const which = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim() || undefined;

/** the command line that shows a note on this platform, or undefined when there is no way to */
export function notifyCommand(note: Note, platform = process.platform, has: (cmd: string) => string | undefined = which): string[] | undefined {
	if (platform === "darwin") {
		const tn = has("terminal-notifier");
		if (tn) return [tn, "-title", note.title, "-message", note.body, "-group", note.group, "-sender", "com.apple.Terminal"];
		const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		return ["osascript", "-e", `display notification ${q(note.body)} with title ${q(note.title)}`];
	}
	if (platform === "linux") {
		const ns = has("notify-send");
		if (ns) return [ns, "--app-name=cmx2", note.title, note.body];
	}
	return undefined;
}

const spawnDetached: Sender = (argv) => {
	const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: false });
	child.on("error", () => {});
	child.unref();
};

export class Notifier {
	/** the last note per session, so a burst of asks is one notification */
	private last = new Map<string, number>();

	constructor(
		private readonly opts: {
			enabled: () => boolean;
			/** how many clients are watching; a note only goes out when nobody is */
			watchers: () => number;
			titleOf: (sessionID: string) => string | undefined;
			send?: Sender;
			/** quiet period per session */
			quietMs?: number;
		},
	) {}

	/** called with every published event; returns the note it sent, for tests */
	onEvent(type: string, properties: Record<string, unknown>, now = Date.now()): Note | undefined {
		if (type !== "permission.asked" && type !== "question.asked") return undefined;
		if (!this.opts.enabled() || this.opts.watchers() > 0) return undefined;
		const sessionID = String(properties.sessionID ?? "");
		const prev = this.last.get(sessionID);
		if (prev !== undefined && now - prev < (this.opts.quietMs ?? 30_000)) return undefined;
		this.last.set(sessionID, now);
		const title = this.opts.titleOf(sessionID) || "a cmx2 session";
		let body: string;
		if (type === "permission.asked") {
			const what = Array.isArray(properties.patterns) && properties.patterns.length ? `: ${String(properties.patterns[0]).slice(0, 120)}` : "";
			body = `wants permission for ${String(properties.permission ?? "a tool")}${what}`;
		} else {
			const q = (properties.questions as Array<{ question?: string }> | undefined)?.[0]?.question;
			body = q ? `asks: ${q.slice(0, 160)}` : "has a question for you";
		}
		const note = { title: `cmx2 · ${title}`.slice(0, 120), body, group: `cmx2-${sessionID}` };
		const argv = notifyCommand(note);
		if (argv) (this.opts.send ?? spawnDetached)(argv);
		console.error(argv ? `cmx2: desktop note (${argv[0]!.split("/").pop()}): ${note.title}: ${note.body}` : "cmx2: a session needs you but this machine has no notifier (terminal-notifier, osascript or notify-send)");
		return note;
	}
}
