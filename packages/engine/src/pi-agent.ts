/**
 * pi's `Agent` without the rest of pi-agent-core. the package index re-exports its whole harness
 * (skills with yaml, the edit tool with diff, compaction, session storage, search): 171 modules and
 * about 12 MB of daemon rss that cmx2 never calls (GOTCHAS, measured at m5). `dist/agent.js` needs
 * only pi-ai and the loop. the package's exports map has no entry for it, so it is imported by file
 * through this package's own dependency link; the drift test pins the file's bytes and checks the
 * index is still out of the daemon's graph.
 */
export { Agent } from "../node_modules/@earendil-works/pi-agent-core/dist/agent.js";
