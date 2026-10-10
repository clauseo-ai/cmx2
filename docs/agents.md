# agents

a session can start other agents: hand one a task, get its report, give it a follow-up later. each agent is a real session with its own context
and transcript, a path in the tree (`/root/<name>[/<child>]`) and a model from the table in
`routing.jsonc` (see [routing](routing.md)). the title shows both, like `scout (sonnet)`. a session talks to the daemon over its http api, which these docs call the contract.

## the verbs the model has

| verb | what it does |
|---|---|
| `spawn` | starts an agent on a brief and returns its id at once. options: `model` (a name from the table, required unless the agent type names one), `effort` (within the model's limits), `after` (the id, path or name of an earlier helper whose attempt this one takes over. its brief and last report ride along, and it keeps running unless you close it), `name`, `agent_type` (`general`, `explore` for read and search only, `review` for read, search and run commands without editing, or a type from `.cmx2/agent/*.md`; the built-in names win over a file with the same name, and the daemon logs a warning once), `files` (contents ride with the brief), `fork_turns`, `on_failure` (`escalate`, `respawn` up to 3 times, `ignore`), `pool` (`n`, `collect`: `all`, `first` or `any_n`; `strategy`: `one_for_one`, `one_for_all`, `rest_for_one`; `briefs`), `cache_ttl` |
| `message` | a note to any agent in the tree by id, path, name or `parent`. a running agent reads it at its next step; with `wake` (default) an idle one starts a turn. `correlation_id` pairs replies |
| `wait` | blocks until mail arrives (or a matching `correlation_id`), 1 s to 10 min; ending the turn is usually cheaper, because reports wake you |
| `agents` | the roster, with each agent's model, effort, context size and cost per step; `close` (for good, children too, transcripts stay), `interrupt` (stops the turn, keeps it resumable), `return_to` (a follow-up) |
| `run` | scripts reach the same verbs as `agents.spawn`, `agents.message`, `agents.wait`, `agents.list`, `agents.close`, `agents.interrupt` |

## what happens

- **done means parked.** when an agent ends its turn, its final text goes to its spawner as a report
  and the agent parks: idle, addressable, costing nothing. a message continues it with its whole history.
  nothing is killed because it finished.
- **reports wake the parent.** an idle parent (the root or any agent with children) starts a turn when a
  report arrives. the root parks between turns while its agents work, and `session.status` says
  `{type: "idle", parked: {agents, jobs}}`.
- **the transcript is the truth.** agents, mailboxes and paths live in sqlite. a loaded session is a cache,
  and at most 8 idle ones stay loaded. after a daemon restart, a message to a parked agent reopens it from
  its transcript. an agent that was mid-turn when the daemon stopped comes back `interrupted`, and its
  spawner is told.
- **caps count running turns.** `caps.running_turns` (default 50, the root included) limits how many
  agents in one tree run a turn at once. the rest wait as `queued`. parked agents do not count. an agent
  inside `wait` lends its slot out. `caps.depth` (default 3) and `caps.budget_tokens` (input, output and
  cache writes across the tree) refuse spawns with `AgentDepthExceededError` and `BudgetExceededError`;
  running agents stop at the budget with a partial report. `spawn(budget_tokens)` caps one dispatch.
  the default used to be 4, which meant 3 helpers at a time. that was a mistake by a coding agent and
  went unnoticed. see the caps section of [routing.md](routing.md).
- **reports are bounded.** the deliverable comes from the turn that just ended, never from an earlier
  task, and is cut at 12,000 characters (the rest stays in the child's transcript). a report with no
  substantive text says so first. a last line `ABORT(<reason>): <details>` (spec_wrong,
  transient_tool_error, out_of_scope, context_full, approach_failed, user_question) is parsed, and
  behaviour contracts per agent type flag a missing deliverable or an undeclared reason.
- **a helper's questions go to its spawner.** a helper's `question` tool sends the questions to the agent that
  started it as a message with a `correlation_id` (waking it when it is parked) and waits. any `message` from that
  agent to the helper is the answer and comes back as the tool result. the spawner answers from what it knows or
  asks with its own `question` tool, so a question reaches the user only through the root. while it waits the
  helper's `cause` is `asking` and its running-turn slot is lent out. the call fails when the helper's turn is
  stopped, or when the spawner ends a turn that read the question without answering.
- **mailboxes hold 32 unread notes**; a full one answers `MailboxFullError`. reports and lifecycle notes
  never bounce.
- **siblings share a cache.** a child's system prompt depends only on its agent type; its name, path,
  model and task ride its first message, so every helper of one type on one model reuses one cached prefix.
- **a helper's effort goes up for a turn and comes back.** a turn that shows failure signals (the same
  tool error twice, the same check failing twice after edits, output cut at the token limit, the same call
  three times, except `wait` and `agents`) makes the next turn one allowed rung higher, recorded on the step
  (`escalation`). a turn without failure signals puts it back where it started. the session you talk to is
  never escalated, and no tool call lowers an effort. the daemon does that.
- **stepping up is a new spawn.** when a helper's output falls short, `spawn(model, after: <id>)` starts
  another helper, usually on a stronger model, with the first one's brief and last report attached.
  `cmx2 stats` counts helpers by model, the step-ups between them and the retries.
- **parked children stay warm.** a parked subagent's prompt cache is refreshed with a one-token request
  just before the ttl runs out, for up to 20 minutes (`spawn(warm: false)` turns it off).

## over rest

| route | what |
|---|---|
| `GET /session/:id/agents` | the tree: live agents, then the newest 32 closed ones |
| `POST /session/:id/agents` | spawn as that session (the same code path as the tool; `model` is a name from the table or a `provider/model-id`; `seat` is gone and answers 400 `SeatsRemovedError`) |
| `POST /session/:id/agents/message`, `/wait`, `/interrupt`, `/close` | the other verbs as that session |
| `GET /session/:id/mailbox` | mail not yet in its transcript |
| `GET /session/:id/agents/metrics` | delivery, safety-net, wait-timeout and tool-error rates for the tree |
| `GET /session/:id/children` | child sessions, which boxbox (the web client) shows as a pack |

events: `agent.spawned`, `agent.updated`, `agent.report`, `agent.message`, `agent.wait`, `agent.closed`,
`agent.metric.*`, `session.escalated`, `session.warmed`; children announce themselves with
`session.created` carrying `parentID`.
