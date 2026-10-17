import { expect, test } from "bun:test";
import { certificateKind, parseIdentities, pickIdentity } from "../src/signing.ts";

/** which keychain identity signs the installed copy, read from `security find-identity -v -p codesigning` */

const LIST = `  1) 1111111111111111111111111111111111111111 "Apple Development: Some One (TEAM000001)"
  2) 2222222222222222222222222222222222222222 "Developer ID Application: Some One (TEAM000001)"
  3) 3333333333333333333333333333333333333333 "cmx2 local"
     3 valid identities found
`;

test("the identity list parses to hashes and names", () => {
	const ids = parseIdentities(LIST);
	expect(ids.map((i) => i.hash[0])).toEqual(["1", "2", "3"]);
	expect(ids[2]!.name).toBe("cmx2 local");
	expect(parseIdentities("     0 valid identities found\n")).toEqual([]);
});

test("one made for cmx2 wins, then developer id, then apple development", () => {
	const ids = parseIdentities(LIST);
	expect(pickIdentity(ids)!.name).toBe("cmx2 local");
	expect(pickIdentity(ids.slice(0, 2))!.name).toStartWith("Developer ID Application:");
	expect(pickIdentity(ids.slice(0, 1))!.name).toStartWith("Apple Development:");
	expect(pickIdentity([])).toBeUndefined();
});

test("CMX2_CODESIGN_IDENTITY picks by hash or by part of the name, and a miss picks nothing", () => {
	const ids = parseIdentities(LIST);
	expect(pickIdentity(ids, "1111111111111111111111111111111111111111")!.name).toStartWith("Apple Development:");
	expect(pickIdentity(ids, "Developer ID")!.hash[0]).toBe("2");
	expect(pickIdentity(ids, "nobody")).toBeUndefined();
});

test("output names the certificate's kind, not the person on it", () => {
	expect(certificateKind("Apple Development: Some One (TEAM000001)")).toBe("Apple Development");
	expect(certificateKind("cmx2 local")).toBe("cmx2 local");
});
