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
  "haiku": { "ref": "anthropic/claude-haiku-5-5", "effort": "high", "note": "cheapest and fastest; bounded work; costs 5× once a request reaches 100k tokens" },
  "sonnet": { "ref": "anthropic/claude-sonnet-5-5", "effort": "high", "note": "routine and terminal-heavy implementation, ui, docs" }
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

stepping up is a spawn with `after` (an id, a path or a name): the new helper starts with the earlier helper's brief and last report attached. the earlier helper keeps running unless you close it. a `step_up` metric is recorded when the model or the effort changes and a `retry` when neither does (`cmx2 stats` counts both per model). the third attempt on one model is told which attempt it is.

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
