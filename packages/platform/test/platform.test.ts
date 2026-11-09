import { describe, expect, test } from "bun:test";
import { COMMAND_VAR, WINDOWS_WRAPPER, compiledRoot, findGitBash, gitRootOf, parseNetstat, pidAlive, processStartMs, startStamp } from "../src/index.ts";

describe("compiledRoot", () => {
	test("names the virtual root of a binary on each platform, and nothing for source", () => {
		expect(compiledRoot("file:///$bunfs/root/cmx2")).toBe("file:///$bunfs/root/");
		expect(compiledRoot("file:///B:/~BUN/root/cmx2.exe")).toBe("file:///B:/~BUN/root/");
		expect(compiledRoot("file:///B:/~BUN/root/tools/src/codemode-worker.js")).toBe("file:///B:/~BUN/root/");
		expect(compiledRoot("file:///Users/x/cmx2/packages/tools/src/run.ts")).toBeUndefined();
	});
});

describe("findGitBash", () => {
	const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u", PATH: "x" };
	const files = (...paths: string[]) => (p: string) => paths.some((f) => f.toLowerCase() === p.toLowerCase());

	test("the git root of each git.exe layout", () => {
		expect(gitRootOf("C:\\Program Files\\Git\\cmd\\git.exe")).toBe("C:\\Program Files\\Git");
		expect(gitRootOf("C:\\Program Files\\Git\\bin\\git.exe")).toBe("C:\\Program Files\\Git");
		expect(gitRootOf("D:\\tools\\git\\mingw64\\bin\\git.exe")).toBe("D:\\tools\\git");
		expect(gitRootOf("C:\\Users\\u\\scoop\\shims\\git.exe")).toBeUndefined();
	});

	test("bin\\bash.exe beside the git on PATH, never System32's wsl launcher", () => {
		const r = findGitBash({ env, exists: files("D:\\git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe"), which: () => "D:\\git\\cmd\\git.exe" });
		expect(r).toEqual({ path: "D:\\git\\bin\\bash.exe", from: "git" });
	});

	test("the usual install places when git is not on PATH", () => {
		expect(findGitBash({ env, exists: files("C:\\Program Files\\Git\\bin\\bash.exe"), which: () => null })).toEqual({ path: "C:\\Program Files\\Git\\bin\\bash.exe", from: "default" });
		expect(findGitBash({ env, exists: files("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"), which: () => null })).toEqual({ path: "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe", from: "default" });
	});

	test("CMX2_GIT_BASH wins, must exist and must not be the wsl launcher", () => {
		const any = () => true;
		expect(findGitBash({ env: { ...env, CMX2_GIT_BASH: "E:\\g\\bin\\bash.exe" }, exists: any, which: () => null })).toEqual({ path: "E:\\g\\bin\\bash.exe", from: "CMX2_GIT_BASH" });
		const wsl = findGitBash({ env: { ...env, CMX2_GIT_BASH: "C:\\Windows\\System32\\bash.exe" }, exists: any, which: () => null });
		expect("error" in wsl && wsl.error).toContain("wsl launcher");
		const gone = findGitBash({ env: { ...env, CMX2_GIT_BASH: "E:\\nope\\bash.exe" }, exists: () => false, which: () => null });
		expect("error" in gone && gone.error).toContain("no file there");
	});

	test("nothing found says how to fix it", () => {
		const r = findGitBash({ env, exists: () => false, which: () => null });
		expect("error" in r && r.error).toContain("winget install --id Git.Git -e");
	});
});

describe("parseNetstat", () => {
	test("listening rows by pid, ipv4 and ipv6, whatever the state word says", () => {
		const text = [
			"",
			"Active Connections",
			"",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040",
			"  TCP    127.0.0.1:4830         0.0.0.0:0              ABH\u00d6REN         7712",
			"  TCP    127.0.0.1:4830         127.0.0.1:50122        ESTABLISHED     7712",
			"  TCP    127.0.0.1:50122        127.0.0.1:4830         ESTABLISHED     9001",
			"  TCP    [::]:135               [::]:0                 LISTENING       1040",
			"  TCP    [::1]:5173             [::]:0                 LISTENING       7712",
			"  UDP    0.0.0.0:5353           *:*                                    2200",
		].join("\r\n");
		const m = parseNetstat(text);
		expect([...m.keys()].sort()).toEqual([1040, 7712]);
		expect([...m.get(1040)!]).toEqual([135]);
		expect([...m.get(7712)!].sort()).toEqual([4830, 5173]);
	});
});

describe("process start times", () => {
	test("a live pid has one stamp, read twice; a pid that is gone has none", async () => {
		const a = startStamp(process.pid);
		expect(a).toBeTruthy();
		expect(startStamp(process.pid)).toBe(a!);
		const started = processStartMs(process.pid);
		expect(started).toBeGreaterThan(0);
		// ps prints to the second; windows to the 100 ns tick
		expect(Math.abs(started! - (Date.now() - process.uptime() * 1000))).toBeLessThan(3000);
		const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
		await child.exited;
		expect(pidAlive(child.pid)).toBe(false);
		expect(startStamp(child.pid)).toBeUndefined();
	});
});

describe("the windows command wrapper", () => {
	// windows runs every command as bash -c WINDOWS_WRAPPER with the command in COMMAND_VAR; any bash runs it the same way
	test.skipIf(process.platform === "win32")("runs the command from the env var, byte for byte, with the var gone", () => {
		const command = 'printf "%s|" "${CMX2_COMMAND-unset}" \'a\\\\b "c"\' "$((1 + 2))"; exit 4';
		const r = Bun.spawnSync(["bash", "-c", WINDOWS_WRAPPER], { env: { ...process.env, [COMMAND_VAR]: command } });
		expect(r.stdout.toString()).toBe('unset|a\\\\b "c"|3|');
		expect(r.exitCode).toBe(4);
		expect(WINDOWS_WRAPPER).not.toContain("\\");
	});
});
