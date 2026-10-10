# changelog

notable changes to cmx2, newest first. the format follows keep a changelog. "contract" means the daemon's http api; clients such as the boxbox web client read it.

## unreleased

contract version 7. additive: completed tool states may carry `attachments` and `attachmentsDropped`.

### added
- a completed tool part carries the images its result returned (a read of an image, a screenshot) as `attachments`, file entries with a data url, so clients can preview them. at most 8 images and 4 MB of data urls per part; `attachmentsDropped` counts any left off. additive; the output text is unchanged.

### changed
- a helper's `question` tool asks the agent that started it, not the user. the question arrives as a message with a `correlation_id`, the spawner's reply is the answer, and the spawner asks further up with its own `question` tool when it cannot answer, so the user only hears questions from the root. while a helper waits its agent `cause` is `asking` and its running-turn slot goes to others. before, a helper's question went straight to the user, and its spawner sat parked without knowing.

## 0.8.8 - 2026-10-10

contract version 7. additive.

### added
- routing is a table of models. `routing.jsonc` version 2 holds `models` (an alias, a `provider/model-id`, a default effort, a one-line note), a `guide` for where to start and where to step up per kind of task, and `rules`. the shipped table has haiku 5.5, sonnet 5.5, opus 5.5 and fable 5.1.
- `spawn` names a model alias instead of a seat. a request that sends `seat` is refused with `SeatsRemovedError`. `cmx2 agent models` prints the table, the caps and where escalation stops per model.
- `anthropic/claude-haiku-5-5` runs in the daemon, with tiered pricing: the whole request bills at a higher rate once it holds 100,000 tokens. `/config/providers` models carry `cost.tiers` when a long-context rate exists. sonnet 5.5 cache reads are priced at the new, lower rate, and stored sessions keep the cost they were recorded with.
- heic and heif photos are accepted wherever images are. they are converted to jpeg before any provider sees them.
- `agents` and `GET /session/:id/agents` report `contextTokens`, `lastStepCost` and `cost` per agent. `cmx2 stats` adds a helpers-by-model table.

### changed
- the prompt cache lasts an hour for a session that waits: one with an open helper, a background job that will notify it, or a context past 100k tokens. an explicit `cache_ttl` still wins.
- a session's turn context carries one line about its helpers, only when it changes. the full roster is read with the `agents` tool.

### fixed
- a helper's effort escalation lasts one turn and the main session never escalates. before, one escalation could pin a session at max for the rest of its life.

## 0.8.7 - 2026-10-03

contract version 6.

### added
- `GET /file/content` reads a file's raw bytes, scoped to the directory, with a sniffed content type, an etag and 304, and a 1 MiB cap.
- `GET /session/:id/queue` lists waiting prompts. `/queue` and `/steer` keep the `model`, `variant`, `agent` and `effort` they were sent with, and steered messages say `steer: true`.
- a native `edit` or `write` part carries its diff and its added and removed line counts. the part union covers every part of imported history, so a decoder generated from the contract reads any page.
- `cmx2 serve --install` links `cmx2` into `~/.local/bin` and says when that directory is not on your PATH. `cmx2 upgrade` keeps the link valid.

### changed
- `POST /session/:id/loop` answers `{ran: n}` and 409 `BusyError` while a turn runs. it used to answer `true` whatever happened. this is the one non-additive change in contract 6.
- `/session` pages by a `<updated_at>:<id>` cursor, so sessions that share a timestamp are no longer dropped at a page edge. the old bare time still works. `/config/providers` lists only reachable providers and only the efforts routing allows.

### fixed
- `/find/file` no longer blocks the daemon while it lists a huge directory. it walks asynchronously under a deadline and marks a cut listing `x-truncated: true`. a subscriber that stops reading is closed promptly instead of letting the daemon buffer megabytes for it.
- imported history shows on linux hosts.

## 0.8.6 - 2026-10-02

### fixed
- a request with many large images no longer dies at the provider's size limit. the context holds images to a byte budget (`images.budget`) and each provider to `providers.<name>.maxRequestBytes`. the oldest images the model has seen are dropped first and the model sees a marker in their place. clients get `session.images_dropped`.
- a provider refusal for request size is a `ContextOverflowError`. the daemon lowers the session's limit, drops images and retries a few times, or compacts when no image is left.
- heavy opaque pngs are re-encoded as jpeg when that saves 30%.
- bytes labelled as an image that are not one no longer hang a session with repeated 400s. they become a marker instead.

## 0.8.5 - 2026-10-01

contract version 5. additive.

- reasoning streams like text: `message.part.delta` with `field: "text"` and an `offset`. before, a thinking part reached clients once, when its step ended.
- every text and reasoning part is announced before its first delta, with `streaming: true` and `time.start`. final parts carry `time: {start, end}`.
- a reasoning part's final is published when its block ends, not when the step ends, so clients stop showing a finished thought as still running.
- the in-flight message read returns every part started so far, typed and in order. a resume that lands mid-thinking gets the reasoning part once, whole, before any delta.
- a message a crash cut off closes with the parts the log announced, so the log and the reads agree.
- the tui draws thinking as a folded "thinking, n words" line that grows as it streams.

## 0.8.4 - 2026-10-01

- the built-in effort floors (opus 5.5 never xhigh, sonnet 5.5 never max) are gone. `never` in `routing.jsonc` is the only rule and ships empty.
- `escalation.ceiling` takes an effort or a per-model object. defaults are xhigh for opus 5.5 and fable 5.1, high for sonnet 5.5, max otherwise.
- the shipped reviewer seat is opus 5.5 in both presets.

## 0.8.3 - 2026-10-01

- `worktree.minFreeRatio` defaults to 3% instead of 10%, still under a 5 GB absolute floor. on a large disk the old ratio refused every fresh checkout.

## 0.8.2 - 2026-10-01

### changed
- a daemon on any address but loopback always needs a credential, before the first pairing too. auth is decided before the request body is read, and bodies over 128 MB get a 413.
- subagents do not push. a `git push *` deny rule comes after every other rule, and git config on a child's commands rewrites push urls to a transport that does not exist.
- `GET /config` and mcp errors mask url passwords, secret query values and command-line tokens.
- every session carries its diff summary, zeros when nothing changed. streamed deltas past 16 per part in one event-loop turn are merged into frames of at most 64 KB.

### fixed
- security review fixes. requests with a cross-site `Origin` or `sec-fetch-site` are refused, and a daemon with no credential answers only to loopback host names, which stops dns rebinding. a repository's `.cmx2/cmx2.jsonc` can no longer set providers, the listener or mcp servers, or allow anything. permission checks follow symlinks, check each command of a compound shell line, and keep read-only agents off the worktree verbs.
- a session with `cache_ttl: "1h"` no longer fails on its second request. requests that start together on a cold prompt prefix no longer each write it: the first leads and the rest read its entry.
- a message a restart cut off reads the same from the store as from its last logged event. a terminal resumed from a cursor older than what is kept gets everything kept, then the meta frame. the snapshot size cap holds for files already in the snapshot.

## 0.8.1 - 2026-10-01

### fixed
- snapshots close with the daemon: nothing new starts, work in flight gets 3 seconds, then its git is killed. a daemon stopped right after a turn leaves no git process behind.
- diff, revert and unrevert wait for the session's snapshot work, so a diff read after a turn settles includes it.

## 0.8.0 - 2026-10-01

first tagged release. contract version 4. this collapses the prototype work before it. cmx2 is a daemon that runs agent sessions on pi, the open source agent engine it builds on, and serves them over http and sse (server-sent events).

### added
- the daemon. sqlite store and message projection, an append-only transcript per session, resume after restart, config layers (defaults, profile, hostname overlay, project, env), basic auth, pairing (`cmx2 pair`), `GET` and `PATCH /config`, and `cmx2 db import-cmx` to import history from cmx, the earlier tool cmx2 replaces.
- the contract. every event and route is json schema in one manifest, from which the typed `@cmx2/client` and `openapi.json` are generated. the event log gives each state-changing event a sequence number so `/event` and `/global/event` resume without gaps or duplicates.
- tools. read, write, edit, grep, glob and shell with typed results. deferred tools behind `tool_search`: webfetch, websearch, skill, lsp. `run`, a code-mode tool with `fs`, `search`, `shell` and `pty` helpers that go through the same permission rules as the direct tools. mcp servers from the profile over stdio and http.
- permissions and questions. wildcard rules, last match wins, no match asks. asks wait for `POST /permission/:id/reply`; the `question` tool waits for any client to answer.
- agents. `spawn`, `message`, `wait` and `agents` verbs. a helper is a real session with a parent, a path and a mailbox. done means parked, so a helper stays addressable after its report. caps on running turns, depth and tree token budget. `routing.jsonc` sets seats, presets, per-seat effort, caps and escalation.
- processes. every job and pty a session starts is owned, listed and reaped. jobs notify on exit, on an output pattern, or when a port opens. a pty websocket resumes from a cursor.
- worktrees. checkouts for agents on a branch of their own, cloned with `clonefile(2)` on macos, merged back as a squash and never pushed.
- long sessions. compaction runs on the session's cached prefix and starts in the background before the threshold. `notes` and `recall` survive compaction. file snapshots per turn power diff, revert, unrevert and fork. nothing in the store can be hard-deleted.
- ops and clients. one compiled binary per platform. `cmx2 serve --install` runs it as a launchd agent or a systemd user unit. `cmx2 upgrade` checks a sha256, swaps atomically and restarts the unit. `cmx2 doctor` reports problems with their fixes. `scripts/install.sh` and a release workflow. the cli (`run`, `session`, `models`, `providers`, `agent`, `stats`, `mcp`, `db`) and a terminal ui. the boxbox web client talks to the same contract.