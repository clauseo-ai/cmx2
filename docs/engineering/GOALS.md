# goals

## what cmx2 is

a coding-agent runtime that replaces cmx entirely: the engine (pi, the open source agent engine cmx2 builds on), our runtime around it (agents, processes, worktrees, daemon), the CLI, a TUI (pi's, themed), and the server contract (the daemon's http api) that boxbox (the web client, https://github.com/clauseo-ai/boxbox2) and the fleet (the machines each running a daemon) depend on. one codebase, one daemon per machine, driven from a terminal, from boxbox in a browser, or headless.

## goals, in priority order

1. **fewer, cheaper, faster steps for the same outcome.** the loop pays a fixed tax per step (re-reading the whole prefix, plus thinking); cut the number of steps and the thinking per step without cutting judgment.
2. **the session is never blocked by waiting.** the root parks while children or processes work; a message typed mid-turn steers at the next boundary; nobody polls.
3. **subagents are colleagues, not function calls.** parked, addressable, warm, resumable, capped by running turns not by count.
4. **nothing leaks.** processes, ptys, worktrees and memory are owned, listed, and reaped.
5. **boxbox and the fleet keep working**, through a typed, versioned contract, with cmx and cmx2 able to run side by side while a machine moves over.
6. **a thin, current base.** pi pinned and rebased deliberately; everything that can be an extension is one; a new model works in days.
7. **measured, not felt.** every step logs effort, calls, cache-read %, ttft, cost; every harness change passes the ten-minute eval.
8. **usable by strangers, installable in minutes.** open source (MIT) from the first commit; nothing machine- or user-specific in code or prompts; one binary per platform; `cmx2 serve --install`, `cmx2 pair` and `cmx2 doctor` make a new machine and its boxbox link a five-minute job.

## non-goals

- a product or a configurable platform with a business behind it. it is one person's instrument, published so others can use and fork it; the maintainer's needs decide the roadmap.
- feature parity with pi's TUI design or with cmx's afterglow TUI. the TUI is pi's, themed; the main surface is boxbox.
- the wave runner, plan mode, the caveman agent, hono/httpapi dual backends, todo tools on 5.x models. all dropped (see `DECISIONS.md`).
- supporting models or providers the maintainer does not use beyond what pi already ships.
- upstreaming to pi. we consume; we do not depend on their review queue.

## success criteria (targets)

| measure | cmx2 target | how measured |
|---|---|---|
| daemon rss, idle | **< 150 MB** | `ps` in the verification loop |
| daemon rss, 3 active sessions at ~300k context | **< 400 MB** | same, during the eval |
| harness gap between steps | ≤ 0.1 s mean, flat across context sizes | telemetry |
| tool calls per driver step | **≥ 2.0** on the eval set | telemetry |
| steps per eval task | **30% fewer** than the same task before the change | eval suite |
| driver cache-read share of input | **≥ 96%** | telemetry |
| compaction cache-read share | **≥ 90%** | telemetry |
| compaction wall time at 300k | **< 20 s** | telemetry |
| poll-only model steps | **0** on the eval set | telemetry |
| session time blocked in wait/poll tool calls | **~0**; the root parks | telemetry |
| warm reuse (follow-ups / spawns) | **≥ 25%** | telemetry |
| orphan processes after session end | **0** in tests | integration test |
| subagent first-call cold prefix | measured; siblings of one agent type and model share a prefix | telemetry |
| new anthropic model support | config + prompt profile, no engine patch | review |
| boxbox | drives cmx2 for inbox, replies, session view, review cards, roster, processes | agent-browser loop against boxbox |

## quality bar

- every user-visible state has copy, including empty and error states.
- every control has deliberate feel: no default-by-accident timeouts, truncations, or orderings.
- every integration invariant from cmx (45) is ported or consciously retired with a note, and every new primitive adds at least one before its production code lands.
