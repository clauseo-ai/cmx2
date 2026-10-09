/**
 * what a child's report says: the deliverable pulled from the turn that just ended (never from before
 * the item that started it), capped, with the ABORT phrase parsed and a warning when there is nothing
 * substantive to hand back. ported from cmx's completion watcher (`agent/control.ts`, D5 and D11), with
 * the extraction bounded to the turn (the cmx defect: a terse follow-up reply returned the previous
 * task's body).
 */

/** a report body longer than this is cut; the rest stays in the child's transcript */
export const REPORT_MAX_CHARS = 12_000;

/** joined text blocks of an assistant message; tool calls and thinking are not the deliverable */
export function textOf(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c.trim();
	if (!Array.isArray(c)) return "";
	return c
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n")
		.trim();
}

const STATUS_WORDS = /\b(delivered|complete|completed|done|no further|closing|closed)\b/i;
/** words a wrap-up line is made of; anything else in it names what was done */
const WRAP_UP = /\b(the|a|an|my|this|that|these|task|tasks|work|report|reports|result|results|is|are|was|were|has|have|had|been|i|i've|ive|all|now|here|it|its|job|to|you|parent|sent|delivered|complete|completed|done|finished|no|further|closing|closed|action|actions|needed|and|with|as|requested|asked|over|back)\b/gi;

/**
 * empty, or one short line made only of wrap-up words ("done.", "report delivered"): not a deliverable.
 * a short line that names something ("quick is done", what a one-line brief usually asks for) is one
 */
export function looksLikeMissingDeliverable(body: string): boolean {
	if (body.length === 0) return true;
	if (body.length >= 200 || body.includes("\n")) return false;
	if (!STATUS_WORDS.test(body)) return false;
	return body.replace(WRAP_UP, "").replace(/[^\p{L}\p{N}]+/gu, "").length === 0;
}

/** `ABORT(reason): details` on the last non-empty line only, so prose that mentions the phrase is not an abort */
export function parseAbort(body: string): { reason: string; details: string } | undefined {
	const trimmed = body.trimEnd();
	const i = trimmed.lastIndexOf("\n");
	const last = i === -1 ? trimmed : trimmed.slice(i + 1);
	const m = last.match(/^ABORT\(([a-z_]+)\):\s*(.+?)\s*$/);
	return m ? { reason: m[1]!, details: m[2]! } : undefined;
}

/**
 * the deliverable of one turn: assistant messages after the triggering item only, newest first; the
 * newest substantive text wins, else the newest non-empty one (so a terse "done." after a long report
 * does not hide the report).
 */
export function extractDeliverable(turn: any[]): string {
	const texts = turn
		.filter((m) => m?.role === "assistant")
		.map(textOf)
		.filter((t) => t.length > 0)
		.reverse();
	return texts.find((t) => !looksLikeMissingDeliverable(t)) ?? texts[0] ?? "";
}

/** the cap: head of the body and where the rest is */
export function capBody(body: string, sessionID: string, max = REPORT_MAX_CHARS): string {
	if (body.length <= max) return body;
	return `${body.slice(0, max)}\n(${body.length - max} more characters; the full text is in session ${sessionID})`;
}

/** paths a turn wrote or edited, from its tool calls (native and run helpers) */
export function filesTouched(turn: any[]): string[] {
	const out = new Set<string>();
	for (const m of turn) {
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b?.type !== "toolCall") continue;
			const path = b.arguments?.path;
			if ((b.name === "write" || b.name === "edit") && typeof path === "string") out.add(path);
		}
	}
	return [...out];
}

const WARNING = "warning: no deliverable. the child ended its turn without a substantive final text or a message to you; its last text follows:";

/** header first so a client (and the pool collector) can key on it; the audit tail names the transcript */
export function reportBody(opts: { header: string; body: string; warn: boolean; childID: string; footer?: string }): string {
	const tail = `[child session: ${opts.childID}; transcript kept on disk. to continue: message("${opts.childID}")]`;
	const main = opts.warn ? [WARNING, "", opts.body.length ? opts.body : "<no text emitted>", "", opts.header].join("\n") : opts.body.length ? `${opts.header}\n\n${opts.body}` : opts.header;
	return [main, ...(opts.footer ? [opts.footer] : []), tail].join("\n\n");
}
