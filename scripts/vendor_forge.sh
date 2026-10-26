#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/vendor/forge-film"
REF="f67f0a003"
if [ -f "$TARGET/forge/scheduler/scheduler.py" ]; then echo "Forge already installed";exit 0;fi
command -v git >/dev/null || { echo "git is required";exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone https://github.com/F-R-L/forge-film.git "$TMP/src"
git -C "$TMP/src" checkout "$REF"
mkdir -p "$TARGET"
cp -a "$TMP/src/." "$TARGET/"
rm -rf "$TARGET/.git"
test -f "$TARGET/LICENSE"
echo "Forge Film MIT code installed and pinned to $REF; commit vendor/forge-film to be independent."