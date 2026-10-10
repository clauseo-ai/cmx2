<div align="center">

<p align="center">
<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="assets/hero-tall-dark.svg">
  <source media="(max-width: 600px)" srcset="assets/hero-tall.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg">
  <img src="assets/hero.svg" alt="cmx2: clients talk to one daemon, which fans work out to helper agents that light up, finish and park" width="100%">
</picture>
</p>

<!-- release badge: add it back after the first tag.
<a href="https://github.com/clauseo-ai/cmx2/releases"><img src="https://img.shields.io/github/v/release/clauseo-ai/cmx2?include_prereleases&sort=semver&style=flat-square&labelColor=1b1546&color=5a43d6" alt="latest release"></a>
-->

one daemon holds your sessions. helpers park between tasks instead of dying.

<a href="LICENSE"><img src="https://img.shields.io/github/license/clauseo-ai/cmx2?style=flat-square&labelColor=1b1546&color=5a43d6" alt="license: mit"></a>
<a href="CHANGELOG.md"><img src="https://img.shields.io/badge/status-pre--1.0-5a43d6?style=flat-square&labelColor=1b1546" alt="status: pre-1.0"></a>
<img src="https://img.shields.io/badge/platform-macos%20%7C%20linux-5a43d6?style=flat-square&labelColor=1b1546" alt="platform: macos and linux">

<a href="#how-it-works">how it works</a> &nbsp;·&nbsp;
<a href="#quickstart">quickstart</a> &nbsp;·&nbsp;
<a href="#usage-basics">usage</a> &nbsp;·&nbsp;
<a href="#docs">docs</a>

</div>

a coding agent that runs as a daemon on your machine. you talk to it from a web app, a script or a terminal, and it reads and edits your code, runs commands, and hands subtasks to cheaper helper agents. sessions live in the daemon, not the client. run it as a service and a turn keeps going after you close the client, and you can pick the same session up later from your phone.

cmx2 builds on [pi](https://github.com/earendil-works/pi), an open source agent library (pinned to one exact version). pi runs the model loop. cmx2 is the runtime around it.

status: pre-1.0. the daemon, the http contract and its clients work end to end. breaking changes are possible between minor versions and are listed in the [changelog](CHANGELOG.md).

## why this exists

i can't use a tool without wanting to change it. in february i forked opencode, another coding agent, and called it cmx. by september the fork was a pile of my patches on top of a version upstream had already moved past. it was slow, used enough memory that i'd restart apps to get it back, and carried features i'd spent months deleting. merging was never going to happen.

so i started over. wishlist first, base second. i looked at goose, codex and pi, three open source agents, and picked pi because it was small and stayed out of the way. then i took the best ideas from the others: the model thinks harder or lighter turn by turn, helper agents stick around after a task so the next one starts with their context, and a helper can get its own checkout of the repo when the work needs one. cmx had taught me that most of the cost was the main agent re-reading its own history, so cmx2 keeps the start of every request identical and the provider's cache serves it cheaply.

the rule i kept coming back to is rich sutton's bitter lesson. as models get smarter, the harness (everything around the model) should decide less for them. cmx2 gives the model tools and limits and lets it choose when to hand work off.

it's not a product. it's what i run all day, mostly from boxbox. it's open source because it finally installs like a real program, and maybe it's useful to you too.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/clauseo-ai/boxbox2/main/assets/demo/demo-dark.webp">
  <img src="https://raw.githubusercontent.com/clauseo-ai/boxbox2/main/assets/demo/demo-light.webp" alt="boxbox driving cmx2 daemons: agents on three machines, one asking which greeting to use, answered from the inbox" width="900">
</picture>
<br><sub>cmx2 driven from <a href="https://github.com/clauseo-ai/boxbox2">boxbox</a></sub>
</p>

## how it works

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img src="assets/architecture.svg" alt="clients on the left send http requests and read server-sent events from one daemon. the daemon holds the server, engine, tools, helper agents, jobs, worktrees and a sqlite store. its engine calls pi, which calls the model providers.">
</picture>
</p>

one daemon runs per machine and owns every session on it. clients send http requests and read a server-sent event stream; they never talk to a model. `cmx2 run` and plain `cmx2` use the running daemon, or start one on loopback inside their own process if none is up, so the quickstart needs no setup step. [docs/architecture.md](docs/architecture.md) names every package and walks one request through the system. here is one turn that spawns a helper:

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/turn-dark.svg">
  <img src="assets/turn.svg" alt="a sequence: the client posts a prompt, the daemon sends the model a request with a stable prefix, runs tools, spawns a helper that reports back and parks, then streams the final message to the client.">
</picture>
</p>

## quickstart

prerequisites: macos or linux (arm64 or x64), [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`, git, and an [anthropic api key](https://console.anthropic.com/) (google and openai-compatible endpoints work too, see the [quickstart](docs/quickstart.md)). to build from source you also need [bun](https://bun.sh) 1.3.14.

```sh
curl -fsSL https://raw.githubusercontent.com/clauseo-ai/cmx2/main/scripts/install.sh | sh
```

no release is tagged yet, so that fails today. until the first release, build from source (below).

```sh
export ANTHROPIC_API_KEY=sk-ant-...
cmx2 doctor            # checks the machine, names a fix for each problem
cmx2 serve --install   # keep the daemon running as a login service
cmx2 pair              # prints a url and a one-time token for a client
```

give that url and token to [boxbox](https://github.com/clauseo-ai/boxbox2#quickstart), the web client, and you can drive your sessions from a browser or a phone. boxbox is a web app plus a rust server. the server pairs with your daemon, and the app talks to the server. for one-off prompts with no client at all:

```sh
cd path/to/a/repo
cmx2 run "explain this repo in three lines"   # headless: prints the answer and exits
```

`cmx2` on its own opens a terminal client.

once a release exists, the installer downloads the binary for your machine from the latest release and checks it against the release's `SHA256SUMS`. it puts it in `~/.local/bin/cmx2`.

from source (`cmx2 upgrade` only works on release binaries, a source build has no repository stamped into it):

```sh
git clone https://github.com/clauseo-ai/cmx2 && cd cmx2
bun install
bun scripts/build.ts            # writes dist/cmx2
bun run dev                     # or run the daemon straight from source on 127.0.0.1:4830
```

## usage basics

| command | what it does |
|---|---|
| `cmx2 doctor` | what is wrong on this machine, in plain words |
| `cmx2 serve --install` | keep the daemon running as a login service (launchd on macos, systemd on linux) |
| `cmx2 pair` | print a url and a one-time token for a client such as boxbox |
| `cmx2 run "<prompt>"` | one prompt, headless. `--session <id>` continues an earlier session |
| `cmx2 session list` | what you have done so far |
| `cmx2 models` | the models this machine can run |
| `cmx2 upgrade` | fetch the latest release and swap the binary. release binaries only |
| `cmx2` | open a terminal client in the current directory |

`cmx2 --help` lists every command. config lives in `~/.config/cmx2/cmx2.jsonc` and sessions in `~/.local/share/cmx2/`. [examples/](examples/) has sample config: another provider, a routing table, a permission preset and service files.

## docs

- [docs/quickstart.md](docs/quickstart.md): install, pick a model, a first session, a service and pairing.
- [docs/architecture.md](docs/architecture.md): the packages, the daemon and one request end to end.
- [docs/tui.md](docs/tui.md): the terminal client's keys and theme.
- [docs/permissions.md](docs/permissions.md): what a session may do without asking, and how rules read.
- [docs/agents.md](docs/agents.md): spawning helper agents, parked agents, reports and caps.
- [docs/routing.md](docs/routing.md): the table of models a helper can run on, and how the model picks one.
- [docs/engineering/](docs/engineering/README.md): design docs for contributors.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

the daemon's http contract is [packages/client/openapi.json](packages/client/openapi.json). both it and the typed client `@cmx2/client` in `packages/client` are generated from `packages/contract/src/manifest.ts`. `@cmx2/client` is a workspace package you use from a checkout. it is not published to npm.

## related projects

- [boxbox](https://github.com/clauseo-ai/boxbox2): the web client for cmx2 (a progressive web app for phone, tablet and desktop) plus a rust server. the server pairs with each daemon using `cmx2 pair`, and the app talks to the server.
- [cmx](https://github.com/clauseo-ai/codemaxxxing): the predecessor, a runtime built on a fork of opencode. cmx2 can import its history: `cmx2 db import-cmx` copies it in read-only, for browsing.
- [pi](https://github.com/earendil-works/pi): the agent library cmx2 runs on.

## license

[MIT](LICENSE). third-party code and its licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
