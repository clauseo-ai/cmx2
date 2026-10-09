# cmx2 agent contract

this file is for coding agents working in this repository. humans can read it too: it is the short list of rules the maintainer holds contributions to.

## read order

[docs/architecture.md](docs/architecture.md) for the map, then [docs/engineering/README.md](docs/engineering/README.md) and the file that matches what you are about to touch. read [docs/engineering/GOTCHAS.md](docs/engineering/GOTCHAS.md) before working in any area it has an entry for.

## rules

1. **offer primitives, guardrails and measurement; let the model decide.** do not put a rule in a prompt that a stronger model would not need. if you catch yourself encoding how you would have done the task, make it a default the model can override.
2. **claim only what you ran.** do not call something verified, working or done unless you drove it against a real running daemon and can show the output. a passing build is not verification. a unit test is not verification of a behaviour that only shows up against a real provider.
3. **use the cheapest check that answers the question.** typecheck, then unit tests, then a real daemon driven over http, then the build, then the eval (see [docs/engineering/VERIFICATION.md](docs/engineering/VERIFICATION.md)). the eval calls paid model apis, so run it only when a change needs it.
4. **no mocks in integration tests.** they run against a real daemon and the real provider path, behind `CMX2_LIVE_TESTS=1` so the default `bun test packages` stays offline and free. recorded fixtures are for wire-format parsing only.
5. **prose a user or a model reads is lowercase, plain and blunt.** no em or en dashes, no shouting, no corporate speak. this covers error messages, cli output, docs and the tool descriptions the model reads: plain definitions of what a tool does, no all-caps rules, no DO NOT lists.
6. **dependencies.** A library that makes the work faster and more reliable is fine. each addition earns its place. pi is pinned exactly; a pi upgrade is its own change with its changelog read, the drift tests run and a changelog line (see the pi entry in GOTCHAS).
7. **licenses.** borrow code only from repositories that carry a license file (MIT or Apache). log every borrowed module in [THIRD_PARTY.md](THIRD_PARTY.md). if a package declares a license only in its metadata, ask its author or reimplement.
8. **ports and daemons.** never run two dev daemons on the same port, and kill what you start. dev daemons use their own ports (`bun run dev` is 4830), never the default port 4097 a real daemon runs on. tests and eval scripts shift their ports with `CMX2_PORT_SHIFT`, so two checkouts can run them at once.
9. **memory is a feature.** the daemon has a budget (see [docs/engineering/GOALS.md](docs/engineering/GOALS.md)). measure rss while you verify, not at the end.
10. **write down what bit you.** add an entry to GOTCHAS when something surprising costs you time, so the next agent skips it.
11. **no time estimates, no emojis, no phases-as-marketing.** report outcomes with evidence. if a test fails, say so and show the output.
12. **this is a public repository.** nothing specific to one person or machine goes in code, prompts, docs or tests: no names, hosts, private endpoints, keys, local paths or usage figures. those belong in the user's profile (`~/.config/cmx2/`). `scripts/check-public.sh` fails on any pattern you list in `$CMX2_PRIVATE_PATTERN`, and CI runs it.
13. **commits are short and plain, with no attribution trailers.** no `Co-Authored-By` lines and no "generated with" footers.
14. **nothing deletes sessions or messages.** not imported history, not native sessions, not prune, compaction or a migration. storage work may move, compress or archive. it never drops rows or transcript files. any storage change comes with a test that counts sessions and messages before and after.
15. **the http contract is shared with clients.** the web client [boxbox](https://github.com/clauseo-ai/boxbox2) and any script build against `packages/contract`. change routes and events additively. when a change cannot be additive, bump the contract version, say so in the changelog and run `bun run contract` so `packages/client` and `openapi.json` follow. a route that answers 404 or a new shape to an existing client request is a failed change even when the unit tests pass.

## commands

```sh
bun install
bunx tsc --noEmit -p .         # typecheck, the cheapest tier
bun test packages              # unit tests and wire-format fixtures
CMX2_LIVE_TESTS=1 bun run test:integration   # real daemon and a real model: costs money
bun run dev                    # daemon from source on 127.0.0.1:4830
bun run contract               # regenerate packages/client from the manifest
bun scripts/build.ts           # single binary in dist/
```

the pattern for integration work: start a throwaway daemon on a spare port in a scratch directory, point tests and the client at it, give any session titles you create a unique nonce, and clean up after.