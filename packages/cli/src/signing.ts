/**
 * macos keeps a binary's privacy grants (desktop, documents, downloads, full disk access) against its
 * designated requirement. bun signs its builds ad hoc, and an ad-hoc requirement is the binary's hash, so
 * every upgrade looked like a new app: the grants stopped applying, macos asked again, and the daemon
 * waited on a prompt nobody was there to answer. a real identity makes the requirement "this identifier,
 * signed by this certificate", which survives upgrades. the installed copy is signed when it is placed.
 */
/** a command's output; a missing command is a failed run, not an exception */
function run(cmd: string[]): { ok: boolean; out: string; missing?: boolean } {
	try {
		const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
	} catch (e) {
		if ((e as { code?: string }).code !== "ENOENT") throw e;
		return { ok: false, out: `${cmd[0]} was not found on PATH`, missing: true };
	}
}

/** the identifier the requirement names; it stays the same across versions */
export const SIGN_IDENTIFIER = "dev.cmx2.cmx2";

export interface Identity {
	hash: string;
	name: string;
}

export type SignResult = { kind: "signed"; name: string } | { kind: "adhoc"; reason: string } | { kind: "failed"; reason: string } | { kind: "skipped" };

/** `security find-identity -v -p codesigning` lines: `  1) <sha-1> "<name>"` */
export function parseIdentities(text: string): Identity[] {
	const out: Identity[] = [];
	for (const m of text.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/gm)) out.push({ hash: m[1]!, name: m[2]! });
	return out;
}

/** CMX2_CODESIGN_IDENTITY names one by hash or by part of its name; else one made for cmx2, then developer id, then apple development, then the first */
export function pickIdentity(ids: Identity[], wanted?: string): Identity | undefined {
	if (wanted) return ids.find((i) => i.hash === wanted.toUpperCase() || i.name.includes(wanted));
	const by = (re: RegExp) => ids.find((i) => re.test(i.name));
	return by(/cmx2/i) ?? by(/^Developer ID Application:/) ?? by(/^Apple Development:/) ?? ids[0];
}

/** what `codesign -dvv` says about a binary; undefined off macos or when it cannot tell */
export function signatureOf(path: string): { adhoc: boolean; authority?: string; identifier?: string } | undefined {
	if (process.platform !== "darwin") return undefined;
	const r = run(["codesign", "-dvv", path]);
	if (r.missing || !/Identifier=/.test(r.out)) return undefined;
	return {
		adhoc: /^Signature=adhoc$/m.test(r.out),
		authority: r.out.match(/^Authority=(.+)$/m)?.[1],
		identifier: r.out.match(/^Identifier=(.+)$/m)?.[1],
	};
}

export const ADHOC_NOTE =
	"macos keeps folder access (desktop, documents, full disk access) against this binary's hash, so it asks again after every upgrade, and a session waits on that prompt. a code signing identity in your keychain keeps the grants: an apple development or developer id certificate, or a self-signed one from keychain access (certificate assistant, type code signing). CMX2_CODESIGN_IDENTITY picks one, and cmx2 serve --install signs the installed copy";

/** signs a binary in place with a keychain identity; off macos, or with CMX2_CODESIGN_IDENTITY=- , it does nothing */
export function signBinary(path: string, env = process.env): SignResult {
	if (process.platform !== "darwin") return { kind: "skipped" };
	const wanted = env.CMX2_CODESIGN_IDENTITY?.trim();
	if (wanted === "-") return { kind: "skipped" };
	const found = run(["security", "find-identity", "-v", "-p", "codesigning"]);
	const ids = found.ok ? parseIdentities(found.out) : [];
	const id = pickIdentity(ids, wanted);
	if (!id) return { kind: "adhoc", reason: wanted ? `no code signing identity matches CMX2_CODESIGN_IDENTITY=${wanted}` : "no code signing identity in the keychain" };
	// a key whose access list leaves codesign out asks on screen; nobody may be there, so it gets a minute
	try {
		const p = Bun.spawnSync(["codesign", "--force", "--sign", id.hash, "--identifier", SIGN_IDENTIFIER, path], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
		if (p.exitCode === 0) return { kind: "signed", name: id.name };
		const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim();
		return { kind: "failed", reason: p.signalCode ? `codesign did not finish within a minute (a keychain prompt waiting on screen?)` : out || `codesign exited ${p.exitCode}` };
	} catch (e) {
		return { kind: "failed", reason: (e as Error).message };
	}
}

/** a certificate's kind without the person or team it names ("Apple Development: <name> (<team>)" reads "Apple Development"), so pasted output stays anonymous */
export function certificateKind(name: string): string {
	return name.replace(/:.*$/, "").trim();
}

/** one line for the install and upgrade output */
export function signLine(r: SignResult): string | undefined {
	if (r.kind === "signed") return `signed     with your ${certificateKind(r.name)} certificate, so macos keeps its folder grants across upgrades`;
	if (r.kind === "adhoc") return `signed     ad hoc (${r.reason}). ${ADHOC_NOTE}`;
	if (r.kind === "failed") return `signed     ad hoc: signing with your identity failed (${r.reason}). ${ADHOC_NOTE}`;
	return undefined;
}
