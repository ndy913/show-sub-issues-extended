#!/usr/bin/env bash
# Builds dist/show-sub-issues-extended.zip, the package attached to each GitHub release: only the
# files the extension needs (no README or demo GIF). Unzipped, it loads as an unpacked extension.
# Refuses to build while one of these files has uncommitted changes, so that a release zip always
# matches a commit.
set -euo pipefail

cd "$(dirname "$0")/.."
files=(manifest.json content.js content.css bridge.js options.js popup.html popup.js
  icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png)
# An assignment keeps git's exit code, so set -e stops here outside a git repo.
changes=$(git status --porcelain -- "${files[@]}")
if [ -n "$changes" ]; then
  echo "Uncommitted changes in packaged files, commit first:" >&2
  echo "$changes" >&2
  exit 1
fi

out="dist/show-sub-issues-extended.zip"
mkdir -p dist
rm -f "$out"
zip -q -X "$out" "${files[@]}"
echo "$out ($(du -h "$out" | cut -f1)), version $(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)"
