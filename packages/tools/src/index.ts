import { webfetchTool, websearchTool } from "./deferred.ts";
import { editTool, globTool, grepTool, readTool, writeTool } from "./fs.ts";
import { type LspPool, lspTool } from "./lsp.ts";
import { procTools } from "./procs.ts";
import { type AskQuestions, type QuestionAudience, questionTool } from "./question.ts";
import { runTool } from "./run.ts";
import { shellTool } from "./shell.ts";
import { type Skills, skillTool } from "./skills.ts";
import type { NestedCall, Tool, ToolEnv } from "./types.ts";

export * from "./types.ts";
export { nestedDetails, shrinkDetails, titleLine, toolTitle } from "./record.ts";
export { diffOnDisk, fileDiff, snapshot, CREATED_PATCH_CAP, DIFF_MAX_BYTES, MIDDLE_MAX_BYTES, PATCH_CAP, type Before, type FileDiff, type FileDiffResult } from "./diff.ts";
export { toolSearchTool, websearchUrl, type DeferredEntry, type SearchResult } from "./deferred.ts";
export type { RunDetails, NestedCallRecord } from "./run.ts";
export { RUN_DESCRIPTION } from "./run.ts";
export { runCommand, outputImages, type ShellResult } from "./shell.ts";
export { type AgentAnswer, type AskQuestions, type QuestionAudience, type QuestionDetails, type QuestionPrompt, QuestionDismissedError } from "./question.ts";
export { hostHeicDecoders, imageMimeOf, imageParts, isHeicMime, MAX_EDGE, MAX_IMAGE_BYTES, readDimensions, resizeDataUrl, resizeImage, sniffHeic, sniffImage, type Dimensions, type ResizedImage } from "./image.ts";
export { defaultSkillDirs, frontmatter, listSkills, Skills, type SkillInfo } from "./skills.ts";
export { formatFile, formatterFor, type Formatted } from "./format.ts";
export { DEFAULT_LSP_SERVERS, errorsAfterWrite, LspPool, type LspDiagnostic, type LspLocation, type LspServerConfig, type LspSymbol } from "./lsp.ts";
export { FileOAuthStore, McpPool, mcpSignIn, mcpToolName, OAUTH_REDIRECT, oauthProvider, type McpServerConfig, type McpState, type McpStatus } from "./mcp.ts";
export { notesTool, readNotes, recallTool, NOTES_MAX_CHARS, type RecallHit, type RecallSearch } from "./memory.ts";
export type { GrepDetails, GrepHit, GlobDetails, ReadDetails, ImageReadDetails, WriteDetails, EditDetails } from "./fs.ts";

/**
 * the hot set: declared in the recorded prefix from request one. order is by name so the tool list is
 * byte-identical across sessions and releases that do not change a definition.
 */
export function hotTools(env: ToolEnv, call: NestedCall, ask: AskQuestions, audience: QuestionAudience = "user"): Tool[] {
	return [readTool(env), writeTool(env), editTool(env), grepTool(env), globTool(env), shellTool(env), runTool(call), questionTool(ask, audience)].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

export interface DeferredOptions {
	/** the session's skills; without them there is no skill tool */
	skills?: Skills;
	/** the daemon's language servers; without them there is no lsp tool */
	lsp?: LspPool;
}

/** tools kept out of the prefix until tool_search loads them */
export function deferredTools(env: ToolEnv, opts: DeferredOptions = {}): Tool[] {
	const tools = [webfetchTool(env), websearchTool(env)];
	if (opts.skills) tools.push(skillTool(opts.skills, env));
	if (opts.lsp) tools.push(lspTool(opts.lsp, env));
	return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** tools only `run` helpers reach (shell.spawn, pty.*); never declared to the model, so never in the prefix */
export function runOnlyTools(env: ToolEnv): Tool[] {
	return procTools(env);
}
