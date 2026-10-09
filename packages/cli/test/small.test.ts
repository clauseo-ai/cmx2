import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "@cmx2/server";
import { assetName } from "../src/release.ts";
import { keepLink, linkBinary, linkDir, linkNotes, placeBinary, run } from "../src/service.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-link-")));
const binary = join(home, ".local", "share", "cmx2", "bin", "cmx2");
writeFileSync(join(home, "old"), "v1");

test("the link dir is $CMX2_INSTALL_DIR, else ~/.local/bin", () => {
	expect(linkDir({}, "/home/x")).toBe("/home/x/.local/bin");
	expect(linkDir({ CMX2_INSTALL_DIR: "/opt/bin" }, "/home/x")).toBe("/opt/bin");
	// a relative one is made absolute, so the PATH check and the link agree
	expect(linkDir({ CMX2_INSTALL_DIR: "rel/bin" }, "/home/x")).toBe(join(process.cwd(), "rel/bin"));
});

test("install links cmx2 into the dir, and the link survives an upgrade that replaces the binary", () => {
	placeBinary(join(home, "old"), binary);
	const dir = join(home, ".local", "bin");
	const r = linkBinary(binary, dir);
	expect(r).toEqual({ kind: "linked", path: join(dir, "cmx2") });
	expect(readlinkSync(r.path)).toBe(binary);
	expect(linkBinary(binary, dir).kind).toBe("ok");
	// what upgrade does: a new file renamed over the installed path
	writeFileSync(join(home, "new"), "v2");
	placeBinary(join(home, "new"), binary);
	expect(Bun.file(r.path).size).toBe(2);
	expect(lstatSync(r.path).isSymbolicLink()).toBe(true);
	expect(linkBinary(binary, dir).kind).toBe("ok");
});

test("a dangling link is pointed back; a working link elsewhere and another regular file are left alone and named", () => {
	const dir = join(home, "other-bin");
	mkdirSync(dir);
	symlinkSync(join(home, "gone"), join(dir, "cmx2"));
	expect(linkBinary(binary, dir).kind).toBe("repaired");
	expect(readlinkSync(join(dir, "cmx2"))).toBe(binary);
	// a link that works but goes somewhere else (a dev build)
	rmSync(join(dir, "cmx2"));
	const dev = join(home, "dev-build");
	writeFileSync(dev, "dev");
	symlinkSync(dev, join(dir, "cmx2"));
	const e = linkBinary(binary, dir);
	expect(e).toEqual({ kind: "elsewhere", path: join(dir, "cmx2"), target: dev });
	expect(readlinkSync(join(dir, "cmx2"))).toBe(dev);
	expect(linkNotes(e, binary, "", home).join("\n")).toContain(`already points at ${dev}`);
	rmSync(join(dir, "cmx2"));
	writeFileSync(join(dir, "cmx2"), "from somewhere else");
	const r = linkBinary(binary, dir, { self: join(home, "old") });
	expect(r.kind).toBe("occupied");
	expect(lstatSync(join(dir, "cmx2")).isSymbolicLink()).toBe(false);
	expect(linkNotes(r, binary, "", home).join("\n")).toContain("separate copy");
});

test("the copy scripts/install.sh left, when it is the binary doing the install, becomes the link; the binary's own dir is untouched", () => {
	const dir = join(home, "readme-bin");
	mkdirSync(dir);
	writeFileSync(join(dir, "cmx2"), "v1");
	chmodSync(join(dir, "cmx2"), 0o755);
	const r = linkBinary(binary, dir, { self: join(dir, "cmx2") });
	expect(r.kind).toBe("replaced");
	expect(readlinkSync(join(dir, "cmx2"))).toBe(binary);
	expect(linkNotes(r, binary, "", home).join("\n")).toContain("replaced the copy");
	// the dir is the one holding the binary: nothing to link, nothing removed
	expect(linkBinary(binary, join(binary, ".."), { self: binary }).kind).toBe("ok");
	expect(Bun.file(binary).size).toBe(2);
});

test("upgrade makes the first link, repairs a dangling one, and leaves a removed one removed", () => {
	const saved = { d: process.env.CMX2_DATA_DIR, i: process.env.CMX2_INSTALL_DIR };
	process.env.CMX2_DATA_DIR = join(home, "data");
	process.env.CMX2_INSTALL_DIR = join(home, "first-bin");
	try {
		// no memory of an install having linked (a 0.8.6 install): the first upgrade makes it
		expect(keepLink(binary, { install: false }).kind).toBe("linked");
		expect(keepLink(binary, { install: false }).kind).toBe("ok");
		// taken away on purpose: not made again
		rmSync(join(home, "first-bin", "cmx2"));
		expect(keepLink(binary, { install: false }).kind).toBe("absent");
		expect(existsSync(join(home, "first-bin", "cmx2"))).toBe(false);
		// a different CMX2_INSTALL_DIR at upgrade than at install: the remembered link is the one looked at
		process.env.CMX2_INSTALL_DIR = join(home, "second-bin");
		expect(keepLink(binary, { install: false }).kind).toBe("absent");
		expect(existsSync(join(home, "second-bin"))).toBe(false);
		// install makes it again
		expect(keepLink(binary, { install: true }).kind).toBe("linked");
		expect(existsSync(join(home, "second-bin", "cmx2"))).toBe(true);
		rmSync(join(home, "second-bin", "cmx2"));
		symlinkSync(join(home, "gone"), join(home, "second-bin", "cmx2"));
		expect(keepLink(binary, { install: false }).kind).toBe("repaired");
	} finally {
		for (const [k, v] of [["CMX2_DATA_DIR", saved.d], ["CMX2_INSTALL_DIR", saved.i]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("cmx2 upgrade that stops at already-on still makes the link (a real run of the cli with a release laid out in a dir)", () => {
	const h = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-upg-")));
	const installed = join(h, "data", "bin", "cmx2");
	mkdirSync(join(h, "data", "bin"), { recursive: true });
	writeFileSync(installed, "#!/bin/sh\necho old\n");
	chmodSync(installed, 0o755);
	// a release whose binary reports the version this source run reports: nothing to upgrade
	const rel = join(h, "rel");
	mkdirSync(rel);
	const asset = join(rel, assetName());
	writeFileSync(asset, `#!/bin/sh\necho ${VERSION}\n`);
	chmodSync(asset, 0o755);
	const sum = new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex");
	writeFileSync(join(rel, "SHA256SUMS"), `${sum}  ${assetName()}\n`);
	const run = () => Bun.spawnSync(["bun", join(import.meta.dir, "../src/index.ts"), "upgrade", "--from", rel], { env: { ...process.env, HOME: h, CMX2_DATA_DIR: join(h, "data"), CMX2_INSTALL_DIR: join(h, "bin"), CMX2_SERVICE_LABEL: "dev.cmx2.small-nothing" } });
	const out = run().stdout.toString();
	expect(out).toContain(`already on ${VERSION}`);
	expect(out).toContain("linked");
	expect(readlinkSync(join(h, "bin", "cmx2"))).toBe(installed);
	expect(run().stdout.toString()).not.toContain("linked");
});

test("the PATH check ignores a trailing slash, and the hint fits the shell", () => {
	const dir = join(home, ".local", "bin");
	const r = { kind: "linked" as const, path: join(dir, "cmx2") };
	expect(linkNotes(r, binary, `/usr/bin:${dir}/`, home).join("\n")).not.toContain("PATH");
	expect(linkNotes(r, binary, "/usr/bin", home, "/opt/homebrew/bin/fish").join("\n")).toContain('fish_add_path "$HOME/.local/bin"');
	expect(linkNotes(r, binary, "/usr/bin", home, "/bin/bash").join("\n")).toContain(">> ~/.bashrc");
	expect(linkNotes(r, binary, "/usr/bin", home, "/bin/zsh").join("\n")).toContain(">> ~/.zshrc");
});

test("it says so, and says when the dir is not on PATH", () => {
	const r = { kind: "linked" as const, path: join(home, ".local", "bin", "cmx2") };
	const off = linkNotes(r, binary, "/usr/bin:/bin", home).join("\n");
	expect(off).toContain(`linked     ${r.path} -> ${binary}`);
	expect(off).toContain(`${join(home, ".local", "bin")} is not on your PATH`);
	expect(off).toContain(`export PATH="$HOME/.local/bin:$PATH"`);
	const on = linkNotes(r, binary, `/usr/bin:${join(home, ".local", "bin")}`, home).join("\n");
	expect(on).toContain("linked");
	expect(on).not.toContain("PATH");
});

test("cmx2 providers lists the providers the daemon lists models for", () => {
	const cfg = join(home, "providers-cfg");
	mkdirSync(cfg);
	writeFileSync(join(cfg, "cmx2.jsonc"), `{ "model": "glm/m", "providers": { "glm": { "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/glm", "apiKey": "k", "models": { "m": {} } }, "anthropic": { "blacklist": ["*"] } } }`);
	const env = { ...process.env, CMX2_CONFIG_DIR: cfg, CMX2_DATA_DIR: join(home, "providers-data"), HOME: home };
	delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
	delete (env as Record<string, string | undefined>).GEMINI_API_KEY;
	const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/index.ts"), "providers", "--json"], { env: env as Record<string, string> });
	expect((JSON.parse(r.stdout.toString()) as Array<{ name: string }>).map((x) => x.name)).toEqual(["glm"]);
});

test("upgrade that stops at already-on leaves the install.sh copy alone when the service's binary is older, and swaps it when it is not", () => {
	// a machine set up the README way: the copy on PATH is this very binary (a copy of bun running the cli source),
	// at the release's version; the service's binary under the data dir is behind
	const h = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-newer-")));
	const installed = join(h, "data", "bin", "cmx2");
	const copy = join(h, "bin", "cmx2");
	mkdirSync(join(h, "data", "bin"), { recursive: true });
	mkdirSync(join(h, "bin"));
	copyFileSync(process.execPath, copy);
	chmodSync(copy, 0o755);
	const script = (version: string) => `#!/bin/sh\necho ${version}\n`;
	writeFileSync(installed, script("0.0.1"));
	chmodSync(installed, 0o755);
	const rel = join(h, "rel");
	mkdirSync(rel);
	const asset = join(rel, assetName());
	writeFileSync(asset, script(VERSION));
	chmodSync(asset, 0o755);
	writeFileSync(join(rel, "SHA256SUMS"), `${new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex")}  ${assetName()}\n`);
	const size = lstatSync(copy).size;
	const upgrade = () => {
		const p = Bun.spawnSync([copy, join(import.meta.dir, "../src/index.ts"), "upgrade", "--from", rel], {
			env: { ...process.env, HOME: h, CMX2_DATA_DIR: join(h, "data"), CMX2_INSTALL_DIR: join(h, "bin"), CMX2_SERVICE_LABEL: "dev.cmx2.small-nothing" },
		});
		return `${p.stdout.toString()}${p.stderr.toString()}`;
	};

	const behind = upgrade();
	expect(behind).toContain(`already on ${VERSION}`);
	expect(behind).toContain("the service's binary is cmx2 0.0.1");
	expect(behind).toContain("cmx2 upgrade --force or cmx2 serve --install");
	// the newer copy is still there, bytes and all, and answers its own version
	expect(lstatSync(copy).isSymbolicLink()).toBe(false);
	expect(lstatSync(copy).size).toBe(size);

	// the service's binary caught up: now the copy is swapped for the link
	writeFileSync(installed, script(VERSION));
	const caught = upgrade();
	expect(caught).toContain(`already on ${VERSION}`);
	expect(caught).toContain("replaced the copy");
	expect(readlinkSync(copy)).toBe(installed);
});

test("a command that is not installed is a failed run that says so, not an exception", () => {
	const r = run(["cmx2-no-such-command-xyz", "--version"]);
	expect(r).toEqual({ ok: false, out: "cmx2-no-such-command-xyz was not found on PATH", missing: true });
	expect(run(["true"]).ok).toBe(true);
});

const script = (version: string) => `#!/bin/sh\necho ${version}\n`;
function exe(path: string, body: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

test("a regular copy no newer than the installed binary becomes the link; a newer or silent one stays and is named", () => {
	const svc = join(home, "svc", "cmx2");
	exe(svc, script("0.8.7"));
	const dirOf = (name: string, body: string) => {
		const dir = join(home, `copies-${name}`);
		exe(join(dir, "cmx2"), body);
		return dir;
	};
	// older, and the same version: swapped; the dir holds the link and no temp name
	for (const [name, v] of [["older", "0.8.6"], ["same", "0.8.7"]] as const) {
		const dir = dirOf(name, script(v));
		const r = linkBinary(svc, dir);
		expect(r).toEqual({ kind: "replaced", path: join(dir, "cmx2"), was: v });
		expect(readlinkSync(join(dir, "cmx2"))).toBe(svc);
		expect(readdirSync(dir)).toEqual(["cmx2"]);
		expect(linkNotes(r, svc, "", home).join("\n")).toContain(`replaced the copy of cmx2 ${v}`);
	}
	// newer: kept, with both versions in the answer and the note
	const newer = dirOf("newer", script("0.9.0"));
	const n = linkBinary(svc, newer);
	expect(n).toEqual({ kind: "occupied", path: join(newer, "cmx2"), copy: "0.9.0", installed: "0.8.7" });
	expect(lstatSync(join(newer, "cmx2")).isSymbolicLink()).toBe(false);
	expect(readFileSync(join(newer, "cmx2"), "utf8")).toBe(script("0.9.0"));
	expect(linkNotes(n, svc, "", home).join("\n")).toContain("is cmx2 0.9.0, newer than the 0.8.7 the service runs");
	// a file that does not say a version, or fails: kept
	for (const [name, body] of [["silent", script("hello")], ["fails", "#!/bin/sh\nexit 3\n"]] as const) {
		const dir = dirOf(name, body);
		const r = linkBinary(svc, dir);
		expect(r).toEqual({ kind: "occupied", path: join(dir, "cmx2"), installed: "0.8.7" });
		expect(lstatSync(join(dir, "cmx2")).isSymbolicLink()).toBe(false);
		expect(linkNotes(r, svc, "", home).join("\n")).toContain("did not report a cmx2 version");
	}
	// the service's own binary silent: nothing to compare with, the copy stays
	const mute = join(home, "svc-mute", "cmx2");
	exe(mute, script("hello"));
	const m = linkBinary(mute, dirOf("mute", script("0.8.6")));
	expect(m.kind).toBe("occupied");
	expect(linkNotes(m, mute, "", home).join("\n")).toContain("did not report a version to compare with");
	// install goes the same way: it makes the link over an older copy and remembers it
	const saved = { d: process.env.CMX2_DATA_DIR, i: process.env.CMX2_INSTALL_DIR };
	process.env.CMX2_DATA_DIR = join(home, "data-keep");
	process.env.CMX2_INSTALL_DIR = dirOf("install", script("0.8.6"));
	try {
		expect(keepLink(svc, { install: true }).kind).toBe("replaced");
		expect(readlinkSync(join(process.env.CMX2_INSTALL_DIR, "cmx2"))).toBe(svc);
	} finally {
		for (const [k, v] of [["CMX2_DATA_DIR", saved.d], ["CMX2_INSTALL_DIR", saved.i]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test.if(process.getuid?.() !== 0)("a replacement that cannot be made leaves the copy on PATH as it was", () => {
	const svc = join(home, "svc-ro", "cmx2");
	exe(svc, script("0.8.7"));
	const dir = join(home, "ro-bin");
	exe(join(dir, "cmx2"), script("0.8.6"));
	chmodSync(dir, 0o555);
	try {
		const r = linkBinary(svc, dir);
		expect(r.kind).toBe("failed");
		expect(lstatSync(join(dir, "cmx2")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "cmx2"), "utf8")).toBe(script("0.8.6"));
		expect(linkNotes(r, svc, "", home).join("\n")).toContain("link it yourself");
	} finally {
		chmodSync(dir, 0o755);
	}
	expect(readdirSync(dir)).toEqual(["cmx2"]);
});

test("cmx2 upgrade run by the installed binary links over an older copy on PATH and leaves a newer one (a real run, as after install.sh)", () => {
	for (const [copyVersion, swapped] of [["0.8.6", true], ["99.0.0", false]] as const) {
		const h = realpathSync(mkdtempSync(join(tmpdir(), "cmx2-copy-")));
		// the installed binary is this runtime (it answers --version with its own version, which is newer than both a 0.8.6 copy and nothing else here)
		const installed = join(h, "data", "bin", "cmx2");
		mkdirSync(dirname(installed), { recursive: true });
		copyFileSync(process.execPath, installed);
		chmodSync(installed, 0o755);
		const copy = join(h, "bin", "cmx2");
		exe(copy, script(copyVersion));
		const rel = join(h, "rel");
		mkdirSync(rel);
		const asset = join(rel, assetName());
		exe(asset, script(VERSION));
		writeFileSync(join(rel, "SHA256SUMS"), `${new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex")}  ${assetName()}\n`);
		const p = Bun.spawnSync([installed, join(import.meta.dir, "../src/index.ts"), "upgrade", "--from", rel], {
			env: { ...process.env, HOME: h, CMX2_DATA_DIR: join(h, "data"), CMX2_INSTALL_DIR: join(h, "bin"), CMX2_SERVICE_LABEL: "dev.cmx2.small-nothing" },
		});
		const out = `${p.stdout.toString()}${p.stderr.toString()}`;
		expect(out).toContain(`already on ${VERSION}`);
		if (swapped) {
			expect(out).toContain(`replaced the copy of cmx2 ${copyVersion}`);
			expect(readlinkSync(copy)).toBe(installed);
		} else {
			expect(out).toContain(`is cmx2 ${copyVersion}, newer than the`);
			expect(lstatSync(copy).isSymbolicLink()).toBe(false);
			expect(readFileSync(copy, "utf8")).toBe(script(copyVersion));
		}
	}
});
