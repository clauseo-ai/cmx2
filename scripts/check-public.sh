#!/bin/sh
# fails when a file in the repo contains a string you want to keep out of it: your hostnames, usernames,
# proxy urls. the patterns are yours and never ship. give one extended regex in $CMX2_PRIVATE_PATTERN, or a
# file holding one in $CMX2_PRIVATE_PATTERN_FILE. with neither set the check skips and exits 0.
set -eu
pattern="${CMX2_PRIVATE_PATTERN:-}"
if [ -z "$pattern" ] && [ -n "${CMX2_PRIVATE_PATTERN_FILE:-}" ] && [ -f "$CMX2_PRIVATE_PATTERN_FILE" ]; then
  pattern="$(cat "$CMX2_PRIVATE_PATTERN_FILE")"
fi
[ -z "$pattern" ] && { echo "public check: no private patterns configured, skipping"; exit 0; }
if git ls-files --cached --others --exclude-standard | xargs grep -nE "$pattern" 2>/dev/null; then
  echo "public check: private strings found (above); remove them or move them to your profile"
  exit 1
fi
echo "public check: clean"
