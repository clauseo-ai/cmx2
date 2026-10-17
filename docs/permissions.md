# permissions

every tool call is checked before it runs, including each helper call inside a `run` script (the tool that lets a model script other tools). a check
ends in allow (the call runs), deny (the model is told which rule blocked it and carries on) or ask
(the turn waits until someone answers from any client: boxbox, the web client, on a phone; the terminal client; the http api).

## the default policy

with no config, a session may do anything inside its working directory without asking:

| permission | default | what it covers |
|---|---|---|
| `*` | allow | anything not listed below |
| `read` | allow, but `*.env` and `*.env.*` ask (`*.env.example` is allowed) | reading files |
| `external_directory` | ask | a path outside the session's working directory, for the tools that take a path (see below) |

so edits, searches, shell commands, background jobs and web fetches run without a prompt. `.env` files ask
before they are read. the outside-the-project check covers only some tools, listed under the table below.
it does not make shell safe.

to keep a person in the loop for commands, use the shell-ask preset below.

## presets

`examples/presets/shell-ask.jsonc` makes every shell command ask:

```jsonc
{ "permissions": { "shell": "ask" } }
```

put it in `~/.config/cmx2/cmx2.jsonc` for every project or in a project's `.cmx2/cmx2.jsonc` for one.
`permissions` and `permission` are the same key, and `bash` is accepted as another name for `shell`.

## how rules are written and read

```jsonc
{
  "permission": {
    "*": "allow",                                   // a permission with one action
    "shell": { "*": "ask", "git status *": "allow", "rm *": "deny" },   // or patterns, each with an action
    "edit": { "*": "allow", "*.lock": "deny" },
    "external_directory": { "~/scratch/*": "allow" }
  }
}
```

- the last matching rule wins, in the order written, across layers: shipped default, then the profile
  (`~/.config/cmx2/cmx2.jsonc`, then `cmx2.<hostname>.jsonc`), then the project (`.cmx2/cmx2.jsonc`),
  then answers saved with "always". a call no rule matches asks.
- `*` matches any run of characters and `?` one character. a pattern that ends in ` *` also matches the
  bare command (`git status *` matches `git status`). `~/` and `$HOME/` expand.
- a value can also be a single action for everything: `"permission": "ask"`.

## what each tool is checked as

| tool | permission | pattern |
|---|---|---|
| read | `read` | the path, relative to the working directory |
| write, edit | `edit` | the path |
| grep, glob | `grep`, `glob` | the searched path |
| shell, and background jobs | `shell` | the command line |
| terminals the model drives (`pty.*` in `run`) | `shell` | the command it starts, and each line typed into it |
| webfetch | `webfetch` | the url |
| webcrawl | `webcrawl` | the start url |
| websearch | `websearch` | the query |
| skill | `skill` | the skill's name |
| lsp | `lsp` | the file |
| any path outside the working directory, for read, write, edit, grep, glob and lsp | `external_directory` also | the directory, as `dir/*` |

the outside-the-project check (`external_directory`) runs for read, write, edit, grep, glob, lsp, and for the `cwd` a
background job or terminal starts in. it does not run for shell command lines, for what is typed into a terminal,
or for webfetch and websearch. a shell command like `cat /etc/passwd` is judged only by the `shell` rules, so with
the default policy it runs without asking. to gate it, set `shell` to `ask` (see the preset above).

`run` has no check of its own: every helper it calls (`fs.read`, `search.grep`, `shell.exec`,
`pty.spawn`, ...) is checked as the tool it calls, with the same rules, and a refused helper rejects
inside the script with the reason, so a script can catch it and carry on. the run's result lists each
helper call with how its check came out.

## the answers

- once: this call runs, and the next one asks again.
- always: this call runs and its pattern is saved for the project (for shell, the command's first
  two words, like `bun test *`). pending asks the saved rule now covers are answered too.
- reject: the call does not run and the turn ends after the current batch. the session's other
  pending asks are rejected with it. reject with a message and the model reads it and continues instead.

pending asks survive a client reconnecting (`GET /permission` lists them). they do not survive a daemon
restart, because the turn that asked ends with it.
