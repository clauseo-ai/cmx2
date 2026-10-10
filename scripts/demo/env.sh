# sourced by record.sh: a throwaway profile, a tiny repo to work in, the scripted model and a daemon pointed at it.
# nothing here reads your real home, config or keys, and no request leaves the machine.
#
# sets: DEMO_ROOT (the scratch dir), DEMO_BIN (holds a cmx2 shim), DEMO_WORK (the repo), and starts the model
# and the daemon in the background. demo_stop ends both.

# REPO is the repo root; record.sh sets it
: "${REPO:?set REPO to the repo root}"
DEMO_ROOT="$(mktemp -d)"
DEMO_BIN="$DEMO_ROOT/bin"
DEMO_WORK="$DEMO_ROOT/work"
MODEL_PORT="${DEMO_MODEL_PORT:-4851}"
DAEMON_PORT="${DEMO_DAEMON_PORT:-4850}"
mkdir -p "$DEMO_BIN" "$DEMO_ROOT/home" "$DEMO_ROOT/config" "$DEMO_ROOT/data" "$DEMO_WORK/src" "$DEMO_WORK/test"

# the shim runs the daemon and the client from source, so the recording needs no build
printf '#!/bin/sh\nexec bun %s/packages/cli/src/index.ts "$@"\n' "$REPO" > "$DEMO_BIN/cmx2"
chmod +x "$DEMO_BIN/cmx2"

cat > "$DEMO_WORK/src/parser.ts" <<'EOF'
export type Token = { kind: "num" | "plus"; text: string };

export function tokenize(src: string): Token[] {
  return [...src.matchAll(/\d+|\+/g)].map((m) => ({ kind: m[0] === "+" ? "plus" : "num", text: m[0] }));
}

export function parse(src: string): number {
  return tokenize(src).reduce((sum, t) => (t.kind === "num" ? sum + Number(t.text) : sum), 0);
}
EOF
cat > "$DEMO_WORK/test/parser.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { parse } from "../src/parser.ts";

test("numbers", () => expect(parse("42")).toBe(42));
test("sums", () => expect(parse("1 + 2")).toBe(3));
EOF
git -C "$DEMO_WORK" init -q 2>/dev/null

cat > "$DEMO_ROOT/config/cmx2.jsonc" <<EOF
{
  "model": "anthropic/claude-opus-5-5",
  "server": { "port": $DAEMON_PORT },
  "providers": { "anthropic": { "baseUrl": "http://127.0.0.1:$MODEL_PORT", "apiKey": "demo" } }
}
EOF

# a clean environment: only the paths the daemon needs. the tape execs a shell with exactly these.
export DEMO_HOME="$DEMO_ROOT/home" DEMO_CONFIG="$DEMO_ROOT/config" DEMO_DATA="$DEMO_ROOT/data" DEMO_BIN DEMO_WORK
DEMO_ENV="HOME=$DEMO_HOME PATH=$DEMO_BIN:$PATH LANG=en_US.UTF-8 CMX2_CONFIG_DIR=$DEMO_CONFIG CMX2_DATA_DIR=$DEMO_DATA"

bun "$REPO/scripts/demo/model.ts" "$MODEL_PORT" > "$DEMO_ROOT/model.log" 2>&1 &
MODEL_PID=$!
env -i $DEMO_ENV bun "$REPO/packages/cli/src/index.ts" serve --port "$DAEMON_PORT" --hostname 127.0.0.1 > "$DEMO_ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!

demo_stop() {
  kill "$MODEL_PID" "$DAEMON_PID" 2>/dev/null || true
  wait "$MODEL_PID" "$DAEMON_PID" 2>/dev/null || true
}
trap demo_stop EXIT INT TERM

i=0
until curl -fs "http://127.0.0.1:$DAEMON_PORT/global/health" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "the daemon did not come up; see $DEMO_ROOT/daemon.log" >&2; exit 1; fi
  sleep 0.2
done
