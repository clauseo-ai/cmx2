import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, ConfigError, EFFORTS, type Effort } from "@cmx2/engine/config";
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/**
 * the profile over http (`GET` and `PATCH /config`), the model blacklist and the named per-model
 * variants. the engine reads the profile; these keys ride along in it untouched by the engine's
 * checks and are read here:
 *
 *   "providers": { "anthropic": { "blacklist": ["*-fast"] } }       globs over that provider's model ids
 *   "variants": { "anthropic/claude-opus-5-5": { "quick": { "effort": "low" } } }
 *
 * a blacklisted model leaves the pickers and is refused for a new turn; a variant is a name a client
 * sends as `variant` that picks an effort for that model (`"*"` names variants for every model).
 */

export const REDACTED = "[redacted]";

/** a secret-shaped value stays a reference (`$ENV_NAME`) and anything literal is masked */
function mask(v: unknown): unknown {
	if (typeof v !== "string") return REDACTED;
	return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) ? v : REDACTED;
}

const SECRET_KEYS = /^(apikey|api_key|key|token|secret|password|authorization|auth|cookie|bearer|client_secret|access_token|refresh_token)$/i;

const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|signature/i;
/** token formats worth masking wherever they appear on a command line */
const TOKEN_SHAPE = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.)/;

/** a url with its password and any secret-named query values masked; anything else as it was */
function maskUrl(v: string): string {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
	try {
		const u = new URL(v);
		let changed = false;
		if (u.password) {
			u.password = REDACTED;
			changed = true;
		}
		for (const k of [...u.searchParams.keys()]) {
			if (!SECRET_NAME.test(k)) continue;
			u.searchParams.set(k, REDACTED);
			changed = true;
		}
		return changed ? decodeURI(u.toString()) : v;
	} catch {
		return v;
	}
}

/** free text (an error message) with every url in it masked the way maskUrl masks one */
export function scrubText(text: string): string {
	return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => maskUrl(u));
}

/** a command line with the value after a secret-named flag, a `--flag=value` secret and token-shaped words masked */
function maskArgv(argv: unknown[]): unknown[] {
	return argv.map((a, i) => {
		if (typeof a !== "string") return a;
		const prev = argv[i - 1];
		if (typeof prev === "string" && /^--?[\w-]+$/.test(prev) && SECRET_NAME.test(prev)) return REDACTED;
		const eq = a.match(/^(--?[\w-]+)=/);
		if (eq && SECRET_NAME.test(eq[1]!)) return `${eq[1]}=${REDACTED}`;
		if (TOKEN_SHAPE.test(a)) return REDACTED;
		return maskUrl(a);
	});
}

/** walks a value and masks anything under a secret-looking key, every value of headers and env maps, url passwords and secret query values, and secrets on command lines */
function redactDeep(v: unknown, underMap = false, key = ""): unknown {
	if (Array.isArray(v)) return key === "command" || key === "args" ? maskArgv(v) : v.map((x) => redactDeep(x));
	if (typeof v === "string" && !underMap) return key === "command" ? (maskArgv(v.split(" ")) as string[]).join(" ") : maskUrl(v);
	if (!v || typeof v !== "object") return underMap ? mask(v) : v;
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) {
		if (underMap) out[k] = mask(x);
		else if (SECRET_KEYS.test(k)) out[k] = mask(x);
		else if (k === "headers" || k === "env" || k === "environment") out[k] = x && typeof x === "object" && !Array.isArray(x) ? redactDeep(x, true) : mask(x);
		else out[k] = redactDeep(x, false, k);
	}
	return out;
}

/**
 * the merged profile a client may see: keys and header values masked (an `$ENV_NAME` reference stays,
 * it names where the key lives, not the key), `!command` keys masked too since a command line can
 * carry a secret. `sources` lists the layers that were read, by file name only.
 */
export function redactConfig(config: Config): Record<string, unknown> {
	const { sources, ...rest } = config;
	return { ...(redactDeep(rest) as Record<string, unknown>), sources: sources.map((s) => s.split("/").pop()) };
}

/** true when a value in the patch is one of our own masks: writing it back would destroy the real value */
function carriesMask(v: unknown): boolean {
	if (typeof v === "string" && v.includes(REDACTED)) return true;
	if (v && typeof v === "object") return Object.values(v).some(carriesMask);
	return false;
}

/**
 * `PATCH /config`: a json merge patch (rfc 7396; `null` removes a key) applied to the profile's
 * `cmx2.jsonc` with its comments and layout kept. `check` loads the result before it is kept, so a
 * patch that would not load is refused and the file is left as it was.
 */
export function patchProfile(dir: string, patch: unknown, check: () => void): { path: string; changed: string[] } {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigError("the body must be a json object: the keys to change, null to remove one");
	if (carriesMask(patch)) throw new ConfigError(`the patch carries ${REDACTED}, a masked value from GET /config; send the real value or leave the key out`);
	const path = join(dir, "cmx2.jsonc");
	const before = existsSync(path) ? readFileSync(path, "utf8") : "{\n}\n";
	const errors: ParseError[] = [];
	parse(before, errors, { allowTrailingComma: true });
	if (errors.length) throw new ConfigError(`${path} is not valid jsonc (${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}); fix it by hand first`);
	let text = before;
	const changed: string[] = [];
	const walk = (obj: Record<string, unknown>, at: string[]) => {
		for (const [k, v] of Object.entries(obj)) {
			const p = [...at, k];
			if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) walk(v as Record<string, unknown>, p);
			else {
				text = applyEdits(text, modify(text, p, v === null ? undefined : v, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
				changed.push(p.join("."));
			}
		}
	};
	walk(patch as Record<string, unknown>, []);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
	try {
		check();
	} catch (e) {
		// put the file back as it was; the error names what was wrong with the patch
		if (existsSync(path)) writeFileSync(path, before);
		throw e;
	}
	return { path, changed };
}

/** `*` matches any run of characters, everything else literally */
function glob(pattern: string): RegExp {
	return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/** the profile's blacklist for a provider: `providers.<id>.blacklist`, globs over model ids */
export function blacklisted(config: Config, ref: string): boolean {
	const slash = ref.indexOf("/");
	if (slash <= 0) return false;
	const list = (config.providers[ref.slice(0, slash)] as { blacklist?: unknown } | undefined)?.blacklist;
	if (!Array.isArray(list)) return false;
	const id = ref.slice(slash + 1);
	return list.some((p) => typeof p === "string" && (glob(p).test(id) || glob(p).test(ref)));
}

export interface Variant {
	effort?: Effort;
}

/** named variants for a model: the profile's `variants["*"]` and then `variants["<provider>/<id>"]` */
export function variantsFor(config: Config, ref: string): Record<string, Variant> {
	const all = (config as { variants?: Record<string, Record<string, Variant>> }).variants;
	if (!all || typeof all !== "object") return {};
	return { ...(all["*"] ?? {}), ...(all[ref] ?? {}) };
}

/** the effort a named variant picks for a model, if the profile names one */
export function variantEffort(config: Config, ref: string, name: string | undefined): Effort | undefined {
	if (!name) return undefined;
	return variantsFor(config, ref)[name]?.effort;
}

/** the profile's own keys checked the way the engine checks its: a wrong one names the fix */
export function checkProfileKeys(config: Config): void {
	for (const [id, p] of Object.entries(config.providers)) {
		const b = (p as { blacklist?: unknown }).blacklist;
		if (b !== undefined && (!Array.isArray(b) || b.some((x) => typeof x !== "string"))) throw new ConfigError(`providers.${id}.blacklist must be a list of model ids or globs like "*-fast"`);
	}
	const v = (config as { variants?: unknown }).variants;
	if (v === undefined) return;
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`variants must be an object: { "provider/model-id": { "name": { "effort": "low" } } }`);
	for (const [ref, named] of Object.entries(v)) {
		if (ref !== "*" && !ref.includes("/")) throw new ConfigError(`variants keys are "provider/model-id" or "*", got ${JSON.stringify(ref)}`);
		if (!named || typeof named !== "object") throw new ConfigError(`variants.${ref} must be an object of named variants`);
		for (const [name, def] of Object.entries(named as Record<string, unknown>)) {
			const effort = (def as { effort?: unknown })?.effort;
			if (effort !== undefined && !EFFORTS.includes(effort as Effort)) throw new ConfigError(`variants.${ref}.${name}.effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(effort)}`);
		}
	}
}
