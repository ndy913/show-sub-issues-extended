#!/usr/bin/env bash
# Builds dist/show-sub-issues-extended.zip, the package attached to each GitHub release: only the
# files the extension needs (no README or demo GIF). Unzipped, it loads as an unpacked extension.
set -euo pipefail

cd "$(dirname "$0")/.."
out="dist/show-sub-issues-extended.zip"
mkdir -p dist
rm -f "$out"
zip -q -X "$out" manifest.json content.js content.css bridge.js options.js popup.html popup.js \
  icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png
echo "$out ($(du -h "$out" | cut -f1)), version $(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)"
