#!/bin/bash
# Official pinned Node runtime, verified before extraction. Build-time only.
set -euo pipefail
VERSION=24.21.0
SHA256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057
if [ -n "${TELEPROMPTER_NODE_DIST:-}" ]; then
  DIST="$TELEPROMPTER_NODE_DIST"
  [ -x "$DIST/bin/node" ] && [ -f "$DIST/LICENSE" ] || { echo "Invalid TELEPROMPTER_NODE_DIST" >&2; exit 1; }
  [ "$("$DIST/bin/node" -p process.arch)" = arm64 ] || { echo "An arm64 Node distribution is required" >&2; exit 1; }
  [ "$("$DIST/bin/node" -v)" = "v$VERSION" ] || { echo "Node v$VERSION is required" >&2; exit 1; }
  echo "$DIST"
  exit 0
fi
CACHE="${TELEPROMPTER_BUILD_CACHE:-${TMPDIR:-/tmp}/smart-teleprompter-build}"
mkdir -p "$CACHE"
ARCHIVE="$CACHE/node-v$VERSION-darwin-arm64.tar.gz"
if [ ! -f "$ARCHIVE" ]; then
  curl --fail --location --retry 2 "https://nodejs.org/dist/v$VERSION/node-v$VERSION-darwin-arm64.tar.gz" -o "$ARCHIVE.partial"
  mv "$ARCHIVE.partial" "$ARCHIVE"
fi
ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[ "$ACTUAL" = "$SHA256" ] || { echo "Node archive checksum mismatch; remove $ARCHIVE and retry" >&2; exit 1; }
DIST="$CACHE/node-v$VERSION-darwin-arm64"
# Re-extract the verified archive rather than trust a previously modified binary.
tar -xzf "$ARCHIVE" -C "$CACHE"
echo "$DIST"
