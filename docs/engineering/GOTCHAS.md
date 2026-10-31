# gotchas

sharp edges already paid for. add an entry the moment something bites.
format: slug, what happened, the fix or the rule.

## pi

- **a plain `Context` loses its system prompt and tools (2026-10-30).** pi's adapters read a `TranscriptContext` (`{ messages }`), with the prompt and tools in a leading system message. a request built as `{ systemPrompt, tools, messages } as never` sends only the messages: the title request ran this way and its prompt never reached the model, which is how a reply like `**title:** planning ...` got through. build it with `normalizeContext({ systemPrompt, tools, messages })`; `packages/engine/test/title.test.ts` checks the prompt is on the wire.
- **api churn.** pi's extension/sdk api broke in 4 of the 6 minor releases
  checked (0.84.0 ~12 items incl. rpc `message_update` deltas and
  SessionRepo v4; 0.84.3 thinking-level type rename; 0.86.0 custom
  providers receive TranscriptContext, `user_bash` fails closed; 0.87.0
  TurnEndEvent/ExtensionEvent union, message assignment no longer replaces
  history, `shouldStopAfterTurn` removed; 0.99.0 builtins renamed
  `builtin:<name>`, `--no-extensions` also disables built-ins). pin exactly;
  read `packages/coding-agent/CHANGELOG.md` before any bump; keep drift
  tests on every internal we mirror.
- **vertex mirror.** `pi-anthropic-vertex` works by mirroring pi's
  non-exported `anthropic-messages` stream (1,520 lines). ours will too;
  a test must fail loudly when pi's file changes.
- **experimental server.** `pi-server`/`pi-protocol`/`pi-client` (cbor v8)
  carry "no compatibility guarantees" and no auth. do not build on them.
- **node-first.** pi never uses bun-only apis; keep bun-specific code
  (`Bun.spawn` ptys, `bun:sqlite`) in our packages, never in anything
  registered into pi's loop that could be shared.
- **per-message effort placement.** anthropic's docs say the new level
  "takes effect from the next user turn"; whether a marker placed after a
  tool result affects the continuation is undefined. pi and codex assume
  yes. verify against the real endpoint before relying on mid-loop escalation.
- **sonnet 5.5 `between_tools`.** per-message effort is a 400 when
  `thinking.display` is `between_tools` on sonnet 5.5.
- **retry after streamed thinking.** pi's agent loop pushes a message on a
  stream's `start` and replaces it on every delta, so a wrapper that retries
  a stream must drop the retried attempt's `start`, or the failed partial
  (unsigned thinking) stays in context and breaks the next request. withRetry
  retries until text or a tool call streams; clients see the restart as a
  second `message.started` and the part announced again, empty.
- **pi does not surface `message_start` (2026-10-22).** pi's anthropic stream reads usage from the raw `message_start` and pushes nothing for it; the first event a caller sees is the first content block, which can come after seconds of thinking. code that stops at "the first event with usage" (the warm refresh did) pays for that thinking. hook `onProviderStreamEvent`, which pi calls with every raw event before handling it, and act on `type: "message_start"` there.
- **codemode's per-call signal.** a global's `execute` gets a context whose
  signal fires when the script ends, times out or is aborted. `run` used to
  ignore it and pass its own signal, so a script that timed out left its
  `shell.exec` running. it now stops pending calls on a timeout only, so an
  unawaited call in a script that returns is left alone as before.

## anthropic through vertex

- **prefix binding.** fable 5.1 binds thinking signatures to the prefix and
  400s on accounts created after 2026-08-31 when anything before a thinking
  block changes. always send `thinking.block_binding.prefix_mismatch_
  behavior: drop_block` (beta `thinking-binding-controls-2026-08-01`) and
  log `input_transformations`.
- **a warming session was never evicted (2026-10-22).** the residency cap skipped every warming session; once roots warmed for hours, parked roots piled up past MAX_RESIDENT. warming roots now count toward the cap and the oldest one on timers goes (D28). tests that measure the cap or the idle sweep with roots run their daemon with `warmHorizonMs: 0`.
- **`max_tokens: 0` pre-warm does not work through vertex (2026-10-22).** anthropic documents a `max_tokens: 0` request as a way to warm a cache. streamed, vertex refuses it ("stream cannot be true when max_tokens is 0"); unstreamed, it produced no output but wrote the prefix again instead of reading the live entry (2 of 2), and a streamed request after it did not read what it wrote. warm by re-sending the request and hanging up at `message_start` instead (D28).
- **forced tool use.** opus ≥ 5.5 and fable ≥ 5.1 400 on `tool_choice:
  any|tool`. map required → auto and use native `output_config.format`
  for structured output.
- **fast mode beta rejected by vertex.** blacklist `-fast` model entries.
- **api key.** sdk clients demand a key even though the proxy ignores it;
  fleet daemons run with a clean env, so bake a dummy in config.
- **refusals.** a content-filter stop looks like a silent non-answer unless
  surfaced; parse `stop_details` into a typed error naming the classifier.
- **byte-size ceilings.** provider byte limits must classify as context
  overflow, not wedge the session. vertex's refusal is a json array,
  `400 [{"error":{"code":400,"message":"The message size (30585366 bytes)
  exceeds 30.000MB limit.","status":"FAILED_PRECONDITION"}}]`: the limit is
  30,000,000 bytes, not 30 MiB, and a parser that slices from the first `{`
  reads nothing (the 2026-10-02 death classified as unknown and did not
  recover). `mediaRefusal` in `errors.ts` reads it, anthropic's 413
  `request_too_large`, and the image count and size refusals; recovery drops
  images (`images.ts`) instead of compacting.
- **images are bytes, not tokens.** a 1560x1688 screenshot is ~3.4k tokens on
  a 4.7+ model and ~1.4 MB of png. an agent that read 68 of them died at
  30.6 MB with 473k of its 1M tokens used and compaction set at 750k; 96% of
  the request was base64. the context holds images to `images.budget`
  (12 MB) and the request to `maxRequestBytes` (catalog limit, 20 MB through
  a baseUrl of your own), dropping the oldest seen images in one batch.
- **a drop costs a cache rewrite and thinking blocks, once.** removing an
  earlier image restarts the cache there and, with `drop_block`, the api
  drops every thinking block after it on every later request (dropped blocks
  are not billed). measured against a real vertex endpoint, opus 5.5: the stubbed request
  read 0 and wrote 7,719, its replay read 7,719, `input_transformations`
  listed `thinking_dropped` for both later thinking blocks; without
  `block_binding` this account answered `thinking_mismatch_allowed`
  (accounts from 2026-08-31 get a 400). so drops are batched (down to 40% of
  the budget), sticky (a transcript line), start early at a turn's first
  request, and ride a compaction for free. `dropped_blocks` stays above 0 on
  every step after a drop; that is expected, not a new prefix change.
- **a bad image wedges a session.** anthropic answers `400 Could not process
  image` for an image block whose bytes are not an image, and the transcript
  replays it, so every later request fails the same way (a boxbox session,
  2026-10-02: a run script base64-decoded a shell spill notice into 90 bytes
  and attached them as image/png). `checkedImages` keeps a block that does
  not sniff as png, jpeg, gif or webp out of every request (a marker in its
  place) and sends the type the bytes say; an image that sniffs fine and is
  still refused leaves with the images since the last reply (an
  `unreadable` drop). `resizeImage` refuses unsniffable bytes at the tool, so
  new ones never land. a copy of the hung session answered on the dev daemon.
- **codemode's `image()` takes one argument.** pi-codemode 0.99.1 reads a
  data url (`data:image/png;base64,...`), an `{image_url}` object or an mcp
  image block; a second argument is ignored, raw base64 throws `invalid image
  output. Pass a base64 data URI instead`, and its base64 decode is lenient,
  so text inside a data url becomes bytes (fixed upstream in 0.99.2, #10215).
  the run description said `image(base64, mime)`; it now says data url, and
  that an image file only needs `fs.read`.
- **an errored tool_result holds text only.** a `tool_result` with
  `is_error: true` and an image in it 400s ("all content must be type text
  if is_error is true"), and since the transcript replays, every later
  request in that session 400s too. a shell command that prints screenshot
  paths and exits non-zero makes exactly this. `toLlm` sends such a result
  unflagged, images kept, with a line saying it failed; the stored record
  keeps its flag, so an already wedged session resumes clean.
- **heic is converted at the door, and each decoder lies differently** (`packages/tools/src/image.ts`). anthropic and openai read no heic, so every heic becomes a jpeg in `resizeImage` and nothing past it knows the format (`sniffImage` stays png, jpeg, gif, webp on purpose: the engine's request gate uses it). what bit: sips converts an iphone photo to a jpeg whose pixels are still sideways, with the rotation left as exif orientation 6, and keeps the camera, time and gps position in that exif (measured on a real photo: `exif:GPSLatitude` present); models do not read exif, so the daemon reads the orientation, turns the pixels and drops every app segment but jfif, the icc profile and adobe's app14 (a color-transform marker). sips `--resampleHeightWidthMax` enlarges a small photo to the edge it is given, so it is given one only when the heic's `ispe` box says the photo is over; sips applies a flip before a turn whatever order they are given in, so mirrored orientations (5 and 7) are done as two runs. libheif's own tools rotate the pixels and leave no orientation, so their jpeg is stripped but never turned again. imagemagick reads heic only when built with libheif and the coder loads: ask `magick -list format`, not `which`. a decoder on PATH is not a decoder that works: after a homebrew bump of x265 a mac's `heif-dec` aborts at load (`Library not loaded ... libx265.215.dylib`) and its magick lists no HEIC; the intake tries the next tool and ends in a placeholder, never an exception (a tool that timed out ends the attempt instead: one 60 s budget covers a photo, so a hostile file cannot hold a prompt for three tool timeouts, and a header over 100 megapixels is refused before any tool starts). the same on ubuntu 24.04: `libheif-examples` decodes nothing ("Unsupported codec") until `libheif-plugin-libde265` is installed, apt does not pull it in, and 24.04 and bookworm ship `heif-convert` only, no `heif-dec`; imagemagick 6 there prints its format list without a module column, so the probe (`listsHeic`) accepts both. the probe is not remembered when it finds nothing, so installing a decoder works on the next photo without a restart (fleet serves are not restarted). tests that convert run only where the first fixture really converts, not where a tool is merely on the path. the fixtures in `packages/tools/test/fixtures/heic` come from ImageIO (`CGImageDestination`, `public.heic`, `kCGImagePropertyOrientation` 1 to 8); o6 also carries gps and camera tags. what was run where: the daemon-level drive (a real daemon, the real proxy, a model describing the photo) was done on macos with sips only. the magick and libheif paths ran at unit level in debian trixie, ubuntu 24.04 and bookworm containers (an independent review: all eight orientations upright, no exif left, 250k fuzz inputs with no throw or hang), with the plugin caveat above; there was no daemon-level drive on linux.

## measured at m0 (2026-09-30, through an anthropic-compatible vertex proxy)

- **beta probe.** one request per feature per model (opus 5.5, fable 5.1, sonnet 5.5), `packages/eval/src/probe.ts`:

  | feature | header | opus 5.5 | fable 5.1 | sonnet 5.5 | honoured? |
  |---|---|---|---|---|---|
  | baseline | none | 200 | 200 | 200 | n/a |
  | per-message effort | `mid-conversation-output-config-2026-07-01` | 200 | 200 | 200 | yes: markers on every request, output tokens move with the dial (low 69-98, max 466-1923), cache survives changes |
  | block binding `drop_block` | `thinking-binding-controls-2026-08-01` | 200 | 200 | 200 | unknown: no prefix mismatch exercised yet |
  | turn-scoped system `clear_at` | `mid-conversation-system-clear-at-2026-08-21` | 200 | 200 | 200 | no: accepted, but the next request lost message-level cache reads (bisect below) |
  | tool search `defer_loading` | `advanced-tool-use-2025-11-20` | 200 | 200 | 200 | unknown: accepted, search not exercised |
  | mid-conversation tool changes | `mid-conversation-tool-changes-2026-07-01` | 200 | 200 | 200 | unknown: accepted, no tool added mid-session yet |
  | 1h cache ttl | `cache_control.ttl: "1h"` | 200 (1h write 7211) | 200 (7211) | 200 (7211) | yes: `ephemeral_1h_input_tokens` 7211 on write |

  a 200 proves acceptance, not effect; there was no negative control (an invented beta) in this run. per-message effort is proven in effect by the daemon: markers ride every request and cache reads survive dial changes.
- **`clear_at` breaks the message cache.** with the batching nudge sent as `{role:"system", clear_at:"next_user_message"}` after the last user block, the next request read only the system+tools prefix (2,770 tokens) and re-wrote every message. the same nudge as a plain system message placed after pi's last breakpoint kept message-level reads (bisected on captured payloads). the nudge is request-scoped by construction; do not use `clear_at` until this is re-measured.
- **localhost is ipv6 first for bun.** a proxy that listens on `127.0.0.1` only is unreachable by name: bun's fetch resolved `localhost` to `::1` and got connection refused while curl worked. configure `127.0.0.1`.
- ~~streaming and non-streaming requests do not share a cache~~ **corrected 2026-10-01:** they share it; a stream write was read by a sync request. the two bodies differ in `stream`, so the pair is a changed request and lands like any other (upstream routing below).
- **cache-read at small contexts is bounded by arithmetic.** at a 3k prefix each step's new tokens are 10-20% of input, so 96% is unreachable; measure cache gates at a realistic context (40k+).
- **pi phones home unless told.** the sdk's settings have `enableInstallTelemetry` and `enableAnalytics`; cmx2 sets both false. pi can also overlay its model catalog from pi.dev; not yet disabled.
- **idle rss.** the daemon sat at 142 MB before any session and 196 MB after two sessions. it imports the full `pi-coding-agent` package (`createAgentSession`, `DefaultResourceLoader`, tool definitions); the engine-only import (`pi-ai` + `pi-agent-core` + codemode) measured 78 MB idle. an m1 fix, not a no-go.
- **pi's catalog refresh.** pi overlays its model catalog from pi.dev unless `PI_OFFLINE` is set; a catalog change mid-session can move the prefix. the daemon sets `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK`, pinning the catalog bundled with pi 0.99.1.

- **cmx cannot start in a bare clone of its own fork.** `.opencode/tool/*.ts` imports `@opencode-ai/plugin`, so `cmx run` exits in 2 s without `node_modules`; `--pure` does not skip project tools. for comparisons, move `.opencode/tool` aside in the scratch clone (cmx2 never loads it).

## measured at m1 (2026-09-30, same proxy)

- **negative control.** an invented beta (`cmx2-invented-negative-control-2099-01-01`) gets a 400 "Unexpected value(s) ... for the `anthropic-beta` header" on opus 5.5, fable 5.1 and sonnet 5.5. betas reach anthropic and are validated there, so the 200s in the m0 table are real acceptance.
- **turn-scoped messages are appended, not spliced.** the api guidance without `clear_at` is a text block after the tool results with earlier copies kept: on fable 5.1, opus 5.5 and sonnet 5.5 deleting an earlier system message invalidates the thinking blocks after it. cmx2 appends the turn text once per turn (system message, or a `<system-reminder>` part in fallback) and never edits it. measured on ~19k contexts: the request that adds the turn's system message read 98.5-99.3% from cache, and `dropped_blocks` stayed 0 on every step.
- **tool additions keep the prefix.** pi declares a deferred placeholder from request one and later tools as `defer_loading` declarations plus a `tool_addition` block. loading `webfetch` mid-session left the rendered prefix byte-identical; the first request carrying it read 98.5% and 98.6% from cache (two of three reps; the third ran at 4k context where a request with no change missed too).
- **single-pair cache experiments through the proxy are noise.** identical requests hit 6 of 6; a control pair that only appends a turn hit 1 of 3. the proxy called vertex at the `global` location, so region routing is not the cause (see "prompt cache" below for what is). judge cache behaviour on real multi-step runs (the 40-step chain read 94.6% overall and 96-97.6% from step 24), never on one pair.
- **pi-coding-agent was the rss.** the engine on pi-ai + pi-agent-core + pi-codemode idles far below budget; cmx2 ships its own read/write/edit/grep/glob/shell. keep pi-coding-agent and pi-tui out of the daemon's import graph (a drift test checks the bundler metafile).
- **glm through vertex did not filter** the historical question expected to trip its content filter; it answered. the live refusal path has no benign trigger on these five models, so refusal surfacing is pinned on recorded wire shapes (`packages/engine/test/drift.test.ts`).
- **opus 5.5 at medium already batches; the nudge did not move it.** on a 20-bug fix task it scripted the work in `run` (up to 41 helper calls in one step) and finished in 4 to 8 steps with or without the nudge; on a 20-hop chain with two independent reads per hop it hit the optimum (22 steps, 3 calls per hop) in both arms, identically. the nudge is a candidate for removal on 5.x anthropic models; measure fable 5.1 and sonnet 5.5 before deciding.
- **structured output shape is not correctness.** glm 5 returned schema-valid json with a wrong value (12 lines for a 2-line file). a format gate proves the shape, not the answer.

## measured at m2 (2026-09-30)

- **sqlite: set `busy_timeout` before anything that writes.** `pragma journal_mode = wal` ahead of `busy_timeout` made a second process opening the same fresh db fail at once with `database is locked`. and read `user_version` inside the write lock: two daemons on one fresh db both read version 0 and one died on `duplicate column`. the store now sets the timeout first and migrates in one `BEGIN IMMEDIATE` transaction (`store.test.ts` spawns four openers at once).
- **sqlite `json_remove` aborts the whole query on one malformed row.** guard with `case when json_valid(data) ...`.
- **reading a column loads all of it; `octet_length` does not.** `length(data)` and `substr(cast(data as blob), ...)` on a 286 MB cmx message took 300 MB rss; `json_remove` on it 889 MB; `octet_length` 24 MB. sqlite reads a value only when an expression needs it, so `case when octet_length(data) > n then null else ... end` skips oversized rows for free. the importer went from 1.33 GB to 505 MB peak on the full cmx db.
- **cmx's biggest rows are user-message `summary.diffs`.** most of a large message table's bytes are whole-file patches (rows over 8 MB, the largest 286 MB). the projection drops them; the cmx db keeps them.
- **the status map omits idle sessions** (cmx semantics, boxbox relies on it). a poller that waits for `status[id].type === "idle"` waits forever; wait for the id to leave the map. the m0/m1 drivers were fixed for this.
- **the run lock is `flock(2)`, not cmx's mkdir plus heartbeats.** the kernel releases it when the holder exits or crashes, so there is no stale lock to judge. bun reaches it through `bun:ffi` (`libSystem.B.dylib` on macos, `libc.so.6` on linux); flock locks are per open file, so a second holder inside the same process is refused too.
- **two daemons on one data dir share transcripts, not memory.** a daemon holding a session in memory while another ran a turn has a stale copy; cmx2 compares the transcript's size on disk with what it last wrote and reopens before running (the lock is taken first, so nothing can append in between).
- **bun test hooks time out at 5 s.** starting two daemons in `beforeAll` needs an explicit timeout.
- **deltas stream before their message exists.** the streaming assistant message is appended at the next transcript position, so `message.part.delta` carries the ids the message and part get when it ends (checked against a live stream: every delta's ids matched the final message).

## processes (m4)

- **bun has native ptys.** `Bun.spawn(argv, { terminal: { cols, rows, data(term, bytes) {} } })` on bun 1.3.14; the child leads its own session, so its pgid is its pid and `process.kill(-pid)` takes the group. piped jobs need `detached: true` for the same. no node-pty, no native addon.
- **a login shell in a pty is slow to answer.** `$SHELL -l` reads the user's rc files first (hundreds of ms on a typical zsh); a read that waits for 150 ms of quiet returns the echoed input before the answer. tests wait for content, not for quiet.
- **`lsof -g` takes a list, and its exit code means nothing there.** `-g 1,2,3` covers many groups in one run (the port sweep's one lsof); with `-Fgn` each process's `g` line comes before its `n` lines. it exits 1 when any listed group has no match, even when others printed ports, so read the output and treat only a failed start or a timeout as no answer.
- **`lsof -g <pgid>` needs `-a`** to and the tcp filter with the group filter: `lsof -nP -iTCP -sTCP:LISTEN -a -g <pgid> -Fn`. without it lsof ors them and lists every listener on the machine.
- **one process journal per daemon.** two daemons may share a data dir (the run lock allows it), so the journal is `<data>/procs/<daemon pid>.json`, not one shared `procs.json`; the sweep reads only journals whose daemon is dead (pid plus `ps -o lstart` start time, so a reused pid is not mistaken for the old daemon). a journaled child is the same process only when its start time matches too.

## measured at m3: the archive (2026-09-30)

- **imported history lives in `archive.db`, attached read-only.** the daemon attaches it with a uri, `attach database 'file:<path>?mode=ro' as archive`; bun:sqlite honours the uri on attach on macos (the system sqlite is built with `USE_URI`), and a write through that connection fails with `attempt to write a readonly database` (tested). **bun's own sqlite, the one its linux builds carry, is built without uri filenames**: the uri is read as a file name, the attach fails, and until 0.8.7 imported history simply never showed on a linux host (found running the suite in a debian container, 2026-10-03; the import and archive tests had failed there since m3). the store now attaches the plain path when the uri fails and creates temp triggers that refuse every insert, update and delete on the archive's tables with the same message, so the test holds on both. archive.db stays in rollback-journal mode: a read-only reader of a wal file needs a writable `-shm`, which defeats the point. the attach is lazy, re-tried on each read until the file and its tables exist, so an import that creates it while a daemon runs shows up without a restart. `all_session` is a temp view (per connection, touches neither file) that unions both session tables with main winning on id.
- **the 8 KB string cap is gone.** on a large cmx db about 8% of parts were over 8 KB and the cap threw away about two thirds of the part text. stored whole with zstd, the archive came out smaller than the m2 projection was with the cap. message rows over 8 MB (the `summary.diffs` rows, up to 286 MB) are still stubbed unread, and `summary.diffs` is still removed in sql; both stay in the cmx db.
- **zstd on this history is 51%, not 10%.** part bodies compress to about half; message infos to about two thirds (small rows, frame overhead). about 40% of the raw part text is base64 screenshot data urls: already-compressed png/jpeg, so deduping them into binary blobs would save about 1% of the archive, not worth a second storage shape. the rest compresses to ~40%. the zstd level barely matters (on non-image rows: level 1 42.5%, 3 41.6%, 9 40.4%, 19 39.9% at 38x the time), because per-row context is the limit: compressing a message's parts together gives 32.5%, a whole session 23.7%. rows stay per part so a part is still a row and page reads decompress only what they return.
- **`--since` defaults to picking up where the last import started** (minus a day of overlap for sessions updated while it ran), or 90 days back on a first run (`DEFAULT_SINCE_DAYS`). `--since all` imports everything. measured on a multi-gigabyte history: `--since all` took about a minute at a peak rss of 517 MB; the default on a fresh dir took about half that; an incremental re-run took 1.4 s.
- **walking all of history peaks rss at 430-590 MB.** a full read of a real archive (every page, 3.2 GB decompressed, 12-14 s) peaked at 588 MB with pages of 100 messages and 434 MB with pages of 20: gc lag behind big image strings, not the page size. normal paging is fine; a bulk export in the daemon would need to yield or run in a subprocess.

## measured at m3 (2026-09-30)

- **bun has real ptys.** `Bun.spawn(argv, { terminal: { cols, rows, data(term, bytes) {} } })` on bun 1.3.14 runs the child on a tty (`tty` prints `/dev/ttysNNN`); input goes through `proc.terminal.write(s)`, size through `proc.terminal.resize`. no node-pty, no native addon.
- **bun's `ReadableStream` types lack `[Symbol.asyncIterator]`** under this tsconfig even though iteration works at runtime; cast a spawned process's stdout to `AsyncIterable<Uint8Array>` to `for await` it.
- **exa's hosted mcp answers `tools/call` as server-sent events** (`event: message` then `data: {...}`), not json, without any `initialize` handshake. parse both.
- **tool results need an explicit return type** when branches return different `details` shapes; `defineTool` infers the details type from the first return and rejects the rest.

## measured at m3/m4: the boxbox drive (2026-09-30)

- **open boxbox's dev server on `localhost`, not `127.0.0.1`.** next's dev server blocks its dev resources for the `127.0.0.1` origin (`allowedDevOrigins`), the page never hydrates, and the login button stays disabled with the password typed.
- **a blocking response must send headers early.** node's fetch (boxbox's proxy) gives up after 300 s without response headers: a `POST /session/:id/message` that held its headers for a whole turn came back 502 at exactly 5.0 min. `/message` and `/command` now stream (headers at once, the json when the turn settles), as cmx did.
- **boxbox reads an open assistant message as a lap in progress.** its queued-bubble logic (and so unsend) needs an assistant message without `time.completed` while the turn runs; cmx2 now announces the step's message on its first token and keeps a message with tool calls open until they answer.
- **ids must sort in transcript order.** boxbox orders and answers by string comparison of ids; a provisional id that outlived its wait sorted after every later message. provisional ids now reissue under the transcript id when the message lands.
- **pi's `peekQueuedMessages` shows one message in one-at-a-time mode.** draining a queue with peek then `clearAllQueues` dropped every queued prompt but the first after an abort. keep the admitted list yourself.
- **a turn that ends in an error leaves pi's follow-up queue in place.** the next send must go after what waited, or the order flips.
- **macos airplay listens on port 5000**, and a random eval port once landed on a local postgres (5432). pick free ports by checking `lsof`, and a port notice must check who holds the port.
- **vertex's content filter is an `invalid_request_error`** ("Output blocked by content filtering policy"), e.g. counting to 300 in words. typed as a refusal at m5 (below).

## measured at m5 (2026-09-30)

- **vertex's content filter arrives mid-stream, after a 200.** the response starts normally (thinking, text deltas) and ends with `event: error` / `{"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}`; there is no `stop_reason: refusal`, so the event gate never sees it. pi turns it into `stopReason: "error"` with the whole error json as `errorMessage`. `refusalFromError` reads the json and names it `vertex_content_filter`; the engine stamps the refusal on the assistant message before it is written, so the step row (`stop_reason: refusal`), `session.error` (`RefusalError`) and the projected message (`info.error.name: RefusalError`) agree. recorded in `packages/engine/test/fixtures/vertex-content-filter.sse`; triggered on sonnet 5.5 and opus 5.5 alike. `bun packages/eval/src/m5.ts refusal` drives it on a real daemon.
- **boot rss is loaded code, not data.** a booted daemon holds ~5 MB of js heap and ~95 MB rss; the rest is module source, bytecode and structures, roughly per module loaded. the top three, measured one import at a time and incrementally in one process: **typebox, +32 MB for 668 modules** (the whole of `typebox`, `typebox/value` and `typebox/compile`; pi-ai's tool validation imports `typebox/compile`, so it stays while pi-ai loads at boot); **bun itself, ~23 MB** before anything is imported; **pi-agent-core's harness, ~8 MB for 171 modules** (its index re-exports skills with `yaml`, the edit tool with `diff`, compaction and session storage; the daemon uses only `Agent`). pi-ai's own code is +4 MB and the event manifest +7 MB. the provider sdks (openai, @anthropic-ai/sdk, @google/genai) are in the static graph but load lazily and cost nothing at boot.
- **import pi's `Agent` by file.** pi-agent-core's exports map has no entry for `dist/agent.js`, so `packages/engine/src/pi-agent.ts` imports it through the engine's own dependency link (`../node_modules/@earendil-works/pi-agent-core/dist/agent.js`); the bundler follows it, `pi-internals.json` pins its bytes, and the drift test fails if the index, the harness, `yaml` or `diff` come back into the daemon's graph. boot went from 936 to 766 modules and the cli daemon from 103.9 to 95.8 MB (median of three boots at +5 s; idle at +3 min 100.3 to 95.0 MB).
- **three sessions at ~340k tokens each cost ~65 MB.** `bun packages/eval/src/m5.ts rss300k`: three seeded sessions (338-343k tokens per request) ran one sonnet 5.5 turn each at once; rss 98 MB idle with them seeded, 156.9 median and 160.8 peak during and after the turns (budget 400). a heavier run at ~505-515k tokens each peaked at 173.4 MB. the transcripts are held in memory once per live session (pi's message array); the request body is built per request and dropped.
- **numbered source tokenizes at ~2.5 characters per token** on claude (1.25 M characters of `cat -n` style reads came back as ~505k tokens). size seeded contexts by tokens reported, not by characters.

## agents (m5)

- **boxbox reads any non-idle status as busy.** its watcher keeps every `session.status` whose type is not `idle` in the busy map, and a busy thread gets flush (abort then loop) on the user's press. a parked session is idle with detail: `{type: "idle", parked: {agents, jobs}}`, never a new type. `GET /session/status` still omits idle sessions.
- **boxbox's pack comes from `parentID`.** its agents sheet lists sessions whose `parentID` is the thread ("on track" when busy, "settled" when idle), learned from `session.created` frames and `GET /session/:id/children`. a child is a real session with `parent_id`; nothing else is needed for the pack. boxbox's proxy allowlist has no `/session/:id/agents` yet (a boxbox work item).
- **siblings of one agent type share one cached prefix, so child turns are cheap.** a child's system prompt depends only on the agent type (and the model's own profile); its path rides the first message. measured: two engineers' first requests read 6,390 tokens from cache each (87%) before writing their own brief. side effect: a token budget of a few thousand does not trip on one child turn; tests that need a spent budget use 1.
- **a tool description's example is prefix text.** the `message` tool says "a path such as /root/worker_a", so a test asserting the prefix lacks `worker_a` fails for the wrong reason; assert on names nothing else uses.
- **a pipe hides a check's exit code.** models run `bun test 2>&1 | tail -30`; the shell reports exit 0 with `1 fail` in the output. the escalation signal reads the output's verdict (`N fail`, `FAIL`, `error TS…`) as well as the exit code.
- **models edit through the shell.** engineers wrote with `printf ... >> src/math.ts` and `cat >> file <<EOF`, never calling write or edit, so the roster's files column was empty. the engine records redirection, `tee` and `sed -i` targets as touched files (a heuristic for the roster, never a permission check).
- **a pool member can fail before its siblings exist.** with an injected fault the first member's turn ended while the loop was still creating the rest, and the collector saw a pool of one. every member is created first, then all are started.
- **a cache entry keyed at a turn-context system message is not found by the next turn.** pi puts the latest breakpoint on the last message, which at a turn's first request is the turn-context system message; an identical replay hits that entry, but the next, longer request does not look back across the system message. measured on a 95k-token agent: every first turn was re-written in full by the second (6.7% read), while later turns read 99.9% at 30 to 120 s gaps. two rules in `gates.ts` fix it: move a trailing system message's breakpoint to the user message before it, and put a fourth breakpoint exactly where the previous request put its last one (the last user message before the newest assistant message, known even after a resume). after the fix the first follow-up read 99.3%. this likely explains part of the "noisy cache at small contexts" seen at m3/m4: single-step turns (most chat turns) paid a full write on the next turn.
- **a cache entry goes missing now and then.** (not the proxy: the requests were the same shape, not the same bytes, so a longer request landed on a different entry; see "an identical replay proves nothing about the next step" below.) two agents with byte-identical request shapes, sent at the same moment: one read 99.9%, the other 5.8% (less than the shared system and tools). about 1 in 12 follow-ups in the gap test; judge cache on several requests, never one.
- **a smaller max_tokens is a different cache key.** (corrected 2026-10-01: it is not a key; `max_tokens: 1` read an entry written at 1024. the 89k re-write was upstream routing of a longer request, not a key. sending the same bytes is still right, since identical requests land on the same cache.) replaying the last request with `maxTokens: 1` to keep it warm changed the thinking parameters, and the refresh re-wrote 89k tokens instead of reading them. the refresh sends the same request byte for byte (same breakpoint rules too) and aborts at the provider's first event, the raw `message_start` on anthropic (see the pi entry: pi does not surface it); the prompt is processed, and the entry refreshed, before that event.
- **pi's first stream event has zero usage.** wait for the event whose partial usage is non-zero before aborting a refresh.
- **the tree budget interrupts the child that spends it.** with `caps.budget_tokens` exhausted mid-turn, the running child stops with a partial report (`reached status: partial`) and never reaches parked; wait for its report, not its park.
- **a root that "hangs" after a helper reports may be asking you something (2026-10-09).** a driver script that
  creates a root, never prompts it, and spawns a helper whose report says a test fails saw the root stay `busy` with
  `steps 0` for minutes, in about two of three runs, the same on an earlier commit and on main, with the provider answering every
  request in under 4 s (a forwarding proxy logged each response delivered whole to the daemon). the root had
  called `question` ("which should change, the test or greet?"): `steps` only records a step when the next request opens
  it, so a turn parked on an ask shows no step, and `/session/status` says `busy`. `GET /question` lists it. a driver
  that wants the root to finish says in the prompt or the brief that nobody is there to answer, or checks `/question`
  before calling it stuck. nothing is wrong in the daemon; the model chose to ask.

- **an agent that closed itself hung its tree for good (2026-10-30).** close and interrupt wait for the target's turn to go idle (`host.interrupt` is `session.abort()`, which awaits pi's `waitForIdle`), and the agents tool awaited the close inside the very turn it was waiting on, ignoring the abort signal. the turn waited on the tool and the tool on the turn, so it stayed `working`, and every later close, interrupt or `POST /session/:id/abort` that reached it waited too. now a target that is the caller or its ancestor is refused, the agents tool returns when its turn's signal fires, and every wait for idle (close, interrupt, abort, archive, stop) gives up after `IDLE_WAIT_MS` (5 s) and ends the session. a disposed session ignores every agent event, so a tool that returns late cannot append to a transcript a reopened session now owns (it overwrote the newer message with the same number), move the agent's state, post a report or release a lock a newer session holds; the unanswered call reopens as "No result provided". with the turn end suppressed, a forced root abort does the root's bookkeeping itself (`forceInterrupted`), or a helper whose question the root had read stays blocked.

- **a deliverable with no handle is lost (2026-10-22).** a parent briefed two `explore` helpers to write their maps to /tmp files. explore cannot write, so each put its whole map (16 kB, 35 kB) in its final reply; reports were cut at 12,000 characters with "the full text is in session X", which no agent tool opens. the parent asked the helpers to resend the maps verbatim to other agents, then tried to retype them itself, and the provider blocked all six requests (anthropic's filter against reproducing model output); the maps never reached the agents that needed them. every report is now a file the report names, `files` on `spawn` and `message` passes it on, and explore and review are told their final reply is the deliverable. a brief that asks a read-only helper to write a file is the thing to watch for in transcripts.
- **a reopened helper declared different tools than a fresh one.** `read_only` children excluded four tools when created and seven (the worktree tools too) when the daemon reopened them, because the two paths each wrote their own list. both now read `exclude_tools` from the agent row (`EXCLUDE_EXPLORE`, `EXCLUDE_REVIEW` in actors.ts); rows written before it fall back to the explore list through `read_only`.
- **a spawn that names no model is an error on purpose.** the first `spawn` after contract 7 with neither `model` nor an agent type that names one answers `BadRequestError: a spawn needs a model: one of ...`; tests and scripts that spawned with no seat need `model`. a rest `seat` is `SeatsRemovedError`, not ignored.
- **a version-1 routing file loads and is half ignored.** `preset`, `presets`, `seats` and an `effort` map are dropped with one warning per file; `escalation.ceiling` and `never` still apply, so an old file that says `"ceiling": "max"` still sets max for every model. read `cmx2 agent models` for the warnings.

## sync and the listener (m6)

- **`Bun.serve` streaming responses have no backpressure (bun 1.3.14).** a `ReadableStream` body is drained into native buffers whatever the socket does: `desiredSize` never drops below the high water mark, `pull()` keeps being called, a `type: "direct"` stream's `write()` and `flush()` always report success, and an async-generator body behaves the same. against a peer that never reads (a python socket that never calls `recv`), daemon rss went past 2.8 GB in 4 s. this is the v1 reconnect balloon waiting to happen: one half-open client grows the daemon without bound.
- **test a stalled client from another process.** an in-process "stalled" client shares the daemon's event loop and can drain the stream; python's `socket.create_connection` plus `sleep` is a real stall. (m6b correction: bun 1.3.14's `net.Socket.pause()` in its own process does stop reading; a paused peer took 1.3 MiB, the kernel buffers, then the server blocked. the boxbox v2 probe's paused bun socket is a real stall.)
- **`node:http` under bun reports honest backlog.** `res.writableLength` grows with what the peer has not taken and `write()` returns false, so a byte cap can be enforced. but bun's `node:http` cannot serve sockets it did not accept (`server.emit("connection", sock)` hangs), and writes to the socket of its `upgrade` event never reach the client, so websockets cannot ride it.
- **so the listener is a tcp front.** a `node:net` server on the public port reads the first request's headers: a websocket upgrade is piped raw to an internal `Bun.serve` on loopback (the pty websocket code is unchanged), everything else to an internal `node:http` server. `pipe()` carries backpressure across the hop: with a stalled peer the 1 MB cap tripped after 2.7 MB written (the rest sat in kernel buffers) and rss stayed at 51 MB.
- **a failed `node:net` listen shows synchronously as `address() === null`**; the `EADDRINUSE` error event comes a tick later. check the address to keep `serve()` synchronous.
- **the loopback hop overflows macos's accept queue (`kern.ipc.somaxconn` 128).** 300 concurrent requests through the front reset exactly 128 of them: the front accepted the burst and dialled the internal server faster than it accepted. each server alone takes the same burst. the front keeps the request head buffered and retries a refused dial (up to 40 times, 5 to 50 ms apart); 300 at once now reset none.
- **an in-process burst is not a daemon burst.** a test that hosts the daemon and fires 300 fresh sockets from the same process can still see resets (the one event loop is busy on both sides, and the front's accept queue is 128); the same burst of 300 and of 1,000 against a daemon in its own process reset none. race in rounds of 50 in process; measure bursts against a cli daemon.
- **pi gates tool calls one at a time, in its before-call hook.** in parallel mode pi awaits `prepareToolCall` (argument checks and `beforeToolCall`) for each call in turn and only then runs the executions together, so a permission ask in the hook holds every later call: the second ask exists only after the first is answered. m6b moved the gate into the execution of tools that run in parallel (`EngineSession.agentTools`); sequential tools (write, edit) keep the hook. two gated reads and two questions in one response are now four open asks (boxbox v2 probe a6).
- **bun's `toMatchObject` writes asymmetric matchers into the received object.** after `expect(r.json).toMatchObject({ id: expect.stringMatching(/x/) })`, `r.json.id` is the matcher, and a later lookup by that id finds nothing. read ids into locals before asserting.
- **boxbox v1 renders a retry as a running turn.** its watcher keeps any non-idle `session.status` in the busy map and the ui reads it as driving; `attempt` and `message` are not shown anywhere on boxbox main. a boxbox change (not shipped) draws them; nothing the daemon could send instead would be honest (a fake part breaks a2, a `session.error` draws a fault).
- **don't test streaming with numbers in words through vertex.** the content filter cut "one to one hundred and fifty in words" mid-list, and the follow-up (asking for a story) went back to the list and was cut again: two `RefusalError` turns, and a mid-answer reload test with nothing streaming. use prose ("a 1500-word story about ...").
- **a reopen test needs an answer that outlasts the reload.** sonnet 5.5 at low finished 150 lines before a page reload landed; a 1,500-word story streams for about 20 s.
- **a burst of requests leaves rss up after the heap is back.** 6,000 gets took the daemon from 102 to 182 MB with the js heap back at 10 MB after a gc; m5's `Bun.serve` build showed the same curve (100 to 179). it is allocator retention, returned over minutes (the m5 idle run fell from 126 to 70 MB by minute 7), not a leak. compare rss across runs with the same load, and let `/global/memory?gc=true` collect first.

## the v2 probes and the listener (m6b)

- **a burst from the provider held the event loop for 1.4 s.** pi walks a network chunk's events on microtasks, so 24,000 deltas ran back to back: no socket write, no heartbeat, no other session, and a stream could not be judged until it was over. the provider stream in `withRetry` now gives the loop a turn every 16 ms.
- **one frame can be bigger than the cap.** the finished part's `message.part.updated` carries the whole text, 4.8 MB for that burst, so a byte rule ("1 MB behind, close") cut a fast reader the moment the frame was written, and "check before the write" cut it on the next small frame while it was still reading. a stream over the cap is held back (nothing more written) and caught up from the log once its peer drains; one that takes nothing for 200 ms while the loop could serve it is closed.
- **count only the loop's responsive time as a peer's silence.** a timer that fires after a blocked stretch runs before the i/o phase, sees no progress and blames the peer. judge after a `setImmediate` and count a long gap as one beat.
- **a graceful close delivers what is parked in the hop.** a closed stream still drained ~5 MB from the loopback hop's four socket buffers into the peer (the v2 probe allows 4 MiB). bun's `resetAndDestroy()` does not send a reset (the client read 2.32 of 2.4 MiB after it, no error), so the listener exposes `cut(peerPort)`: the daemon drops the public socket at once and only the client-side kernel buffers reach it.
- **rss after a gc cannot show a 1 MB difference between two daemons.** the same 12,000-event run grew -2.6, +2.2, +49.1 and +69.4 MB on four fresh daemons. assert where the stream is cut, print rss.
- **coalescing deltas broke a v2 probe's precondition.** probe a1 needs a frame per streamed delta (the 40-glyph reply must arrive as at least 40 deltas); merging deltas that arrive in one read gave 32. reverted; the bytes it saved are real (a 200-character delta is a ~760-byte frame) and worth revisiting if a client needs them.

## worktrees (m6b)

- **`cp -c -R` is not the fast path.** it clones file by file: 3.3 s for cmx2's node_modules (19,786 files), 11.8 s for a checkout with a rust target dir. one `clonefile(2)` call per top-level entry through `bun:ffi` took 453 ms for the same node_modules. errno comes from `__error()` in libSystem.
- **a symlink is not a directory to git.** a linked `node_modules` in a git-path checkout is untracked (the `node_modules/` rule matches directories only), so every checkout read dirty and merge refused. linked paths go into the repository's shared `info/exclude`, anchored.
- **`git worktree add --no-checkout` then `reset --hard` rewrites every tracked file.** fine after a clone (the tracked files are small next to what the clone brought), and it is what drops the source's uncommitted work; `git clean -fd` then removes its untracked files and keeps the ignored ones.
- **boxbox v1's "open a repo" is a project-scoped list.** it sends `GET /session?scope=project&roots=true&limit=1` with the directory header and expects the repo to become a project (cmx made an instance). cmx2 derived projects from sessions only, so an opened repo never listed and compose never offered its workspaces (main, fresh checkout). such a list now records the project (`project_opened`).
- **boxbox v1 reads the project index only on (re)connect.** a repo opened after its watcher connected reaches compose's workspace line after the next reconnect; the same would be true against cmx.
- **boxbox v1 folds a dead checkout by its path**: `/worktree/<40 hex>/<name>`, with the hex a project id. cmx2's project ids are paths, so a merged checkout's thread became a tile named after the checkout. merge and discard now move the checkout's sessions to the repository's main checkout.
- **an eval brief that says "leave it running" gets `keep`.** told to leave the dev server running, an engineer started it with `keep: "shop-dev"`, which outlives the session by design, and the orphan check failed on a process that was working as documented. the eval says "without keep".
- **`pgrep -f <dir>` misses a dev server.** its command line is `bun server.ts`; the checkout is only its working directory. `lsof -a -d cwd -Fpn` lists every process's cwd (the `fcwd` line sits between the pid and the path).

## the binary and ops (m8)

- **a compiled binary has no files next to its code.** `bun build --compile` embeds modules, not what they read from disk: the prompt profiles (`readFileSync(new URL("./x.md", import.meta.url))`) came back ENOENT under `/$bunfs/root/`, and so did quickjs's wasm. import text as `with { type: "text" }` and binary assets as `with { type: "file" }` (a path bun's fs can read inside the binary).
- **bun 1.3.14 forgets to initialise pi-ai's event stream in a bundle.** pi-ai declares itself free of side effects, so the bundler wraps `utils/event-stream.js` in a lazy initialiser and the engine's static import never calls it: the first turn of a compiled binary failed with `undefined is not a constructor (evaluating 'new AssistantMessageEventStream')`. a later turn would have worked (a provider module's import runs it). the cli does `await import("@earendil-works/pi-ai/utils/event-stream")` at startup; a named import plus `void X` is dropped as dead code and does not help.
- **workers in a binary are extra entrypoints.** pi-codemode runs each `run` script in a worker whose default path points into node_modules. the build passes `packages/tools/src/codemode-worker.ts` as a second entrypoint; bun keeps extra entries at their path below the entries' common root (`/$bunfs/root/tools/src/codemode-worker.js`), while the main entry is named after `--outfile`. test for `/$bunfs/` rather than a file name. the tui rides the same way (`tui/src/index.js`), loaded by a computed path so pi-tui stays out of the daemon's graph.
- **launchd gives an agent almost no environment.** `serve --install` writes HOME, PATH and CMX2_* into the plist; provider keys go to a 0600 `service.env` that `/bin/sh` sources before `exec`ing the binary, so `ps` still shows the copied binary and no secret sits in the plist.
- **systemd user units** cannot depend on `network-online.target` (a system target), need `Restart=always` because `/global/restart` exits 0, and stop at logout unless `loginctl enable-linger` is on.
- **a guessed release repository is a supply-chain hole.** the first cut of `install.sh` and `cmx2 upgrade` defaulted to an org nobody owned; whoever registered it would have served every install. the binary now carries the repository it was built from (`--repo`, from `GITHUB_REPOSITORY` in the release workflow) and `install.sh` refuses to run until its `REPO` line names the real one.
- **`screencapture` fails from an agent's shell** ("could not create image from display"). to prove a desktop notification was shown, read notification center's own record: `~/Library/Group Containers/group.com.apple.usernoted/db2/db`, table `record`, `data` is a binary plist with `req.titl` and `req.body` (`plutil -p`; json conversion fails on its data fields). `bun packages/eval/src/m8.ts notify` does this.

## compaction, snapshots, recall (m7)

- **small contexts miss the message cache through vertex.** below roughly 60k tokens, a step whose rolling breakpoint sits exactly where the previous request wrote its entry still often reads only the system prompt and tools (6.5k here) or nothing, and writes the rest again; from ~60k up the same code reads 97-99%. it shows in the m6 and m8 lanes' databases too, so it is not compaction's doing; it makes the first few steps after a compaction cost a write of the compacted context. measure before blaming a prefix change: `prefix_same` stays 1. (2026-10-01: upstream routing, not the minimum prefix; the floor for the 5.x models is at or under ~1.4k. raw requests settle on one cache from about 28k tokens; below that about half of the follow-ups miss. `cache.ts classify` tells a routing miss from a prefix change.)
- **code is 2.3 characters a token, not 4.** the m7 eval seeded 232k tokens at 3.5 characters a token and the provider counted 348k. the engine's estimate for messages after the last usage is characters over three; the threshold check leans on the provider's own count for everything before the newest step.
- **a string and its one-block form are the same prompt.** the rolling breakpoint rewrites `content: "text"` into `[{type: "text", text, cache_control}]`; the summary request sends the string form for the same message and still reads 97-99%. compare requests with that normalised.
- **the end-of-turn snapshot is asynchronous.** a blocking `/message` answers before the turn's snapshot and the session diff are written. `GET /session/:id/diff`, revert and unrevert wait for the session's snapshot work (up to 30 s), so they include the turn that just settled; the row's `summary` still moves on the `session.updated` that follows, so a bare `GET /session/:id` right after the answer can show the previous turn's numbers. the m7 test caught the diff route reading too early once in five runs.
- **a daemon stopping mid-snapshot left git running.** a test that ended right after a turn stopped its daemon while the end-of-turn `git add` was still going; bun killed the orphan and the test's hook timed out, four at once on main. `stop()` now closes the snapshots: nothing new starts, work in flight gets 3 s, then its git is killed. a checkout removed under a turn (a merge) now logs that its directory is gone, not that git is missing.
- **the turn-start snapshot races the first tool call.** the before-turn tree is taken while the first request is in flight; a first snapshot of a huge repo (20k files) could still be running when the model's first write lands. in practice the first request takes seconds; the limit and the log line are in `snapshot.ts`.
- **a disposed session must start nothing.** the overflow recovery ran after `dispose()` in a unit test and its requests landed in the next test's fake provider. recovery waits a tick and checks `disposed`; so does the prefire.
- **a ready prefire sat unused through cold caches.** the prefire summary was only applied at `at`, so a session that idled past the ttl between the prefire line and `at` rewrote its whole context on each return while a summary that would have shrunk it was ready (D25). the cold check reads `lastCacheUseAt`, set by the turn's request, a warm refresh and the summary request; a provider request this session sends that touches its cache and does not set it would make the session look cold and compact early.
- **a refresh races the compaction that makes it pointless.** the refresh's summary describes the context it started on; a compaction (or a revert, or a cold attempt that found the old summary stale) clears `refresh` before it can land, and the refresh adopts its result only while it is still `this.refresh`, else it reports `stale` with `refresh: true`. a compaction never waits on a refresh: it uses the old ready summary. if the old one is stale at the threshold, the synchronous summary runs while the dropped refresh's request may still be in flight, the one case with two summary requests at once.
- **recall found its own query first.** fts5 ranks short rows high, so the model's recall call and the prompt that asked for it outranked the cleared output. recall skips its own calls and results, reads four times the limit, and orders cleared output, then compacted-away rows, then what is still in context.
- **an evicted session forgot its cache clock.** `lastCacheUseAt` lived only in memory, so a reloaded session never looked cold, and the summary made ahead was dropped with it. dispose leaves both behind (session.ts `leaveBehind`); after a restart the last reply's time stands in.
- **the idle timer counts from the request's start.** a timer set at the turn's end added the last request's duration and could fire after a 5m entry had expired.
- **`recall_doc` had no index on `message_id`.** `putRecall` deletes a message's rows before it writes them, and that delete scanned the whole table (454 MB, 311k rows on a two-week database) on the main thread for every projected message. with the pages in the os cache it passed unnoticed; on a machine 9 GB into swap every page was a page-in, `sample` showed the main thread in `sqlite3BtreeNext → readDbPage → pread` for minutes, and `/global/health` timed out. migration 12 adds the index. when a daemon is up but not answering, `sample <pid> 3` first, then `explain query plan` for whatever it is stepping; a query on a table that grows with history needs an index on every column it filters by.

## installing as a service (m8c)

- **an ad-hoc signature costs the privacy grants on every upgrade.** bun signs its
  builds ad hoc, and macos keeps desktop, documents and full disk access against the
  designated requirement, which for an ad-hoc binary is its hash. after an upgrade the
  daemon touched a session directory under ~/Desktop, macos put up a prompt with nobody
  at the mac, and the synchronous file call it was in held the main thread, so every
  session stopped for 18 minutes until someone answered. the tcc log says "failed to
  match existing code requirement". `placeBinary` signs the copy with a keychain
  identity (`codesign -d -r-` then reads "identifier ... and certificate leaf ...",
  which survives rebuilds), and the daemon's first touch of a directory runs off the
  main thread.
- **a sync fs call or spawnSync in a session directory can freeze the whole daemon.**
  git as a child waits on the same prompt, and the 2 s git call behind every published
  event and the untimed `git status` in session rows ran in the incident too. go
  through `reachFor(dir)` (packages/server/src/reach.ts) before any sync read of a
  directory the daemon has not touched yet. a FIFO at `<dir>/.cmx2/cmx2.jsonc`
  reproduces a blocking open (not a blocking stat).
- **the unit took a PATH entry that dies with the shell.** `serve --install` copied the installing shell's PATH into the plist, and fnm puts a per-shell link first (`~/.local/state/fnm_multishells/<pid>/bin`), gone when that shell exits; the service would have lost node. `servicePath` drops `fnm_multishells` entries and directories that are not there. a node the service needs should come from a stable install (homebrew, or fnm's `node-versions/<v>/installation/bin`).
- **importing from a live cmx db needs one snapshot.** the importer read the session list once and each session's rows later, so a cmx serve writing meanwhile could make "imported" and "source" disagree. the import is one read transaction now (wal: the serve keeps writing, its checkpoints wait about a minute) and prints the source's own counts from that snapshot. the full import of a 4.7 GB db took 159 s at a peak rss of 434 MB.
- **next dev does not hydrate on 127.0.0.1.** next 16 blocks its dev resources for any origin but localhost unless `allowedDevOrigins` lists it; boxbox lists its tailnet names (a tailnet is a private tailscale network), so drive it through a tailnet name (what a phone client uses) or `localhost`, never `127.0.0.1`. the symptom is a login button that stays disabled.
- **a bench in boxbox held a port a test needed.** boxbox's `bench/exactly-once.ts` hard-coded 3001 and restarted every ten minutes. check `lsof` before claiming a port and never kill another project's process (the bench now takes a `BOXBOX_PORT` override and refuses to start while 3001 is taken, it does not kill the holder).
- **boxbox v1's new-thread sheet starts on the first host every time** (the cmx serve, in BOXBOX_HOSTS order). while cmx and cmx2 run side by side a thread meant for cmx2 lands on cmx unless the machine chip is switched first.
- **boxbox v1's desk counts come from its own loading, not the daemon's totals.** a tile's "earlier: n threads" is the newest 1,000 roots across all repos plus directories the watcher has proven; cmx proves directories through instance frames, cmx2 when a directory is opened or active, so the cmx2 side can start lower and catches up. the data was equal when counted.

- **a disk under 10% free fails every checkout test, and the daemon's fresh checkouts with it.** checkout creation refuses under `max(minFreeGB, minFreeRatio × volume)` free (was 5 GB, 10%; the ratio is 3% since 0.8.3, a 14 GB floor on a 460 GB disk; `worktree.minFreeRatio` in config, `DEFAULT_POLICY` in `packages/worktrees`). on a 460 GB disk with 45 GB free the old 10% floor was 46 GB: 21 of the full suite's tests failed on it (the first create gets `WorktreeRefusedError` 409, the rest of the file cascades), all 21 passed with the floor at 5%. read the error before calling it flaky, and free disk (stale `/tmp` clones and build dirs) before a test run. an installed daemon applies the same floor, so boxbox's "fresh checkout" is refused on a full disk until space is freed.

- **boxbox v1's machines card shows a session's version, not the serve's.** `rebuild()` in its client store takes `info.version` from the first session it holds for the host; the watcher's own `fetchVersion` (health, on every `server.connected`) is right but the card does not read it. after `cmx2 upgrade` to 0.8.1 the card said 0.8.0 while `/global/health`, the `server.connected` frame and boxbox's `/api/hosts` all said 0.8.1. prove an upgrade from health, not the card.

## the security review (2026-10)

- **node cannot see a peer's backlog behind the loopback hop.** a stalled sse reader had over 10 mb in the four kernel buffers between node's response and the peer before `res.writableLength` moved, so "batch when the peer is behind" barely engaged (35,837 frames for 40,000 deltas). delta batching counts deltas per turn of the event loop instead (`DELTA_FREE_PER_TURN`).
- **`POST /session/:id/prompt` returns when the turn starts**, not when it ends. a test that reads the stream right after it sees the turn half done; wait for `session.idle` on the stream.
- **bun drops queued websocket frames on `close()`.** a terminal that had exited closed its socket right after the replay and the client got 262,144 of 327,680 characters and no meta frame. close on `drain` once `getBufferedAmount()` is 0.
- **an empty `pushInsteadOf` matches every url.** `url.<base>.pushInsteadOf=""` rewrites every push, and `<name>::` as the base is a remote-helper transport, so git stops locally (`remote helper 'name' aborted session`) with no dns or ssh attempt; a bare name as the base made git try ssh to a host of that name.
- **the project config layer is the cloned repository.** anything it may set runs or points somewhere on a first request (`apiKey: "!cmd"` is a shell command). keep it to how to work in the repo; `projectLayer()` drops the rest.
- **a symlink is two paths to a permission check.** `resolve()` keeps links, so check the realpath too, and only where it changes the answer (`/etc` is `/private/etc` on macos).
- **probe a3 now fails on main as well** (2026-10-01): a paused bun socket was handed 13.6 of 17.9 MiB on that commit and the daemon logged no close. not the kernel buffers (a paused loopback peer takes under 2 MB; pinning `SO_SNDBUF`/`SO_RCVBUF` on the listener's sockets changed nothing). suspect bun's `node:http` letting `writableLength` fall while bytes sit in a native buffer, which reads as a drained peer. it passed earlier the same day; do not read one a3 pass as proof.
- **a test daemon's cwd is where a lost directory lands.** in the baseline run `worktree.test.ts`'s first step failed, the next ones sent an empty `x-opencode-directory`, the daemon fell back to its cwd (the harness started it in the repo root), and a real model turn committed `hello.txt` into the worktree running the suite. the harness now starts daemons in their data dir and the test refuses an empty checkout.
- **the v2 probe runner takes ports 4840-4898 and a literal `export const VERSION = "..."`.** a lane on other ports runs it from a copy with its `checkPort` and version regex widened, and `CMX2_REPO` pointing at the lane's worktree. its a1 reads the resumed stream as soon as the witness stream sees idle, which can be a few frames before the resumed stream has them (13 to 47 characters short, on main as well); waiting for idle on the resumed stream passes.

## streamed parts (a23, 0.8.5)

- **a text part's first delta was its birth, and nothing said what type a part was.** at version 4 a client created a text part from the first `message.part.delta` it saw for an id, so a delta for a part it never saw (a stream opened mid-part, or a reasoning part once those streamed) drew as reply text. a streamed part is announced first, and a client ignores a delta for an id it was not told about (`packages/tui/src/state.ts`). a `text_delta` with no `text_start` is still announced by the engine before its delta, so the rule holds for providers that skip the start event.
- **a final published only at the step's end keeps a finished thought running.** the reasoning block ends when the reply begins, but its `message.part.updated` with `time.end` waited for the step's message end, so a client's clock ran through the whole reply (boxbox measured +12.4 s against +18.5 s on a bench turn) and could not infer the end without a workaround. pi's `thinking_end` and `text_end` carry the provider's whole text and say when a block ended: the engine emits `message.part.ended` on them (once per part, announcing the part first if nothing had) and the daemon publishes the final then, marks the in-flight part ended (reads and resumes serve it final, deltas to it are dropped) and lets the step's end publish it again with the same text and `time.end`. the `end` time is stamped once, on the end event, and `partTimes` reuses it, so the two publications agree to the millisecond.
- **an announcement with no final is an orphan.** the announcement is logged the moment the part starts and the final only at message end, so a daemon killed in between leaves a streaming part in the log with no message behind it. `closeCutOff` closes the message with the parts the log announced for it (a part whose block had ended keeps its final text and `time.end`, one still streaming closes empty), so the log's last word on each part is the stored one. a closing that built the message without them would leave the part streaming in every client forever.
- **`putMessage` deletes a message's parts and inserts them again.** a part published by hand (as a crash close first did) is gone at the next rebuild of the projection. anything a part must keep goes on the transcript message (`partTimes`, by content position, like `agent` and `refusal`), because that is what a rebuild reads.
- **tool parts do not exist while a message streams.** a tool call's part is first published at its step's message end, in the same synchronous step that drops the in-flight state, so an in-flight read has parts of text and reasoning only. a read taken a few ms after the thinking can already be the projected message with a running tool part: not a bug, the step ended.
- **the provider decides whether thinking streams.** opus 5.5 through a vertex endpoint sent one `thinking_delta` holding the whole summary 1.6 s after `content_block_start`, and sonnet 5.5 at high effort on a counting question did not think at all. the announcement is what a client can show during that silence; the words arrive in one burst (a no-tool reply after it came the same way: the reasoning final, the text's announcement and its 17 deltas within 40 ms of each other). boxbox's bench model (`[bench:think N MS]`) is the way to see words arrive over time. `bun packages/eval/src/a23.ts` records either.
- **an agent's shell may carry the subagent no-push env.** `GIT_CONFIG_COUNT=1` with `url.cmx2-subagents-do-not-push::.pushInsteadOf` in the environment makes `security.test.ts` and `permission.test.ts` fail their git push tests ("remote helper aborted session") in a full `bun test`. unset the three `GIT_CONFIG_*` variables and they pass; neither is a regression.

## the queue (a18 to a21, 0.8.7)

- **a queued prompt that asks for another model or effort runs as a turn of its own, by design, not because pi cannot switch.**
  pi 0.99.1 applies `prepareNextTurn` -> `{model, thinkingLevel}` at every inner turn of a run (the engine already uses
  `prepareNextTurnWithContext` for tools). the engine keeps such a prompt in `held` (still in `waiting`, in order, and
  every prompt behind it) and starts it with `drainQueue` when the running turn completes, because the model is part of the
  recorded prefix and the prompt cache is per model. the visible cost is an idle between the two turns. `held` must lose a
  prompt the moment it leaves `waiting` (`takeBatch` does it): a stale entry makes every later plain prompt hold for a turn
  of its own. `drainQueue` resolves the model before it takes anything off the queue and has no await between its last
  check and the start, so a prompt cannot slip in while the model resolves.
- **pi's queues have no remove, and `clearAllQueues` also drops steers that are not prompts** (a `!` line's record, the
  output-limit continuation). `unqueue` filters the one message out of pi's `steeringQueue` and `followUpQueue` by hand;
  only the paths that start a turn from the queue clear them whole.
- **a steer's effort and the dial are ordered by when each was said, not by when each takes effect.** `effortClock` stamps the
  dial (`setEffort`), an effort a turn starts with, and a waiting prompt's or steer's own effort (`choiceAt`); `dialAt` is the
  newest that took effect. a steer's effort moves the dial when the steer lands only if it is newer than `dialAt`, and a turn
  started from waiting prompts (`drainQueue`, `prompt()`, `wake()`) runs at the newest explicit effort among them (`batchEffort`),
  so a steer left by an abort runs the next turn at its effort unless the dial or a fresh prompt's effort came after it. a waiting
  prompt's own effort runs its own turn and sticks, unless the dial (`dialMove`) was moved after the prompt was sent: then the
  effort the session stood at before the prompt's was applied (the dial's, with any escalation since) comes back as the pending
  effort when the turn ends, and only if routing allows it on the model the turn runs on (`allowed`, as `escalate` is passed in);
  a dial effort the held prompt's model never runs at is dropped and the prompt's own stands. a steer that calls off a pending dial move emits `session.effort` with
  the effort that stayed, because the dial route stored the pending value when it answered "pending".
- **the engine's `session.effort` and `session.model` events are stored now** (the server writes them to the session row), so
  the effort a queued prompt applies, and an auto-escalation (`maybeEscalate`), outlive the turn: a subagent's escalation
  survives eviction and a restart where it used to fall back to the effort it was spawned with. it matches the live session.
- **a session with prompts waiting is not evicted** by the residency lru (`evictIdle`): the queue is memory only, and
  dropping the session would make the queue read `[]` while clients still draw its cards.
- **the assistant message's `agent` was always "build" on reads**; the engine stamped the record and the projection ignored it.
  it reads the stamp now, so an agent the user picked shows on the messages it answered.

## edit diffs (a16, 0.8.7)

- **`summariseDetails` caps a tool's metadata at 4 kb and replaces anything bigger with `{truncated: true}`.** an edit's `filediff` is bounded where it is made (64 KB, `PATCH_CAP` in `packages/tools/src/diff.ts`) and projected outside that cap; any new bulky detail a client needs has to be exempted the same way or it vanishes without an error.
- **the formatter runs inside `afterWrite`, so a diff taken before it counts the wrong lines, and one taken after the language server wait can disagree with the event.** the hook takes the call's one diff right after the formatter, publishes `file.edited` with its counts, and returns `{notes, diff}`; the tool puts that diff on the part. a hook that returns a string (the bare tool tests) gets a diff taken by the tool afterwards. a new `afterWrite` hook gets `before` as its second argument.
- **a diff needs no object per line.** the first cut built an object per unchanged line (+100 MB rss on a 10 MB file). the script is runs (type, a, b, n) over line arrays that start at the changed region, found by comparing bytes from both ends at line boundaries; a diff that is local costs the change, not the file.
- **no counts beat made-up counts.** a change too big to diff (a changed region over 32 MB, a file over 64 MB) used to be counted as every old line gone and every new line added, which looked exact and was wrong by orders of magnitude for a change at both ends of a file. the part has no `filediff` and `file.edited` no counts there; a client that needs a number can say it has none.
- **a cut hunk without trailing context is read by `patch` as anchored at the end of the file.** the patch is cut at hunk boundaries for that reason; only a first hunk bigger than the cap (a created file) is cut inside.

## the stalled subscriber (a22, 0.8.7)

- **the loopback hop hid the stall in kernel buffers, not in a bun buffer.** with the listener's sockets instrumented, probe a3's paused socket had 5.6 MB parked between node's response and the peer (the hop's four socket buffers autotune, macos up to 4 MB each) before `writableLength` moved, so the cap tripped at 9.7 MB written, the burst's last frames. the d9 guess (node:http moving bytes into a native buffer) was wrong. event streams are now answered by the front on the public socket (`listen.ts`, `SocketResponse`), a kept-alive connection's later stream too.
- **a reader that reads is seen in lumps.** a peer's kernel opens the window by about half its receive buffer at a time, so the sender sees nothing between: a 500 KB/s python reader with a 64 KB buffer showed no progress for 420 ms at a stretch on macos (1.19 s at 200 KB/s), and the kernel's unsent count (`SO_NWRITE`) sat at the full 256 KB the whole time, so measuring the kernel does not help. the review saw the same lumps in bun's write callbacks on linux. a stall rule shorter than the lumps closes slow readers in a loop: the first fix's 200 ms clock and 50 ms verdict reconnected a 1000 KB/s reader 176 times. the quiet clock is 3 s now.
- **a burst blocks the loop for its length, and probe a3 reads again soon after.** a 24,000-delta network chunk ran 245 to 370 ms with no beat of the stall clock (the provider's 16 ms yield did not let one in), and the probe's socket reads 60 to 170 ms after the burst ends. in that window a peer that reads nothing and a reader both took their kernel's fill during the burst and look the same, so the fast verdict (owed more than 4 MB, nothing taken for 100 ms) is a race the daemon wins about 4 times in 5 against the probe on macos (more on a quiet machine) and every time in linux docker. traced, not guessed: in the failures the no-read peer's last kernel fill came 40 to 50 ms before the probe read.
- **the verdict's quiet restarted at every hold, and the probe's peer looked like a reader until the end.** traced on the release code: a paused bun peer's kernel took everything held for about 280 ms of the burst (its receive buffer grew to 2.1 MB) and the probe read again 66 ms after it stopped, while the fast verdict's quiet counted only stall-clock beats and started again at each hold and each catch-up, so it missed by 3 to 60 ms. the quiet is now wall time since the peer last took anything, carried across a hold that comes back and the catch-up after it, and the looks also read the socket's kernel (`SO_NWRITE`, `SIOCOUTQ`) without the loop, so a reader still shows while a burst holds it: compiled and interleaved on the same mac, probe a3 failed 11 of 30 on main and 2 of 30 with this.
- **a drain is not proof of reading.** a paused bun peer's kernel took 1.2 to 2.1 MB after a hold began, so its backlog fell to nothing and it was caught up from the log as if it had read. an account goes on across holds within a second unless the peer took more than 4 caps, and a catch-up after a hold is judged by the hold's account.
- **bun's socket counts a pending batch whole.** while a write is pending, everything written after it leaves `writableLength` only when the last byte of the batch is out (4.4 MB stood still for 130 ms while the reader took 512 KB every 20 ms), and slicing the writes does not help: the handle takes the batch into its own buffer. keep a queue and hand the socket one slice at a time.
- **node's `finish` is not delivery, and bun's node:http cuts a long answer short when the next request comes in behind it.** ending the hop as soon as node said it had finished lost a pipelining client's earlier answer (`/session` 85 of 500 on macos and 33 of 500 on linux, the review's race.py), and with a 400 KB `/session` answer a `/global/event` sent 0 to 2.5 ms behind it cut the answer short 81 times in 200 on macos, on main as well (linux main: none). the front counts the hop's answers by their framing as they pass back (`Answers` in `listen.ts`), forwards a connection's next request only once every earlier answer is through to its last byte, and answers a stream itself only then: 0 lost in 1,600 tries on macos and 1,300 on linux. the hop answers HEAD with a body (`HEAD /global/health` came back with its chunked json, on main as well), so after one the count is unknown and the connection keeps main's behaviour.
- **rss after a 14 MiB burst is the burst's, not a stalled reader's.** probe a3 with no stalled subscriber went 115 to 369-374 MiB, with one 112-116 to 370-400; the heap after a gc was 19-20 MB both ways, and rss fell back to 126 MiB after 140 s idle. compare against a control before blaming a subscriber.
- **a slow reader in a test is a raw socket with a small receive buffer, paced in `recv`.** bun's fetch reads the socket ahead of its reader, and a loopback socket paused between reads takes megabytes at each resume, so neither is slow on the wire (`stream-peers.py`).

## a vertex proxy

- ~~suspected proxy region routing~~ **ruled out 2026-10-01.** vertex global endpoints route to the region holding the cache. the m0 misses (a turn-boundary re-write of 48k while resending the captured bytes hit every time) were a cache effect, not the proxy: identical bytes land on the same cache, a longer request may not (see below).

## prompt cache (2026-10-01)

- **a 5m breakpoint ahead of a 1h one is a 400.** the rolling breakpoint was a bare `{type: "ephemeral"}` while pi marks its own 1h under `cache_ttl: "1h"`, so every 1h session failed on its second request. any breakpoint cmx2 adds copies pi's marker, ttl included.
- **requests that start together on a cold prefix all write it.** an entry is readable only once its writer has begun answering: four at once, or 200 ms apart, all wrote. siblings spawned in one step wait on a `PrefixGate` for the first one's `message_start`.
- **fable 5.1 misses byte-identical requests.** 11 of 23 identical replays re-wrote the prefix, at pauses of 0 to 12 s; opus and sonnet 0 of 46. judge fable cache on many requests.
- **an identical replay proves nothing about the next step.** identical bytes land on the same cache (46 of 46 on opus and sonnet); the next request, even with its breakpoint on the previous entry, may not. measure cache on chains, and at 30k+ tokens, with `cache.ts classify` beside the ratio.
- **`m7.test.ts`'s fork assertion (`first step cache_read > 0`) can miss on a real endpoint.** one full run read 0 on the fork's first step and the same test passed alone minutes later at 83%; a provider cache miss, not a daemon fault. rerun it alone before reading anything into it.
- **the minimum cacheable prefix is not 4,096 for the 5.x models.** opus 5.5, fable 5.1 and sonnet 5.5 cached 1,414-1,520-token prefixes; haiku 4.5 did not cache 3,795 and did cache 4,736.
- **a btw's request ends with the effort marker, after the question (2026-10-22).** pi appends the per-request `output_config` system message after the last user message and puts its breakpoint on the message before that marker, so a test that expects the question last, or the request on the wire plus one message, is wrong: the question sits before the marker. `asideBreakpoint` must run after `rollingBreakpoint`, which otherwise marks the question on a btw's second step (after a tool call), and `moveTrailingSystemBreakpoint` again after it, for a mark that lands on a turn-context system message mid-turn. btw bodies are captured with `CMX2_CAPTURE_DIR` as `*-btw-*.json`.
- **a session's newest cache entry is often not readable for seconds (2026-10-22, haiku 5.5 through the vertex proxy).** with a unique nonce in each session's first prompt, the next request read only the shared system and tools entry (7,037 tokens), not the session's own entry through its first message (about 7,142), in most cases: at 2 s after the turn, a btw read the session's entry 1 time in 5 and a second turn (the control) 0 in 5; at 15 s, 3 in 5 and 2 in 5. a full miss (read 0) came 1 in 5 for both at 2 s and never at 15 s. the bodies were byte-identical up to the first request's last breakpoint every time, so this is the provider, not the request. judge a btw's cache against the session's own next turn at the same gap, never against a later btw on another session holding the same bytes.
- **a btw mid-turn called a tool almost every time with a mild framing.** "answer ... without calling tools" still got a tool call (and a second, paid step) in 7 of 8 mid-turn btws, where the last thing in context is the user asking for a command; idle btws called none in 15. saying that the reply is not a step of the task, that tools are off and a call runs nothing, took it to 0 in 5 at half the cost, but 2 of 5 answers then told the user "tools are off for this reply", and adding "leave this note out of the answer" made all 5 talk about tools. the framing that shipped never names tools ("plain text only ... nothing in it is run ... keep this note to yourself and answer as if the question had come up in conversation"): 1 tool call in 5, and only that answer mentioned tools, retelling the error result. the framing sits in the question message only, after every breakpoint.

## haiku 5.5 (2026-10-09, probed through a vertex endpoint)

- **it costs 5x once a request reaches 100,000 tokens.** $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write up to there; $0.50, $2.50, $0.05, $0.625 from there, input and output both, on every token of the request (input + cache read + cache write counts). pi ships haiku 5.5 only from 1.1.0, with the tier at 100,000 and sonnet 5.5's cache read still $0.20, so `catalog()` in `models.ts` overlays it on 0.99.1: tier at 99,999 because pi's test is strictly above. a real step with 141k of context stored $0.0883685, the long rates to the digit. a helper that grows past 100k pays five times as much for the same tokens: give the next task to a fresh one.
- **thinking cannot be turned off at xhigh or max.** `thinking: disabled` with `output_config.effort: xhigh` is a 400 (`xhigh is not supported when thinking is disabled on this model`); high and below work. `thinking.type: enabled` with a budget is a 400 too: adaptive thinking and effort are the only controls. low to high answered a trivial prompt with no thinking block at all; xhigh and max thought first.
- **an xhigh turn can end with no visible text** (the vendor's guide; not reproduced here). a helper's final text is its report, so routing's never list keeps haiku at high and below.
- **no temperature, no prefill.** `temperature` is a 400 ("deprecated for this model"), and a conversation that ends on an assistant message is a 400 ("does not support assistant message prefill"). pi's `supportsTemperature: false` already keeps temperature off the wire.
- **its tokenizer counts about 30% more than haiku 4.5's** (the vendor's number; the same 600-word filler was 1,515 tokens here). a context budget set from a haiku 4.5 count runs out sooner.
- **the minimum cacheable prefix is 512 tokens.** a 413-token system block neither wrote nor read; 543 wrote 534 and read them back. the 1h ttl is accepted (write 9,013, read 9,013 on the next request), and a per-message effort change (a `system` message with `output_config`) keeps the cache. the anthropic refusal test string did not produce a refusal here, so the refusal shape is unprobed.
- **images per request: 100 is a guess.** the overlay copies sonnet's limits and lowers `maxPerRequest` to the older haiku's 100; not probed.

## the cmx defects not to repeat

- **self-close kills warm reuse.** never tell a child to close itself;
  never make "done" mean "dead".
- **re-rendered prefix.** date, skills list, agents.md, canonical path in
  the system prompt = a cache miss risk on every step. record once, append
  deltas.
- **a list the model never sees.** cmx2 shipped the skill tool behind
  tool_search with no skills list anywhere in context, so the model only
  loaded a skill when the user named it. every other harness (claude code,
  opencode, pi, goose, codex cli) shows each skill's name and description
  up front; that is what auto pickup runs on. keeping volatile text out of
  the prefix means appending it, not leaving it out.
- **identity in memory only.** a serve restart orphaned every parked child.
  rehydrate from the db.
- **unbounded deliverable extraction.** the watcher walked the whole
  session newest-first; after a follow-up a terse reply returned the
  previous task's body. bound to messages after the triggering item.
- **compaction with `system: []`.** guaranteed cache miss and minutes of
  stall. reuse the session prefix.
- **poll floors as a substitute for notifications.** a large share of model
  steps did nothing but poll. jobs notify.
- **processes owned by nobody.** dev servers from worktrees ran for hours
  until the machine was restarted. own, ledger, reap.
- **routing in prose.** cmx's agents.md still named fable as the driver after
  sessions had moved to another model and effort. config, hot-reloaded,
  rendered.
- **1 GB daemon.** caching whole transcripts and 64 × 1 MiB pty buffers in
  memory on a laptop. budget it.

## machine and ops

- **the suite inside a cmx2 helper fails two git push tests.** a helper's shell inherits `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, the env that stops its own `git push`, and `security.test.ts` (and the push cases in `calls.test.ts`, `permission.test.ts`) then fail with exit 128. run them with `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0`.
- **tcc.** a binary run from `~/Documents` makes launchd spawns stall for
  minutes on a consent prompt nobody can answer; copy the binary to
  `~/.local/share/cmx2/bin` at install.
- **channel db split.** a channel build without `OPENCODE_DISABLE_CHANNEL_DB`
  opened a near-empty db and showed ghost-empty session lists; cmx2 uses one
  db path, no channel variants.
- **host-global sessions.** a throwaway daemon sees the whole machine's
  history and its sessions persist; nonce titles, clean up, `-m` timeouts on
  deletes.
- **no `timeout` on macos.** use a shell timer or `gtimeout`.
- **tailscale ssh re-auth.** the first hop to a fleet host may print a login
  url; not an error.
- **never two dev servers on one port**, and tests stay off the daemon's default port (4097).

- **boxbox's dev server does not hydrate on `127.0.0.1`.** next's dev bundle answers but React never attaches (the login button stays disabled, the desk says "radio silence"); open `http://localhost:<port>` instead. set `BOXBOX_PASSWORD=boxbox` in the dev server's env, or it reads the password in the repo's `.env.local`.
- **a subagent's shell env breaks git in tests.** an agent running as a cmx2 subagent has `GIT_CONFIG_COUNT=1` and a `pushInsteadOf` key in its env; any `git push` in a test run from it fails with `remote-cmx2-subagents-do-not-push`. run the suites with `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0`.
- **`os.freemem()` on macos counts only free pages.** on a 16 GB mac it read under 1 GB while activity monitor showed about 5 GB available, since file cache and purgeable pages are not free. `/global/system` reads `host_statistics64` through ffi (no process per request) and counts available as physical memory less app (anonymous less purgeable), wired and compressed pages. the field offsets are in `vm_statistics64`; `vm_stat` prints the same counters, which is what the fixture is.
- **apple silicon model identifiers do not name the family.** `MacBookPro18,3` does, `Mac16,11` (a mac mini) does not. `system_profiler SPHardwareDataType -json` has `machine_name`; it takes about 0.3 s, so it runs once. a command killed at its timeout can leave an xpc helper holding the pipe, so `close` may never fire: `run()` in `system.ts` resolves from its own timer.
- **a docker container sees no dmi.** `/sys/class/dmi` and `/sys/firmware` are hidden and cannot be bind-mounted over, and arm or rosetta x86 cpuinfo has no `hypervisor` flag, so in an orbstack container `/global/system` says `model: null, virtual: false`. os-release, meminfo and statfs read true there; check `machine` on a real vm.
- **the data directory on macos sits on `/System/Volumes/Data`**, not `/`: `df -P` names that mount, and the apfs container's free space is the same for both.

## licenses

- `aliou/pi-processes` and `nicobailon/pi-interactive-shell` declare MIT
  only in package.json with no LICENSE file. ask before copying; otherwise
  reimplement from the design.
- oh-my-pi is MIT but a hard fork with bun and n-api coupling; take the two
  standalone crates' designs (`pi-iso`, `pi-shell`) and the revive/wake
  logic as design only.

## round three perf (2026-10-21)

- `bun --compile --bytecode` defaults to cjs, which refuses top-level await: pass `--format=esm`.
- evicting sessions lowers heap, not rss (the allocator keeps its pages): measure with `/global/memory?gc=true`.
- `Bun.spawn` throws synchronously when the command is missing, unlike `spawnSync`, which returned an error: keep the spawn inside the try, and catch in any timer that calls it.
- test ports span 4830 to 4929 plus `CMX2_PORT_SHIFT`, so shifts 10 apart collide: give parallel checkouts shifts at least 100 apart.
- an unloaded session's transcript is replayed into the database only when its size, mtime or last row changed; the record lives in memory, so the first read after a restart replays once.
- a read stamped with `x-cmx2-seq` loads git first, then reads its rows and stamps in one synchronous step: rows read before an await and stamped after it make boxbox drop the events that fell inside the wait.
- events a transaction publishes are held until it commits; a failed commit sends nothing and puts the head back, or clients would hold ids the next process hands out again.
- bun's node:zlib cannot compress a stream synchronously across calls (`_processChunk` closes its handle), so the gzip switch compresses each batch separately with the last 32 kb as its preset dictionary and joins them into one gzip member; every streaming decoder reads it batch by batch.
- the stall judge's timing depends on the work done per withheld frame: delta frames, and frames to a stream held at the cap, are built per stream rather than shared, or 30 readers through a burst start getting cut.
- bun's fetch asks for gzip by default, so the tui and cli get gzipped json answers since the rest gzip landed.

## session transfer (export and import over http)

- **a migration test that rewinds user_version must drop every later column too (2026-10-31).** the btw, lineage, refresh and rev tests build a fresh store, drop their own column and set an older user_version, so the store reruns every migration after it. a new `alter table add column` migration then fails on the column the fresh store already made ("duplicate column"). when you add a column migration, add its drop to those tests.
- **a streamed answer must not be `application/json`.** the listener reads a json answer whole to gzip it for a client that takes gzip, which undoes streaming. the export answers `application/vnd.cmx2.session+json` so it stays a stream.
- **request bodies are buffered whole.** the listener reads each body into memory, cut at the precheck's maxBody; a route that takes big bodies gets its own cap there (`/session/import`, IMPORT_MAX_BYTES), not a bigger MAX_BODY_BYTES for every route.
