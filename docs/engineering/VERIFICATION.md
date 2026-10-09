# verification

nothing is done until it was driven against a real daemon in the session
that claims it. tiers, from cheapest to most expensive; use the cheapest
that answers the question, and climb until the claim is proven. tier 0 is
free and tier 1 is mostly offline (some test files in `packages/server/test`
call a real model). tiers 2 to 6 run against a real provider with your own
key and spend tokens, so read a run's cost before repeating it.

| tier | question | tool |
|---|---|---|
| 0 | typechecks? | `bunx tsc --noEmit` |
| 1 | logic right? | `bun test` (unit; wire-format fixtures via record/replay) |
| 2 | primitive behaves? | integration invariants against a throwaway daemon on a spare port (`CMX2_LIVE_TESTS=1 bun run test:integration`, needs a provider key) |
| 3 | the flow works for a person? | agent-browser loop (a browser-driving cli) against boxbox, or the tui, driving the real daemon through a real provider endpoint |
| 4 | regressed? | `bun scripts/build.ts` (single binary) and the ten-minute eval |
| 5 | budgets? | rss idle and under load, cache-read %, calls/step, steps per task, printed by the eval |
| 6 | the big one | a large end-to-end eval on your own repositories (hours a run) before a release you will depend on |

## the harness pattern

```sh
cd /tmp && mkdir -p cmx2-it && cd cmx2-it && git init -q
cmx2 serve --port 4830 --hostname 127.0.0.1 --log-level error &   # never the default port, 4097
```

the test daemons sit on 4830-4839; `CMX2_PORT_SHIFT=20 bun test packages` moves
every one of them by 20, so a second lane (another worktree) runs the suites on
4850-4859 without taking the first lane's ports.

sessions are host-global; nonce every session title you create
(`it-<name>-<random>`), delete them at the end, and put a curl `-m` timeout
on deletes.

## integration invariants

port all 45 from cmx's multi-agent invariants test
(multi-root scoping, child completion wakes parent, cross-root send rejected,
session deletion cleanup, parent close cascades, delivery contract, sibling
coordination, ask pattern, ABORT protocol, supervision, pools, bounded
mailboxes, behaviour contracts, observability). retire one only with a note
in the commit message saying which primitive replaced it.

new invariants, one per new primitive, before its production code lands:

- prefix bytes identical across steps and across a resume (byte diff).
- a parked child accepts a message after a daemon restart and continues
  with full history.
- `interrupt` cancels the current turn and the child remains resumable.
- an idle non-root parent is woken by a child's report; the root parks when
  only children or jobs remain and wakes on a report.
- deliverable extraction never returns a body from before the triggering
  follow-up.
- running-turn cap holds under a pool of size cap+2; parked agents do not
  count.
- steer lands in the next model request of a running turn without an abort;
  queue waits.
- a job with `notify: on_exit` wakes a parked owning session; `on_port` fires when
  the port opens; `on_pattern` fires once per match.
- session end reaps every owned process except `keep`ed ones; daemon start
  reports orphans from the journal.
- worktree create carries `.env*` and env; merge and discard refuse under a
  run lock; discard leaves a rescue commit.
- compaction request reuses the session prefix (cache-read ≥ 90%); a
  degenerate summary is rejected; the post-compaction block lists live
  agents and jobs.
- effort change between turns keeps cache-read ≥ 96%; effort is recorded on
  every assistant message; no model-callable tool changes effort.
- tool search: adding a deferred tool mid-session does not invalidate the
  prefix.
- run lock: two daemon processes cannot run one session concurrently.
- rss: idle < 150 MB after 10 minutes; < 400 MB with three 300k sessions
  active (the eval prints both).

## the ten-minute eval (`packages/eval/src/tasks.ts`)

real tasks, each with a machine-checkable result, run against a real daemon
through a real provider endpoint (it spends tokens). seed set (extend as
tasks recur):

1. a next.js web client: add a typed event decoder for a new event and a pinned
   decode test; passes `bun test`.
2. a large typescript monorepo: find every caller of a function across the
   tree and summarise call sites (scout work; measures calls/step and
   steps).
3. a next.js app: start the dev server as a job, wait for the port, run a
   check against it, stop it (measures poll-only steps and orphans).
4. two disjoint edits in parallel worktrees with an independent reviewer
   (measures warm reuse, parked root, review event).
5. a long-context session seeded from a recorded transcript that crosses
   the compaction threshold (measures compaction cache-read and time).
6. a provider probe: fable 5.1, opus 5.5, sonnet 5.5, gemini, glm each
   answer a tool-using prompt (measures gates and betas through the endpoint).

the three seed tasks that exist today are tasks 1 to 3; `packages/eval/src/tasks.ts` runs them (`CMX2_TASK_WEB`, `CMX2_TASK_MONO` and `CMX2_TASK_FN` name the repos and the function). with `CMX2_TASK_BASE` (and
`CMX2_TASK_PASSWORD`) they run against an installed daemon instead of a throwaway one, and
`CMX2_TASK_BASELINE` prints an earlier run's rows beside the new ones.

the eval prints one row per task: steps, calls/step, cache-read %, ttft,
cost, wall time, rss peak, outcome; and a diff against the previous run.
a harness change that moves steps or calls/step the wrong way fails the run.

## the routing eval (`packages/eval/src/m9.ts`)

measures the model table against the old seat matrix and against the main model alone, on real merged commits. each run is a scratch clone at a commit's parent, a fresh daemon, the commit's message as the prompt, and the commit's hidden tests run once the tree settles. `bun packages/eval/src/m9.ts prepare` makes arm a's checkout (a worktree of main from before routing v2, with the eval knob patched in), `check` proves each task's tests fail at the base and pass at the commit, `run` writes one row per run to `<tasks dir>/m9-<date>.jsonl`, `table` prints the arms side by side. the task list is yours to write (paths on your machine); `packages/eval/m9-tasks.example.json` shows the shape. it spends real money: run the pilot (`run --pilot`) first and read its cost before the full set.

eval-only knobs it uses: `Daemon`'s `root` option (run the daemon from another checkout) and `CMX2_EXCLUDE_TOOLS=spawn,message,wait,agents` (the server's `hooks()` takes those tools away from root sessions, and the routing text when `spawn` is among them; helpers never read it). every arm excludes `question` for the main session (nobody answers), arm c also `spawn,message,wait,agents`. it is not a setting and no config key reaches it.

## provider fixtures

record real provider traffic once per model with pi's or an http recorder,
replay in unit tests for wire-format parsing (thinking blocks, block
binding drops, `input_transformations`, refusals, structured output). never
mock the loop.

## reporting

state outcomes with the evidence: the command, the row, the screenshot
path. if a tier was skipped, say so. if a number is worse, say so first.
