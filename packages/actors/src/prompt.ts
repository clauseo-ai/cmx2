import { ABORT_REASONS } from "./contracts.ts";

/**
 * the text a helper's system prompt gains at spawn, after the model profile. it depends on the agent
 * type only, never on the helper's model, name, path or task, so every helper of one agent type shares
 * a byte-identical prefix on a given model and siblings reuse each other's cache. identity rides the
 * first message.
 */
export function helperFragment(opts: { typeBody?: string; readOnly?: boolean; review?: boolean } = {}): string {
	const lines = [
		"you are a helper another agent started. your first message names you, your path in the agent tree and who started you, then gives the task.",
		"",
		"when the task is done, end your turn with the deliverable as your final text: outcome first, exact identifiers (paths with line numbers, commands, values), what you verified and how, what you did not. that text reaches your spawner as a report. you stay addressable afterwards: your spawner can message you again and you carry on with everything you already know.",
		"",
		"message reaches another agent in your tree by id, path or name; use it when someone needs a partial finding before you finish. question asks your spawner and waits for its answer; it answers or asks further up for you. messages to you arrive as agent-message blocks.",
		"",
		`if you cannot go on, make the last line of your final text ABORT(<reason>): <details>, with reason one of ${ABORT_REASONS.join(", ")}.`,
	];
	if (opts.readOnly) lines.push("", "your tools read and search; you do not change files or run commands.");
	else if (opts.review) lines.push("", "your tools read, search and run commands; you do not change files.");
	if (opts.typeBody) lines.push("", opts.typeBody.trim());
	return lines.join("\n");
}

/** an earlier attempt at the same task, attached to the first message of the helper that takes it over */
export function attemptAttachment(opts: { path: string; model: string; effort: string; brief: string; lastInstruction?: string; report: string | undefined }): string {
	return [
		`an earlier attempt at this task, by ${opts.path} on ${opts.model} at ${opts.effort} effort.`,
		"its brief:",
		opts.brief.trim(),
		...(opts.lastInstruction?.trim() ? ["its last instruction:", opts.lastInstruction.trim()] : []),
		"its last report:",
		opts.report?.trim() || "none",
	].join("\n");
}

/** the first message a helper reads: who it is, who started it, then the brief and anything attached */
export function taskEnvelope(opts: { path: string; id: string; model: string; effort: string; spawnerPath: string; spawnerID: string; brief: string; attachments?: string[] }): string {
	const head = `you are ${opts.path} (session ${opts.id}), on ${opts.model} at ${opts.effort} effort, started by ${opts.spawnerPath} (session ${opts.spawnerID}).`;
	return [head, "", opts.brief.trim(), ...(opts.attachments?.length ? ["", ...opts.attachments] : [])].join("\n");
}
