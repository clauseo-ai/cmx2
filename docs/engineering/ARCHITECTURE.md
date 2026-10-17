# architecture

pi is the open source agent engine cmx2 builds on; boxbox is the web client; the contract is the daemon's http api; cmx is the predecessor. a shorter overview is in `docs/architecture.md`.

## shape

```
                 web client (boxbox, next.js)                    pi tui (themed)          cmx2 cli / headless
                        │ sse + rest (typed manifest)                 │ in-process             │
                        ▼                                             ▼                        ▼
   ┌─────────────────────────────────────────── cmx2 daemon (bun, one per machine) ──────────────────────────────────┐
   │  server: auth · instance routing · /event · /global/* · sessions · permission · question · pty ws · roster    │
   │  runtime: actor system (five verbs) · jobs + processes · worktrees · run lock · routing.jsonc · telemetry      │
   │  engine adapter: hosts pi AgentSession per session · effort layers · prefix recording · turn-scoped messages   │
   │  persistence: sqlite (sessions, messages projection, agents, jobs, processes, steps) · pi jsonl kept as-is    │
   └────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                        │
              pi engine libs (pinned 0.99.1): pi-ai (providers) · pi-agent-core (loop) · pi-codemode · pi-mcp
                        │
              an anthropic-compatible endpoint, direct or behind a proxy (configured, never assumed)  →  anthropic (fable 5.1, opus 5.5, sonnet 5.5), gemini, glm, grok
```

## packages (one bun workspace)

| package | owns | notes |
|---|---|---|
| `engine` | the adapter over pi: session creation, provider registration (vertex), effort layers, prefix recording, turn-scoped messages, tool registration with exposure modes, compaction hooks, telemetry taps | the only package that imports pi. keeps our surface to pi's documented extension api (`docs/extensions.md`, `docs/rpc.md`, `docs/session-format.md`, `docs/packages.md` in the pi repo at the pinned tag) |
| `actors` | the five verbs, registry, mailboxes, watcher, residency lru, revive, roster, caps, supervision, delivery contract, ABORT protocol, metrics | ported from cmx (`AgentControl`) |
| `procs` | pty sessions, background jobs with notify, ownership registry, ports, ledger, reaping, detach journal | port of cmx pty pool + `pi-processes` notify design |
| `worktrees` | create/merge/discard, CoW fast path on apfs, env and file carry-over, secrets policy, review event | port of cmx worktree + nicobailon `worktree.ts` + oh-my-pi `pi-iso` design |
| `routing` | `routing.jsonc` schema (models, guide, rules, never, caps, escalation), hot reload, prompt rendering of the table | new |
| `server` | http + sse, auth, instance routing, run lock, the event manifest, openapi, in-process client for tests | port of cmx routes; one backend |
| `store` | sqlite schema and migrations, message projection from pi jsonl, steps/telemetry table, import from cmx db, retention and vacuum | new |
| `tools` | core tools with typed results and spill (read, edit, write, apply_patch, glob, grep, webfetch, websearch, skill, question, lsp), image attach and resize (heic and heif always become jpeg, upright and without exif), `run` code-mode namespaces (`fs`, `search`, `shell`, `pty`, later `edit`, `agents`) | pi ships several; ours wrap for typed metadata and permissions |
| `prompts` | system prompt profiles per model family, agent-type prompts, fragments (capability hints, delegation rules), the audit checklist | text, versioned |
| `cli` | `cmx2 tui/run/serve/pair/doctor/upgrade/session/models/providers/agent/mcp/stats/db` | thin |
| `eval` | the ten-minute smoke suite, the routing-eval runner, provider record/replay fixtures | see `VERIFICATION.md` |

rule: `actors`, `procs`, `worktrees`, `server` never import pi directly; they
talk to `engine`. that is what keeps a pi upgrade a one-package event.

## the loop (per session)

1. **admission**: a user prompt arrives as `prompt`, `steer` or `queue`.
   `prompt` starts a turn if idle. `steer` is promoted at the next safe
   boundary inside a running turn (after the current tool results are
   recorded, before the next model request). `queue` waits for the turn to
   end. there is no flush.
2. **request assembly** (engine): recorded prefix (system prompt bytes +
   tool definitions in recorded order) → history from pi's session tree →
   appended volatile block (turn context: date/time, cwd, the model table, a helpers
   line when its counts change, ledger, mailbox digest) → turn-scoped system messages (batching nudge,
   effort marker) → the user or steer message. nothing volatile is ever in
   the prefix. cache breakpoints: last tool, system, latest user (pi's
   auto placement) with ttl per session/agent.
3. **effort**: layer 1 the model's default (from routing), layer 2 turn dial (per-
   message `output_config.effort`, recorded per assistant message, markers
   rebuilt deterministically on replay), layer 3 escalation for
   helpers only, for the next turn only: one rung up at the boundary on the
   same tool error twice, the same check failing twice after an edit,
   `stop_reason: max_tokens`, or the same call three times (`wait` and
   `agents` do not count); a turn without those signals puts the effort back
   to where the session stands (`session.escalated`, `session.deescalated`;
   the stored effort never moves). the main session never escalates.
   never mid-loop downshift, never top-level effort change, never a
   model-callable "set effort" tool.
4. **tools**: native parallel calls, or one `run` script. results pass
   through spill (2,000 lines / 50 KB) and typed metadata. permissions are
   evaluated per tool including nested calls inside `run`.
5. **park**: when the turn would otherwise end with live children or jobs
   and nothing to do, the session parks: state `parked`, turn ended, cache
   warm. any mailbox delivery (child report, job event, steer) wakes it.
6. **telemetry**: every assistant step writes one row: model, effort,
   input/cache/output tokens, ttft, tool calls (count, names, durations),
   cost, outcome signals (error, test fail), context size.

## agents (the five verbs)

```
spawn(model, brief, name?, effort?, after?, agent_type?, files?, fork_turns?, on_failure?, pool?)  → { id, path, name }
message(target, body, wake: boolean, correlation_id?)                                          → delivered | mailbox_full
wait(timeout_ms, correlation_id?)                                                              → "arrived" | "timed out"
agents(list | return_to(id) | close(id) | interrupt(id), path_prefix?)                          → roster | ok
run(code)                                                                                      → script result (+ attachments)
```

- **identity**: stable id + canonical path `/root/<name>[/<child>]` + nickname;
  returned at spawn and in every completion with "to continue: message(id)".
- **state**: `working` | `parked` | `closed`. transcript in pi's session
  file + our sqlite projection is the truth. a live `AgentSession` is a hot
  cache in an lru whose size equals the running-turn cap; eviction flushes
  and forgets; a later message reloads from disk.
- **recorded at spawn**: system prompt bytes, tool list, model, effort,
  cwd, isolation. replayed on every resume.
- **mailbox**: bounded (32), typed items `{kind: task|message|report|job|
  system, from, to, correlation_id?, body}`. `wake: true` starts a turn if
  idle or lands at the next boundary if running. completion reports bypass
  the cap.
- **watcher**: on every terminal transition of a child, post a report with
  the deliverable extracted from messages after the triggering item only.
- **caps**: running turns per root (default 4 incl. root, config), depth
  (default 3), per-session token budget; parked agents are free.
- **supervision** as spawn options: `on_failure: escalate|respawn|ignore`,
  `pool: {n, collect: all|first|any_n, strategy}`; links removed.
- **behaviour contracts** and the ABORT last-line protocol carried over.
- **roster** served by the `agents` verb and over rest, with context size and cost per
  agent, and to boxbox. the turn context only
  carries a one-line helper count when it changes (the full roster in every
  turn filled one long root's transcript with lists); a compaction
  carries a compact roster in the post-compaction state block.

## processes and jobs

- `procs.spawn({cmd, cwd, tty?, env?, notify?: {on_exit?, on_pattern?,
  on_port?}, keep?: name})` → `{pid, id, ports?}`; output retained head/tail
  with cursors; `procs.write(id, chars)`, `procs.read(id, since_cursor)`,
  `procs.kill(id)`, `procs.list()`.
- notifications are mailbox items of kind `job`, so a parked owning session wakes.
- ownership registry in sqlite: session id, pid, pgid, ports (polled from
  `lsof` on demand), started at, keep name. ledger appended each turn.
  session end reaps everything not `keep`ed; daemon start reaps orphans
  from the journal and reports them.
- exposed to the model as `shell.exec` and `pty.*` inside `run`, and as a
  thin native `shell` tool for single commands.

## worktrees

`packages/worktrees` (git and files, no pi) plus the daemon's run locks, events and routes.

- `worktree_create({name?, from?, setup?})` (a deferred tool) and `POST /experimental/worktree`: a new
  branch `cmx2/<name>` in `<data>/worktree/<repo>-<hash>/<name>`, from what the directory has checked
  out. `git worktree add --no-checkout`, then on macos one `clonefile(2)` per top-level entry but `.git`
  (ignored files, node_modules and env come along copy-on-write), `git reset --hard` and `git clean -fd`
  (tracked files at the ref, the source's uncommitted work dropped). elsewhere, or when the volume
  refuses the clone, git fills it and the carry list runs: allowlisted env files anywhere git ignores
  them, `.worktreeinclude` entries (gitignore syntax), `node_modules` and virtualenvs linked from the
  source (and excluded in `info/exclude`), local dev certs. which path ran is in the answer (`mode`,
  `fallback`, `ms`) and the log line.
- secrets policy: an untracked file shaped like a secret (env files, keys, certificates, `.npmrc`,
  credentials, tfstate) goes into a checkout only when `worktree.carry` names it (basename globs;
  default `.env`, `.env.*`, `.envrc`, `.dev.vars`, `localhost*.pem`). the rest stay behind and are
  listed (`left`).
- setup: `worktree.setup` from the checkout's config (usually the project's `.cmx2/cmx2.jsonc`) then
  the caller's command, `bash -lc` in the checkout with `CMX2_WORKTREE*` set, 10 minutes each.
  `worktree.ready` after setup, `worktree.failed {message, log}` with the output's tail.
- caps and refusals, typed: `worktree.cap` checkouts per project (15), a disk floor of
  max(`minFreeGB`, `minFreeRatio`) (5 GB, 3%), `WorktreeRefusedError {reason}`, `WorktreeNotGitError`,
  `WorktreeNotFoundError`, `WorktreeMergeConflictError {files}`.
- `worktree_merge` / `POST .../merge`: a squash onto the branch it was made from (recorded in
  `branch.<name>.cmx2base`), in the working tree where that branch is checked out, or by moving the
  ref when it is not; conflicts found with `git merge-tree` first. never pushes.
- `worktree_discard` / `POST .../discard`: the last state, uncommitted files included, is kept under
  `refs/cmx2/rescue/<name>` when there was work.
- both take the run lock of every session homed in the checkout for as long as they run (a session
  mid-turn here or in another daemon process refuses with `BusyError`), stop processes still working
  there, and then move those sessions to the repository's main checkout (rows kept).
- `request_review(note)`, declared only in root sessions homed in a checkout, emits
  `worktree.review.requested`; boxbox raises the card on it and nothing else. `project.updated
  {worktree, sandboxes}`, `worktree.merged`, `worktree.discarded`; `GET /project?worktrees=true`,
  `GET /experimental/worktree`, `GET .../diff`.
- `spawn({directory})` puts an agent to work in a checkout; a checkout's sessions belong to its
  repository's project (`projectID` is the main checkout's path).

## routing

`routing.jsonc` in the profile dir (per machine overlay allowed, hot-reloaded), version 2:

```jsonc
{
  "models": {
    "haiku":  { "ref": "anthropic/claude-haiku-5-5",  "effort": "high",   "note": "where bounded work starts; about a seventeenth of a sonnet step under 100k tokens of context ..." },
    "sonnet": { "ref": "anthropic/claude-sonnet-5-5", "effort": "high",   "note": "about 17× a haiku step under 100k tokens of context and about opus medium per task on long contexts; ..." },
    "opus":   { "ref": "anthropic/claude-opus-5-5",   "effort": "medium", "note": "exploration that shapes a plan, implementation that needs judgment, ui, docs and copy, debugging, code review; ..." },
    "fable":  { "ref": "anthropic/claude-fable-5-1",  "effort": "medium", "note": "second opinion on plans and designs; about 4× opus per task" }
  },
  "guide": [ { "task": "any bounded task whose brief pins down the behaviour and the checks; ...", "start": "haiku high", "up": "opus medium" } ],
  "rules": [ "haiku is where a task starts unless a row above says otherwise. ..." ],
  "never":  { "claude-haiku-5-5": ["xhigh", "max"] },
  "caps":   { "running_turns": 50, "depth": 3, "budget_tokens": null },
  "escalation": { "ceiling": { "default": "xhigh", "claude-haiku-5-5": "high", "claude-sonnet-5-5": "high", "claude-opus-5-5": "xhigh", "claude-fable-5-1": "xhigh" } }
}
```

(the guide and rules are abbreviated here; `examples/routing.jsonc` has the
shipped text and a test pins it to the default.) the engine renders the table,
the guide and the rules into the delegating session's appended context;
`spawn(model=...)` resolves model and effort through the table; a per-dispatch
`effort` override is allowed within `never`. the session the user talks to is
not in the table: its model and effort are the user's.

## caching rules (checked by tests)

- prefix bytes identical across steps of a session and across resumes.
- tool order deterministic (sorted by a stable key), tools added later are
  deferred behind the placeholder.
- no date, helpers line, ledger, skills list or routing table in the
  system prompt; all appended.
- compaction and title/summary requests reuse the session prefix.
- ttl: 5m default; 1h once a session has a helper that is not closed, a job
  that will notify it, or 100k of context (stored on the session, never
  switched back; an explicit `cache_ttl` wins).
- model switches only at compaction boundaries.

## events

one manifest (`packages/contract/src/manifest.ts`) with a `type` discriminator and a
`version`, generated into the client package and the openapi doc. families:
`server.*`, `session.*` (incl. `parked`, `steered`), `message.*`, `part.*`,
`agent.*` (spawned, report, parked, resumed, closed, metric), `job.*`,
`process.*`, `worktree.*` (incl. `review.requested`), `permission.*`,
`question.*`, `compaction.*`, `config.reloaded`. cmx event names are kept
where the shape is unchanged so boxbox's move from cmx is a regeneration, not a
rewrite of semantics.

every state-changing event carries `(epoch, seq)`: a persisted, strictly
increasing 64-bit counter and an epoch that changes only when the store is
reset. sse frames carry it as `id:`; `Last-Event-ID` and `?after=` resume
from the log (at least 30 minutes and 50,000 events), `stream.reset` names
why a cursor cannot be honoured, and every state-returning read answers
`x-cmx2-seq` so a client applies only the events after what it read.
deltas are not logged; a part that was streaming is resent once in full at
the resume seq. every text and reasoning part of a streaming message is
announced by a logged `message.part.updated` (empty, `streaming: true`,
`time.start`) before its first delta, reasoning streams like text, and the
in-flight read returns every started part typed and in order (contract
version 5). a part's final goes out when its block ends, not at
the step's end: the engine says `message.part.ended` on pi's
`thinking_end` and `text_end`, the daemon publishes the part final and reads
and resumes serve it final from then on.

### the listener

the public port is a small tcp front (`node:net`). it reads the first
request's headers: a websocket upgrade is piped raw to an internal
`Bun.serve` on loopback (the pty websocket), everything else to an
internal `node:http` server. the reason is backpressure: `Bun.serve`
drains a streaming response into native buffers whatever the socket does,
so one client that opened `/global/event` and stopped reading grew the
daemon to 2.8 GB in 4 s and no cap could be measured; `node:http` reports
its backlog honestly, so each subscriber is cut at 1 MB and resumes from
its cursor later. bun's `node:http` cannot carry websockets, hence the
split. the cost is one loopback hop per request (microseconds; 1,000
concurrent requests against a daemon in its own process reset none, after
the front learned to retry a refused dial under macos's 128-deep accept
queue). memory is bounded by construction against misbehaving clients,
the same rule boxbox v2 applies on its side. details and the bun version
this was measured on: `GOTCHAS.md`, "sync and the listener (m6)".

## persistence

- pi session jsonl trees stay the engine's format.
- sqlite (`~/.local/share/cmx2/cmx2.db`, wal): `session`, `message`
  (projection with tokens/cost/effort), `part`, `agent` (id, path, name,
  parent, seat, state, recorded prefix hash, session file), `mailbox`,
  `job`, `process`, `worktree`, `step` (telemetry), `permission`,
  `question`. page cache capped; connections pooled; transcripts read in
  ranges, never materialised whole for rendering.
- import: a one-shot importer from `~/.local/share/opencode/opencode.db`
  (sessions, messages, parts) into the projection so history is browsable.

## configuration and profiles

four layers, merged in order: shipped **defaults** (work for anyone with
an anthropic key) → the **profile** dir (`~/.config/cmx2/` or
`CMX2_CONFIG_DIR`) with a per-machine overlay selected by hostname
(`cmx2.<hostname>.jsonc`) → the **project** dir (`.cmx2/cmx2.jsonc`, a limited
layer) → env. config files are jsonc, validated on load, and hot-reloaded.
secrets are referenced by env var name or a `!command` (a keychain lookup),
never stored. `examples/` has starter files to copy into the profile dir. no
machine- or user-specific text exists in `packages/` or in prompt files.

## security

- code mode is a confined interpreter: only supplied namespaces, no eval,
  no ambient fs/net/process; every nested tool call runs the same
  permission evaluation as a native call.
- shell stays behind the same permission rules as today; `run` scripts do
  not widen them.
- worktree copies obey the secrets allowlist; children never push (`SUBAGENT_RULES` plus
  `subagentEnv` in `packages/engine/src/permission.ts`: a deny rule and a push url rewrite).
- server: basic auth, paired bearers or `local.token`; a credential is always required off
  loopback; cross-site and rebinding requests are refused before auth; auth is decided on the
  headers before a body is read. the project config layer cannot move keys or loosen rules.
  an outside security review of the daemon's http api shaped these rules.
