import { expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

const ctx = { home: "/Users/jdoe", user: "jdoe", hosts: ["jdoes-laptop.example.com", "jdoes-laptop"] };

test("a shareable report keeps loopback and ports but not hosts, homes, users, ips or keys", () => {
	const report = [
		"ok    profile  read /Users/jdoe/.config/cmx2/cmx2.jsonc",
		"ok    daemon   cmx2 0.1.0 answers on http://127.0.0.1:4097 (pid 42)",
		"fail  model    https://proxy.internal:8080/v1 refused: invalid x-api-key sk-ant-api03-AbCdEf123456",
		"note  peer     http://user:pw@10.1.2.3:4096/global/health from vm-a.tail1234.ts.net",
		"warn  host     jdoes-laptop runs as jdoe in /home/other/x, token Bearer abc.def.ghi123456",
		"note  blob     aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZzEyMw==",
		"ok    service  /private/tmp/cmx2-m8-svc/home/Library/LaunchAgents/dev.cmx2.serve.m8test.plist, binary /tmp/cmx2-m8-svc/data/bin/cmx2",
	].join("\n");
	const out = redact(report, ctx);
	expect(out).toContain("read ~/.config/cmx2/cmx2.jsonc");
	expect(out).toContain("http://127.0.0.1:4097");
	expect(out).toContain("https://<host>:8080/v1");
	expect(out).toContain("<secret>");
	expect(out).toContain("http://<host>:4096/global/health from <host>");
	expect(out).toContain("<host> runs as <user> in /home/<user>/x, token Bearer <secret>");
	expect(out).toContain("/private/tmp/cmx2-m8-svc/home/Library/LaunchAgents/dev.cmx2.serve.m8test.plist, binary /tmp/cmx2-m8-svc/data/bin/cmx2");
	for (const leak of ["jdoe", "proxy.internal", "10.1.2.3", "tail1234", "AbCdEf123456", "user:pw", "ghi123456", "aGVsbG8"]) expect(out).not.toContain(leak);
});

test("a home under a symlinked folder is masked by its resolved path too (/tmp is /private/tmp on macos)", () => {
	const { realpathSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const home = mkdtempSync("/tmp/cmx2-redact-home-");
	const real = realpathSync(home);
	const out = redact(`binary ${real}/.local/bin/cmx2 and ${home}/.config`, { home, user: "nobody-here", hosts: [] });
	expect(out).toBe("binary ~/.local/bin/cmx2 and ~/.config");
});
