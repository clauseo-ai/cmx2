# contributing

cmx2 is a coding-agent daemon written in typescript on [bun](https://bun.sh). it builds on [pi](https://github.com/earendil-works/pi), an open source agent library. [docs/architecture.md](docs/architecture.md) is the overview of how the packages fit together. the design notes for people changing cmx2 are in [docs/engineering/](docs/engineering/README.md).

## prerequisites

- macos or linux.
- [bun](https://bun.sh) 1.3.14, the version CI uses.
- git.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`. the grep and glob tools run it, and some tests need it.

## set up

```sh
git clone https://github.com/clauseo-ai/cmx2 && cd cmx2
bun install
```

## check your change

```sh
bunx tsc --noEmit -p .                                  # typecheck, the cheapest check
bun test packages                                       # all unit tests
bun test packages/routing                               # one package
bun test packages/routing/test/routing.test.ts          # one file
bun test packages/routing -t "version-1"                # tests whose name matches
CMX2_LIVE_TESTS=1 bun run test:integration              # real daemon and a real model, costs money
```

`bun test packages` runs offline: no api key and no network are needed, and CI runs exactly that. tests that call a real model provider or the live network are skipped unless you set `CMX2_LIVE_TESTS=1`. they use `$CMX2_LIVE_PROFILE` (a config folder), else `~/.config/cmx2/cmx2.jsonc`, else `ANTHROPIC_API_KEY`, and they cost money. they start real daemons on spare ports (4830 to 4839), never mocks. set `CMX2_PORT_SHIFT=20` to move them if another checkout is using those ports.

a passing build is not verification. verification climbs from cheap to expensive: typecheck, unit tests, a real daemon driven over http, a build, the eval. [docs/engineering/VERIFICATION.md](docs/engineering/VERIFICATION.md) describes each tier.

## run a dev daemon

```sh
bun run dev                  # daemon on 127.0.0.1:4830, from source
bun packages/cli/src/index.ts --port 4830     # terminal client against it
```

the daemon needs a model to talk to. set `ANTHROPIC_API_KEY`, or write a profile (see [docs/quickstart.md](docs/quickstart.md)). to point a dev daemon at a scratch profile and database, set `CMX2_CONFIG_DIR` and `CMX2_DATA_DIR` to temporary folders.

## what ci runs

on every pull request and every push to `main`:

```sh
bun install --frozen-lockfile
bunx tsc --noEmit -p .
bun test packages
bun packages/contract/src/generate.ts --check   # the generated client matches the contract
scripts/check-public.sh      # fails if a file holds a string from your own private patterns
```

run all five locally before you push. `scripts/check-public.sh` skips itself unless `CMX2_PRIVATE_PATTERN` or `CMX2_PRIVATE_PATTERN_FILE` names a pattern, so it passes on a fresh clone. a tag `v*` also runs the release workflow, which builds the binaries.

## pull requests

- keep commits small, one idea each, with a plain message that says what changed and why.
- add or update tests with the change. a bug fix gets a test that failed before it.
- run the typecheck and the tests before you open the pull request.
- write anything a user or model reads in lowercase, plain words, with no em or en dashes, no shouting, and errors that name the fix.
- keep anything about your own machines, proxies or keys out of `packages/` and prompts. that belongs in your profile (`~/.config/cmx2/`).
- pi is pinned to one exact version. a pi bump is its own change: read its changelog, run the drift checks and add a line to `CHANGELOG.md`.

cmx2 is [MIT licensed](LICENSE). by contributing you agree your work is released under the same license.
