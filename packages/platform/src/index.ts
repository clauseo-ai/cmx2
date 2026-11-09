export { BASH_HINT, BashMissing, bashArgv, bashCommand, bashEnv, bashPath, COMMAND_VAR, findGitBash, gitRootOf, IS_WINDOWS, type BashLookup, type BashSource } from "./bash.ts";
export { compiledRoot, isCompiled } from "./compiled.ts";
export { parseNetstat, windowsImageName, windowsListeners } from "./ports.ts";
export { pidAlive, processStartMs, startStamp } from "./proc.ts";
export { forgetTree, killTree, trackTree, treeAlive, treeOf, treePids, treeSpawnOptions, treeTracked, type WindowsTreeSpawn } from "./tree.ts";
