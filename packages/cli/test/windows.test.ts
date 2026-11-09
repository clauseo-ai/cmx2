import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, buildTarget, installedBinary, RELEASE_TARGETS, sumFor, targetFile } from "../src/release.ts";
import { pathNotes, placeBinary, placeWindows, removeOld } from "../src/service.ts";
import { nextDelay } from "../src/supervise.ts";
import { decodeOutput, parseTaskXml, pathHas, renderTaskXml, splitWinArgs, type TaskSpec, taskArguments, utf16File, winQuote, withPathEntry } from "../src/windows.ts";

const task: TaskSpec = {
	label: "dev.cmx2.serve",
	user: "BOX\\some one",
	conhost: "C:\\Windows\\System32\\conhost.exe",
	binary: "C:\\Users\\some one\\.local\\share\\cmx2\\bin\\cmx2.exe",
	envFile: "C:\\Users\\some one\\.local\\share\\cmx2 & co\\service.env",
	port: 4097,
	hostname: "127.0.0.1",
	workingDirectory: "C:\\Users\\some one",
};

test("the task runs the supervisor under a headless conhost, as the user, at logon, with no password and no time limit", () => {
	const x = renderTaskXml(task);
	expect(x).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
	expect(x).toContain("<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>BOX\\some one</UserId>");
	expect(x).toContain("<LogonType>InteractiveToken</LogonType>");
	expect(x).toContain("<RunLevel>LeastPrivilege</RunLevel>");
	expect(x).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
	expect(x).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
	expect(x).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
	expect(x).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
	expect(x).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
	expect(x).toContain("<Priority>5</Priority>");
	expect(x).toContain("<RestartOnFailure>");
	expect(x).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
	expect(x).toContain("<Arguments>--headless &quot;C:\\Users\\some one\\.local\\share\\cmx2\\bin\\cmx2.exe&quot; serve --supervise --env-file &quot;C:\\Users\\some one\\.local\\share\\cmx2 &amp; co\\service.env&quot; --port 4097 --hostname 127.0.0.1</Arguments>");
	expect(x).not.toMatch(/Password|API_KEY/);
});

test("the binary, port and env file read back from the task's xml, as schtasks /Query /XML prints it", () => {
	const x = renderTaskXml(task);
	const want = { command: task.conhost, binary: task.binary, envFile: task.envFile, port: 4097, hostname: "127.0.0.1" };
	expect(parseTaskXml(x)).toEqual(want);
	// schtasks answers in utf-16 with a mark, or in utf-8; both decode to the same
	expect(parseTaskXml(decodeOutput(utf16File(x)))).toEqual(want);
	expect(parseTaskXml(decodeOutput(new TextEncoder().encode(x)))).toEqual(want);
	expect(parseTaskXml("<Task></Task>")).toEqual({});
});

test("the task file is utf-16 little endian with a byte order mark", () => {
	const b = utf16File("<a/>");
	expect([...b.slice(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00]);
	expect(decodeOutput(b)).toBe("<a/>");
});

test("windows quoting round-trips through the CommandLineToArgvW rules", () => {
	const args = ["plain", "with space", 'a "quoted" word', "C:\\dir with space\\", "trail\\\\", "", "back\\slash"];
	expect(splitWinArgs(args.map(winQuote).join(" "))).toEqual(args);
	expect(winQuote("C:\\x\\cmx2.exe")).toBe("C:\\x\\cmx2.exe");
	expect(winQuote("C:\\a b\\")).toBe('"C:\\a b\\\\"');
	expect(splitWinArgs(taskArguments(task))).toEqual(["--headless", task.binary, "serve", "--supervise", "--env-file", task.envFile, "--port", "4097", "--hostname", "127.0.0.1"]);
});

test("release names: windows assets end in .exe, and every build target's file is the asset its machine asks for", () => {
	expect(assetName("win32", "x64")).toBe("cmx2-windows-x64.exe");
	expect(assetName("win32", "arm64")).toBe("cmx2-windows-arm64.exe");
	expect(assetName("darwin", "arm64")).toBe("cmx2-darwin-arm64");
	expect(assetName("linux", "x64")).toBe("cmx2-linux-x64");
	expect(() => assetName("freebsd", "x64")).toThrow("no cmx2 build for freebsd");
	expect(() => assetName("linux", "ia32")).toThrow("no cmx2 build for ia32");
	expect(buildTarget("win32", "x64")).toBe("bun-windows-x64");
	expect(buildTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
	const machines: Array<[string, string]> = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["win32", "arm64"]];
	expect(RELEASE_TARGETS.map(targetFile)).toEqual(machines.map(([p, a]) => assetName(p, a)));
	expect(RELEASE_TARGETS.map(String)).toEqual(machines.map(([p, a]) => buildTarget(p, a)));
	expect(installedBinary({ CMX2_DATA_DIR: "data" }, "win32")).toBe(join("data", "bin", "cmx2.exe"));
	expect(installedBinary({ CMX2_DATA_DIR: "data" }, "linux")).toBe(join("data", "bin", "cmx2"));
});

test("SHA256SUMS lines with .exe names, as build.ts --all writes them", () => {
	const sums = `${"a".repeat(64)}  cmx2-windows-x64.exe\r\n${"b".repeat(64)}  cmx2-windows-arm64.exe\n${"c".repeat(64)}  cmx2-linux-x64\n`;
	expect(sumFor(sums, "cmx2-windows-x64.exe")).toBe("a".repeat(64));
	expect(sumFor(sums, "cmx2-windows-arm64.exe")).toBe("b".repeat(64));
	expect(sumFor(sums, "cmx2-windows-x64")).toBeUndefined();
});

test("the user PATH gains the bin dir once, compared without case, trailing slash or %VARS%", () => {
	const env = { USERPROFILE: "C:\\Users\\me" };
	const dir = "C:\\Users\\me\\.local\\share\\cmx2\\bin";
	expect(withPathEntry("", dir, env)).toBe(dir);
	expect(withPathEntry("C:\\tools;", dir, env)).toBe(`C:\\tools;${dir}`);
	expect(withPathEntry("C:\\tools;c:\\users\\ME\\.local\\share\\cmx2\\bin\\", dir, env)).toBeUndefined();
	expect(withPathEntry("%USERPROFILE%\\.local\\share\\cmx2\\bin;C:\\tools", dir, env)).toBeUndefined();
	expect(withPathEntry("%userprofile%\\AppData\\Local\\Microsoft\\WindowsApps", dir, env)).toBe(`%userprofile%\\AppData\\Local\\Microsoft\\WindowsApps;${dir}`);
	expect(pathHas('C:\\a;"C:\\Users\\me\\.local\\share\\cmx2\\bin"', dir, env)).toBe(true);
	expect(pathNotes({ kind: "added", dir }).join("\n")).toContain("open a new terminal");
	expect(pathNotes({ kind: "failed", dir, why: "denied" }).join("\n")).toContain("could not add");
});

test("the supervisor backs off from 1 s to 30 s while the daemon dies fast, and starts over after a minute up", () => {
	let d = 0;
	const seen: number[] = [];
	for (let i = 0; i < 7; i++) {
		d = nextDelay(d, 500);
		seen.push(d);
	}
	expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	expect(nextDelay(30000, 61_000)).toBe(1000);
});

test("the windows swap renames the old file aside, puts the new one in place and clears the leftovers it can", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-swap-")));
	const to = join(dir, "cmx2.exe");
	writeFileSync(to, "old");
	writeFileSync(join(dir, "new"), "new");
	writeFileSync(join(dir, "cmx2.exe.old-1"), "stale");
	expect(placeWindows(join(dir, "new"), to, 2).aside).toBe(join(dir, "cmx2.exe.old-2"));
	expect(readFileSync(to, "utf8")).toBe("new");
	// nothing runs the old copies here, so both went
	expect(readdirSync(dir).sort()).toEqual(["cmx2.exe", "new"]);
	// a copy that fails leaves the target as it was
	expect(() => placeWindows(join(dir, "missing"), to)).toThrow();
	expect(readFileSync(to, "utf8")).toBe("new");
	expect(readdirSync(dir).sort()).toEqual(["cmx2.exe", "new"]);
	expect(removeOld(to)).toEqual([]);
});

describe.if(process.platform === "win32")("on windows", () => {
	test("placeBinary replaces an exe that is running: the new file is in place and the running one renamed aside", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-running-")));
		const to = join(dir, "cmx2.exe");
		copyFileSync(process.execPath, to);
		const p = Bun.spawn([to, "-e", "await Bun.sleep(60000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
		await Bun.sleep(1000);
		try {
			// the plain way fails while it runs
			expect(() => copyFileSync(join(dir, "..", "nope-does-not-exist"), to)).toThrow();
			expect(() => writeFileSync(to, "x")).toThrow();
			writeFileSync(join(dir, "fresh.exe"), "new bytes");
			expect(placeBinary(join(dir, "fresh.exe"), to)).toEqual({ kind: "skipped" });
			expect(readFileSync(to, "utf8")).toBe("new bytes");
			const old = readdirSync(dir).filter((n) => n.startsWith("cmx2.exe.old-"));
			expect(old.length).toBe(1);
			// still running, so it stays
			expect(removeOld(to)).toEqual([join(dir, old[0]!)]);
		} finally {
			p.kill();
			await p.exited;
		}
		for (let i = 0; i < 20 && removeOld(to).length; i++) await Bun.sleep(250);
		expect(readdirSync(dir).filter((n) => n.startsWith("cmx2.exe.old-"))).toEqual([]);
		expect(existsSync(to)).toBe(true);
	});

	test("cmx2 upgrade --from a dir with the .exe and SHA256SUMS swaps a running installed cmx2.exe (a real run of the cli)", async () => {
		const h = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-upg-win-")));
		const installed = join(h, "data", "bin", "cmx2.exe");
		mkdirSync(join(h, "data", "bin"), { recursive: true });
		copyFileSync(process.execPath, installed);
		// the release: a copy of this bun, which answers --version with a version above any cmx2's
		const rel = join(h, "rel");
		mkdirSync(rel);
		const asset = join(rel, assetName());
		writeFileSync(asset, readFileSync(process.execPath));
		writeFileSync(join(rel, "SHA256SUMS"), `${new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex")}  ${assetName()}\n`);
		const running = Bun.spawn([installed, "-e", "await Bun.sleep(60000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
		await Bun.sleep(1000);
		try {
			const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/index.ts"), "upgrade", "--from", rel], {
				env: { ...process.env, CMX2_DATA_DIR: join(h, "data"), CMX2_SERVICE_LABEL: "dev.cmx2.windows-test-nothing" },
			});
			const out = `${p.stdout.toString()}${p.stderr.toString()}`;
			expect(out).toContain(`replaced ${installed}`);
			expect(out).toContain("no service installed");
			expect(p.exitCode).toBe(0);
			expect(readdirSync(join(h, "data", "bin")).filter((n) => n.startsWith("cmx2.exe.old-")).length).toBe(1);
		} finally {
			running.kill();
			await running.exited;
		}
	}, 60_000);
});
