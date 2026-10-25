import { randomUUID } from "node:crypto";
import type { CallDecision, Tool, ToolResult } from "@cmx2/tools";
import { Value } from "typebox/value";
import {
	checksFor,
	evaluate,
	PERMISSION_REJECTED,
	type PermissionCheck,
	type PermissionReply,
	type PermissionRule,
	permissionCorrected,
	permissionDenied,
} from "./permission.ts";

/**
 * the permission gate and the nested call, apart from the session so they can be driven without a
 * model. a native call and a helper call inside `run` go through the same two functions.
 */

export interface GateOptions {
	cwd: string;
	/** configured rules then saved "always" rules, read at every check */
	rules: () => PermissionRule[];
	/** asks whoever is connected; without it, a call that needs asking is refused */
	ask?: (check: PermissionCheck, callID: string, signal?: AbortSignal) => Promise<{ reply: PermissionReply; message?: string }>;
}

export interface GateResult {
	/** the refusal the model reads; absent when the call may run */
	refused?: string;
	decision: CallDecision;
}

const ruleText = (r: PermissionRule) => `${r.permission} ${r.pattern}: ${r.action}`;

/**
 * the checks for one call: deny wins at once, allow passes, anything else asks and waits. the
 * decision records how it came out, so a script's nested calls can be read back one by one.
 */
export async function gateCall(o: GateOptions, tool: string, args: unknown, callID: string, signal?: AbortSignal): Promise<GateResult> {
	const checks = checksFor(tool, args, o.cwd);
	if (checks.length === 0) return { decision: { permission: "none" } };
	let decision: CallDecision = { permission: "allow" };
	for (const check of checks) {
		const rules = o.rules();
		let asking: PermissionRule | undefined;
		for (const pattern of check.patterns) {
			const rule = evaluate(rules, check.permission, pattern);
			if (rule.action === "deny") return { refused: permissionDenied(rule), decision: { permission: "deny", rule: ruleText(rule) } };
			if (rule.action === "ask") asking ??= rule;
			else if (!decision.rule) decision = { permission: "allow", rule: ruleText(rule) };
		}
		if (!asking) continue;
		if (!o.ask) {
			return {
				refused: `this call needs the user's permission (${check.permission} ${check.patterns.join(" ")}) and no client is connected to ask`,
				decision: { permission: "ask:reject", rule: ruleText(asking) },
			};
		}
		const answer = await o.ask(check, callID, signal);
		if (answer.reply === "reject") {
			return { refused: answer.message ? permissionCorrected(answer.message) : PERMISSION_REJECTED, decision: { permission: "ask:reject", rule: ruleText(asking) } };
		}
		// one "always" among several checks still reads as always; once is the weaker answer
		if (decision.permission !== "ask:always") decision = { permission: `ask:${answer.reply}`, rule: ruleText(asking) };
	}
	return { decision };
}

/**
 * names models reach for from their training, accepted at dispatch and never declared: a call to a tool
 * named on the left runs the tool on the right, and an argument named on the left is read as the one on
 * the right (str_replace's old_str and new_str for edit's old_text and new_text)
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = { bash: "shell" };
export const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = { edit: { old_str: "old_text", new_str: "new_text" } };

/** the tool a call's name stands for: itself when a tool has that name, else its alias */
export function toolAlias(name: string, exists: (name: string) => boolean): string {
	const to = Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name]! : undefined;
	return to && !exists(name) ? to : name;
}

/** a call's arguments with aliased names renamed; when the call gives both names, the real one wins */
export function aliasArgs(tool: string, args: unknown): unknown {
	const map = Object.hasOwn(ARG_ALIASES, tool) ? ARG_ALIASES[tool] : undefined;
	if (!map || !args || typeof args !== "object" || Array.isArray(args)) return args;
	const a = args as Record<string, unknown>;
	if (!Object.keys(map).some((k) => Object.hasOwn(a, k))) return args;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) {
		const to = Object.hasOwn(map, k) ? map[k]! : undefined;
		if (to && !Object.hasOwn(a, to)) out[to] = v;
		else if (!to) out[k] = v;
	}
	return out;
}

/** a helper call from inside `run`: the same tool object, schema check, permission gate and error shape as a direct call */
export async function nestedCall(
	o: GateOptions,
	lookup: (name: string) => Tool | undefined,
	name: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<{ result: ToolResult; isError: boolean; decision?: CallDecision }> {
	const fail = (t: string, decision?: CallDecision) => ({ result: { content: [{ type: "text" as const, text: t }], details: {} }, isError: true, decision });
	name = toolAlias(name, (n) => lookup(n) !== undefined);
	args = aliasArgs(name, args);
	const tool = lookup(name);
	if (!tool) return fail(`no tool named ${name}`);
	if (!Value.Check(tool.parameters, args)) {
		const first = [...Value.Errors(tool.parameters, args)][0];
		const where = first ? `${(first as { instancePath?: string }).instancePath || "(root)"} ${first.message}` : "does not match the schema";
		return fail(`${name}: invalid arguments: ${where}`);
	}
	const callID = `nested_${randomUUID().slice(0, 8)}`;
	const gate = await gateCall(o, name, args, callID, signal);
	if (gate.refused) return fail(gate.refused, gate.decision);
	try {
		const result = await tool.execute(callID, args as never, signal);
		return { result, isError: result.isError === true, decision: gate.decision };
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e), gate.decision);
	}
}
