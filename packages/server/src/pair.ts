import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * pairing: `cmx2 pair` leaves a one-time token here; a client trades it at `POST /pair` for a
 * long-lived bearer credential it stores on its side; `cmx2 pair --revoke` removes one. only hashes are
 * kept, in `<data>/auth/`, so a copy of the data dir cannot be replayed as a login. the daemon reads the
 * files again whenever they change, so a revoke bites on the next request without a restart.
 *
 * once any client is paired, every request needs a credential (or the basic password); this machine's
 * own cli and tui use `local.token`, written next to the list with mode 0600.
 */

/** how long a one-time token from `cmx2 pair` can be traded */
export const PAIR_TOKEN_MS = 10 * 60_000;

export interface Credential {
	id: string;
	/** what the client called itself, or what `cmx2 pair --name` said */
	name: string;
	/** sha256 of the bearer, hex */
	hash: string;
	created_at: number;
	/** the local credential (this machine's cli and tui); never listed as a paired client */
	local?: boolean;
}

interface Pending {
	hash: string;
	name?: string;
	expires_at: number;
}

interface Files {
	credentials: Credential[];
	pending: Pending[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 32 random bytes, base64url: what a client stores */
function secret(prefix: string): string {
	return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && timingSafeEqual(x, y);
}

export class PairError extends Error {}

export class Pairing {
	readonly dir: string;
	private cache: { key: string; files: Files } | undefined;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "auth");
	}

	private path(name: "credentials" | "pending") {
		return join(this.dir, `${name}.json`);
	}

	private stamp(): string {
		return (["credentials", "pending"] as const).map((n) => (existsSync(this.path(n)) ? `${statSync(this.path(n)).mtimeMs}:${statSync(this.path(n)).size}` : "-")).join("|");
	}

	private read(): Files {
		const key = this.stamp();
		if (this.cache?.key === key) return this.cache.files;
		const load = <T>(n: "credentials" | "pending"): T[] => {
			if (!existsSync(this.path(n))) return [];
			try {
				const v = JSON.parse(readFileSync(this.path(n), "utf8"));
				return Array.isArray(v) ? v : [];
			} catch {
				// a hand-edited file that no longer parses locks clients out rather than letting everyone in
				return [];
			}
		};
		const files = { credentials: load<Credential>("credentials"), pending: load<Pending>("pending") };
		this.cache = { key, files };
		return files;
	}

	private write(n: "credentials" | "pending", rows: unknown[]) {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		// mkdir's mode applies only when it creates the directory
		chmodSync(this.dir, 0o700);
		const tmp = `${this.path(n)}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(rows, null, 1)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path(n));
		this.cache = undefined;
	}

	/** clients that traded a token; the local credential is not one */
	clients(): Credential[] {
		return this.read().credentials.filter((c) => !c.local);
	}

	/** true once a client has been paired: from then on every request needs a credential */
	required(): boolean {
		return this.clients().length > 0;
	}

	/** the credential a bearer belongs to, or undefined */
	check(bearer: string): Credential | undefined {
		const h = sha(bearer);
		return this.read().credentials.find((c) => sameHash(c.hash, h));
	}

	/** this machine's own credential, made on first use; the cli and the tui read it from local.token */
	ensureLocal(): string {
		const file = join(this.dir, "local.token");
		if (existsSync(file)) {
			const t = readFileSync(file, "utf8").trim();
			if (t && this.check(t)) return t;
		}
		const token = secret("cmx2l");
		const rest = this.read().credentials.filter((c) => !c.local);
		this.write("credentials", [...rest, { id: `cred_${randomBytes(6).toString("hex")}`, name: "this machine", hash: sha(token), created_at: Date.now(), local: true } satisfies Credential]);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		writeFileSync(file, `${token}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		return token;
	}

	/** `cmx2 pair`: a one-time token, valid for PAIR_TOKEN_MS; expired ones are dropped as new ones are made */
	begin(name?: string, now = Date.now()): { token: string; expires_at: number } {
		const token = secret("cmx2p");
		const live = this.read().pending.filter((p) => p.expires_at > now);
		const expires_at = now + PAIR_TOKEN_MS;
		this.write("pending", [...live, { hash: sha(token), expires_at, ...(name ? { name } : {}) } satisfies Pending]);
		return { token, expires_at };
	}

	/** `POST /pair`: the one-time token is spent and a bearer credential comes back, once */
	exchange(token: string, clientName?: string, now = Date.now()): { id: string; name: string; credential: string } {
		const h = sha(token);
		const { pending, credentials } = this.read();
		const hit = pending.find((p) => sameHash(p.hash, h));
		if (!hit) throw new PairError("that pairing token is not one this daemon issued, or it was already used; run cmx2 pair on the host for a fresh one");
		this.write(
			"pending",
			pending.filter((p) => p !== hit && p.expires_at > now),
		);
		if (hit.expires_at <= now) throw new PairError("that pairing token expired (they last 10 minutes); run cmx2 pair on the host for a fresh one");
		const credential = secret("cmx2");
		// a name the client picked lands in the daemon's log and in `cmx2 pair --list`: no control characters, no escapes
		const name = (hit.name ?? clientName ?? "client").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 80) || "client";
		const id = `cred_${randomBytes(6).toString("hex")}`;
		this.write("credentials", [...credentials, { id, name, hash: sha(credential), created_at: now } satisfies Credential]);
		return { id, name, credential };
	}

	/** `cmx2 pair --revoke`: by id, by name, or `all`; the local credential stays. returns what went */
	revoke(which: string): Credential[] {
		const creds = this.read().credentials;
		const gone = creds.filter((c) => !c.local && (which === "all" || c.id === which || c.name === which));
		if (gone.length) this.write("credentials", creds.filter((c) => !gone.includes(c)));
		return gone;
	}
}
