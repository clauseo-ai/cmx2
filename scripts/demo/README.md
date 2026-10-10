# demo recordings

the readme has a marked slot for an animated demo. this folder holds the capture scripts. nothing here calls a paid model: the model is a scripted stand-in on loopback and everything runs in a throwaway profile.

## terminal clip

```sh
scripts/demo/record.sh                     # writes assets/demo-terminal.gif
scripts/demo/record.sh /tmp/draft.gif      # or anywhere else
```

needs bun, [vhs](https://github.com/charmbracelet/vhs) (`brew install vhs`), ripgrep and git.

| file | what it does |
|---|---|
| `record.sh` | sets the scene, fills the tape's output path and runs vhs |
| `env.sh` | a scratch profile and a tiny repo, the scripted model on 4851 and a daemon on 4850 (`DEMO_MODEL_PORT` and `DEMO_DAEMON_PORT` move them). stops both when the script ends |
| `model.ts` | the stand-in for the anthropic messages api. the prompt starts a root that spawns two helpers on haiku, waits for their reports and answers. each helper makes one tool call and reports |
| `demo.tape` | the vhs script: `cmx2 run "add a test for the parser"`, then `cmx2 agent tree` showing both helpers parked |

the clip is about 13 seconds and 150 KB. github does not play repo-relative video in a readme, so keep recordings as gif or webp under 4 MB. vhs makes the gif directly. for a webp, run `ffmpeg -i demo.gif -loop 0 demo.webp`.

## web client

the main demo is the boxbox web app driving a daemon, not the terminal. that capture lives in the boxbox repo and runs against its bench model, which has a `[bench:pack N MS]` script that spawns two helpers from one turn. drop the result in `assets/demo.gif` and swap it into the `<!-- demo -->` comment in the readme.
