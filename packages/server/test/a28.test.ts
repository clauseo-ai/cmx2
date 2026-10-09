/**
 * `GET /file/content`, a file's raw bytes scoped by x-cmx2-directory. a daemon in this process
 * (port 0, no model); the files are real, written to a scratch directory.
 *
 * run: bun test packages/server/test/a28.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "@cmx2/engine/config";
import { Cmx2Error, createClient } from "@cmx2/client";
import { openapi } from "../../contract/src/generate.ts";
import { serve } from "../src/index.ts";

const SCRATCH = realpathSync(mkdtempSync("/tmp/cmx2-a28-"));
const REPO = join(SCRATCH, "repo");
const OUTSIDE = join(SCRATCH, "outside");
mkdirSync(join(REPO, "app/.next/server/app"), { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ");
const AVIF = Uint8Array.from([0, 0, 0, 0x1c, ...new TextEncoder().encode("ftypavif"), 0, 0, 0, 0]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
const SVG = `<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;

const write = (rel: string, body: Uint8Array | string, root = REPO) => {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), body);
};
write("favicon.ico", ICO);
write("app/icon.png", PNG);
write("app/.next/server/app/icon.body", PNG); // next's extensionless png
write("photo.jpg", JPEG);
write("anim.gif", GIF);
write("pic.webp", WEBP);
write("pic.avif", AVIF);
write("logo.svg", SVG);
write("logo-no-ext", SVG);
// illustrator's: a doctype with an internal subset, entities declared inside [ ]
write("illustrator.svg-data", `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n\t<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">\n]>\n<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`);
// a doctype that never closes, built so a backtracking pattern tries every way to split it (review: 70 bytes held the daemon 1.1 s)
write("evil.txt", "<!DOCTYPE " + "[]".repeat(30));
write("evil-long.txt", "<!DOCTYPE [" + "]".repeat(8000));
write("liar.png", "<html>not a png</html>"); // the bytes say nothing, the extension speaks
write("png-named-txt.txt", PNG); // the bytes win over the extension
write("notes.md", "# hi\n");
write("data.bin", Uint8Array.from([1, 2, 0, 3]));
write("README", "plain words with a café\n");
write("big.png", new Uint8Array(1024 * 1024 + 1));
writeFileSync(join(REPO, "huge.bin"), ""); // a sparse 8 GiB file: reading it whole would take the daemon down
truncateSync(join(REPO, "huge.bin"), 8 * 1024 ** 3);
write("exact.bin", new Uint8Array(1024 * 1024).fill(7));
write("secret.txt", "outside", OUTSIDE);
symlinkSync(join(OUTSIDE, "secret.txt"), join(REPO, "link-out.txt"));
symlinkSync(OUTSIDE, join(REPO, "link-dir"));
symlinkSync(join(REPO, "app/icon.png"), join(REPO, "link-in.png"));
symlinkSync(join(SCRATCH, "nowhere"), join(REPO, "dangling"));

let d: ReturnType<typeof serve>;
let base = "";
const get = (path: string, dir: string | undefined = REPO, headers: Record<string, string> = {}) => fetch(base + path, { headers: { ...(dir ? { "x-cmx2-directory": dir } : {}), ...headers } });
const q = (p: string, extra = "") => `/file/content?path=${encodeURIComponent(p)}${extra}`;

beforeAll(() => {
	const config = { ...structuredClone(DEFAULTS), sources: [] };
	d = serve({ config, port: 0, hostname: "127.0.0.1", dataDir: join(SCRATCH, "data"), checkEvents: true, reload: () => config });
	base = `http://127.0.0.1:${d.server.port}`;
});
afterAll(() => d?.stop());

describe("a28: /file/content", () => {
	test("the bytes come back whole, with content-type, etag and content-length", async () => {
		const r = await get(q("app/icon.png"));
		expect([r.status, r.headers.get("content-type"), r.headers.get("content-length")]).toEqual([200, "image/png", String(PNG.length)]);
		expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
	});

	test("the type is sniffed from the bytes: png, jpeg, gif, webp, avif, ico, svg, even with no extension or a wrong one", async () => {
		const types: Array<[string, string]> = [
			["app/.next/server/app/icon.body", "image/png"],
			["photo.jpg", "image/jpeg"],
			["anim.gif", "image/gif"],
			["pic.webp", "image/webp"],
			["pic.avif", "image/avif"],
			["favicon.ico", "image/x-icon"],
			["logo.svg", "image/svg+xml"],
			["logo-no-ext", "image/svg+xml"],
			["illustrator.svg-data", "image/svg+xml"],
			["png-named-txt.txt", "image/png"],
		];
		for (const [p, want] of types) expect([p, (await get(q(p))).headers.get("content-type")]).toEqual([p, want]);
	});

	test("a doctype built to make the svg sniff backtrack is answered at once, as text", async () => {
		for (const p of ["evil.txt", "evil-long.txt"]) {
			const t0 = performance.now();
			const r = await get(q(p));
			const ms = performance.now() - t0;
			expect([p, r.status, r.headers.get("content-type")]).toEqual([p, 200, "text/plain; charset=utf-8"]);
			expect(ms).toBeLessThan(100);
		}
	});

	test("the extension speaks when the bytes say nothing; text without an extension is text/plain, binary is octet-stream", async () => {
		expect((await get(q("liar.png"))).headers.get("content-type")).toBe("image/png");
		expect((await get(q("notes.md"))).headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect((await get(q("README"))).headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect((await get(q("data.bin"))).headers.get("content-type")).toBe("application/octet-stream");
	});

	test("a missing path, a directory and a missing directory are 404 FileNotFoundError, not the route's NotFoundError", async () => {
		for (const [path, dir] of [[q("nope.png"), REPO], [q("app"), REPO], [q("."), REPO], [q("dangling"), REPO], [q("a.png"), join(SCRATCH, "no-such-dir")], [q("repo/favicon.ico"), join(REPO, "favicon.ico")]] as const) {
			const r = await get(path, dir);
			expect([path, dir, r.status, (await r.json()).name]).toEqual([path, dir, 404, "FileNotFoundError"]);
		}
		expect((await (await get("/file/contents?path=x")).json()).name).toBe("NotFoundError");
	});

	test("a path outside the directory is 403: by .., by an absolute path, by a symlink to a file or a directory", async () => {
		for (const p of ["../outside/secret.txt", "app/../../outside/secret.txt", join(OUTSIDE, "secret.txt"), "link-out.txt", "link-dir/secret.txt", "../nonexistent"]) {
			const r = await get(q(p));
			expect([p, r.status, (await r.json()).name]).toEqual([p, 403, "ForbiddenError"]);
		}
		// a symlink that stays inside is fine
		const ok = await get(q("link-in.png"));
		expect([ok.status, ok.headers.get("content-type")]).toEqual([200, "image/png"]);
		// and so is a path with a harmless ..
		expect((await get(q("app/../favicon.ico"))).status).toBe(200);
	});

	test("over max is 413 from the size alone: default and ceiling are 1 MiB, max lowers it, exactly the limit passes", async () => {
		const big = await get(q("big.png"));
		expect([big.status, (await big.json()).name]).toEqual([413, "FileTooLargeError"]);
		const t0 = performance.now();
		const huge = await get(q("huge.bin"));
		expect([huge.status, (await huge.json()).data.size, performance.now() - t0 < 500]).toEqual([413, 8 * 1024 ** 3, true]);
		expect((await get(q("exact.bin"))).status).toBe(200);
		// a ceiling: max cannot raise the limit
		expect((await get(q("big.png", "&max=99999999"))).status).toBe(413);
		const small = await get(q("app/icon.png", `&max=${PNG.length - 1}`));
		expect([small.status, (await small.json()).name]).toEqual([413, "FileTooLargeError"]);
		expect((await get(q("app/icon.png", `&max=${PNG.length}`))).status).toBe(200);
		expect((await get(q("app/icon.png", "&max=0"))).status).toBe(400);
		expect((await get(q("app/icon.png", "&max=abc"))).status).toBe(400);
	});

	test("an if-none-match that still holds is 304 with no body", async () => {
		const first = await get(q("favicon.ico"));
		const etag = first.headers.get("etag")!;
		const again = await get(q("favicon.ico"), REPO, { "if-none-match": etag });
		expect([again.status, again.headers.get("etag"), (await again.arrayBuffer()).byteLength]).toEqual([304, etag, 0]);
		write("favicon.ico", Uint8Array.from([...ICO, 9, 9]));
		const changed = await get(q("favicon.ico"), REPO, { "if-none-match": etag });
		expect([changed.status, changed.headers.get("content-length")]).toEqual([200, String(ICO.length + 2)]);
	});

	test("path is required; the route is scoped by the header or ?directory=", async () => {
		expect((await get("/file/content")).status).toBe(400);
		const viaQuery = await get(`${q("favicon.ico")}&directory=${encodeURIComponent(REPO)}`, undefined);
		expect(viaQuery.status).toBe(200);
	});

	test("a read never creates an instance: no directory is loaded, known or unknown", async () => {
		const instances = async () => (await (await fetch(`${base}/global/reload`, { method: "POST" })).json()).instances as number;
		await instances(); // clears whatever other requests made
		await get(q("favicon.ico"));
		await get(q("favicon.ico"), join(SCRATCH, "unknown-dir"));
		await get(q("nope"), OUTSIDE);
		expect(await instances()).toBe(0);
	});

	test("every answer carries nosniff and a sandboxing content-security-policy, so a page from the daemon's origin runs nothing", async () => {
		for (const p of ["logo.svg", "notes.md", "app/icon.png"]) {
			const r = await get(q(p));
			expect([p, r.headers.get("x-content-type-options"), r.headers.get("content-security-policy")]).toEqual([p, "nosniff", "default-src 'none'; style-src 'unsafe-inline'; sandbox"]);
		}
		const notModified = await get(q("logo.svg"), REPO, { "if-none-match": (await get(q("logo.svg"))).headers.get("etag")! });
		expect([notModified.status, notModified.headers.get("x-content-type-options")]).toEqual([304, "nosniff"]);
	});

	test("HEAD answers what GET would, headers only; it is not the unknown route's NotFoundError", async () => {
		const g = await get(q("app/icon.png"));
		const h = await fetch(base + q("app/icon.png"), { method: "HEAD", headers: { "x-cmx2-directory": REPO } });
		expect([h.status, h.headers.get("content-type"), h.headers.get("content-length"), h.headers.get("etag"), (await h.arrayBuffer()).byteLength]).toEqual([200, "image/png", String(PNG.length), g.headers.get("etag"), 0]);
		const missing = await fetch(base + q("nope.png"), { method: "HEAD", headers: { "x-cmx2-directory": REPO } });
		expect(missing.status).toBe(404);
		// a HEAD has no body to read the name from, so GET names it
		expect((await (await get(q("nope.png"))).json()).name).toBe("FileNotFoundError");
		const outside = await fetch(base + q("../outside/secret.txt"), { method: "HEAD", headers: { "x-cmx2-directory": REPO } });
		expect(outside.status).toBe(403);
	});

	test("a file that grows while it is read comes back whole or not at all: never a torn read", async () => {
		const grow = join(REPO, "grow.log");
		writeFileSync(grow, "");
		// an appender in its own process, 1000 bytes a write, as fast as it can
		const writer = Bun.spawn(["bash", "-c", `while true; do head -c 1000 /dev/zero | tr '\\0' 'x' >> ${grow}; done`], { stdout: "ignore", stderr: "ignore" });
		const outcomes = new Map<string, number>();
		let torn = 0;
		const t0 = Date.now();
		try {
			while (Date.now() - t0 < 2500) {
				const r = await get(q("grow.log"));
				if (r.status === 200) {
					const body = new Uint8Array(await r.arrayBuffer());
					if (body.length % 1000 !== 0 || body.some((b) => b !== 0x78) || r.headers.get("content-length") !== String(body.length)) torn++;
				} else {
					await r.arrayBuffer();
					if (r.status === 413) writeFileSync(grow, ""); // it outgrew the limit: start it over
				}
				outcomes.set(String(r.status), (outcomes.get(String(r.status)) ?? 0) + 1);
			}
		} finally {
			writer.kill();
		}
		console.log(`a28 growth reads: ${JSON.stringify(Object.fromEntries(outcomes))}, torn ${torn}`);
		expect(torn).toBe(0);
		expect([...outcomes.keys()].every((k) => ["200", "409", "413"].includes(k))).toBe(true);
		expect(outcomes.get("200") ?? 0).toBeGreaterThan(50);
	});

	test.skipIf(process.platform !== "linux")("a virtual file (size 0 in stat, bytes on read) is read to its end, not cut to one byte", async () => {
		const r = await get("/file/content?path=self/status", "/proc");
		const body = await r.text();
		expect([r.status, body.length > 100, r.headers.get("content-length")]).toEqual([200, true, String(body.length)]);
	});

	test("the manifest declares the 304 and the errors the route can answer", () => {
		const doc = JSON.parse(openapi());
		const responses = doc.paths["/file/content"].get.responses;
		expect(Object.keys(responses)).toEqual(expect.arrayContaining(["200", "304", "400", "401", "403", "404", "409", "413"]));
	});

	test("the generated client reads it: bytes with type and etag, a 304 with no data, a typed error", async () => {
		const client = createClient({ baseUrl: base, directory: REPO });
		const a = await client.fileContent({ path: "app/icon.png" });
		expect([a.contentType, [...(a.data ?? [])].length, !!a.etag]).toEqual(["image/png", PNG.length, true]);
		const again = await client.fileContent({ path: "app/icon.png" }, { ifNoneMatch: a.etag });
		expect([again.notModified, again.data]).toEqual([true, undefined]);
		const err = await client.fileContent({ path: "missing.png" }).catch((e) => e);
		expect([err instanceof Cmx2Error, err.status, err.name]).toEqual([true, 404, "FileNotFoundError"]);
	});
});
