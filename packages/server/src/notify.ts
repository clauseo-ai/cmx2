import { spawn } from "node:child_process";
import { basename } from "node:path";

/**
 * a desktop notification when a session needs the user (a permission ask or a question) and no
 * client is watching the event stream. opt-in: `"notify": true` in cmx2.jsonc (or `{ "desktop": true }`).
 * macos uses terminal-notifier when it is installed and osascript otherwise; linux uses notify-send;
 * windows shows a toast through windows powershell, with no console window. a machine with none of them stays quiet.
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

const which = (cmd: string) => Bun.which(cmd) ?? undefined;

/** windows powershell's own app id: a toast needs a registered app to come from, and this one is on every windows */
const POWERSHELL_APP = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * the powershell script that shows a toast. the text is xml-escaped, and every quote character powershell knows
 * (the ascii ones and the curly ones it also accepts) becomes an xml character reference, so the single-quoted strings
 * the script holds cannot be closed by what a session put in its title
 */
export function toastScript(note: Note): string {
	const x = (s: string) =>
		s
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/["'`\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/g, (c) => `&#${c.charCodeAt(0)};`);
	const xml = `<toast><visual><binding template="ToastGeneric"><text>${x(note.title)}</text><text>${x(note.body)}</text></binding></visual></toast>`;
	const tag = note.group.slice(0, 64).replace(/[^\w-]/g, "_");
	return [
		"$ErrorActionPreference = 'Stop'",
		"[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
		"[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]",
		"$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
		`$x.LoadXml('${xml}')`,
		"$t = New-Object Windows.UI.Notifications.ToastNotification $x",
		`$t.Tag = '${tag}'`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP}').Show($t)`,
	].join("\n");
}

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
	if (platform === "win32") {
		// windows powershell 5.1, which every windows 10 and 11 has; pwsh 7 cannot load the winrt toast types
		const ps = has("powershell");
		if (ps) return [ps, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(toastScript(note), "utf16le").toString("base64")];
	}
	return undefined;
}

const spawnDetached: Sender = (argv) => {
	const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: false, windowsHide: true });
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
			/** the command line for a note; notifyCommand with what this machine has installed unless a test pins it */
			command?: (note: Note) => string[] | undefined;
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
		const argv = (this.opts.command ?? notifyCommand)(note);
		if (argv) (this.opts.send ?? spawnDetached)(argv);
		console.error(argv ? `cmx2: desktop note (${basename(argv[0]!)}): ${note.title}: ${note.body}` : `cmx2: a session needs you but this machine has no notifier (${process.platform === "win32" ? "windows powershell" : "terminal-notifier, osascript or notify-send"})`);
		return note;
	}
}
