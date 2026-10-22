import { expect, test } from "bun:test";
import { attemptAttachment, helperFragment, taskEnvelope } from "../src/prompt.ts";

test("the helper prompt names no seat and no model, and is byte-identical however the helper is called", () => {
	const a = helperFragment();
	const b = helperFragment();
	expect(a).toBe(b);
	expect(a).not.toMatch(/seat|sonnet|opus|haiku|fable|claude/i);
	expect(a.startsWith("you are a helper another agent started. your first message names you")).toBe(true);
	expect(a).toContain("ABORT(<reason>): <details>, with reason one of spec_wrong, transient_tool_error, out_of_scope, context_full, approach_failed, user_question.");
	// identity rides the first message, so two helpers with different names and paths share these bytes
	expect(taskEnvelope({ path: "/root/a", id: "ses_1", spawnerPath: "/root", spawnerID: "ses_0", brief: "x" })).not.toContain(a);
});

test("explore and review add their own line, then the type body", () => {
	expect(helperFragment({ readOnly: true })).toContain("your tools read and search; you do not change files or run commands.");
	expect(helperFragment({ review: true })).toContain("your tools read, search and run commands; you do not change files.");
	expect(helperFragment({ review: true, typeBody: "  check the diff.\n" })).toEndWith("put it in your final reply instead.\n\ncheck the diff.");
	expect(helperFragment({ typeBody: "be brief" })).toEndWith("approach_failed, user_question.\n\nbe brief");
});

test("the first message says who started it, then the brief; an earlier attempt rides after the brief and names no model or effort", () => {
	const earlier = attemptAttachment({ path: "/root/memo", brief: "  fix the thing\n", report: undefined });
	expect(earlier).toBe("an earlier attempt at this task, by /root/memo.\nits brief:\nfix the thing\nits last report:\nnone");
	// a follow-up that changed the task rides separately from the brief it started with
	expect(attemptAttachment({ path: "/root/memo", brief: "fix it", lastInstruction: " now only the tests ", report: "done" })).toBe(
		"an earlier attempt at this task, by /root/memo.\nits brief:\nfix it\nits last instruction:\nnow only the tests\nits last report:\ndone",
	);
	expect(taskEnvelope({ path: "/root/b", id: "ses_2", spawnerPath: "/root", spawnerID: "ses_0", brief: "do it", attachments: [earlier] })).toBe(
		`you are /root/b (session ses_2), started by /root (session ses_0).\n\ndo it\n\n${earlier}`,
	);
	// the helper is not told its model or effort, so neither a model name nor the word effort reaches it
	const first = taskEnvelope({ path: "/root/b", id: "ses_2", spawnerPath: "/root", spawnerID: "ses_0", brief: "do it", attachments: [earlier] });
	expect(first).not.toMatch(/effort|claude|sonnet|opus|haiku|fable/i);
});
