import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, sumFor } from "../src/release.ts";
import { keyNames, parseEnvFile, renderEnvFile, renderLaunchd, renderSystemd, servicePath, type UnitSpec } from "../src/service.ts";

const spec: UnitSpec = {
	label: "dev.cmx2.serve",
	binary: "/home/someone/.local/share/cmx2/bin/cmx2",
	port: 4097,
	hostname: "127.0.0.1",
	env: { HOME: "/home/someone", PATH: "/usr/bin:/bin", CMX2_CONFIG_DIR: "/home/someone/.config/cmx2 & co" },
	envFile: "/home/someone/.local/share/cmx2/service.env",
	logDir: "/home/someone/.local/share/cmx2/log",
	workingDirectory: "/home/someone",
};

test("the launchd agent runs the copied binary through sh with the env file, keeps alive, and holds no keys", () => {
	const plist = renderLaunchd(spec);
	expect(plist).toContain("<string>dev.cmx2.serve</string>");
	expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
	expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
	expect(plist).toContain(`<string>${spec.envFile}</string>\n\t\t<string>${spec.binary}</string>`);
	expect(plist).toContain("exec &quot;$1&quot; 'serve' '--port' '4097' '--hostname' '127.0.0.1'");
	expect(plist).toContain("/home/someone/.config/cmx2 &amp; co");
	expect(plist).toContain("<string>/home/someone/.local/share/cmx2/log/serve.log</string>");
	expect(plist).not.toMatch(/API_KEY/);
});

test.if(process.platform === "darwin")("plutil accepts the rendered plist", () => {
	const dir = mkdtempSync(join(tmpdir(), "cmx2-plist-"));
	const path = join(dir, "dev.cmx2.serve.plist");
	writeFileSync(path, renderLaunchd(spec));
	const r = Bun.spawnSync(["plutil", "-lint", path]);
	expect(r.stdout.toString().trim()).toBe(`${path}: OK`);
	expect(r.exitCode).toBe(0);
});

test("the systemd unit restarts always, reads the env file if present and quotes what needs it", () => {
	const unit = renderSystemd({ ...spec, env: { ...spec.env, LANG: "en_US.UTF-8", ODD: 'a "b" 50%' } });
	expect(unit).toContain("ExecStart=/home/someone/.local/share/cmx2/bin/cmx2 serve --port 4097 --hostname 127.0.0.1");
	expect(unit).toContain("Restart=always");
	expect(unit).toContain("EnvironmentFile=-/home/someone/.local/share/cmx2/service.env");
	expect(unit).toContain('Environment="ODD=a \\"b\\" 50%%"');
	expect(unit).toContain("WantedBy=default.target");
	expect(unit).not.toMatch(/API_KEY/);
});

test("the env file round-trips values with quotes and spaces, the way sh reads it", () => {
	const vars = { ANTHROPIC_API_KEY: "sk-ant-abc'def ghi", OTHER: "$not expanded" };
	const text = renderEnvFile(vars);
	expect(parseEnvFile(text)).toEqual(vars);
	const dir = mkdtempSync(join(tmpdir(), "cmx2-env-"));
	writeFileSync(join(dir, "env"), text);
	const r = Bun.spawnSync(["/bin/sh", "-c", `set -a; . "${join(dir, "env")}"; printf '%s|%s' "$ANTHROPIC_API_KEY" "$OTHER"`]);
	expect(r.stdout.toString()).toBe("sk-ant-abc'def ghi|$not expanded");
});

test("key names include the profile's $references", () => {
	expect(keyNames({ providers: { proxy: { apiKey: "$PROXY_KEY" }, lit: { apiKey: "x" }, b: { apiKey: "${BRACED}" } } })).toEqual(["ANTHROPIC_API_KEY", "BRACED", "CMX2_SERVER_PASSWORD", "GEMINI_API_KEY", "OPENAI_API_KEY", "PROXY_KEY"]);
});

test("release helpers: sums and version order", () => {
	const sums = `${"a".repeat(64)}  cmx2-darwin-arm64\n${"b".repeat(64)} *cmx2-linux-x64\n`;
	expect(sumFor(sums, "cmx2-darwin-arm64")).toBe("a".repeat(64));
	expect(sumFor(sums, "cmx2-linux-x64")).toBe("b".repeat(64));
	expect(sumFor(sums, "cmx2-linux-arm64")).toBeUndefined();
	expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
	expect(compareVersions("0.1.0", "0.1.0-dev")).toBe(1);
	expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
	expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
});

test("the unit's PATH drops a version manager's per-shell links and missing directories", () => {
	const here = new Set(["/Users/me/.bun/bin", "/opt/homebrew/bin", "/usr/bin", "/Users/me/.local/state/fnm_multishells/18731_1790691598682/bin"]);
	const path = "/Users/me/.local/state/fnm_multishells/18731_1790691598682/bin:/Users/me/.bun/bin:/gone/bin:/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin";
	expect(servicePath(path, (p) => here.has(p))).toBe("/Users/me/.bun/bin:/opt/homebrew/bin:/usr/bin");
	expect(servicePath(undefined)).toBe("/usr/local/bin:/usr/bin:/bin");
});
