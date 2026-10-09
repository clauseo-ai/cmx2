import { expect, test } from "bun:test";
import { summariseDetails } from "../src/projection.ts";

/** an edit's or a write's filediff rides outside the 4 kb cap on a tool's metadata, and only theirs does */

const filediff = (patch: string) => ({ file: "/x/a.ts", patch, additions: 3, deletions: 1 });
const small = filediff("@@ -1 +1 @@\n-a\n+b\n");
const big = filediff("+x\n".repeat(20_000));

test("edit and write keep a filediff whose patch is bounded, beside the details the cap still governs", () => {
	for (const tool of ["edit", "write"]) {
		expect(summariseDetails({ path: "/x/a.ts", replacements: 1, line: 3, truncated: false, filediff: big }, tool)).toEqual({ path: "/x/a.ts", replacements: 1, line: 3, truncated: false, filediff: big });
		// other details over 4 kb are still cut, and the diff still rides
		expect(summariseDetails({ junk: "z".repeat(5000), filediff: small }, tool)).toEqual({ truncated: true, filediff: small });
	}
});

test("any other tool's filediff is held to the cap like the rest of its details", () => {
	expect(summariseDetails({ path: "/x", filediff: big }, "shell")).toEqual({ truncated: true });
	expect(summariseDetails({ path: "/x", filediff: small }, "grep")).toEqual({ path: "/x", filediff: small });
	expect(summariseDetails({ filediff: big })).toEqual({ truncated: true });
});

test("an edit's filediff that is not a diff this daemon made (no counts, or a patch far past the cap) is held to the cap", () => {
	expect(summariseDetails({ filediff: { file: "/x", patch: "p" } }, "edit")).toEqual({ filediff: { file: "/x", patch: "p" } });
	expect(summariseDetails({ filediff: filediff("y".repeat(200_000)) }, "write")).toEqual({ truncated: true });
	expect(summariseDetails({ filediff: "text" }, "edit")).toEqual({ filediff: "text" });
});
