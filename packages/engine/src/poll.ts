/**
 * poll-only steps: a model step whose every call only waits for something to change (a sleep, a
 * retry loop, a read of process output) and does nothing else. cmx paid 1,096 of them in 60 days;
 * cmx2's target is zero, because jobs notify. a check that runs once (`curl localhost:3000/health`)
 * is work, not polling; the same check in a sleep loop is polling.
 */

/** words a waiting shell line is made of; a line counts only when it also sleeps, waits or loops */
const WAIT_WORDS = new Set(["sleep", "wait", "until", "while", "do", "done", "then", "fi", "if", "true", "false", "curl", "wget", "nc", "lsof", "ps", "pgrep", "tail", "head", "cat", "echo", "grep", "wc", "test", "[", "[[", "jobs", "timeout", "gtimeout", "break", "continue", "exit"]);

export function isWaitingShell(command: string): boolean {
	const c = command.trim();
	if (!/\b(sleep|wait|until|while)\b/.test(c)) return false;
	const segments = c.split(/;|&&|\|\||\||\n|\bdo\b|\bthen\b/).map((s) => s.trim()).filter(Boolean);
	return segments.every((s) => {
		const first = s.replace(/^[!(\s]+/, "").split(/\s+/)[0] ?? "";
		return WAIT_WORDS.has(first) || /^\d/.test(first) || first.startsWith("$(") || first === "}";
	});
}

const READ_TOOLS = new Set(["proc_read", "pty_read"]);
const READ_HELPERS = new Set(["pty.read", "shell.read", "proc.read"]);

export interface PollCall {
	name: string;
	arguments?: Record<string, unknown>;
	/** helpers a run script called, when the call was run */
	nested?: Array<{ helper: string }>;
}

function waits(call: PollCall): boolean {
	if (call.name === "shell") {
		// starting a background job is work, whatever the command sleeps on; the job waits, the model does not
		const a = call.arguments ?? {};
		if (a.background || a.notify || a.tty || a.keep) return false;
		return isWaitingShell(String(a.command ?? ""));
	}
	if (READ_TOOLS.has(call.name)) return true;
	if (call.name === "run") {
		const code = String(call.arguments?.code ?? "");
		const nested = call.nested ?? [];
		if (!nested.length) return false;
		const loops = /\bsleep\b|setTimeout|while\s*\(|for\s*\(\s*;\s*;\s*\)|wait_ms/.test(code);
		return loops && nested.every((n) => READ_HELPERS.has(n.helper) || n.helper === "shell.exec");
	}
	return false;
}

/** 1 when the step made calls and every one of them only waited */
export function pollOnly(calls: PollCall[]): 0 | 1 {
	return calls.length > 0 && calls.every(waits) ? 1 : 0;
}
