import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "@cmx2/engine/config";
import { DEFAULT_SINCE_DAYS, fileBytes, importCmx, ImportError, parseSince, Store } from "@cmx2/store";
import { fail } from "../util.ts";

export const help = `cmx2 db: the session database on this machine

usage:
  cmx2 db status                  what cmx2.db and archive.db hold: sessions, messages, sizes, imports
  cmx2 db import-cmx [--from path] [--since when]
                                  copy cmx history into archive.db, browse only. --from defaults to
                                  ~/.local/share/opencode/opencode.db, opened read-only. --since takes
                                  all, 30d, 12h, 2w, 2026-08-01 or ms; by default it picks up from the
                                  last import (a day of overlap), or ${DEFAULT_SINCE_DAYS} days back on the first run

the database lives in ~/.local/share/cmx2/cmx2.db (or $CMX2_DATA_DIR). nothing here deletes a session.`;

export async function main(args: string[]) {
	const [sub, ...rest] = args;
	const path = join(dataDir(), "cmx2.db");
	if (sub === "status") {
		const store = new Store(path);
		const cmx = store.sessionCount("cmx");
		const mib = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
		console.log(`${path} (${mib(fileBytes(path))}), schema version ${store.version}`);
		console.log(`sessions: ${store.sessionCount() - cmx} cmx2, ${cmx} imported from cmx; messages: ${store.messageCount()}; parts: ${store.partCount()}`);
		const a = store.archiveStats();
		if (a?.attached) console.log(`${a.path} (${mib(fileBytes(a.path))}, read-only to the daemon): ${a.sessions} sessions, ${a.messages} messages, ${a.parts} parts, ${mib(a.raw_bytes)} of json stored as ${mib(a.stored_bytes)}`);
		else if (a) console.log(`${a.path}: not there yet; cmx2 db import-cmx creates it`);
		for (const r of store.imports().slice(0, 3)) {
			console.log(`import ${r.db}#${r.id}: ${r.path}, ${r.sessions} sessions, ${r.messages} messages, ${r.parts} parts, finished ${r.finished_at ? new Date(Number(r.finished_at)).toISOString() : "never (interrupted)"}`);
		}
		store.close();
		return;
	}
	if (sub === "import-cmx") {
		const { values } = parseArgs({ args: rest, options: { from: { type: "string" }, since: { type: "string" } } });
		const from = values.from ?? join(homedir(), ".local/share/opencode/opencode.db");
		const store = new Store(path);
		const t0 = performance.now();
		try {
			const since = parseSince(values.since);
			const archive = store.archivePath!;
			const before = fileBytes(archive);
			console.log(`importing from ${from} (read-only) into ${archive}`);
			const counts = importCmx(store, {
				from,
				since,
				onProgress: (p) => console.log(`  ${p.sessions} sessions, ${p.messages} messages, ${p.parts} parts so far`),
			});
			const s = ((performance.now() - t0) / 1000).toFixed(1);
			const mib = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
			const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
			const b = counts.bytes;
			console.log(`since ${counts.since ? new Date(counts.since).toISOString() : "the beginning"}`);
			console.log(`imported ${counts.sessions} sessions, ${counts.messages} messages, ${counts.parts} parts in ${s} s`);
			const src = counts.source;
			const same = src.sessions === counts.sessions + counts.inMain && src.messages === counts.messages && src.parts === counts.parts;
			console.log(`source had   ${src.sessions} sessions, ${src.messages} messages, ${src.parts} parts (one snapshot)${same ? ", every one imported" : ""}`);
			console.log(`part bodies:   ${mib(b.partRaw)} raw -> ${mib(b.partStored)} compressed (${pct(b.partStored, b.partRaw)})`);
			console.log(`message infos: ${mib(b.infoRaw)} raw -> ${mib(b.infoStored)} compressed (${pct(b.infoStored, b.infoRaw)})`);
			console.log(`archive.db:    ${mib(before)} before -> ${mib(fileBytes(archive))} after; source ${mib(fileBytes(from))}`);
			if (counts.inMain) console.log(`${counts.inMain} sessions were already in cmx2.db and were left there`);
			if (counts.truncated) console.log(`${counts.truncated} long fields were cut; the full text stays in the cmx db`);
			if (counts.oversized) console.log(`${counts.oversized} messages over 8 MB (whole-file diffs) were imported without their body`);
			if (counts.skipped) console.log(`${counts.skipped} rows could not be read as json and were skipped`);
		} catch (e) {
			if (e instanceof ImportError) fail(e.message);
			throw e;
		} finally {
			store.close();
		}
		return;
	}
	fail(`db ${sub ?? ""} is not a command. try cmx2 db status, cmx2 db import-cmx or cmx2 db --help`);
}
