// a stand-in daemon for the crash test: starts jobs, prints their pids, then waits to be killed
import { Procs } from "../../src/index.ts";

const dataDir = process.argv[2]!;
const procs = new Procs({ dataDir });
const orphan = procs.spawn({ command: "sleep 300", sessionID: "ses_crash", origin: "model" });
const kept = procs.spawn({ command: "sleep 301", sessionID: "ses_crash", origin: "model", keep: "kept-sleeper" });
console.log(JSON.stringify({ orphan: orphan.pid, kept: kept.pid }));
await Bun.sleep(600_000);
