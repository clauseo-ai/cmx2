# third party

borrowed modules and what was taken. dependencies installed from npm are listed in `package.json` and `bun.lock`, not here.

cmx is an earlier coding-agent runtime that was a fork of opencode. cmx2 reimplements parts of it, and opencode is MIT licensed.

| source | commit / version | license | what was taken |
|---|---|---|---|
| cmx (opencode fork, `packages/opencode/src/util/image-resize.ts`) | `31fdc05bba` | MIT (opencode) | the header-only png/jpeg/gif/webp dimension readers and the converter choice (sips on macos, imagemagick elsewhere), reimplemented in `packages/tools/src/image.ts` |
| cmx (opencode fork, `packages/opencode/src/agent/control.ts`, `agent/behaviors.ts`, `agent/mailbox.ts`, `wave/metric.ts`) | `31fdc05bba` | MIT (opencode) | the agent runtime's semantics, reimplemented in `packages/actors`: the completion watcher's two-pass extraction and no-deliverable warning, the ABORT last-line parser, behaviour contracts v1/v2 per agent type, bounded mailboxes with a system bypass, tombstones, the metric events and rate helpers |
| cmx (`packages/opencode/test/integration/multi-agent-invariants.test.ts`) | `31fdc05bba` | MIT (opencode) | the 51 invariant scenarios and their slugs, rewritten against a real daemon in `packages/server/test/integration/invariants.test.ts` |
| cmx (opencode fork, `packages/opencode/src/worktree/index.ts`, `tool/request-review/`) | `31fdc05bba` | MIT (opencode) | the checkout semantics, reimplemented in `packages/worktrees`: the per-project cap and disk floor, `.worktreeinclude` through `git ls-files --ignored --exclude-from`, the diff shape boxbox reads, the conflict probe with `git merge-tree`, the rescue snapshot before discard, declared review (`worktree.review.requested`) |
