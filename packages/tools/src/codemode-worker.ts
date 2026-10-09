// the `run` sandbox's worker entry. a compiled binary carries it as a second entrypoint (scripts/build.ts);
// pi-codemode's default worker path points into node_modules, which a binary does not have.
import "@earendil-works/pi-codemode/worker";
