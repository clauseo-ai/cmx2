# security

## reporting a vulnerability

report vulnerabilities privately through GitHub private vulnerability reporting. open the repository's Security tab, choose "Report a vulnerability", or go straight to https://github.com/clauseo-ai/cmx2/security/advisories/new. please do not open a public issue or pull request for one.

the maintainer will acknowledge reports as soon as possible. include the version (`cmx2 --version`), what you did and what you expected.

supported versions: the latest release only. fixes land there, not on older releases.

note for the maintainer: private vulnerability reporting must be switched on for the repository, under Settings > Code security > Private vulnerability reporting. without it the report link above does not work.

## what cmx2 guarantees today

- the daemon is your shell. a client that gets past auth can start a terminal and run anything as you, so auth is the boundary. the daemon binds loopback (`127.0.0.1`) by default. on any other address it always needs a credential, even before the first client is paired. a credential is basic auth (user `cmx2`, password from `CMX2_SERVER_PASSWORD`), a paired bearer token from `cmx2 pair`, or this machine's own `local.token`.
- a request that a web page makes for another site (a cross-site `Origin` or `sec-fetch-site`) is refused on every daemon. a daemon with no credential set answers only to loopback host names, so a page cannot drive it or rebind its own name to it. the daemon decides auth from the headers before it reads a body, and refuses bodies over 128 mb.
- expose the daemon only over a tailnet (a private tailscale network) or an ssh tunnel. it speaks plain http, so a password or a bearer token on an open lan is readable on the wire.
- permission rules (`permission` in your profile) are checked for every tool call a model makes: native calls, every helper inside a `run` script, jobs, terminals, typed terminal input, a job's environment and a checkout's setup command. path rules follow symlinks. shell rules check each command in a compound line (`a && b | c`, `$(...)`). the shipped default allows every shell command, so path rules only bite once you narrow shell. shell rules match text. they are guardrails for a model, not a sandbox.
- a repository's own config (`.cmx2/cmx2.jsonc`) cannot set providers (endpoints, keys, key commands), the listener or mcp servers. its permission rules can ask or deny but not allow.
- subagents do not push. a child session's `git push` is refused by a rule, and every command it runs carries git config that rewrites push urls to a transport that does not exist. a child that deliberately strips its environment, or pushes through an api or an mcp tool, is not stopped. that needs an os sandbox.
- `run` scripts execute in a quickjs vm with no fs, network, process or timers of their own. every helper they call goes through the same tool path and permission checks as a direct call.
- keys live in env, the keychain (`!command`) or your profile, never in the store. `GET /config` masks keys, header and env values, url passwords, secret query values and command-line tokens, and `cmx2 doctor` never prints a key. the daemon removes `CMX2_SERVER_PASSWORD` from its environment once it reads it, so nothing it starts inherits it. provider keys stay in the environment of the commands it runs, because your own commands use them.
- imported history (`archive.db`) is attached read-only. a write through the daemon fails.
