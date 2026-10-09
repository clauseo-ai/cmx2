import { expect, test } from "bun:test";
import { effortsFor } from "../src/dialogs.ts";
import { imageMimeOfPath } from "../src/format.ts";
import { apply, initialState } from "../src/state.ts";

const ALL = ["low", "medium", "high", "xhigh", "max"];
const catalog = {
	providers: [
		{
			id: "anthropic",
			models: {
				"claude-opus-5-5": { variants: { low: {}, medium: {}, high: {}, max: {}, quick: {} } },
				"claude-locked": { variants: {} },
			},
		},
	],
};

test("the effort picker offers what the daemon lists for the model, never the five rungs it refused", () => {
	expect(effortsFor(catalog, "anthropic/claude-opus-5-5", ALL)).toEqual(["low", "medium", "high", "max", "quick"]);
	// routing forbids every effort: the list is empty, and stays empty
	expect(effortsFor(catalog, "anthropic/claude-locked", ALL)).toEqual([]);
});

test("the five rungs are for no model, or one the catalog has not loaded", () => {
	expect(effortsFor(catalog, undefined, ALL)).toEqual(ALL);
	expect(effortsFor(undefined, "anthropic/claude-opus-5-5", ALL)).toEqual(ALL);
	expect(effortsFor(catalog, "anthropic/not-listed", ALL)).toEqual(ALL);
});

test("a heic or heif path typed or dropped into the prompt rides as an image file part", () => {
	expect(imageMimeOfPath("/Users/me/Downloads/IMG_0001.HEIC")).toBe("image/heic");
	expect(imageMimeOfPath("photo.heif")).toBe("image/heif");
	expect(imageMimeOfPath("shot.PNG")).toBe("image/png");
	expect(imageMimeOfPath("notes.txt")).toBeUndefined();
	expect(imageMimeOfPath("noextension")).toBeUndefined();
});

test("an escalation shows the effort in force until it comes back down, and a session read in between does not undo it", () => {
	const s = initialState();
	s.sessionID = "ses_x";
	const at = (type: string, properties: Record<string, unknown>) => apply(s, { type, properties } as never);
	at("session.updated", { info: { id: "ses_x", effort: "low" } });
	expect(s.effort).toBe("low");
	at("session.escalated", { sessionID: "ses_x", from: "low", to: "medium", reason: "x" });
	expect(s.effort).toBe("medium");
	at("session.updated", { info: { id: "ses_x", effort: "low" } });
	expect(s.effort).toBe("medium");
	at("session.deescalated", { sessionID: "ses_x", from: "medium", to: "low", reason: "y" });
	expect(s.effort).toBe("low");
	at("session.updated", { info: { id: "ses_x", effort: "high" } });
	expect(s.effort).toBe("high");
});
