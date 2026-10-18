# prompts, routing, delegation

pi is the open source agent engine cmx2 builds on; cmx is its predecessor.

## principles

1. **the bitter lesson, applied.** every sentence in a prompt encodes an
   assumption about what the model cannot do. those assumptions go stale
   within one model generation. write tool-behaviour definitions, not
   prohibitions. no DO NOT / MUST / IMPORTANT lists. cursor cut 66% of its
   system prompt this way with no quality loss; anthropic's fable 5.1 guide
   says over-prescriptive prompts degrade output.
2. **one home per rule.** anything stated twice in an assembled context is
   a bug. capability text lives with the capability (tool description or
   fragment), not in the system prompt and again somewhere else.
3. **per-model profiles.** anthropic 5.x, gemini, openai, default. the same
   intent, different register. profiles are files under `prompts/`, selected
   by model family, and versioned in git.
4. **nothing volatile in the prefix.** date, ledger, skills list, the routing
   table and one helpers line (counts only, sent when
   they change) are appended as messages or turn-scoped system messages. the
   roster itself is not in the turn context: the `agents` tool lists it, and
   the post-compaction state block carries a compact one.
5. **judgment over rules.** questions and discussion get analysis, not
   edits; directives get action without ceremony; ambiguity gets one
   clarifying question with concrete options. these are three sentences,
   not three pages.
6. **measure prompts like code.** every change runs the ten-minute eval and
   is committed with what moved (calls/step, steps, reuse rate,
   escalations).

## the audit checklist (apply to every prompt inherited from cmx)

- [ ] remove every capability the model no longer lacks (planning
  scaffolds, todo rituals, "think step by step", worked examples).
- [ ] replace each prohibition with a behaviour definition of the tool or
  primitive it was protecting.
- [ ] delete the subagent self-close contract; replace with "end your turn
  when done; your parent may message you again".
- [ ] delete "close agents once integrated"; replace with the `agents` tool's
  semantics (parked is free; return-to beats spawn for the same area).
- [ ] move the routing matrix out of prose into `routing.jsonc` rendering.
- [ ] keep machine facts (hostname, ports, what never gets restarted) out of
  prompt text; the hostname already rides the turn context.
- [ ] check every fragment is injected by capability (permission set), so a
  session without `spawn` never reads about spawning.
- [ ] read it aloud against the house style: lowercase, no dashes, blunt.

## what the driver's prompt contains (anthropic 5.x profile, outline)

- identity and the two-sentence contract (act on directives, analyse on
  questions, ask once on ambiguity).
- the tool surface as behaviour: read/edit/write/apply_patch/glob/grep/
  webfetch/websearch/skill/question/lsp; `run` for scripts and batches;
  `shell` for a single command; `pty` for repls; jobs and notifications;
  worktrees; the five agent verbs with the `agents` list semantics.
- the batching nudge is not here; it is turn-scoped.
- browsers: agent-browser when it is on the path, in a session of its own
  that it closes; another browser tool only when it is missing and the user
  agrees. the reason rides with the rule: it is installed, and a playwright
  setup downloads browsers and leaves processes behind.
- cleanup: once the work is done and checked, what the session started
  (jobs, servers, ptys, browser sessions) is stopped and what it created
  (temporary files, scratch scripts, downloads, worktrees once merged or
  dropped) is removed; what existed before and what it was asked to keep
  stays. the base is the best practices guide's sample ("if you create any
  temporary new files, scripts, or helper files for iteration, clean up these
  files by removing them at the end of the task").
- claims discipline and outcome-first reporting (short), closing with one
  line on what was cleaned up and what was left running or on disk, when the
  task started or created anything.
- the security floor (owasp classes, secrets in worktrees).
- appended per turn: env block (hostname, cwd, date), the model table, guide
  and rules from `routing.jsonc`, a helpers line (`helpers: 2 working, 1 parked; agents lists
  them.`, only when the counts change), ledger, mailbox digest. the roster is
  read with `agents`; a compaction carries it as one line per live agent.

## turn-scoped messages (system authority for one turn)

- batching: "first privately list what you need next; then request every
  item that does not depend on another's result in this one response, as
  parallel calls or one `run` script."
- mailbox digest: "2 reports arrived (auth_worker, api_scout); 1 agent
  parked; 1 job finished with exit 1."
- ledger: "alive: dev server on 3100 (keep), pty 12 (repl), auth_worker
  (parked)."
- post-compaction state block after a compaction.
- fallback when the endpoint rejects the beta: the same text as a synthetic
  part on the user message (user authority, costs tokens each turn).

## routing (`~/.config/cmx2/routing.jsonc`, version 2)

a table of models and a guide, not seats. the delegating model names a model
from the table at spawn (`spawn(model: "sonnet")`) and may move its effort; the
harness maps the alias to a provider model and enforces `never`. the table is
rendered into the delegating session's turn context, never the prefix, and the
`spawn` description names no alias, so it is byte-identical whatever the file
says. what the model reads, for the shipped default:

- a header (`models for helpers. spawn names one; your own model is the user's
  choice and is not in this table.`), one line per model (`- haiku:
  claude-haiku-5-5, high by default. <note>.`), and an `off limits` line only
  when `never` lists something;
- the guide: one line per kind of task with where to start and where to step up
  when the output falls short, marked as defaults, not limits;
- the rules (`how to use it:`), nine short sentences.

the guide's evidence: merge quality
per task, cognition's frontiercode 1.1 extended, haiku 5.5 medium 55.0 for
$0.10, sonnet 5.5 high 61.5 for $0.35, opus 5.5 medium 65.3 for $0.67;
terminal-bench 4 at high effort, haiku 22, sonnet 44, opus 57. so lookups and
mechanical work start on haiku, terminal-heavy work on sonnet (sonnet medium
beats haiku at the same cost there), hard work and risky review on opus, and
fable is a second opinion at about four times opus per task. haiku never runs
at xhigh or max: its final text is a report and an xhigh turn can end with
none. the table is a hypothesis built from benchmarks and other people's
practice; the routing eval (`VERIFICATION.md`) measures it on real work.

## delegation rules (the `rules` list, rendered with the table)

- small work (under about ten tool calls) stays with the delegating session; a
  helper starts with none of its context.
- start with the cheapest option that can do the task, and judge the output,
  not the price. when a helper falls short: retry once with a sharper brief,
  then spawn one step up with `after`, then do it yourself; no helper is
  retried more than twice.
- difficulty or file count alone is no reason to start higher; a missing tool
  or permission gets fixed, not escalated.
- tests and typecheck run before any review; only risky changes get one.
- a helper past about 250k tokens of context costs about twice as much per
  step; the next task goes to a fresh helper.
- disjoint work runs in parallel, one writer per area, each in its own
  worktree.
- long watches are jobs with `notify`, not helpers; when only helpers or jobs
  remain, end your turn.

the version-1 text (delegate to protect context, return before you spawn,
never delegate the decision on the critical path, review on a different seat)
is gone from the shipped rules: the model decides, and the table's notes carry
the costs. the `spawn` description says a helper stays addressable and `message(id)` carries it on with
everything it knows, which is the whole of the old "return before you spawn" rule.

## effort (what the prompt says, and does not)

the prompt never tells the model to lower its own effort; effort applies to
the request that reads a tool result, so lowering it "before a read" lowers
the judgment step. the prompt says: the dial is the user's; a helper starts
at its model's default effort; the harness raises a helper's effort for a turn
on repeated failures and puts it back after a clean turn (never the session
you talk to, never the model).

## the helper prompt (per agent type, outline)

the system prompt depends on the agent type only (general, explore, review, or
a custom type's body), never on the model, name or task, so helpers of one type
on one model share a byte-identical prefix. identity and the task ride the first
message: `you are <path> (session <id>), started by <spawner> (session <id>).`,
the brief, then attachments (files, `fork_turns`, and with `after` the earlier
attempt's brief and last report). the helper is not told its model or effort:
escalation can change effort mid-session, and a stated effort invites the model
to scale its work to the label. the spawner's reasoning for the choice goes in
`why`, which the helper never sees.

- a helper another agent started, how to report (end your turn with the
  deliverable; you may be messaged again; `message` for a partial finding).
- your tools by capability; your worktree if any; commit, never push.
- the ABORT last-line protocol with the six reasons.
- what a good report looks like: outcome first, exact identifiers, what was
  verified and how, what was not.

## per-model notes to encode in profiles

- fable 5.1: rejects prefix edits before thinking blocks on new accounts
  (we send `drop_block`); at low effort it searches less; often one tool
  call per turn without the batching nudge.
- opus 5.5: default effort medium at the api; forced `tool_choice` rejected;
  between-tool narration travels in thinking blocks (display summarized).
- sonnet 5.5: per-message effort incompatible with `between_tools`; at low
  it may skip verifying a change; 30% faster; minimum cacheable prompt 512.
- gemini 3.8 flash: prescriptive framing over prohibitions; used only when
  a job needs it.
