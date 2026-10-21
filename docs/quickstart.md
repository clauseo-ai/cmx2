# quickstart

from nothing to a first session in five minutes.

## prerequisites

- macos or linux, on arm64 or x64.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`. the grep and glob tools and file search run it. `brew install ripgrep` on macos, `apt install ripgrep` or `dnf install ripgrep` on linux.
- git. the worktree features and many coding tasks call it.
- a way to reach a model: an anthropic api key, or any other provider you set up in your profile (step 2).
- [bun](https://bun.sh) 1.3.14, only if you build from source. the release binary bundles its runtime.
- optional, for heic photos (iphone images) sent to a model: nothing on macos (the built-in `sips` converts them). on linux, imagemagick built with heic support, or libheif's `heif-dec` or `heif-convert` with an hevc decoder. without one, cmx2 refuses a heic image and says what to install. png, jpeg, gif and webp need nothing.

## 1. install

```sh
curl -fsSL https://raw.githubusercontent.com/clauseo-ai/cmx2/main/scripts/install.sh | sh
```

it downloads the binary for your machine from the latest release, checks it against the release's
`SHA256SUMS` and puts it in `~/.local/bin/cmx2`. if that folder is not on your `PATH`, it prints the line
to add. `CMX2_INSTALL_DIR` changes the folder.

no release is tagged yet, so the installer fails today. until the first release, build from source (next block).

or build it yourself:

```sh
git clone https://github.com/clauseo-ai/cmx2 && cd cmx2
bun install
bun scripts/build.ts
mkdir -p ~/.local/bin && cp dist/cmx2 ~/.local/bin/
export PATH="$HOME/.local/bin:$PATH"
```

## 2. a model

cmx2 keeps its settings in a profile, the folder `~/.config/cmx2/`. with an anthropic key you need no profile:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

for anything else, write `~/.config/cmx2/cmx2.jsonc`. here is a proxy that speaks the anthropic api
(the url is a placeholder):

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "providers": {
    "anthropic": { "baseUrl": "https://llm-proxy.example.com", "apiKey": "$PROXY_KEY" }
  }
}
```

`apiKey` takes a literal, a `$NAME` read from the environment, or a `!command` such as a keychain lookup.
`examples/cmx2.jsonc` shows the other shapes: google and an openai-compatible server. `examples/cmx2.laptop.jsonc`
is a per-machine overlay (`cmx2.<hostname>.jsonc`, read on top of the main file on that machine).

### web search

web search works with no setup: it goes through [tavily](https://tavily.com)'s free
[keyless mode](https://docs.tavily.com/documentation/keyless), which is rate limited, and falls back to exa's
keyless endpoint when tavily says no. for regular use, get a free tavily key (1,000 credits a month, no card) at
[app.tavily.com](https://app.tavily.com):

```sh
export TAVILY_API_KEY=tvly-...
```

that is all it takes. without a `web` entry the first of `TAVILY_API_KEY`, `EXA_API_KEY` and `BRAVE_API_KEY`
found in the environment picks the provider. to choose one outright, or to turn on the extras:

```jsonc
{
  "web": {
    "provider": "tavily",          // tavily, exa, brave, or searxng (with "url": your instance)
    "apiKey": "$TAVILY_API_KEY",   // a literal, $NAME or !command; defaults to the provider's variable
    "search": { "search_depth": "advanced", "chunks_per_source": 3 },  // extra request fields; advanced costs 2 credits a search, not 1
    "fetch": "provider",           // webfetch reads public pages through tavily extract (renders javascript); default "local"
    "crawl": true                  // adds webcrawl: list a site's pages or read many at once (needs a key)
  }
}
```

`fetch` and `crawl` are off by default and need `"provider": "tavily"`. with `fetch: "provider"` the urls the
model reads go to tavily; localhost and private-network addresses are always fetched locally. a repository's
`.cmx2/cmx2.jsonc` cannot set `web`. tavily's [credits](https://docs.tavily.com/documentation/api-credits)
page has what each call costs.

then check it:

```sh
cmx2 doctor
```

each line is `ok`, `note`, `warn` or `fail`, and every problem comes with its fix. `cmx2 doctor --offline` skips
the one-token request that tests the model.

## 3. a first session

a session is one conversation with a model, with its own transcript, working directory and tool history.

```sh
cd path/to/a/repo
cmx2 run "explain this repo in three lines"
```

the answer prints, and stderr names the session so you can continue it with `cmx2 run --session <id> "..."`.
tools run in the current directory under your permission rules (see [permissions](permissions.md)). `cmx2 run`
has nobody to answer a prompt, so a call that needs an answer is refused.

`cmx2` on its own opens the terminal client in the same directory (see [tui](tui.md)).

the daemon is the background process that hosts sessions, runs tools and serves clients over http. neither
command needs one running. when none is up, cmx2 starts one on loopback inside its own process for as long as it runs.

`cmx2 session list` shows your sessions. `cmx2 --help` lists every command.

## 4. keep it running (optional)

a daemon that stays up lets a turn keep going after you close the terminal, and lets clients on your phone or
another machine reach your sessions. `serve --install` needs the compiled binary from step 1, not the source
checkout.

```sh
cmx2 serve --install            # launchd on macos, systemd --user on linux; starts at login
cmx2 pair                       # a url and a one-time token for a client like boxbox
```

`cmx2 serve --install` copies the binary to `~/.local/share/cmx2/bin`, links it as `cmx2` in `~/.local/bin`
and writes the service unit. it also saves provider keys from your current shell for the service, which does
not inherit your shell's environment. export a key and run it again to change one. the service logs to
`~/.local/share/cmx2/log/serve.log`; the daemon rotates it at 10 MB and keeps three older copies
(`serve.log.1` is the newest).

on macos the copy is signed with a code signing identity from your keychain when there is one (one named for
cmx2 first, then developer id, then apple development; `CMX2_CODESIGN_IDENTITY` picks one by name or hash, `-`
keeps the build's ad-hoc signature). macos remembers folder access (desktop, documents, full disk access)
against the signature, and an ad-hoc one changes with every build, so without an identity macos asks again
after each upgrade and a session in that folder waits until someone answers. `cmx2 serve --install` and
`cmx2 upgrade` sign the copy they place, and `cmx2 doctor` says which signature the installed copy has. with no
developer certificate, keychain access can make a self-signed one (certificate assistant, create a
certificate, type code signing).

boxbox is the web client (https://github.com/clauseo-ai/boxbox2). pairing connects a client to your daemon:
`cmx2 pair` prints the daemon's url and a token that works once, for 10 minutes. the client trades it for
its own credential. once any client is paired, every request needs a credential. this machine's own cli
and tui keep working through a local token file. `cmx2 pair --list` shows paired clients and
`cmx2 pair --revoke <id>` cuts one off.

the daemon listens on `127.0.0.1` by default, so only this machine reaches it. to reach it from another
device, run it on a private network such as a tailnet (a private tailscale network) and install with
`--hostname 0.0.0.0`. on a machine with a public address, keep the default. the daemon speaks plain http,
so do not expose it on an open network. see [SECURITY.md](../SECURITY.md).

`cmx2 upgrade` fetches the latest release and restarts the service. it only works on release binaries. a source build has no repository stamped into it.

## where things live

- `~/.config/cmx2/`: the profile (`cmx2.jsonc`, `routing.jsonc`, `agent/`, `command/`). it reloads when it
  changes. `CMX2_CONFIG_DIR` moves it.
- `~/.config/cmx2/AGENTS.md`: your notes for every session you start, such as how you reach the machine or
  how you like to work. they end the session's system prompt; an edit reaches new sessions, and helpers do
  not get them.
- `~/.local/share/cmx2/`: sessions (`cmx2.db`), transcripts, logs, the installed binary and the pairing
  credentials. `CMX2_DATA_DIR` moves it. nothing cmx2 does deletes a session.

## next

- [routing](routing.md): which models helper agents run on.
- [agents](agents.md): how a session starts and talks to helper agents.
- [permissions](permissions.md): what a model may do without asking.
- [tui](tui.md): keys and theme for the terminal client.
- [architecture](architecture.md): how the daemon is put together.
