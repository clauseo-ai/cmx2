# architecture

a map of cmx2 for someone who has never seen the code. the design rules and the list of sharp edges are in [docs/engineering/](engineering/README.md).

## the shape

cmx2 is one daemon per machine. the daemon owns every agent session on that machine: the conversation, the tools the model calls, the background processes it starts and the git worktrees it works in. clients (a terminal ui, the boxbox web app, your scripts) never talk to a model. they send http requests to the daemon and read a stream of events back.

```mermaid
flowchart TB
  subgraph clients["clients"]
    tui["terminal ui<br/>cmx2, packages/tui"]
    run["headless<br/>cmx2 run"]
    box["boxbox web client<br/>(separate repo)"]
    other["your scripts<br/>@cmx2/client"]
  end

  subgraph daemon["cmx2 daemon (one bun process)"]
    server["server<br/>auth, routes, event stream, run lock"]
    engine["engine<br/>one live session per conversation, effort, prompt cache"]
    actors["actors + routing<br/>helper agents, model table"]
    tools["tools<br/>read, edit, shell, lsp, mcp, run"]
    procs["procs + worktrees<br/>background jobs, terminals, git checkouts"]
    store[("store<br/>sqlite + transcripts")]
  end

  pi["pi<br/>the open source agent loop and provider layer"]
  llm["model provider<br/>anthropic, google, openai, or a compatible endpoint"]

  tui -- "http + sse" --> server
  box -- "http + sse + websocket" --> server
  other -- "http + sse" --> server
  run -- "in process, no network" --> server

  server --> engine
  engine --> actors
  engine --> tools
  tools --> procs
  engine --> pi
  pi -- "https" --> llm
  server --> store
  engine --> store
  actors --> store
  procs --> store
```

`cmx2 run` and a plain `cmx2` start a daemon inside their own process when none is running, so you do not have to start anything first. `cmx2 serve --install` makes the daemon a login service, so it stays up and other clients can reach it.

## how the pieces split

- **the engine is [pi](https://github.com/earendil-works/pi).** pi is an open source agent library. it has the loop that sends the conversation to a model, runs the tool calls the model asks for and repeats, plus a provider layer for each model api. cmx2 pins pi to one exact version and is the runtime around it. only `packages/engine` imports pi, so a pi upgrade touches one package.
- **the contract is the daemon's http api.** `packages/contract` describes every route and event once. it generates `packages/client/openapi.json` and the typed client in `packages/client`. a client written against the contract needs no other knowledge of the daemon.
- **state is on disk.** sqlite holds sessions, messages, agents, jobs and a row per model step (tokens, cache hits, cost). the full transcript stays in pi's own jsonl files. a restart loses the running turn and nothing else.

## directories

| path | what it holds |
|---|---|
| `packages/` | the bun workspace, one folder per package (below) |
| `docs/` | user docs: quickstart, tui, permissions, agents, routing, and this file |
| `docs/engineering/` | design docs for contributors: goals, architecture rules, decisions, gotchas |
| `examples/` | sample config: a profile, a routing table, a permission preset, launchd and systemd service files |
| `scripts/` | `build.ts` (single-file binaries), `install.sh` (the installer), `check-public.sh` (a pre-publish check) |
| `.github/workflows/` | ci and the tag-triggered release |

## packages

each package is `@cmx2/<name>` in the workspace.

| package | what it does |
|---|---|
| `cli` | the `cmx2` command: `run`, `serve`, `pair`, `doctor`, `upgrade`, `session`, `models` and the rest. it builds into the single binary. |
| `server` | the daemon. http routes, server-sent events, websocket terminals, auth and pairing, the run lock that keeps two processes from driving one session, and the event log clients resume from. |
| `contract` | every route and event with its schema. `bun run contract` regenerates the client and `openapi.json` from it. |
| `client` | the generated typed http client and event decoder. the terminal ui and any script use it. |
| `engine` | the adapter over pi. it creates a session, picks the model and effort, builds each request so the prompt cache stays warm, compacts long transcripts and registers tools. |
| `actors` | helper agents. a session spawns others, they work, report back and park. five verbs: spawn, message, wait, agents, run. |
| `routing` | `routing.jsonc`: the table of models a helper may run on, the guide that tells the model which to pick, and the efforts a model never runs at. |
| `tools` | what the model can call: read, edit, write, apply_patch, glob, grep, shell, webfetch, websearch, skills, lsp, mcp servers, image attach, and `run`, a confined script that calls the other tools in one step. |
| `procs` | background jobs and pty terminals. a job reports back to its session when it exits, prints a matching line or opens a port. everything a session starts is reaped when it ends. |
| `worktrees` | git worktrees for agents: create, squash-merge, discard, with a secrets policy and copy-on-write checkouts on macos. |
| `store` | sqlite schema, migrations, message projection from transcripts, session export and import, and the read-only archive of imported history. |
| `prompts` | the system prompt text per model family and the agent-type prompts, as plain markdown files. |
| `tui` | the terminal client, built on pi's terminal ui library. |
| `eval` | scripts that drive a real daemon against real models to measure behaviour. they cost money and are not part of `bun test`. |

## one request, end to end

you type "add a test for the parser" in the terminal client.

1. the tui sends `POST /session/:id/prompt` to the daemon with your text. a client id on the request makes a retry safe.
2. the server checks auth from the headers (a paired bearer, basic auth or the machine's own `local.token`), refuses cross-site requests, then routes the call. it takes the session's run lock so no other process drives the same session.
3. the server hands the prompt to the engine. the engine appends your message, picks the effort for this turn and builds the request: the stored system prompt and tool list (identical bytes every step, so the provider's cache hits), the history, then a small volatile block with the date, the directory and the model table.
4. pi sends that request to the provider and streams the answer back. the engine turns each streamed piece into an event.
5. the server writes each state change to the event log, then pushes it down every open `GET /event` stream. your tui draws the text as it arrives. a client that drops and reconnects resumes from the last event id it saw.
6. the model asks to read `parser.ts` and run the tests. the engine checks each call against the permission rules first (allow, ask or deny; an ask becomes a `permission.asked` event the client answers). the tools package runs it. a long test run can go to procs as a background job that wakes the session when it exits.
7. the model may spawn a helper on a cheaper model through actors. the helper is its own session with its own transcript. it reports to its parent's mailbox and parks until someone messages it.
8. the final message lands. the store has already written every message and a row for each step. the session goes idle and the run lock is released.

## configuration

three layers merge in order: shipped defaults, your profile (`~/.config/cmx2/`, moved by `CMX2_CONFIG_DIR`), then the project's `.cmx2/` folder. a repository's own config cannot set providers, keys or listeners and cannot loosen permissions, so a cloned repo cannot take over your machine. the profile reloads when a file changes. see [quickstart.md](quickstart.md) and [routing.md](routing.md).

## glossary

- **session**: one conversation with a model, with its own transcript and working directory.
- **turn**: one prompt and everything the model does in answer, across as many model steps as it takes.
- **effort**: how much the model thinks on a step, from low to max. it is a per-turn setting.
- **profile**: your config folder, `~/.config/cmx2/`.
- **pair**: give a client a one-time token to trade for a long-lived credential (`cmx2 pair`).
- **parked**: an agent that finished its work and waits for a message. it costs little to keep because its prompt cache stays warm.
- **prompt cache**: the provider keeps the start of a request for minutes to an hour and charges less to read it again. cmx2 keeps the start of every request byte-identical to hit it.
- **contract**: the daemon's http api and event schema. it carries a version number, shown in the changelog.

## where to go next

- [engineering/README.md](engineering/README.md): the design docs for contributors.
- [engineering/ARCHITECTURE.md](engineering/ARCHITECTURE.md): the long version of this page, with every rule.
- [../CONTRIBUTING.md](../CONTRIBUTING.md): build and test.