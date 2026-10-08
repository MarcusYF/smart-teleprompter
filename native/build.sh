#!/bin/bash
# Builds the on-device recognizer helper (needs Xcode or the Command Line Tools, macOS 26+).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -swift-version 5 -parse-as-library tp-asr.swift -o build/tp-asr \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force --sign - build/tp-asr >/dev/null 2>&1 || true
echo "built native/build/tp-asr"
