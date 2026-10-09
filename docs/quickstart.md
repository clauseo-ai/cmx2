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
`examples/cmx2.jsonc` shows the other shapes: google, an openai-compatible server, and a per-machine
overlay (`cmx2.<hostname>.jsonc`, read on top of the main file on that machine).

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
command needs one running. when none is up, cmx2 starts one inside its own process for as long as it runs.

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
not inherit your shell's environment. export a key and run it again to change one.

boxbox is the web client (https://github.com/clauseo-ai/boxbox2). pairing connects a client to your daemon:
`cmx2 pair` prints the daemon's url and a token that works once, for 10 minutes. the client trades it for
its own credential. once any client is paired, every request needs a credential. this machine's own cli
and tui keep working through a local token file. `cmx2 pair --list` shows paired clients and
`cmx2 pair --revoke <id>` cuts one off.

the daemon listens on `127.0.0.1` by default, so only this machine reaches it. to reach it from another
device, run it on a private network such as a tailnet (a private tailscale network) and install with
`--hostname 0.0.0.0`. on a machine with a public address, keep the default. the daemon speaks plain http,
so do not expose it on an open network. see [SECURITY.md](../SECURITY.md).

`cmx2 upgrade` fetches the latest release and restarts the service.

## where things live

- `~/.config/cmx2/`: the profile (`cmx2.jsonc`, `routing.jsonc`, `agent/`, `command/`). it reloads when it
  changes. `CMX2_CONFIG_DIR` moves it.
- `~/.local/share/cmx2/`: sessions (`cmx2.db`), transcripts, logs, the installed binary and the pairing
  credentials. `CMX2_DATA_DIR` moves it. nothing cmx2 does deletes a session.

## next

- [routing](routing.md): which models helper agents run on.
- [agents](agents.md): how a session starts and talks to helper agents.
- [permissions](permissions.md): what a model may do without asking.
- [tui](tui.md): keys and theme for the terminal client.
- [architecture](architecture.md): how the daemon is put together.
