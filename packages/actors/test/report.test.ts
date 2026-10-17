import { expect, test } from "bun:test";
import { capBody, computeViolations, extractDeliverable, failedTurnBody, looksLikeMissingDeliverable, parseAbort, reportBody, resolveContract } from "../src/index.ts";

const assistant = (text: string, tool = false) => ({ role: "assistant", content: [{ type: "text", text }, ...(tool ? [{ type: "toolCall", id: "t", name: "read", arguments: { path: "a" } }] : [])] });

test("the newest substantive text wins over a terse wrap-up", () => {
	expect(extractDeliverable([assistant("FULL REPORT BODY ".repeat(40), true), { role: "toolResult" }, assistant("Done.")])).toContain("FULL REPORT BODY");
	expect(extractDeliverable([assistant("only this"), assistant("")])).toBe("only this");
	expect(extractDeliverable([assistant("done.")])).toBe("done.");
	expect(extractDeliverable([])).toBe("");
});

test("extraction reads only the turn it is given, so an earlier task's body never leaks", () => {
	const turn1 = [assistant("LONGBODY ".repeat(50))];
	const turn2 = [{ role: "mail", text: "follow-up" }, assistant("ok.")];
	expect(extractDeliverable(turn2)).toBe("ok.");
	expect(extractDeliverable([...turn1, ...turn2])).toBe("ok.");
});

test("status-line heuristic", () => {
	expect(looksLikeMissingDeliverable("")).toBe(true);
	expect(looksLikeMissingDeliverable("Report delivered to parent")).toBe(true);
	expect(looksLikeMissingDeliverable("Found: src/a.ts:42 checks expiry.")).toBe(false);
	expect(looksLikeMissingDeliverable("done\nwith two lines")).toBe(false);
	// m5 saw these warned; they answered one-line briefs and name what is done
	expect(looksLikeMissingDeliverable("quick is done")).toBe(false);
	expect(looksLikeMissingDeliverable("slow is done.")).toBe(false);
	expect(looksLikeMissingDeliverable("tests pass, report delivered")).toBe(false);
	// nothing but wrap-up words is still no deliverable (the cmx invariants pin "done.")
	expect(looksLikeMissingDeliverable("Done.")).toBe(true);
	expect(looksLikeMissingDeliverable("The task has been completed.")).toBe(true);
});

test("ABORT is read from the last line only", () => {
	expect(parseAbort("Some preamble.\nABORT(spec_wrong): details here.")).toEqual({ reason: "spec_wrong", details: "details here." });
	expect(parseAbort("it said ABORT(spec_wrong): x in the middle\nthen more")).toBeUndefined();
	expect(parseAbort("ABORT(approach_failed):   tried 3 attempts  ")).toEqual({ reason: "approach_failed", details: "tried 3 attempts" });
});

test("bodies are capped with a pointer to the transcript", () => {
	const body = capBody("x".repeat(20), "ses_1", 10);
	expect(body).toStartWith("xxxxxxxxxx\n(10 more characters; the full text is in session ses_1)");
	expect(capBody("short", "ses_1")).toBe("short");
});

test("report body: header first, warning when nothing substantive, the audit tail last", () => {
	const warn = reportBody({ header: "agent /root/a reached status: parked", body: "", warn: true, childID: "ses_a" });
	expect(warn.startsWith("warning: no deliverable")).toBe(true);
	expect(warn).toContain("<no text emitted>");
	expect(warn.endsWith('[child session: ses_a; transcript kept on disk. to continue: message("ses_a")]')).toBe(true);
	expect(reportBody({ header: "h", body: "b", warn: false, childID: "c" })).toStartWith("h\n\nb");
});

test("contracts: missing delivery, undeclared failure modes, versions side by side", () => {
	const v1 = resolveContract("general");
	expect(v1?.version).toBe("subagent_v1");
	expect(resolveContract("general", "subagent_v2")?.version).toBe("subagent_v2");
	expect(resolveContract("nope")).toBeUndefined();
	expect(computeViolations(v1, { delivered: false }).map((v) => v.kind)).toEqual(["missing_delivery"]);
	expect(computeViolations(resolveContract("explore"), { delivered: true, abort: { reason: "approach_failed", details: "x" } }).map((v) => v.kind)).toEqual(["undeclared_failure_mode"]);
	expect(computeViolations(v1, { delivered: true, abort: { reason: "approach_failed", details: "x" } })).toEqual([]);
});

test("a failed turn's text says whether it was cut off or is a note from earlier in the turn", () => {
	const failedThinking = { role: "assistant", stopReason: "error", content: [{ type: "thinking", thinking: "weighing the build slots" }] };
	const early = extractDeliverable([assistant("Tests are pure; flipping the default is safe.", true), { role: "toolResult" }, failedThinking]);
	expect(early).toBe("Tests are pure; flipping the default is safe.");
	expect(failedTurnBody([assistant(early, true), { role: "toolResult" }, failedThinking], early)).toBe("it had not written a report. its last text, from earlier in the turn:\n\nTests are pure; flipping the default is safe.");
	const cut = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "the fix is in and the suite" }] };
	expect(failedTurnBody([assistant("reading", true), { role: "toolResult" }, cut], "the fix is in and the suite")).toStartWith("it failed while writing this; the text stops where the turn did:\n\n");
	expect(failedTurnBody([failedThinking], "")).toBe("");
});
