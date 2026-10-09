# cmx2 for claude code

read [AGENTS.md](AGENTS.md) first and follow its read order.

@AGENTS.md

## working with /goal in this repo

- state the goal as evidence you can print into the transcript (test output, curl output, rss numbers, step rows from the store). the evaluator cannot run commands, so show it the proof.
- end every goal with a turn limit and a stop clause: "or, after N turns, write a short note of what is done, what is verified, what is not and the exact next command, and stop."
- daemons you start for verification run on ports 4830-4839, never 4097. kill them before the goal completes so background work does not hold the evaluation open.
- report outcomes with evidence, worse numbers first. a build passing is not verification.