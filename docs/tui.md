# the terminal client

`cmx2` with no command opens the tui (terminal ui) in the current directory. it is the tui library from pi,
the open source agent engine cmx2 builds on (`@earendil-works/pi-tui`), with a theme on top. it is only a client.
sessions live in the daemon, so you can close the tui, pick the same session up from boxbox (the web client)
on your phone, and come back.

it talks to the daemon already running on this machine (the port in your profile). when none is up,
it starts one inside itself for as long as it runs. `--port n` picks a running daemon and never starts
one. the profile is the config folder, `~/.config/cmx2/`.

```sh
cmx2                              # new session on your first message
cmx2 --session ses_...            # reopen a session
cmx2 --model anthropic/claude-sonnet-5-5
```

## keys

| key | what it does |
|---|---|
| enter | send. while a turn runs, enter steers it: the message lands at the next tool boundary |
| alt+enter | while a turn runs, queue the message to run after it. when idle it is a new line |
| shift+enter, ctrl+j | new line |
| esc | stop the running turn (closes a picker when one is open) |
| ctrl+p | model picker (applies from the next turn) |
| ctrl+o | effort picker (the daemon refuses efforts a model may not run, and says why) |
| ctrl+r | agent picker (build, or an agent file from your profile or project) |
| ctrl+t | the agent tree: every subagent under the session, its state and last words, live |
| ctrl+c | clear the composer; twice within two seconds quits. the session keeps running |
| tab | complete |
| up, down | history when the composer is empty |

in pickers, type to narrow the list, enter picks, esc closes.

## the composer

- `/` at the start lists commands: the tui's own (`/model`, `/effort`, `/agent`, `/tree`, `/new`,
  `/thinking`, `/stop`, `/quit`) and the daemon's command files and skills, which run as a prompt.
- `@path` completes a file in the session's directory and sends it with the message. pictures go as
  images, anything else as the file's text.
- `!command` runs a shell line in the session's directory; the model reads it on its next turn.

## asks

when the model (or one of its agents) wants permission, a dialog opens with three answers: allow once,
always allow (the patterns shown are saved for the project), or no. when the model asks a question, pick
an option or type your own answer. esc dismisses it. an ask answered from another client closes here on
its own. see [permissions](permissions.md).

## the status line

model · effort · agent · state, then the context in use, the session's cost and how many agents are
working, as room allows. the state is `working` (with how many messages wait), `retry n: why`,
`parked on 2 agents` or `idle`. the terminal title says `working` or `needs you` too.

## theme

the tui reads `tui.json` from your profile directory (`~/.config/cmx2/tui.json`, or
`$CMX2_CONFIG_DIR/tui.json`). every key is optional:

```json
{
  "theme": {
    "mode": "auto",
    "colors": {
      "accent": "#e8a33d",
      "user": "oklch(75% 0.08 240)",
      "tool": 141
    }
  }
}
```

`mode` is `dark`, `light` or `auto` (the default: light when the terminal's `COLORFGBG` says the
background is light, dark otherwise). `colors` overrides slots of that base: `text`, `muted`,
`accent`, `user`, `tool`, `ok`, `warn`, `error`, `selection`, `border`. a colour is `#rrggbb`,
`oklch(...)`, `okhsl(...)` or a 0-255 terminal palette index. a slot the tui cannot read keeps its default,
and the tui says which one. `NO_COLOR` turns colour off.
