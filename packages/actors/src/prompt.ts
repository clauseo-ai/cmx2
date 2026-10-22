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
	const deliverable = "your final reply is your deliverable: the daemon saves it in full to a file your spawner's report names, so when a brief asks you to write something to a file, put it in your final reply instead.";
	if (opts.readOnly) lines.push("", `your tools read and search; you do not change files or run commands. ${deliverable}`);
	else if (opts.review) lines.push("", `your tools read, search and run commands; you do not change files. ${deliverable}`);
	if (opts.typeBody) lines.push("", opts.typeBody.trim());
	return lines.join("\n");
}

/**
 * an earlier attempt at the same task, attached to the first message of the helper that takes it over. it names the
 * earlier helper by path and never its model or effort: a helper is not told what it runs on
 */
export function attemptAttachment(opts: { path: string; brief: string; lastInstruction?: string; report: string | undefined }): string {
	return [
		`an earlier attempt at this task, by ${opts.path}.`,
		"its brief:",
		opts.brief.trim(),
		...(opts.lastInstruction?.trim() ? ["its last instruction:", opts.lastInstruction.trim()] : []),
		"its last report:",
		opts.report?.trim() || "none",
	].join("\n");
}

/**
 * the first message a helper reads: who it is, who started it, then the brief and anything attached. it does not
 * name the helper's model or effort (escalation can change effort mid-session, and a stated effort invites the
 * model to scale its work to the label); the spawner's reasoning for the choice goes in `why`, which stays out of this
 */
export function taskEnvelope(opts: { path: string; id: string; spawnerPath: string; spawnerID: string; brief: string; attachments?: string[] }): string {
	const head = `you are ${opts.path} (session ${opts.id}), started by ${opts.spawnerPath} (session ${opts.spawnerID}).`;
	return [head, "", opts.brief.trim(), ...(opts.attachments?.length ? ["", ...opts.attachments] : [])].join("\n");
}
