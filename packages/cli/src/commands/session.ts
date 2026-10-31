import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "@cmx2/engine/config";
import { VERSION } from "@cmx2/server";
import { ExportError, exportSession, importBundleFile, sessionMarkdown, Store } from "@cmx2/store";
import { fail } from "../util.ts";

export const help = `cmx2 session: the sessions on this machine

usage:
  cmx2 session list [--here] [--all] [--limit n] [--json]
                                  newest first: id, last active, title, directory. --here keeps the
                                  ones started in this directory, --all adds archived ones
  cmx2 session show <id>          the conversation as text: your messages, the answers, each tool call
  cmx2 session export <id> [--format json|markdown] [--out file]
                                  json (the default) is one file with everything a daemon needs to
                                  list, read and continue the session: messages, parts, the transcript,
                                  the recorded prefix, the step telemetry and where it was written
                                  (machine, os, folder). markdown is for reading.
                                  without --out it prints to stdout
  cmx2 session import <file.json> [--as-new] [--directory path]
                                  put an exported session into this machine's database. an id that is
                                  already here is refused and nothing changes; --as-new imports a copy
                                  under a fresh id. --directory moves it to a folder on this machine,
                                  where its tools will run when you continue it. one from another machine
                                  or folder gets a note the model reads on its next turn, saying where it moved

these read the database directly, so they work with or without a daemon running. nothing here deletes
a session; archive one from a client instead. sharing to a public url is not a thing cmx2 does.`;

const openStore = () => new Store(join(dataDir(), "cmx2.db"));

function ago(ms: number | null | undefined): string {
	if (!ms) return "never";
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
	return new Date(ms).toISOString().slice(0, 10);
}

function list(args: string[]) {
	const { values } = parseArgs({ args, options: { here: { type: "boolean" }, all: { type: "boolean" }, limit: { type: "string" }, json: { type: "boolean" } } });
	const limit = values.limit ? Number(values.limit) : 30;
	if (!Number.isInteger(limit) || limit < 1) fail(`--limit must be a whole number above 0, got ${values.limit}`);
	const store = openStore();
	try {
		const rows = store.sessionsByUpdated({ limit, ...(values.here ? { directory: realpathSync(process.cwd()) } : {}), ...(values.all ? { archived: true } : {}) });
		if (values.json) return console.log(JSON.stringify(rows, null, 2));
		if (!rows.length) return console.log(values.here ? "no sessions started in this directory yet. cmx2 starts one" : 'no sessions yet. start one with cmx2, or cmx2 run "..."');
		const home = process.env.HOME ?? "";
		for (const r of rows) {
			const dir = home && r.directory.startsWith(home) ? `~${r.directory.slice(home.length)}` : r.directory;
			const tags = [r.source === "cmx" ? "cmx" : "", r.archived_at ? "archived" : "", r.parent_id ? "agent" : ""].filter(Boolean).join(", ");
			console.log(`${r.id}  ${ago(r.updated_at).padStart(9)}  ${(r.title || "untitled").slice(0, 60)}${tags ? ` (${tags})` : ""}  ${dir}`);
		}
		if (rows.length === limit) console.log(`the newest ${limit}; --limit ${limit * 4} shows more`);
	} finally {
		store.close();
	}
}

function one(store: Store, id: string | undefined, verb: string) {
	if (!id) fail(`which session? cmx2 session ${verb} <id>, with an id from cmx2 session list`);
	try {
		return exportSession(store, id, { cmx2: VERSION });
	} catch (e) {
		if (e instanceof ExportError) fail(e.message);
		throw e;
	}
}

function show(args: string[]) {
	const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
	const store = openStore();
	try {
		process.stdout.write(sessionMarkdown(one(store, positionals[0], "show"), { toolOutput: 1200 }));
	} finally {
		store.close();
	}
}

function exportCmd(args: string[]) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { format: { type: "string" }, out: { type: "string" } } });
	const format = values.format ?? (values.out?.endsWith(".md") ? "markdown" : "json");
	if (format !== "json" && format !== "markdown" && format !== "md") fail(`--format is json or markdown, got ${values.format}`);
	const store = openStore();
	try {
		const e = one(store, positionals[0], "export");
		const text = format === "json" ? `${JSON.stringify(e, null, 1)}\n` : sessionMarkdown(e);
		if (!values.out) return void process.stdout.write(text);
		const out = resolve(values.out);
		if (existsSync(out)) fail(`${out} already exists; pick another --out or move it aside`);
		writeFileSync(out, text);
		const kb = (statSync(out).size / 1024).toFixed(1);
		console.error(`wrote ${e.session.id} (${e.messages.length} messages${format === "json" ? `, transcript ${e.transcript === null ? "none" : "included"}` : ""}) to ${out}, ${kb} KB`);
	} finally {
		store.close();
	}
}

function importCmd(args: string[]) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "as-new": { type: "boolean" }, directory: { type: "string" } } });
	const file = positionals[0];
	if (!file) fail("which file? cmx2 session import <file.json>, one that cmx2 session export wrote");
	if (!existsSync(file)) fail(`there is no file at ${resolve(file)}`);
	let directory: string | undefined;
	if (values.directory) {
		directory = resolve(values.directory);
		if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`--directory ${directory} is not a folder on this machine`);
		directory = realpathSync(directory);
	}
	const store = openStore();
	try {
		const before = { sessions: store.sessionCount(), messages: store.messageCount() };
		// read a piece at a time, so a large export never sits in memory whole
		const r = importBundleFile(store, resolve(file), { dataDir: dataDir(), ...(directory ? { directory } : {}), ...(values["as-new"] ? { asNew: true } : {}) });
		const where = r.directory;
		console.log(`imported ${r.id}${r.id !== r.source ? ` (a copy of ${r.source})` : ""}: ${r.messages} messages, ${r.parts} parts, ${r.steps} steps${r.transcript ? "" : ", no transcript so it is browse only"}`);
		if (r.moved) console.log(`moved from ${r.moved.from.machine} (${r.moved.from.os}, ${r.moved.from.directory}); the model reads that with its next turn`);
		console.log(`sessions ${before.sessions} -> ${store.sessionCount()}, messages ${before.messages} -> ${store.messageCount()}`);
		if (!existsSync(where)) console.log(`its directory ${where} is not on this machine; import again with --as-new --directory <folder> to continue it here`);
		else if (r.transcript) console.log(`continue it with cmx2 --session ${r.id}, or cmx2 run --session ${r.id} "..."`);
	} catch (err) {
		if (err instanceof ExportError) fail(err.message);
		throw err;
	} finally {
		store.close();
	}
}

export async function main(args: string[]) {
	const [sub, ...rest] = args;
	if (sub === "list" || sub === "ls" || sub === undefined) return list(rest);
	if (sub === "show") return show(rest);
	if (sub === "export") return exportCmd(rest);
	if (sub === "import") return importCmd(rest);
	fail(`session ${sub} is not a command. try cmx2 session list, show, export or import (cmx2 session --help)`);
}
