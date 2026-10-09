# engineering docs

design notes for people changing cmx2. if you only want to use it, start with the [quickstart](../quickstart.md). if you want the lay of the land first, read [docs/architecture.md](../architecture.md), which opens with a diagram and walks one request through the daemon.

cmx2 is a coding-agent daemon built on [pi](https://github.com/earendil-works/pi) (an open source agent library, pinned to one exact version). it is the successor to [cmx](https://github.com/clauseo-ai/codemaxxxing), an earlier runtime built on a fork of opencode. the web client is [boxbox](https://github.com/clauseo-ai/boxbox2).

| file | what it is | read it when |
|---|---|---|
| [GOALS.md](GOALS.md) | goals, non-goals and the measurable targets | before design work |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the full design: packages, the loop, agents, processes, worktrees, routing, caching, events, persistence | before writing code |
| [DECISIONS.md](DECISIONS.md) | decisions that are settled, and open questions | before reopening a design question |
| [PROMPTS.md](PROMPTS.md) | prompt principles, routing and delegation rules, per-model profiles | when you touch anything the model reads |
| [VERIFICATION.md](VERIFICATION.md) | how to prove a change works: tiers from typecheck to a real daemon, and what each costs | before you say something works |
| [GOTCHAS.md](GOTCHAS.md) | sharp edges already paid for, by area | before you touch the matching area |

## the one rule behind the rest

models get better faster than harness rules age well. cmx2 offers primitives, guardrails and measurement, and lets the model decide when to think, when to delegate and to whom. every rule in these docs is a default the model can override, and the eval measures whether it does.

## working on it

build and test commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md). agents that work in this repo read [AGENTS.md](../../AGENTS.md) first.