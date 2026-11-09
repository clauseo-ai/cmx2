// a stand-in daemon: starts a tree whose grandchild is a native windows program, prints the grandchild's windows pid,
// then exits without killing anything. argv[2] is the windows spawn to use ("detached" or "attached")
import { bashArgv, bashEnv, trackTree, treePids, treeSpawnOptions, type WindowsTreeSpawn } from "../../src/index.ts";

const variant = (process.argv[2] ?? "detached") as WindowsTreeSpawn;
const env = { ...process.env, ...bashEnv() };
const p = Bun.spawn(bashArgv('ping -n 300 127.0.0.1 >/dev/null & echo "gc $(cat /proc/$!/winpid)"; wait', { env }), {
	env,
	stdin: "ignore",
	stdout: "pipe",
	stderr: "ignore",
	...treeSpawnOptions({ windows: variant }),
});
const tracked = trackTree(p.pid);
const reader = p.stdout.getReader();
let out = "";
while (!/gc \d+/.test(out)) {
	const { done, value } = await reader.read();
	if (done) break;
	out += new TextDecoder().decode(value);
}
const gc = Number(out.match(/gc (\d+)/)?.[1] ?? 0);
console.log(JSON.stringify({ tracked, gc, inJob: treePids(p.pid).includes(gc) }));
process.exit(0);
