import { defineTool, text, type Tool, type ToolResult } from "@cmx2/tools";
import type { Created, Discarded, Merged, SetupRun } from "@cmx2/worktrees";
import { Type } from "typebox";

/**
 * checkouts as the model sees them. create, merge and discard are deferred (tool_search loads them), so
 * sessions that never isolate work carry none of them in their prefix. request_review is declared only in
 * sessions homed in a checkout, where it means something. descriptions say what each does and never
 * change with config.
 */

const CREATE = `make a separate checkout of this repository: a new branch (cmx2/<name>) in a directory of its own, for work that should not touch the main working tree until it is merged. it starts from what your directory has checked out, or from. on macos it is a copy-on-write clone, so ignored files such as node_modules, build caches and .env files come along at almost no cost; elsewhere it is a git worktree with .env files and .worktreeinclude entries copied and node_modules linked. untracked secrets the profile's worktree.carry does not name are left behind and listed. the project's worktree.setup commands, then setup, run before this returns. pass the directory to spawn to put an agent to work there; merge or discard it when the work is done.`;

const MERGE = `squash-merge a checkout's branch into the branch it was made from, on this machine, then remove the checkout and its branch. processes still running in the checkout are stopped. it refuses while an agent is mid-turn in the checkout, when the checkout has uncommitted changes, and when the branches conflict (it names the files: rebase inside the checkout, then merge again). it never pushes.`;

const DISCARD = `remove a checkout and its branch without merging. processes still running in it are stopped. when it held work, its last state, uncommitted files included, is kept first as a commit under refs/cmx2/rescue/<name>, and the result says how to get it back. it refuses while an agent is mid-turn in the checkout.`;

const REVIEW = `tell the person that the work in this checkout is ready for them to look at. their client raises a review card with the diff and merge and discard controls. call it when the work is committed and checked, with a one-line note on what changed and what to look at, then end your turn.`;

export interface WorktreeActions {
	create(input: { name?: string; from?: string; startCommand?: string }): Promise<Created & { setup?: SetupRun[] }>;
	merge(directory: string, message?: string): Promise<Merged & { stopped: string[] }>;
	discard(directory: string): Promise<Discarded & { stopped: string[] }>;
}

function ok(t: string, details: unknown): ToolResult {
	return { content: [text(t)], details, structuredContent: details };
}

function failed(e: unknown): ToolResult {
	const err = e as { name?: string; message?: string; extra?: Record<string, unknown>; data?: Record<string, unknown> };
	const data = err.extra ?? err.data ?? {};
	return { content: [text(`${err.name ?? "Error"}: ${err.message ?? String(e)}`)], details: { error: err.name, ...data }, isError: true };
}

const list = (xs: string[]) => (xs.length ? xs.join(", ") : "nothing");

function setupLine(runs: SetupRun[] | undefined): string {
	if (!runs?.length) return "no setup commands (worktree.setup is empty)";
	return runs.map((r) => (r.ok ? `setup \`${r.command}\` ok in ${(r.ms / 1000).toFixed(1)} s` : `setup \`${r.command}\` failed (${r.timedOut ? "timed out" : `exit ${r.exitCode}`}):\n${r.log.split("\n").slice(-15).join("\n")}`)).join("\n");
}

export function worktreeTools(actions: WorktreeActions): Tool[] {
	const create = defineTool({
		name: "worktree_create",
		label: "worktree_create",
		description: CREATE,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "a few lowercase words; made up when omitted" })),
			from: Type.Optional(Type.String({ description: "a branch or commit to start from" })),
			setup: Type.Optional(Type.String({ description: "one more command to run in it after the project's setup, e.g. bun install" })),
		}),
		async execute(_id, params) {
			try {
				const c = await actions.create({ ...(params.name ? { name: params.name } : {}), ...(params.from ? { from: params.from } : {}), ...(params.setup ? { startCommand: params.setup } : {}) });
				const how = c.mode === "clone" ? `apfs clone, ${c.ms} ms` : `git worktree, ${c.ms} ms${c.fallback ? `; no clone: ${c.fallback}` : ""}`;
				const lines = [
					`made checkout ${c.name} at ${c.directory}, branch ${c.branch} from ${c.base ?? c.from.slice(0, 10)} (${how}).`,
					`carried: ${list(c.carried)}${c.linked.length ? `; linked: ${list(c.linked)}` : ""}.`,
					...(c.left.length ? [`left behind (worktree.carry does not name them): ${list(c.left)}.`] : []),
					setupLine(c.setup),
				];
				return ok(lines.join("\n"), c);
			} catch (e) {
				return failed(e);
			}
		},
	});

	const merge = defineTool({
		name: "worktree_merge",
		label: "worktree_merge",
		description: MERGE,
		parameters: Type.Object({
			directory: Type.String({ description: "the checkout's directory" }),
			message: Type.Optional(Type.String({ description: "the squash commit's message; made from the branch's commit subjects when omitted" })),
		}),
		async execute(_id, params) {
			try {
				const m = await actions.merge(params.directory, params.message);
				return ok(`merged ${m.branch} into ${m.base} as ${m.commit.slice(0, 10)} (${m.commits} commit${m.commits === 1 ? "" : "s"} squashed${m.into ? `, in ${m.into}` : ""}). the checkout and its branch are gone${m.stopped.length ? `; stopped ${list(m.stopped)}` : ""}. nothing was pushed.`, m);
			} catch (e) {
				return failed(e);
			}
		},
	});

	const discard = defineTool({
		name: "worktree_discard",
		label: "worktree_discard",
		description: DISCARD,
		parameters: Type.Object({ directory: Type.String({ description: "the checkout's directory" }) }),
		async execute(_id, params) {
			try {
				const d = await actions.discard(params.directory);
				const rescue = d.ref ? ` its last state is ${d.snapshot!.slice(0, 10)} at ${d.ref}: git branch <name> ${d.ref} brings it back.` : " it held no work, so nothing was kept.";
				return ok(`discarded the checkout at ${params.directory}.${rescue}${d.stopped.length ? ` stopped ${list(d.stopped)}.` : ""}`, d);
			} catch (e) {
				return failed(e);
			}
		},
	});

	return [create, merge, discard];
}

export function requestReviewTool(requestReview: (note?: string) => { name: string; branch?: string }): Tool {
	return defineTool({
		name: "request_review",
		label: "request_review",
		description: REVIEW,
		parameters: Type.Object({ note: Type.Optional(Type.String({ description: "one line: what changed and what to look at" })) }),
		async execute(_id, params) {
			try {
				const r = requestReview(params.note);
				return ok(`review requested for ${r.branch ?? r.name}. the person sees the card with the diff and decides: merge, discard, or send it back with notes.`, r);
			} catch (e) {
				return failed(e);
			}
		},
	});
}
