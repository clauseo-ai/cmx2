#!/bin/sh
# records the terminal demo: a turn that spawns two helpers, then the agent tree with both parked.
# the model is scripted (scripts/demo/model.ts) and everything runs in a throwaway profile, so it costs nothing.
#
# usage: scripts/demo/record.sh [out.gif]     (default: assets/demo-terminal.gif)
# needs: bun, vhs (brew install vhs), rg, git
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$REPO/assets/demo-terminal.gif}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
export REPO
. "$REPO/scripts/demo/env.sh"

sed "s#__OUT__#$OUT#" "$REPO/scripts/demo/demo.tape" > "$DEMO_ROOT/demo.tape"
cd "$DEMO_ROOT"
vhs demo.tape
ls -l "$OUT"
