import { realpathSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";

export interface RedactContext {
	home: string;
	user: string;
	/** this machine's names: the full hostname and its first label */
	hosts: string[];
}

export function machineContext(): RedactContext {
	const full = hostname().toLowerCase();
	let user = "";
	try {
		user = userInfo().username;
	} catch {}
	return { home: homedir(), user, hosts: [...new Set([full, full.split(".")[0]!])].filter((h) => h && h !== "localhost") };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * masks what should not leave the machine in a pasted report: urls keep their scheme, port and path
 * but not their host, and home paths, the user name, this machine's names, private domains, ip
 * addresses and anything shaped like a key are replaced. loopback addresses stay, they say nothing.
 */
export function redact(text: string, ctx: RedactContext = machineContext()): string {
	let out = text;
	// anything key-shaped first, before a url or path rule splits it
	out = out.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, "<secret>");
	out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <secret>");
	// long runs of letters and digits read as tokens; slashes and dots end a run, so paths and file names survive
	out = out.replace(/(?<![A-Za-z0-9+_./-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_./-])/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "<secret>" : m));
	out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^@\s/]*@)?(\[[^\]]+\]|[^\s/:?#'"<>]+)/gi, (_m, scheme: string, host: string) => `${scheme}${LOOPBACK.has(host.toLowerCase()) ? host : "<host>"}`);
	if (ctx.home && ctx.home !== "/") {
		// the resolved home first: on macos /tmp is /private/tmp, and binaries report the resolved path
		let real = ctx.home;
		try {
			real = realpathSync(ctx.home);
		} catch {}
		if (real !== ctx.home) out = out.split(real).join("~");
		out = out.split(ctx.home).join("~");
	}
	// only where a path starts, so a directory named home deeper in a path stays
	out = out.replace(/(?<![\w.-])\/(Users|home)\/[^/\s'"]+/g, "/$1/<user>");
	if (ctx.user.length >= 3) out = out.replace(new RegExp(`\\b${esc(ctx.user)}\\b`, "gi"), "<user>");
	for (const h of [...ctx.hosts].sort((a, b) => b.length - a.length)) if (h.length >= 3) out = out.replace(new RegExp(`\\b${esc(h)}\\b`, "gi"), "<host>");
	out = out.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|internal|local|lan|home\.arpa|corp)\b/gi, "<host>");
	out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (LOOPBACK.has(ip) ? ip : "<ip>"));
	return out;
}
