# routing

`routing.jsonc` is the table of models a helper can run on, and a short guide the delegating model reads. a helper is another agent a session starts with `spawn` (see [agents](agents.md)). the spawn names a model from the table by its alias, like `haiku` or `opus`, and optionally an effort. cmx2 maps that to a provider model and checks the effort against the `never` list. nothing in this file routes the session you talk to: its model and effort are your choice, set with the picker and the dial.

this is version 2 of the file. version 1 had seats and presets; see "version-1 files" below.

## where it lives

layers, each on top of the one before:

1. the shipped default (works with an anthropic key alone)
2. `~/.config/cmx2/routing.jsonc` (or `$CMX2_CONFIG_DIR/routing.jsonc`)
3. `~/.config/cmx2/routing.<hostname>.jsonc`, the per-machine overlay
4. `<project>/.cmx2/routing.jsonc` (read by `cmx2 agent models`; the daemon does not read a project layer)

objects merge key by key, lists replace: a `models` entry merges into the shipped entry of the same alias, while `guide` and `rules` are lists, so a layer that sets one replaces it whole. `examples/routing.jsonc` spells out the default with comments.

## hot reload

every spawn reads the table fresh: cmx2 checks the files' size and modification time and re-reads when one changed. edit the file and the next spawn uses it, no restart and no reload call. a broken edit keeps the last good table in force, and the error names the file and the fix (`cmx2 agent models` shows it).

## models

```jsonc
"models": {
  "haiku": { "ref": "anthropic/claude-haiku-5-5", "effort": "high", "note": "where bounded work starts; about a seventeenth of a sonnet step under 100k tokens of context and about a third past it, so split at 100k when the work splits" },
  "sonnet": { "ref": "anthropic/claude-sonnet-5-5", "effort": "high", "note": "ui, docs and copy, work the brief cannot pin down, diagnosis; about 17× a haiku step under 100k tokens of context" }
}
```

- the key is the alias a spawn names: a lowercase word (letters, digits and `-`, up to 24).
- `ref` is `provider/model-id`.
- `effort` is what a spawn gets when it names none. the `never` list may not forbid it.
- `note` is the one line the delegating model reads: what the model is for and what it costs.

the shipped table has `haiku`, `sonnet`, `opus` and `fable`. a layer takes a shipped alias out with `null` (`"models": { "fable": null }`); the table must keep at least one model. add an alias for any model the daemon can run (one behind a proxy, one from a second provider) and the delegating model can name it. a spawn must say which model it runs on, unless the agent type it asks for names one in its frontmatter (`model: opus`, or a `provider/model-id`). over rest a spawn may also pass a `provider/model-id`; the model-facing verb takes aliases only, so a model cannot step around the table. the profile's blacklist (`providers.<id>.blacklist`) applies to the model a spawn ends up on. the alias is the helper's label: the session title is `<name> (<alias>)` and the agents list shows it.

## guide and rules

the guide is a list of `{ task, start, up? }` rows: the kind of task, where to start (`haiku medium`), and where to step up when the output falls short (`sonnet high, then opus medium`). the rules are short sentences. both are rendered next to the table in the delegating model's turn context, after the user's message and only when the text changed, never in the cached prefix. they are defaults, not limits: the model may start anywhere the table allows, and nothing enforces a row.

notes, guide and rules are text the model reads, so they follow the voice rules: no en or em dashes, and none of `DO NOT`, `MUST` or `IMPORTANT`. a file that breaks them does not load (`invalid_guide`).

the shipped guide is haiku first, with opus as the step up: its first row names haiku as the start for any bounded task whose brief pins down the behaviour and the checks, and the other rows are the exceptions (exploration, judgment, ui, docs, diagnosis, hard debugging and reviews, all on opus). the rules ask a spawn above haiku to say in `why`, in one line, why haiku cannot do the task; `why` is stored on the agent and its metrics and never reaches the helper. this is deliberate. left to choose, a driver picks the model it trusts over the cheapest one that can do the job: across two threads in october 2026 where the user said nothing about models, 0 of 43 helpers ran on haiku, while a thread that asked for haiku shipped its core code on haiku with a review after each task. the price ratios in the notes are averages per helper step from the step table in the same month (haiku about $0.002 under 100k tokens of context, sonnet about $0.03, opus about $0.06); they follow the list prices, so revise them when those move. per task the sonnet to opus gap closes: sonnet high writes about 1.4× the output tokens per step and takes about twice the steps per review, so matched reviews in the same thread cost about the same on either (iOS: $1.48 against $1.35). that is why the step up from haiku is opus rather than sonnet. sonnet has no start row: at the same per-task cost it sits a little behind opus on the design boards (design arena, read 2026-10-11: opus 1417 overall, 1400 on ui components, 1335 on websites; sonnet 1382, 1384, 1314) and well behind on writing (arena creative writing: opus 5.5 high 1516, sonnet 5.5 xhigh 1447). it stays in the table for the cases where per-step price matters: short tasks, or one long read that cannot be split.

stepping up is a spawn with `after` (an id, a path or a name): the new helper starts with the earlier helper's brief and last report attached. the earlier helper keeps running unless you close it. a `step_up` metric is recorded when the model or the effort changes and a `retry` when neither does (`cmx2 stats` counts both per model). the third attempt on one model is told which attempt it is.

opus runs at high by default for helpers. at medium it stops short of the checks: across 55 opus medium helpers in october 2026 it ran half the steps of high (86 against 181) and the owner found the results unfinished. high costs more per helper, mostly because it runs longer and its context grows; the 250k rule and compaction are what hold that down, not the effort.

## tuning the guide

the guide is revised from sessions, not from first principles. two sources feed it: what the driver saw, which only it knows, and what the step table recorded, which `cmx2 stats --session <id>` prints (cost split between the session and its helpers, helpers by model with step-ups and retries, helpers that passed 250k tokens of context).

at the end of a session, paste this as the last message. the driver still has its context, so it can account for each spawn; the fixed shape makes the reports easy to compile across sessions.

```text
routing debrief. answer from what you already have in context; spawn nothing and read nothing new. facts and outcomes only: your own verdict on your own choices is not evidence. keep it under 600 words, in this shape.

1. session: what was built, in one line. your model and effort. what the user said about models or cost, quoted, or "nothing".

2. helpers: one line each. name | model and effort | the guide row it matched, or "none" | if above haiku, its `why`, verbatim | outcome: first pass shipped, shipped after N fix rounds, stepped up to X, abandoned | defects a review found, as a count and the worst one | peak context, if you know it.

3. where you did not follow the guide, and why. include spawns you considered and did not make.

4. haiku: what it did well and where it fell short, each with the helper name and what happened. "needs judgment" is not a finding; say which decision it got wrong or could not make.

5. misrouted: tasks that went above haiku and could have gone to haiku with a tighter brief, and the reverse. for each, what the brief would have had to say.

6. briefs: decisions a helper made mid-task that belonged in the brief. targets (frame time, latency, size) nobody stated and the result missed because of it.

7. you: steps you spent reading files or running commands that a helper could have done, roughly. your peak context. anything you held in context that you only needed a digest of.

8. proposals: at most five, each as a routing.jsonc row, note or rule, each tied to a numbered observation above. no proposal without an observation.

9. keep as is, and unsure: what this session confirmed, and what it cannot tell.
```

then run `cmx2 stats --session <id>` and keep both with the date. after a few sessions, give the compiled debriefs and stats to a fresh session with `examples/routing.jsonc` and ask it which proposals recur, which contradict each other, and which the stats support; change the guide from that, one or two rows at a time, so the next sessions show whether the change did what it should. the numbers to watch across sessions: haiku's share of spawns in threads where the user said nothing about models, review rounds per haiku task, step-ups out of haiku, and the driver's share of the tree's cost.

## never

`never` maps a model to the efforts it never runs at. keys are a `provider/model-id` or a bare model id and match the model on any provider. an effort is off only when a layer says so, and an empty list lifts an entry a lower layer set. the shipped list keeps haiku 5.5 off `xhigh` and `max`. a helper's final text is its report, and an xhigh haiku turn can end with no visible text. above `high` it also spends two to three times the tokens for two or three points. a default effort the list forbids is a load error, and a spawn that asks for a forbidden effort is refused with the efforts the model does run at.

## caps

`running_turns` counts turns running at once in one session tree, the root included; parked agents are free. `depth` is how far children nest below the root. `budget_tokens` caps what one tree spends, cache reads not counted; `null` means no limit.

the default was 4 until 2026-10-10. a coding agent picked that number when it built the cap as a control, and nobody noticed that it left only 3 child slots, because the root takes one. the helper summary line also counted queued agents as working, so trees that looked like six helpers at once were really three running and three waiting. the default is now 50, which in practice means no limit. set a lower number only on a machine that needs one.

## escalation

escalation applies to helpers only. when a helper's turn keeps failing (the same tool error twice, the same check failing twice after edits, output cut at the token limit), its next turn runs one rung higher, skipping rungs the model never runs at and stopping at the model's ceiling. the turn after one without failures puts it back at the effort it started at; the stored effort never changes. the session you talk to is never escalated: its effort is the dial's. the daemon lowers an effort, the model never does.

`escalation.ceiling` is one effort for every model, or an object of model to effort with a `"default"` for the rest. keys match like `never`'s: the exact ref first, then the bare id, then the id on another provider. the shipped ceilings:

```jsonc
"escalation": { "ceiling": { "default": "xhigh", "claude-haiku-5-5": "high", "claude-sonnet-5-5": "high", "claude-opus-5-5": "xhigh", "claude-fable-5-1": "xhigh" } }
```

no model escalates to `max` on its own: opus 5.5 at `max` scores below `xhigh` on code for more money, and sonnet 5.5 past `high` is better spent on opus. an object in your file merges onto the shipped one entry by entry. a single effort (`"ceiling": "max"`) replaces the whole object, per-model entries and all, so it applies to every model; the daemon logs a warning when it reads one and `cmx2 agent models` prints it.

## version-1 files

a file that still has `preset`, `presets`, `seats` or an `effort` map loads: those keys are ignored, with one warning per file in the daemon log and in `cmx2 agent models`. `never`, `caps` and `escalation` keep working. to move over, write the models you want under `models` (the example shows the shape) and delete the old keys. `cmx2 agent seats` prints what `cmx2 agent models` prints, for one more release.

## looking at it

`cmx2 agent models` prints the table in force: each alias with its model, default effort and note, the caps, where escalation stops for each model, the never list, the files read and any warnings. `cmx2 agent models --json` prints the same as json.
