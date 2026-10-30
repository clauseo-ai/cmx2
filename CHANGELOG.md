# changelog

notable changes to cmx2, newest first. the format follows keep a changelog. "contract" means the daemon's http api; clients such as the boxbox web client read it.

## unreleased

contract version 7. additive: `ProcessInfo` carries `serve` (boolean) and `notify` (what can still fire, or null); `POST /session/:id/procs` takes `serve`; `process.updated` also goes out when a running job's listening ports change. older daemons also report contract 7 and send neither field: read a missing `serve` as false and a missing `notify` as unknown. `McpStatus` (`GET /mcp`, `mcp.status`, the reload answer) carries `sessions`, `caller` and `instructions`. `POST /session/:id/agents/close` answers 400 for a target that is the session itself or one of its ancestors; `/interrupt` answers as before.

### added
- `serve: true` on `shell` and on `shell.spawn` in run: a dev server or preview the person will open, left running (a server started only to test against stays a plain job). it gets no default notify and never counts in `parked.jobs` or toward the 1h ttl switch, even with an explicit notify still armed; an explicit notify (on_port to learn it is up) fires as before. on `shell`, serve starts the command in the background. a background job without serve behaves as before. the tool descriptions and the system prompt say to start a dev server or preview for the person with serve and give them the url. why: a dev server started the default way counted as a job the session waited on until it exited, so a client could not tell "here is your dev server" from "waiting on a long task".
- job ports stay fresh without a client asking: while any job runs, one `lsof` every 3 s covers every running job's process group, and a job whose listening ports changed gets `process.updated`. ptys are not swept (an interactive shell puts each command in a group of its own); their ports come from `GET /session/:id/procs` as before. only the job's own process group is seen, so a server under docker or setsid shows `[]`. it costs 26 to 29 ms of cpu per sweep on a busy mac with 700 to 1,700 processes (about 1% of one core) and stops when nothing runs.
- `notify` on `ProcessInfo` is what is still armed: on_port drops out once it fired, everything once the process exited. the ledger line marks serve jobs.
- an mcp server in the profile can say `"caller": true`: each `tools/call` to it then carries the calling session in `_meta["cmx2/caller"]`, as `{ sessionID, rootID, parentID, depth, path, directory, host, callID }`. it is off by default, so session ids and folder paths never reach a server that did not ask. a `_meta` key the model puts in a tool's arguments stays in `arguments`. why: a server that acts as the calling session (boxbox's thread tools) has to know which session called, and one connection per server leaves no room for a per-session header.
- `"sessions": "root"` on an mcp server offers its tools to top-level sessions only: forks and sessions made with `POST /session` see them, spawned helpers do not. the filter sits where a session's tools come from, so for a helper the tools are not in `tool_search`, not loadable and not reachable from `run`, and switching a server to root takes a tool a helper already loaded away from it. the default, `"all"`, is unchanged. why: tools that start or message top-level threads must never reach a helper, where they would stand in for spawn.
- `"instructions": true` on an mcp server puts the instructions it sent at initialize in the turn context of each session that sees the server (so a root-only server's reach roots only), as one `<mcp-instructions server="<name>">` block; a `</` in the server's text is written `<\/`, so the server cannot close the block and speak as cmx2 or the person after it. it rides the first turn, again when the text changes, and after a compaction; past 4096 characters it is cut with a note. off by default. `fork_turns` leaves the spawner's turn context (`<system-reminder>` and `<mcp-instructions>` blocks) out of the turns it copies into a helper's brief, so a root-only server's instructions cannot reach a helper that way. why: a server's tools are deferred behind tool_search, so the model rarely learned they existed: in boxbox's thread-tools eval the model started a thread in 3 of 12 cases that called for one with the tool descriptions alone, and 11 of 12 with the server's instructions in front of it, still 0 of 14 where a helper was right.

### changed
- `POST /session/:id/agents/close` answers 400 `BadRequestError` ("you can't close yourself or an ancestor; end your turn instead.") when the target is the calling session or one of its ancestors; close such an agent as a session above it.

### fixed
- an agent that closed itself or an ancestor deadlocked its tree: its turn never ended, and any close, interrupt or abort that reached it hung too. close now refuses such a target at once ("you can't close yourself or an ancestor; end your turn instead."), and so does the agents tool's interrupt, the root included (the route still lets a client stop the root as before). the agents tool stops waiting when its turn is stopped, and a helper in `wait` or `question` stops without queueing for its slot. close, interrupt, abort, archive and shutdown wait at most 5 s for a stopped turn to go idle (the agents of one depth, and shutdown's sessions, together), then end its session anyway: a helper is closed or marked interrupted (a message reopens it), a root leaves memory with its jobs kept and the questions it read settled, and a turn that finishes late writes nothing and changes nothing.

## 0.9.4 - 2026-10-30

contract version 7. no shape changes.

### changed
- the model picks up skills by itself. the turn context lists each skill the session can load, as `- name: description` under one line saying to load a matching skill with the skill tool before starting on the task. it is sent on the first turn, again when the list changes (a config reload re-reads the skills dirs) and in the state block after a compaction, and never in the prefix. why: the list lived only behind `skill` with no name, so a skill was loaded only when the user named it.
- `skill` is declared from the first request instead of behind `tool_search`, so a matching skill takes one call. an agent without the tool gets no list either.
- a skill whose frontmatter says `disable-model-invocation: true` (or `autoinvoke: false`, as opencode writes it) is left out of the list and out of `skill`'s own listing; the user's `/name` and a call by name still load it. a skill with no description is not listed, since there is nothing to match on, and descriptions are cut at 1024 characters.

## 0.9.3 - 2026-10-25

contract version 7. no shape changes.

### changed
- names models bring from training are accepted instead of failing the call: a call to `bash` runs `shell` (bash is never declared), `edit` takes `old_str`/`new_str` for `old_text`/`new_text` (direct and `fs.edit` in run), agent names are lowercased with `-` and spaces read as `_` wherever a name is given or looked up, and spawn takes a model id (with or without a provider prefix) that matches exactly one routing alias. why: models trained on other harnesses reach for these names and the calls failed.
- `fs.read` inside run returns the file's raw text (offset and limit count lines); the read tool still shows line numbers. why: scripts that `JSON.parse`d it failed.
- run's description and helpers follow the tools the session has: an agent without `write` sees no `fs.write`, and calling one says it is not available to this agent. scripts run in an inner scope, so `const tools`, `let text` and the like no longer collide with the sandbox's own names.
- shell returns 300 ms after bash exits even when a background process still holds its output; that process group is adopted as a job of the session (the result names its `job_id`, later output goes to the job, and session cleanup reaps it). a call killed at its timeout says to use `background: true` for long builds, tests and servers. why: commands with `&` sat until the timeout and then the server they started was killed.

## 0.9.2 - 2026-10-22

contract version 7. no shape changes: the `session.warmed` description now says how a refresh works.

### changed
- a cache refresh hangs up as soon as the provider has read the prompt: on anthropic models at the raw `message_start`, which pi reads without passing on, instead of at the first content block, which can come after seconds of thinking billed as output. a refresh costs a cache read and a few output tokens; its usage and cost come from `message_start`, and the abort that follows is not a warning. providers that send no `message_start` keep the old path. why: refreshes sometimes paid hundreds of output tokens for thinking nobody read.
- the session you talk to is kept warm while parked too: up to 4 hours on the 1h ttl (a refresh every 54 minutes costs a cache read, about a fortieth of the rewrite a return after an hour pays) and 20 minutes on the 5m one (refreshes every 4.5 minutes would cost more than that rewrite over hours). helpers keep 20 minutes. warming roots count toward the residency cap: past it, the oldest one with no request on the wire leaves memory and stops warming. the engine's `warm` option is now asked with the ttl in force; `rootWarmHorizonMs` sets the root's 1h window.
- a helper no longer switches to the 1h ttl when its context passes 100k tokens; the session you talk to still does, and an open helper or a background job still switches any session. why: helpers rarely wait more than 5 minutes between steps, a parked helper is warmed at 5m, and the switch rewrites the whole prefix at twice the input price.

### added
- refresh costs are kept: each refresh is a row in a new `cache_refresh` table (migration 16) and its cost and tokens add to the session's totals. why: `session.warmed` was only an event, the event log keeps an hour, and refreshes never reached any total.

## 0.9.1 - 2026-10-22

contract version 7. additive: session infos carry `forkedFrom`; btw routes (`POST`/`GET /session/:id/btw`, `/btw/:btwID/dismiss`, `/btw/:btwID/promote`), the `Btw` schema, `btw.updated` and `btw.delta` events, and `btw` on a promoted user message's info; `POST /session/:id/agents/message` takes `files`; `agent.report` carries `file`; `POST /session/:id/fork` takes `clientID`.

### added
- btw: a side question about a session, answered by the session's model from the session's context and never added to it. `POST /session/:id/btw` (`{ text, clientID? }`) answers a running `Btw` at once, idle or mid-turn, without touching the session's status, queue, steers, transcript or revision; `GET /session/:id/btw` lists them oldest first; `/dismiss` sets `time.dismissed` (a flag, a second call changes nothing, a running btw stops); `/promote` puts the question and answer into the thread as a user message marked `btw: <id>` (a steer mid-turn, a prompt otherwise; 409 unless done and not promoted yet). `btw.updated` carries the whole btw on ask, finish, dismiss and promote (keyed per btw for `compact=1`, resent with the answer so far at a resume's seam); `btw.delta` streams the answer unlogged (merged per batch under `coalesce=100`). the request is the session's own (same model, options, system prompt, tools and messages; mid-turn the messages already sent) with one user message after it and the session's cache breakpoints kept where they were, so it reads the session's prompt cache instead of paying for the context again; the answer is capped at 16,000 characters and 3 minutes in the engine, since changing `max_tokens` would miss the message cache. a tool call gets an error result and one more step, never runs. the spend adds to the session's cost and tokens, not its context fill. btws live in a new `btw` table (migration 15), outside messages, forks, compaction and exports; a btw a stopped daemon left running reads "the daemon restarted before it answered". why: a client can ask about a thread from any device without steering the work or paying full price for the context.
- a fork says where it came from: `forkedFrom: { sessionID, messageID? }` on its session info (the fork answer, `GET /session/:id`, the list, `session.created` and `session.updated`). `messageID` is the parent's message the fork was cut before, in the parent's ids, and is absent when the whole history was forked; the fork's own copies carry new ids under the fork's id (`msg_<fork>_00001`, ...). a fork of a fork names its direct parent. `parentID` stays "an agent spawned by" and a fork never sets it. stored in two new session columns (migration 14, `forked_from` and `forked_at_message`); existing sessions keep every row and have no lineage. why: a client can show a fork's origin and point at the spot in the parent.
- every helper report is saved in full to `<data dir>/reports/<root session id>/<child id>-<turn end>.md`, and the report names it (the last line, each pool member's line, the cut note of a body over 12,000 characters, `meta.report_file`, the `agent.report` event's `file`). agents in the tree read it without an ask and nobody edits it. the files are copies, pruned oldest first past 64 MiB or 5,000 files. why: explore helpers briefed to write maps to files could not, put 16 kB and 35 kB maps in their final replies, and the parent got them cut with a pointer to a session no agent tool opens; its attempts to have the maps resent or retyped were all blocked by the provider.
- `message` takes `files`, the same as `spawn`: contents ride along with the note, each cut at 20,000 characters. a report's file reaches a running agent this way.

### changed
- fork acts once per client id, as prompts do: a repeat of `POST /session/:id/fork` with the same `clientID` answers the first fork's session info and makes no other session; without one, or with a new one, each call forks. why: a client that gives up waiting on a long transcript copy and retries made a second fork. the copy still holds the event loop for its whole length (measured in process: 60 ms for a 5 mb transcript, 200 ms for 25 mb, 0.9 s for 100 mb).
- the spawn tool's `agent_type` and `files` descriptions, and the explore and review helper prompts, say that explore and review cannot write files, that their final reply is the deliverable and is saved to a file the report names, and that the file can be passed on.

## 0.9.0 - 2026-10-21

contract version 7. additive: progress frames carry `state.metadata.progress`; `/global/event` and `/event` take opt-in `coalesce=100`, `types=`, `compact=1` and `gzip=1`; json answers over 1 kb are gzipped when the request accepts gzip; session infos carry `transcriptRev`, message reads send `x-cmx2-rev`, and `rev=1` puts the revision on stream events.

### added
- a transcript revision per session (`transcriptRev`): every logged `message.updated`, `message.part.updated` and `message.removed`, a revert and its undo move it in the transaction that writes them; a landing that fails midway still moves it; transcripts ahead of their rows (a crash between the two writes) heal after start, in pages off the start path. message reads send `x-cmx2-rev`, at least the last counted event at or before `x-cmx2-seq`; `rev=1` adds it to events. existing sessions start at 0 with their history, so 0 does not mean empty; an older binary on a migrated store writes without moving it. why: boxbox, after a gap it cannot replay, re-sends only the threads whose revision moved. migration 13 on a 470-session store took 11 ms with every count unchanged.
- event stream switches, each described in the manifest, all off unless a client asks: `coalesce=100` merges a part's text deltas into 100 ms batches and flushes them before any other frame; `types=` sends only the listed kinds (heartbeats and `stream.reset` always pass, and a heartbeat carries the last id the stream passed); `compact=1` resumes with the first and last state event of each key instead of every event since the cursor (asks never compacted; busy and idle statuses both kept), ending in the same state as a full replay; `gzip=1` with `accept-encoding: gzip` gzips the stream, flushed per batch. a stream that asks for none is unchanged. why: boxbox's stream from a busy daemon went from 699,555 to 29,800 bytes a minute with coalesce and gzip, and an idle one from 546 to 103.

### changed
- json answers over 1 kb are gzipped for clients that accept gzip (bun's fetch does, so the tui and cli get them and decode them transparently); the decoded bytes are the same. a transcript read went from 10,967 to 3,387 bytes.
- the daemon runs git status and checkout lists off its event loop, with a 10 s limit (a slow git keeps the last known status); lists and session events wait for git, and a read's `x-cmx2-seq` still covers its body. why: git ran on the loop after every edit, turn end and list, and every stream stalled; the worst loop stall during an edit-heavy run went from 108-413 ms to 20-51 ms, and `/project` from 113 ms to 3.6 ms.
- reading an unloaded session again writes nothing (it rewrote every row: about 800 commits for one read of all sessions, now 0), and message pages are built from the stored json instead of parsed and stringified again (daemon cpu for a 19.6 mb transcript 52 to 26 ms; bytes identical).
- `session.updated` goes out once per tick for activity, and a landed message commits once, its events sent after the commit (5,811 commits in the edit run, now 2,497).
- a daemon keeps at most 4 idle sessions loaded and drops idle ones after 20 minutes unless they are warming the prompt cache; a session keeps 50 request summaries, not 200, and drops its copy of the last request once warming stops. why: each loaded session holds about its whole transcript in memory; with large sessions rss went from 128-155 mb to 102-107 mb.
- a running shell's output tail (`message.part.updated` with `state.metadata.output`, at most once a second) is no longer stored, logged or numbered: on the default stream it has no id line and is numbered by `state.metadata.progress` (1, 2, 3 per part); reads carry the latest tail, and a resume gets that latest tail where it goes live, not every tick.
- the event log keeps 30 minutes or 10,000 events, whichever keeps more (it kept at least 50,000 of any age). a client away longer gets `stream.reset` and reconciles, as before.
- serve.log rotates at 10 mb, keeping 3 older copies.
- the port watch probes every 250 ms for 30 s, then every 2 s; lsof and ps run without blocking the daemon.
- release binaries ship bytecode with whitespace minified and names kept: the first health answer comes in about 33 ms instead of 80 and boot rss is 53 mb instead of 60; the binary grows from 72 to 81 mb.

## 0.8.17 - 2026-10-19

contract version 7. no contract change.

### added
- your notes for every session you start: `AGENTS.md` in the profile directory (`~/.config/cmx2/`, moved by `CMX2_CONFIG_DIR`). a session created with `POST /session` ends its system prompt with the file, trimmed, inside `<user_notes>` tags with the path it came from. it is read when the session is created and recorded with the prefix, so an edit reaches new sessions, not running ones. helpers do not get it. a missing or empty file changes nothing. why: what is true of one person and machine, such as which devices they talk to the daemon from and how those reach it, has no place in the shipped prompts or in every repository.

### changed
- every prompt profile says a decision or question put to the user is answerable from that message: what it is about, what is being decided, the options with their costs and a recommendation, in plain words.

## 0.8.16 - 2026-10-18

contract version 7. no contract change.

### changed
- the anthropic 5 and default prompt profiles say how to reach a browser and how to leave the machine. a task that needs a browser uses agent-browser when `command -v agent-browser` finds it, in a session of its own (`--session <name>`) that it closes, and asks before installing playwright, puppeteer or another browser tool. when the work is done and checked, the agent stops the jobs, dev servers, ptys and browser sessions it started and removes the temporary files, scratch scripts, downloads and merged or dropped worktrees it created, leaving what was there before and what it was asked to keep. its report closes with one line on what it cleaned up and what it left running or on disk. why: agents installed playwright on a machine that already had agent-browser, and left processes, files and worktrees behind. the openai and gemini profiles are unchanged.

## 0.8.15 - 2026-10-18

contract version 7. additive: `spawn` takes `why`, and `AgentInfo` and the `step_up` and `retry` metrics carry it.

### added
- `spawn` takes an optional `why`, one line on why the model and effort were picked. it is stored on the agent, returned in `AgentInfo`, written to the `step_up` and `retry` metrics, and shown by the `agents` tool on the agents below the caller. the helper never sees it.

### changed
- a helper's first message no longer names its model or effort. it reads `you are <path> (session <id>), started by <spawner> (session <id>).`, and an earlier attempt attached by `after` is named by path only. a stated effort invites the model to scale its work to the label, and escalation can change it mid-session.
- the shipped routing rule asks a spawn above haiku for its one-line reason in `why` instead of in the brief, so the helper does not read the spawner's cost reasoning. a routing.jsonc of your own that copied the old rule keeps working; change "in its brief" to "in why" to move over.

## 0.8.14 - 2026-10-17

contract version 7. additive: `GET /global/system`.

### added
- `GET /global/system`: the machine the daemon runs on, for a client that lists machines. `os` (platform, name, version, kernel, arch), `machine` (a mac's family and model identifier, else the dmi product name; `virtual` for a vm or cloud instance), `cpu` (model, logical cores, 1, 5 and 15 minute load), `memory` (total and available bytes), `disk` (the mount point holding the data directory, total and available bytes), host `uptime`, the daemon's `rss` and `uptime`, and `at`. the static fields are read on the first request and kept (macos spawns `sysctl`, `system_profiler` and `df` once then); the live ones come from the kernel on each request without a process. available memory is `MemAvailable` on linux and, on macos, physical memory less app, wired and compressed memory as activity monitor counts it, since `os.freemem()` leaves out file cache. on arm linux, where /proc/cpuinfo has no model name, the cpu reads from its implementer and part codes ("Arm Neoverse N1"). inside a container `machine` reads null and not virtual, since docker hides the dmi files. authenticated like every route but `/pair`.

## 0.8.13 - 2026-10-15

contract version 7. additive: a `busy` session status may carry `waiting`, a plain line saying what the session waits for.

### added
- `compaction.cold` (200k tokens by default, or a fraction of the window up to 1; `false` turns it off): a session idle at or past it makes its compaction summary just before its prompt cache expires, at 90% of the ttl, reading the cache; nothing is compacted then. the first request after the cache expired compacts with that summary, so a thread that comes back does not rewrite its whole context, and one that never comes back paid for one summary from cache. a cold session past the floor with no summary ready makes one on the spot, sent without writing the cache, and compacts. closed helpers get no idle summary. why: across two weeks of one machine's sessions idle past an hour at 200k or more, roots came back 75% of the time and open helpers 38%, against a break-even near 16%. a session evicted from memory keeps its summary and its cache clock now (up to 64 of them); before, a reloaded session never read as cold.

### changed
- the routing guide, from the first days on it: opus helpers run at high by default, since at medium they stop short of the checks on open work (across 55 opus medium helpers in october 2026, half the steps of high and claims without evidence behind them); medium is for applying a given defect list or re-checking a delta. merge conflicts where the brief says which side wins are mechanical work for haiku, with "stop and report when claims contradict". three rules added: a brief asks for a report under about 300 words with the detail in a file, every claim naming the check behind it; a brief names the files the task touches and attaches digests with `files` rather than a reading list; a task that needs more than about 150k of context is split or gets its own compaction point. why: in a three-day thread the opus helpers' cost was 57% cache reads at an average 206k of context per step, and the tool output cap fired 28 times in 10,298 calls, so the size came from steps, not from logs.

### fixed
- the recall index has an index on `message_id`. projecting a message replaces its recall rows, and the delete before the write scanned the whole table (454 MB after two weeks); on a machine deep in swap that held the daemon's main thread on disk reads for minutes and `/global/health` timed out. the index is added by migration on the next start.
- `cmx2 doctor` tells a daemon that holds the port but does not answer within 2 s apart from a port held by something else. before, a slow cmx2 read as "something that is not cmx2 holds port 4097", and the fix line said to stop it.
- a session whose directory does not answer (a macos privacy prompt for desktop, documents or downloads, a hung network mount) holds only itself. the daemon's first touch of a directory, its project config, its git root and the project picker's listing now run off the main thread, and git does not run in a directory until that first touch has settled. before, one such directory stopped every session and route until the prompt was answered: 18 minutes once, after an upgrade. the waiting session reads `busy` with `waiting` ("waiting for access to <dir>. macos may be asking on the mac"), and `prompt` and `prompt_async` still answer at once, queuing the prompt until the directory answers.
- on macos, `cmx2 serve --install` and `cmx2 upgrade` sign the copy they place with a code signing identity from your keychain (one named for cmx2, then developer id, then apple development; `CMX2_CODESIGN_IDENTITY` picks one, `-` keeps ad hoc). bun's ad-hoc signature changes with every build, and macos keeps folder access against it, so each upgrade lost the desktop, documents and full disk access grants and macos asked again; a daemon that hit the prompt with nobody at the mac waited on it. `cmx2 doctor` says how the installed copy is signed. the first signed install asks once more, then upgrades keep the grants.
- a provider stream that fails after only thinking has streamed (a dropped connection 80 s into thinking, say) is retried like a failure before any content, with the same backoff and retry status. the failed attempt's thinking is thrown away and clients see the thinking part start again. once text or a tool call has streamed, the error still ends the turn, since a retry would replay them.
- a failed helper's report says what its text is: what the failing message had written when it broke, or its last note from earlier in the turn. before, a progress line from mid-turn read like the report.
- a `run` script that times out stops the call it was waiting on. before, a `shell.exec` past the script's 10 minutes kept its command running after `run` answered. a script that returns normally still leaves an unawaited call alone.
- `agents` with `path_prefix: "/root/"` lists the same agents as `"/root"`; a trailing slash matched nothing, and `"/"` lists the whole tree.

## 0.8.12 - 2026-10-14

contract version 7. additive: `session.compacted` carries `cold`, and `compaction.prefire` may carry `refresh`.

### added
- the web tools have a choice of provider, set with `web` in `cmx2.jsonc`: tavily, exa, brave or a searxng instance for websearch, each one http call with no mcp server. with no `web` entry the first of `TAVILY_API_KEY`, `EXA_API_KEY` and `BRAVE_API_KEY` in the environment picks the provider; with none, websearch goes through [tavily](https://tavily.com)'s free keyless mode and falls back to keyless exa when tavily refuses (before, it always went to keyless exa). `web.search` adds request fields (tavily's `search_depth`); `web.url` moves the endpoint. opt-in, tavily only: `"fetch": "provider"` sends webfetch's public urls through tavily extract, which renders javascript (private addresses are always fetched locally), and `"crawl": true` adds a deferred `webcrawl` tool on tavily map and crawl, checked under the `webcrawl` permission. a repository's own config cannot set `web`. websearch details name the `provider` that answered and any `fallback`; webfetch details say `via` local or tavily; `cmx2 doctor` names the provider and where its key comes from.

### changed
- the shipped routing guide is haiku first, with opus as the step up. its first row names haiku high as the start for any bounded task whose brief pins down the behaviour and the checks; exploration, implementation that needs judgment, ui, docs and copy, terminal diagnosis, hard debugging and reviews start on opus medium. sonnet has no start row: it costs about what opus does per task on long contexts and sits behind it on the design and writing boards; it stays in the table for short tasks and for one long read that cannot be split. a spawn above haiku says in its brief, in one line, why haiku cannot do the task. the model notes carry measured price ratios instead of a warning about haiku's 100k tier (haiku about a seventeenth of a sonnet step under 100k tokens of context and about a third past it; sonnet per task about what opus costs on long contexts, since it writes more per step and takes more steps). the rules now ask briefs to make the task's decisions and state its targets, send haiku's code to review when no test or reference pins it down, and keep the driver's own context small. why: left to choose, a driver picked haiku 0 times in 43 unsteered spawns; sonnet high and opus cost about the same per matched review in practice. `docs/routing.md` has the evidence and an end-of-session debrief prompt for revising the guide from sessions.
- explore and review agents see an mcp tool only when its server marks it `readOnlyHint: true`; general agents and the root see every mcp tool as before. a server you configured is trusted, so its annotation stands. why: a read-only agent could write through an mcp tool it was never meant to have.
- a session whose background summary is ready compacts at the first request after its prompt cache went cold (more than the cache ttl plus 30 s since its last request, or a model switch), even under `compaction.at`. that request rewrites the cache either way, and the summary makes the rewrite small. only the ready summary is used; when it no longer fits the context, nothing compacts and the request goes on. `session.compacted` says `cold: true`, the transcript's compaction line carries `cold`, and the trigger stays `auto`. a session kept warm by cache warming is not cold.
- a ready background summary is made again over the current messages once the messages after it pass max(`keep` × `at`, 20k tokens), so the tail a compaction keeps verbatim stays short. the old summary stays in use until the new one is ready; a failed refresh keeps the old one and is not retried before the next compaction. its `compaction.prefire` events carry `refresh: true`.

## 0.8.11 - 2026-10-10

contract version 7. additive: completed tool states may carry `attachments` and `attachmentsDropped`.

### added
- a completed tool part carries the images its result returned (a read of an image, a screenshot) as `attachments`, file entries with a data url, so clients can preview them. at most 8 images and 4 MB of data urls per part; `attachmentsDropped` counts any left off. additive; the output text is unchanged.

### changed
- a helper's `question` tool asks the agent that started it, not the user. the question arrives as a message with a `correlation_id`, the spawner's reply is the answer, and the spawner asks further up with its own `question` tool when it cannot answer, so the user only hears questions from the root. while a helper waits its agent `cause` is `asking` and its running-turn slot goes to others. before, a helper's question went straight to the user, and its spawner sat parked without knowing.

## 0.8.10 - 2026-10-10

contract version 7. no contract change.

### fixed
- an mcp server whose connection closes is dialled again, after 1 s, then 2, 5, 10, 30 and 60 s, up to 12 tries; one that held for 30 s starts the waits over. before, it stayed failed until a reload or a restart (xcode's `mcpbridge` exits whenever xcode's own service quits). `/mcp` shows `reconnecting in N s` while it waits. a server that fails its first dial still stays failed, since that is a config problem.
- a session whose transcript holds more than 384 tool additions sends its requests with each removal that a later addition undoes taken out, together with that addition, when the tool was not called in between. the provider refuses more than 512, so such a session failed every request; the session that hit it goes from 547 to 70. under the limit, requests are unchanged.
- a revert leaves loaded exactly the tools the remaining context declares, as a resume would. before, a tool loaded in the reverted turns stayed loaded and the next turn declared it again.

## 0.8.9 - 2026-10-10

contract version 7. no contract change.

### fixed
- a session whose mcp server dropped no longer adds that server's tools back and removes them again on every turn. each round sent tens of thousands of uncached tokens and wrote as many to the cache, and after enough turns the provider refused every request with "total resolved tool_addition definitions across the request exceed 512". now a server that goes away costs one removal, and one addition if it comes back.

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