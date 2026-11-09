import { describe, expect, test } from "bun:test";
import { compiledRoot, findGitBash, gitRootOf } from "../src/index.ts";

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
