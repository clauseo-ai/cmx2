#!/bin/sh
# installs the cmx2 binary for this machine from a github release, checked against its SHA256SUMS.
#
#   curl -fsSL https://raw.githubusercontent.com/clauseo-ai/cmx2/main/scripts/install.sh | sh
#
# CMX2_VERSION      a release like 0.1.0 (default: the latest)
# CMX2_INSTALL_DIR  where the binary goes (default: ~/.local/bin)
# CMX2_REPO         owner/name of the repository (default: REPO below)
# CMX2_INSTALL_BASE a url laid out like a release (cmx2-<os>-<arch> next to SHA256SUMS), for mirrors and tests
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'cmx2 install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "there is no cmx2 build for $(uname -s); darwin and linux only" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "there is no cmx2 build for $(uname -m); arm64 and x64 only" ;;
esac
# a shell under rosetta reports x86_64 on an arm mac; the native build is the one to run
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
asset="cmx2-$os-$arch"

# the repository this script ships in. a fork that still has a placeholder here refuses to run, so binaries
# never come from a guessed name.
REPO="clauseo-ai/cmx2"
repo="${CMX2_REPO:-$REPO}"
if [ -n "${CMX2_INSTALL_BASE:-}" ]; then
  base="${CMX2_INSTALL_BASE%/}"
elif case "$repo" in *"<"*) true ;; *) false ;; esac; then
  die "this copy of install.sh does not name a repository yet; set CMX2_REPO=owner/name (or CMX2_INSTALL_BASE)"
elif [ -n "${CMX2_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/v${CMX2_VERSION#v}"
else
  base="https://github.com/$repo/releases/latest/download"
fi
dir="${CMX2_INSTALL_DIR:-$HOME/.local/bin}"

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q -O "$2" "$1"; }
else
  die "needs curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "needs sha256sum or shasum to check the download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t cmx2)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset from $base"
get "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not fetch $base/SHA256SUMS; check the version and your network"
want="$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || die "SHA256SUMS has no line for $asset; that release has no build for this machine"
get "$base/$asset" "$tmp/cmx2" || die "could not fetch $base/$asset"
got="$(sum "$tmp/cmx2")"
[ "$got" = "$want" ] || die "$asset does not match its checksum (expected $want, got $got); nothing was installed"
chmod 755 "$tmp/cmx2"
version="$("$tmp/cmx2" --version 2>/dev/null)" || die "the downloaded binary does not run on this machine; nothing was installed"

mkdir -p "$dir"
mv -f "$tmp/cmx2" "$dir/cmx2"
say "installed cmx2 $version to $dir/cmx2 (sha256 ok)"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    # the line goes into a shell rc, so a dir under home is written as $HOME/...
    case "$dir" in "$HOME"/*) shown="\$HOME${dir#"$HOME"}" ;; *) shown="$dir" ;; esac
    say ""
    say "$dir is not on your PATH. add it, for zsh:"
    say "  echo 'export PATH=\"$shown:\$PATH\"' >> ~/.zshrc && export PATH=\"$dir:\$PATH\""
    say "or for bash, the same line into ~/.bashrc"
    ;;
esac
say ""
say "next:"
say "  export ANTHROPIC_API_KEY=...     # or configure a provider in ~/.config/cmx2/cmx2.jsonc"
say "  cmx2                             # the terminal client in the current directory"
