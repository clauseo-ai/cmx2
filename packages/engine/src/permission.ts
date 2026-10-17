import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * permission rules, wire- and config-compatible with cmx: `{permission, pattern, action}` entries,
 * wildcard matching, the last matching rule wins, and no match means ask.
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
	permission: string;
	pattern: string;
	action: PermissionAction;
}

/** `"ask"`, or `{ "<permission>": action | { "<pattern>": action } }`; key order matters (last match wins) */
export type PermissionConfig = PermissionAction | Record<string, PermissionAction | Record<string, PermissionAction>>;

export const PERMISSION_ACTIONS: readonly PermissionAction[] = ["allow", "ask", "deny"];

/**
 * what a session may do without asking. everything is allowed inside the working directory, reads
 * of env files ask, and anything outside the working directory asks. a profile or project config
 * layers its own rules on top.
 */
export const DEFAULT_PERMISSION: PermissionConfig = {
	"*": "allow",
	read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
	external_directory: "ask",
};

/** cmx names that map onto cmx2's, so a copied opencode permission block keeps working */
const ALIASES: Record<string, string> = { bash: "shell" };

function expandHome(p: string): string {
	if (p === "~" || p === "$HOME") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	if (p.startsWith("$HOME/")) return homedir() + p.slice(5);
	return p;
}

export function rulesFromConfig(c: PermissionConfig | undefined): PermissionRule[] {
	if (c === undefined) return [];
	if (typeof c === "string") return [{ permission: "*", pattern: "*", action: c }];
	const out: PermissionRule[] = [];
	for (const [key, v] of Object.entries(c)) {
		const permission = ALIASES[key] ?? key;
		if (typeof v === "string") out.push({ permission, pattern: "*", action: v });
		else for (const [pattern, action] of Object.entries(v)) out.push({ permission, pattern: expandHome(pattern), action });
	}
	return out;
}

const compiled = new Map<string, RegExp>();

/** `*` is any run of characters, `?` one character; a trailing ` *` also matches the bare command */
export function wildcardMatch(value: string, pattern: string): boolean {
	let re = compiled.get(pattern);
	if (!re) {
		let body = pattern
			.replace(/\\/g, "/")
			.replace(/[.+^${}()|[\]]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");
		if (body.endsWith(" .*")) body = `${body.slice(0, -3)}( .*)?`;
		re = new RegExp(`^${body}$`, "s");
		compiled.set(pattern, re);
	}
	return re.test(value.replace(/\\/g, "/"));
}

export function evaluate(rules: PermissionRule[], permission: string, pattern: string): PermissionRule {
	const match = rules.findLast((r) => wildcardMatch(permission, r.permission) && wildcardMatch(pattern, r.pattern));
	return match ?? { permission, pattern: "*", action: "ask" };
}

/** one permission check a tool call needs: what it touches, and the patterns an "always" answer saves */
export interface PermissionCheck {
	permission: string;
	patterns: string[];
	always: string[];
	metadata: Record<string, unknown>;
}

function within(cwd: string, p: string): boolean {
	const r = relative(cwd, p);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** a path with every symlink resolved; the part that does not exist yet (a file about to be written) is kept as named */
function realish(p: string): string {
	let head = p;
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(head), ...rest);
		} catch {
			const up = dirname(head);
			if (up === head) return p;
			rest.unshift(basename(head));
			head = up;
		}
	}
}

/**
 * the simple commands inside one command line, for rules that name a command: split at unquoted `;`,
 * `&&`, `||`, `|`, `&` and newlines, with the insides of `$(...)`, backticks and `<(...)` taken out as
 * commands of their own, grouping brackets dropped, and each one also without leading `NAME=value`
 * assignments. an approximation of bash's grammar, on the cautious side: a rule that allows `git status *`
 * no longer allows `git status && curl ... | sh`, and one that denies `git push *` sees `cd x && git push`.
 */
export function commandParts(command: string): string[] {
	const parts: string[] = [];
	const nested: string[] = [];
	let cur = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		let t = cur.trim().replace(/^[({]\s*/, "");
		// a closing bracket left over from a group, not one that closes a substitution inside the command
		const count = (ch: string) => t.split(ch).length - 1;
		while (/[)}]$/.test(t) && count(t.endsWith(")") ? ")" : "}") > count(t.endsWith(")") ? "(" : "{")) t = t.slice(0, -1).trim();
		if (t) parts.push(t);
		cur = "";
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (c === "\\" && quote !== "'") {
			cur += c + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (quote) {
			if (c === quote) quote = undefined;
			else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) {
				const end = closing(command, i);
				nested.push(command.slice(i + (c === "`" ? 1 : 2), end));
				cur += command.slice(i, end + 1);
				i = end;
				continue;
			}
			cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			cur += c;
			continue;
		}
		if (c === "`" || ((c === "$" || c === "<" || c === ">") && command[i + 1] === "(")) {
			const end = closing(command, i);
			nested.push(command.slice(i + (c === "`" ? 1 : 2), end));
			cur += command.slice(i, end + 1);
			i = end;
			continue;
		}
		if (c === ";" || c === "\n" || c === "&" || c === "|") {
			flush();
			if ((c === "&" || c === "|") && command[i + 1] === c) i++;
			continue;
		}
		cur += c;
	}
	flush();
	for (const n of nested) parts.push(...commandParts(n));
	const out = new Set<string>();
	for (const p of parts) {
		out.add(p);
		const bare = p.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "");
		if (bare && bare !== p) out.add(bare);
	}
	return [...out];
}

/** the index of the backtick or parenthesis closing the substitution that opens at `at` (or the end) */
function closing(s: string, at: number): number {
	if (s[at] === "`") {
		const end = s.indexOf("`", at + 1);
		return end < 0 ? s.length - 1 : end;
	}
	let depth = 0;
	let quote: string | undefined;
	for (let i = at + 1; i < s.length; i++) {
		const c = s[i]!;
		if (quote) {
			if (c === quote) quote = undefined;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return s.length - 1;
}

/** the patterns one command line is checked as: the line itself, then each simple command in it when there is more than one */
function shellPatterns(command: string): string[] {
	const parts = commandParts(command);
	return parts.length === 1 && parts[0] === command.trim() ? [command] : [command, ...parts];
}

/** a job's environment is part of what it runs (BASH_ENV, GIT_SSH_COMMAND and friends run code), so it is checked as leading assignments */
function withEnv(command: string, env: unknown): string {
	if (!env || typeof env !== "object") return command;
	const pairs = Object.entries(env as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
	return pairs.length ? `${pairs.join(" ")} ${command}` : command;
}

/**
 * a subagent's own rules, after every configured and saved one: it never pushes. the shell rule makes a
 * plain `git push` a clear refusal; `subagentEnv` catches the spellings a pattern cannot (`git -C dir push`,
 * a script that pushes).
 */
export const SUBAGENT_RULES: PermissionRule[] = [{ permission: "shell", pattern: "git push *", action: "deny" }];

/** the git transport every push from a subagent is rewritten to; no helper by this name exists, so git stops before any network */
export const NO_PUSH_TRANSPORT = "cmx2-subagents-do-not-push";

/**
 * what every command a subagent runs gets on top of the daemon's environment: git config (through
 * GIT_CONFIG_COUNT, after any the daemon already carries) that rewrites every push url to a transport
 * that does not exist. fetch, pull, commit and merge are untouched.
 */
export function subagentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const n = Number(base.GIT_CONFIG_COUNT) || 0;
	return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: `url.${NO_PUSH_TRANSPORT}::.pushInsteadOf`, [`GIT_CONFIG_VALUE_${n}`]: "" };
}

/** the command prefix an "always" covers: `git status *`, `bun test *`, `ls *` */
export function commandPrefix(command: string): string {
	const words = command.trim().split(/\s+/);
	const first = words[0] ?? "";
	const second = words[1];
	if (second && /^[a-z][\w-]*$/i.test(second) && !second.startsWith("-")) return `${first} ${second} *`;
	return `${first} *`;
}

/**
 * the checks for one tool call. path tools check their own permission against the path relative to
 * the working directory, plus `external_directory` when the path leaves it. `run` has none of its
 * own: every helper call inside the script is checked as the tool it calls.
 */
export function checksFor(tool: string, args: any, cwd: string): PermissionCheck[] {
	const checks: PermissionCheck[] = [];
	// a symlink is judged by where it points too: a link in the repo to ~/.ssh is outside, a link named notes.txt to .env is .env
	const realCwd = realish(cwd);
	const pathCheck = (permission: string, raw: string | undefined) => {
		const abs = resolve(cwd, expandHome(raw ?? "."));
		const target = realish(abs);
		const inside = within(cwd, abs) && within(realCwd, target);
		const rel = within(cwd, abs) ? relative(cwd, abs) || "." : abs;
		const relTarget = within(realCwd, target) ? relative(realCwd, target) || "." : target;
		// the target counts where it can change the answer: a link inside the directory, or one that renames the file
		const both = relTarget !== rel && (within(cwd, abs) || basename(target) !== basename(abs));
		checks.push({ permission, patterns: both ? [rel, relTarget] : [rel], always: ["*"], metadata: { path: abs, ...(target !== abs ? { target } : {}) } });
		if (!inside) {
			const out = within(cwd, abs) ? target : abs;
			const dir = tool === "glob" || tool === "grep" ? out : dirname(out);
			checks.push({ permission: "external_directory", patterns: [`${dir}/*`], always: [`${dir}/*`], metadata: { path: abs, directory: dir } });
		}
	};
	const shellCheck = (command: string, metadata: Record<string, unknown> = {}) => {
		const patterns = shellPatterns(command);
		const always = [...new Set(patterns.slice(patterns.length > 1 ? 1 : 0).map(commandPrefix))];
		checks.push({ permission: "shell", patterns, always, metadata: { command, ...metadata } });
	};
	switch (tool) {
		case "read":
			pathCheck("read", args?.path);
			break;
		case "write":
		case "edit":
			pathCheck("edit", args?.path);
			break;
		case "grep":
		case "glob":
			pathCheck(tool, args?.path);
			break;
		case "shell":
			shellCheck(String(args?.command ?? ""));
			break;
		case "worktree_create":
			// the extra setup command runs in the new checkout like any shell command
			checks.push({ permission: tool, patterns: ["*"], always: ["*"], metadata: {} });
			if (args?.setup) shellCheck(String(args.setup), { worktree: true });
			break;
		case "webfetch":
			checks.push({ permission: "webfetch", patterns: [String(args?.url ?? "")], always: ["*"], metadata: { url: args?.url } });
			break;
		case "webcrawl":
			checks.push({ permission: "webcrawl", patterns: [String(args?.url ?? "")], always: ["*"], metadata: { url: args?.url } });
			break;
		case "websearch":
			checks.push({ permission: "websearch", patterns: [String(args?.query ?? "")], always: ["*"], metadata: { query: args?.query } });
			break;
		case "skill":
			checks.push({ permission: "skill", patterns: [String(args?.name ?? "*")], always: [String(args?.name ?? "*")], metadata: { name: args?.name } });
			break;
		case "lsp":
			pathCheck("lsp", args?.path);
			break;
		case "proc_spawn": {
			// a job or a terminal runs a command like shell does, under the same rules
			shellCheck(withEnv(String(args?.command ?? ""), args?.env), { ...(args?.tty ? { tty: true } : {}), ...(args?.keep ? { keep: args.keep } : {}) });
			if (args?.cwd) {
				const abs = resolve(cwd, expandHome(String(args.cwd)));
				if (!within(cwd, abs)) checks.push({ permission: "external_directory", patterns: [`${abs}/*`], always: [`${abs}/*`], metadata: { path: abs, directory: abs } });
			}
			break;
		}
		case "proc_write": {
			// what is typed into a terminal is a command line too; a script cannot widen the shell rules through it
			const typed = String(args?.data ?? "").trim();
			if (typed) shellCheck(typed, { pty: args?.id });
			break;
		}
		case "proc_read":
		case "proc_list":
		case "proc_kill":
		case "run":
		case "tool_search":
			break;
		default:
			checks.push({ permission: tool, patterns: ["*"], always: ["*"], metadata: {} });
	}
	return checks;
}

export type PermissionReply = "once" | "always" | "reject";

/** why a call did not run, in the words the model reads */
export const PERMISSION_REJECTED = "the user rejected permission to use this specific tool call.";
export function permissionCorrected(feedback: string): string {
	return `the user rejected permission to use this specific tool call with the following feedback: ${feedback}`;
}
export function permissionDenied(rule: PermissionRule): string {
	return `a permission rule blocks this call (${rule.permission} ${rule.pattern}: deny). change the approach or ask the user to change the rule.`;
}
