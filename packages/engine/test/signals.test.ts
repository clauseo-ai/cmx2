import { expect, test } from "bun:test";
import { shellWrites } from "../src/session.ts";
test("shellWrites", () => {
	expect(shellWrites("printf 'x' >> src/math.ts")).toEqual(["src/math.ts"]);
	expect(shellWrites("cat >> src/strings.ts <<'EOF'\nx\nEOF")).toEqual(["src/strings.ts"]);
	expect(shellWrites("bun test 2>&1 | tail -30")).toEqual([]);
	expect(shellWrites("echo hi > /dev/null; echo a | tee -a notes.md")).toEqual(["notes.md"]);
	expect(shellWrites("sed -i '' 's/a/b/' src/x.ts")).toEqual(["src/x.ts"]);
	expect(shellWrites("ls 2>/dev/null")).toEqual([]);
});
