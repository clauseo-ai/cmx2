# custom tools

status: proposal, decisions settled by the maintainer (2026-10-11), not built.

a native way for a user to add a tool of their own: a web search provider we do not ship, a call to an internal api, a wrapper around a cli with a nicer schema. today the paths are an mcp server (a process speaking a protocol), a skill (prose plus scripts run through `shell`), or forking `packages/tools`. `extraTools` on `SessionOptions` is internal (the agent verbs ride it) and stays that way.

## summary

- a tool is one file, `~/.config/cmx2/tool/<name>.ts` (or `.js`, `.mjs`), or `.cmx2/tool/<name>.ts` in a repository. its tool name is `user_<name>`.
- it default-exports a plain object: `{ description, parameters, execute }` plus a few optional fields. no cmx2 import is needed or expected.
- `parameters` is json schema. the daemon validates arguments against it before `execute` runs.
- the files are loaded and run in one tool host subprocess per daemon, with the daemon's full environment, not in the daemon. a hang or crash kills the host, not the daemon.
- every custom tool is deferred behind `tool_search`, so the cached prefix is the same with or without them.
- each is checked by the permission rules under its own name; the default policy (`*: allow`) lets them run, like mcp tools.
- `run` scripts reach them (and mcp tools) through one new generic helper, `tools.call({ name, args })`.
- a repository's `.cmx2/tool/` loads too, with no trust prompt: opening a repo runs its tool code once the model loads one of its tools. a profile tool wins over a repo tool of the same name.
- the export shape is versioned public api from the first release: additive changes only.

## the file

```
~/.config/cmx2/tool/
  tavily.ts        -> tool "user_tavily"
  jira_issue.js    -> tool "user_jira_issue"
  _shared.ts       -> not a tool (leading underscore): a module the others import
```

- the stem matches `^[a-z][a-z0-9_]{0,47}$`; the tool is `user_<stem>` (provider tool names allow 64 of `[A-Za-z0-9_-]`). a file whose stem does not match is reported and skipped.
- the `user_` prefix is fixed, so a user tool never clashes with a builtin (no builtin starts with `user_`, and none ever will) or an mcp tool (`<server>_<tool>`; a server named `user` is refused). a later release adding a builtin cannot break a user's tool.
- `.ts`, `.js`, `.mjs` load. `.d.ts`, dotfiles, `_`-prefixed files and subdirectories do not, so a tool can keep helpers and a `node_modules` next to it.
- a file may import anything resolvable from where it sits: node builtins, bun apis, packages in a `package.json` the user installed in that directory. it must not need a cmx2 package, so a profile works against any cmx2 binary. this is the lesson from cmx's `.opencode/tool/*.ts` importing `@opencode-ai/plugin` (GOTCHAS: a bare clone could not start).
- a file that fails to import (syntax error, missing package) is skipped with its error; the other tools load. a broken tool never stops the daemon or a session.

alternatives: tools listed in `cmx2.jsonc` with a path (one more place to keep in sync; the directory already says it); one file exporting many tools (opencode's `file_export` naming makes names nobody chose; one file, one tool keeps the name, the permission rule and the file the same word); `~/.config/cmx2/tools/` plural (singular matches `agent/` and opencode's `tool/`, so a user moving over copies a folder).

## the export shape

```ts
export default {
  description: "search the web with tavily and return the top pages with their text.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "what to search for" },
      results: { type: "number", description: "how many pages, default 5" },
    },
    required: ["query"],
  },
  subject: "query",        // optional: the argument a call is about (permission pattern, row title)
  readOnly: true,          // optional, default false: changes nothing (explore and review agents may use it)
  timeout: 60,             // optional: seconds, default 120, at most 600
  version: 1,              // optional: the shape this file is written against, default 1
  async execute(args, ctx) {
    return "text the model reads";
  },
};
```

`name` is not a field: the file name is the name. an object that has `name` and disagrees with the file is refused, so a copied file cannot pretend to be another tool.

the tool does its own work: there is no handle to call other tools from `ctx` (opencode has none either). work longer than the timeout belongs in a background job the model starts with `shell`, not in a tool.

### ctx

| field | what it is |
|---|---|
| `cwd` | the calling session's working directory |
| `signal` | an `AbortSignal`: fires on interrupt, on timeout and on daemon shutdown |
| `config` | this tool's block from the profile (`tools.<name>`), with `$NAME` and `!command` string values resolved (below); `{}` when absent |
| `env` | variables the session adds for commands it runs (a subagent's push guard). a tool that spawns a process should merge them |
| `session` | `{ id, child }`: which session called, and whether it is a subagent |
| `callId` | the tool call id, for the tool's own logs |

left out on purpose: `spill` (the daemon clips every result to the shared 2000 lines / 50 KB and spills the rest itself, as it does for mcp), a handle to call other tools (decided: tools do their own work), the procs host (background jobs belong to the model's `shell`, not to a tool), the raw daemon config.

secrets: a tool can read `process.env` like any program. for keys that live in the profile, a block in `cmx2.jsonc`:

```jsonc
{ "tools": { "tavily": { "apiKey": "$TAVILY_API_KEY", "depth": "advanced" } } }
```

the block is for profile tools; a repo tool reads its keys from the environment. string values starting with `$` or `!` go through the same `resolveSecret` as provider keys (`$ENV`, `${ENV}`, `!command` with a 10 s limit), once per load, and the result is cached until the next reload. `tools` joins `PROFILE_ONLY`, and `GET /config` redacts it with the existing rules (secret-named keys stay `$NAME` or are masked). resolution happens in the daemon; the host gets resolved values over its pipe, never through the environment of commands the session runs.

### the result

```ts
type Result =
  | string
  | {
      content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      data?: unknown;      // machine-readable, for run scripts (structuredContent); never sent to the model
      details?: unknown;   // for clients, kept to the size a part can carry (shrinkDetails)
      isError?: boolean;
    };
```

text goes through the shared clip. images go through `imageParts` (sniffed, resized, refused if unreadable), so a tool cannot wedge a session with bad bytes (GOTCHAS: a bad image wedges a session). a thrown error becomes an error result whose text is the message (stack trimmed to the tool's file), same as a builtin that throws.

### why json schema, not typebox

json schema is what the provider receives and what mcp tools already hand us (`Type.Unsafe` in `mcp.ts`); typebox is a builder for it that would make every tool import a package and pin its major version. a user who likes typebox can still build the object with it: typebox output is json schema. the daemon validates with the validator already behind the builtin schema check (a nested `run` call and a direct call share it), so a tool sees arguments that match its schema and never needs to check types. at load the schema must be an object schema with `properties`; anything else is refused with a reason.

## where the code runs

| option | a `while(true)` | `process.exit()` / native crash | memory | cost |
|---|---|---|---|---|
| in the daemon (`import()`) | freezes every session and the http api | kills the daemon | counts against the 150 MB idle budget (D15), leaks never return | none |
| a bun `Worker` | `terminate()` recovers | still the daemon's process | same heap budget, per worker | one worker |
| a subprocess (chosen) | killed, host restarts | host dies, daemon reports it | its own process, off the budget | ~30 MB rss while alive, one pipe |

chosen: one tool host per daemon for every tool, profile and repo (revisit if one tool's stuck cancels start costing the others). it starts as `process.execPath tool-host` (the same binary; from source, the cli entry), imports the files, answers `list`, `call` and `cancel` over json lines on stdio, and exits after 5 minutes idle, where idle means no user tool call is running. a bun 1.3.14 compiled binary was checked to `import()` a `.ts` file from disk, including a relative `.ts` import, and a fresh process picks up edits. the daemon keeps the catalog (names, descriptions, schemas) from the last `list`, keyed by file mtimes, so an idle host costs nothing and the catalog is there without starting it; the first call starts it again (one import of the files, measured at load).

- **settings**: `toolHost: { idle: 300, timeout: 120 }` in the profile (seconds; profile only) sets the idle exit and the default call timeout. a tool's own `timeout` overrides the default; nothing goes past 600.
- **timeout**: the daemon aborts the call at `timeout` (sends `cancel`, which fires `ctx.signal`), returns an error result saying the tool took longer than n s, and gives the host 2 s to answer the cancel. no answer means the host is stuck: it is killed and other calls in flight fail with "the tool host restarted while this call ran". a tool that honours `signal` never costs its neighbours anything.
- **crash**: a host that exits fails its in-flight calls with its last stderr lines (mcp's connect error does the same) and is started again on the next call. three crashes inside a minute mark the tool host failed until the next reload, so a tool that kills it at import does not loop.
- **why not an mcp server**: the host could speak mcp and ride `McpPool`. it would bring the server sdk into the binary, a handshake per start and `<server>_` names. the private protocol is three messages and a cancel; the redial and status logic is small enough to keep separate.

the host gets the daemon's full environment, the same as `shell` (the tools are code the user chose to run, like their shell). a scrubbed environment was weighed and refused: a tool that needs a key would need config to reach it, and the shell next to it sees everything anyway.

## catalog, prefix and reload

- custom tools join the deferred catalog through `dynamicTools` (beside mcp and the checkout tools), so `tool_search` finds them and `loadTools` declares them after the cached prefix. the hot set and the system prompt never change, so adding, removing or editing a tool never rewrites a cache.
- a loaded tool stays declared in the transcript. if its file is removed, a call to it answers "the tool <name> is no longer installed" (an mcp tool whose server went away is withdrawn the same way).
- reload: the profile watcher today is `fs.watch(configDir())`, which is not recursive, so edits inside `tool/` do not fire it. the watcher gets `{ recursive: true }` or a second watch on `tool/`. a change marks the catalog stale; the host, if running, is stopped and the next `list` or call starts a fresh one. no `import()` cache busting inside a long-lived process, so old module versions do not pile up. `/global/reload` does the same and its answer lists the custom tools and any load errors, as it does for mcp.
- an edited tool whose schema changed after a session loaded it: the session keeps the old declaration until its next turn start, where tools are re-declared as of now (the same path mcp uses at the turn's start).

## repository tools

`.cmx2/tool/*.ts` (and `.js`, `.mjs`) in the session's directory load like profile tools, the way opencode loads `.opencode/tool/`. there is no trust prompt for now; a claude-code-style "trust this folder" prompt is future work and would sit in front of exactly this step.

said plainly: opening a repository with a `.cmx2/tool/` directory runs that repository's code, with your rights and your environment, when one of its tools loads. a clone you have not read can do anything a script you run could.

when code runs: a repo tool's file is imported only when `tool_search` loads it, not at session start. until then the catalog lists it by name and path only (`user_<name>: repository tool from .cmx2/tool/<name>.ts`), so `tool_search` matches its name, and the model sees the real description and schema once it is loaded. profile tools are imported when the catalog is built, so their descriptions are searchable. this makes loading async for user tools (the host imports, then answers the schema), so `loadTools` awaits the host for them.

- a profile tool wins over a repo tool of the same name: the repo tool is not listed, and `GET /tool` reports it shadowed.
- the daemon logs one line per directory naming the repo tools it loaded (`cmx2: loaded repository tools from <dir>/.cmx2/tool: user_a, user_b`), at the time each loads.
- the project layer keeps its other limits: `.cmx2/cmx2.jsonc` still cannot allow a permission, set `providers`, `mcp`, `server`, `tools` or `toolHost`. it can make a tool ask or deny.

## permissions

checked by the default branch of `checksFor`: permission = the tool name. with `subject` set, the pattern is that argument's value as a string (like `websearch` checks the query); without it, `*`. "always" saves `*`.

```jsonc
{ "permission": { "user_jira_issue": "ask", "user_tavily": { "*": "allow", "*internal*": "deny" } } }
```

default: allow, through the shipped `*: allow`, the same as mcp tools and websearch, for profile and repo tools alike. a prompt on every call would teach people to click through. asking is one line, shown above, and `"user_*": "ask"` covers every user tool. docs/permissions.md gets a row in "what each tool is checked as":

| tool | permission | pattern |
|---|---|---|
| a user tool (`~/.config/cmx2/tool/<name>.ts`, `.cmx2/tool/<name>.ts`) | its name, `user_<name>` | the argument named by `subject`, else `*` |

and a sentence under it: a user tool runs its code with your rights, and a repository's tools load without asking; the `external_directory` check does not run for them, whatever paths they touch.

## run scripts

one new helper with a fixed signature:

```
tools.call({ name, args }): Promise<data | string>   // data when the tool returns it, else its text
```

it is a nested call like any helper: schema check, permission check under the tool's name, a record in `nested`. it reaches any deferred tool, loaded or not, so mcp tools become scriptable too (they are not today). a per-tool helper (`tools.tavily(...)`) was refused: helper signatures live in `RUN_DESCRIPTION`, which is in the hot prefix, so listing user tools there would make the prefix differ per user and change on every edit. the new line changes the description once, in the release that adds it.

## subagents

a child session gets the same catalog through the same `dynamicTools` (it is per daemon, not per session). explore and review agents exclude tools by name today (`EXCLUDE_EXPLORE`, `EXCLUDE_REVIEW`); custom tools without `readOnly: true` are added to their exclusion, so a read-only agent cannot write through a tool it cannot see the code of. a repo tool not yet imported counts as not read-only. mcp tools follow the same rule through the server's `readOnlyHint` annotation (built, see the changelog). the push guard env reaches the tool as `ctx.env`. permissions are the parent's rules plus `SUBAGENT_RULES`, as for every call.

## clients

- the tool row is titled by `toolTitle`: with `subject`, the argument's value (`user_tavily: rust async runtimes`), else the tool name. `toolTitle` gets the subject map from the catalog; no contract change, rows already carry a title.
- `details` render as today's unknown-tool details (collapsed json); a client may add a renderer later keyed on the name.
- status: `GET /tool` (new, additive) lists custom tools with `{ name, file, description, readOnly, status: "ok" | "error" | "shadowed", error? }` and the host's state. `config.updated` lists `tools` in `changed`. boxbox and the tui show it next to mcp status; `cmx2 doctor` prints the same list with load errors. `bun run contract` follows the route.

## stability

the export shape is public api. promise, written in the user docs:

- v1 fields keep their meaning for as long as the major version of cmx2 is 1. new optional fields and new `ctx` members can appear; nothing is renamed or removed, and a result shape that works keeps working.
- `version` lets a file say what it was written for. a file with a `version` the daemon does not know is refused with "this tool needs a newer cmx2". a breaking change would mean `version: 2` with v1 files still loading.
- unknown fields on the export are an error at load (a typo like `paramaters` should not silently give a tool no arguments).
- a types-only package (`@cmx2/tool-types`, no runtime) may ship for editor help. using it is optional and it is never required to load a tool.

## worked example

`~/.config/cmx2/tool/tavily.ts`:

```ts
export default {
  description: "search the web with tavily and return the top pages with a short extract of each.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "what to search for, as you would type it" },
      results: { type: "number", description: "how many pages, default 5, up to 20" },
    },
    required: ["query"],
  },
  subject: "query",
  readOnly: true,
  timeout: 30,
  async execute(args: { query: string; results?: number }, ctx: { config: { apiKey?: string }; signal: AbortSignal }) {
    const key = ctx.config.apiKey;
    if (!key) throw new Error("no tavily key: set tools.tavily.apiKey in cmx2.jsonc, e.g. \"$TAVILY_API_KEY\"");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: args.query, max_results: Math.min(args.results ?? 5, 20) }),
      signal: ctx.signal,
    });
    if (!res.ok) return { content: `tavily answered ${res.status}: ${await res.text()}`, isError: true };
    const body = (await res.json()) as { results: Array<{ title: string; url: string; content: string }> };
    const hits = body.results.map((r) => ({ title: r.title, url: r.url }));
    return {
      content: body.results.map((r) => `${r.title}\n${r.url}\n${r.content}`).join("\n\n") || `no results for "${args.query}"`,
      data: hits,
      details: { query: args.query, results: hits },
    };
  },
};
```

`~/.config/cmx2/cmx2.jsonc`: `{ "tools": { "tavily": { "apiKey": "$TAVILY_API_KEY" } } }`. the model finds it with `tool_search tavily`; a script calls `await tools.call({ name: "user_tavily", args: { query: "bun workers" } })` and gets the hits array.

## test strategy

unit (`bun test packages`, offline):
- loader: a scratch profile dir with a good tool, a syntax error, a bad name, `_shared.ts`, a `name` that disagrees, an unknown field, an unknown `version`, a non-object schema. each lands as ok or a named error; the good tool loads regardless.
- host: a real host subprocess (no mocks) with tools that return text, return `{ content, data }`, throw, ignore the signal in a busy loop, call `process.exit(1)` and leak memory. asserts: timeout result text, the host killed and restarted after a stuck cancel, in-flight calls failing with the restart message, three crashes marking it failed, idle exit, the daemon's rss unchanged after the leaking tool.
- permissions: `checksFor` with and without `subject`; a project layer `allow` dropped; a subagent with `SUBAGENT_RULES`.
- prefix: the hot tool list and system prompt are byte-identical with an empty and a full `tool/` dir.
- run: `tools.call` on a custom tool and an mcp fixture, a refused call rejecting inside the script, the nested record.
- reload: editing a file inside `tool/` changes the catalog without a restart (covers the recursive watch).
- repo tools: a scratch repo whose tool writes a marker file at import; the marker is absent after session start and present after `tool_search` loads it; a profile tool of the same name shadows it; the log line names it.
- compiled binary: `bun scripts/build.ts`, then the binary loads a `.ts` tool from a scratch profile (kept as a regression test; checked by hand on bun 1.3.14).

live (`CMX2_LIVE_TESTS=1`): a throwaway daemon with the tavily-shaped tool pointed at a local http stub (the stub is the service, not a mock of cmx2), a real model asked something that needs it: it calls `tool_search`, loads the tool, calls it, and the transcript shows the call checked as `user_tavily <query>`. measure daemon rss with the host up and after its idle exit.

## decided (2026-10-11)

1. names: a fixed `user_` prefix on every user tool. no clash rules needed.
2. no `ctx.call`: tools do their own work.
3. the host exits after 5 minutes with no user tool call running; `toolHost.idle` changes it. call timeout 120 s by default, 600 s at most, `toolHost.timeout` or the tool's `timeout`. long work starts a background job.
4. the host gets the daemon's full environment, like `shell`.
5. one host for all tools; revisit if problems show up.
6. no non-js tools: a local mcp server covers that.
7. repository tools load from `.cmx2/tool/` without a trust prompt, imported only when `tool_search` loads them; profile tools win; a log line names them. a trust prompt is future work.
8. mcp tools for explore and review agents follow the server's `readOnlyHint` annotation (a configured server is trusted), the same rule as `readOnly` here.
