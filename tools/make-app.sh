#!/bin/bash
# Builds 智能提词器.app (native window: editing + floating presenter mode over
# Keynote/PowerPoint) and installs it into /Applications (or ~/Applications).
# Portable Apple Silicon / macOS 26+ bundle. No source checkout or Node install
# is needed at runtime. Never package the developer's data/ directory.
set -euo pipefail
# --output APP / --archive ZIP build without replacing an install.
OUTPUT=""
FORMAT="app"
if [ "${1:-}" = "--output" ] || [ "${1:-}" = "--archive" ]; then
  [ -n "${2:-}" ] && [ "$#" -eq 2 ] || { echo "usage: $0 [--output App.app | --archive App.zip]"; exit 2; }
  [ "$1" != "--archive" ] || FORMAT="zip"
  OUTPUT="$2"
  [ ! -e "$OUTPUT" ] || { echo "output already exists: $OUTPUT"; exit 2; }
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--output App.app | --archive App.zip]"; exit 2
fi
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="arm64"
NAME="智能提词器"
VERSION="$(node -p 'require(process.argv[1]).version' "$PROJ/package.json")"
BUILD="$(node -p 'require(process.argv[1]).buildNumber' "$PROJ/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$BUILD" =~ ^[0-9]+$ ]] || { echo "invalid package version/buildNumber"; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -target "$ARCH-apple-macos26.0" -swift-version 5 -parse-as-library -module-cache-path "$WORK/swift-cache" -o "$APP/Contents/MacOS/Teleprompter" "$PROJ/native/shell/TeleprompterShell.swift"
[ -x "$APP/Contents/MacOS/Teleprompter" ] || { echo "build failed"; exit 1; }

# Package only runtime sources, with the recognizer compiled for the same OS.
RUNTIME="$APP/Contents/Resources/app"
mkdir -p "$RUNTIME/native/build" "$APP/Contents/Resources/licenses"
node -e 'const fs=require("node:fs"); for(const d of ["public","server"]) fs.cpSync(process.argv[1]+"/"+d,process.argv[2]+"/"+d,{recursive:true});' "$PROJ" "$RUNTIME"
cp "$PROJ/package.json" "$RUNTIME/package.json"
swiftc -O -target "$ARCH-apple-macos26.0" -swift-version 5 -parse-as-library -module-cache-path "$WORK/swift-cache" \
  "$PROJ/native/tp-asr.swift" -o "$RUNTIME/native/build/tp-asr" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PROJ/native/Info.plist"
NODE_DIST="$(bash "$PROJ/tools/fetch-node.sh")"
cp "$NODE_DIST/bin/node" "$APP/Contents/MacOS/node"
cp "$NODE_DIST/LICENSE" "$APP/Contents/Resources/licenses/Node-LICENSE.txt"
cp "$PROJ/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/licenses/THIRD_PARTY_NOTICES.md"
cp "$PROJ/LICENSE" "$APP/Contents/Resources/licenses/Project-LICENSE.txt"
chmod 755 "$APP/Contents/MacOS/node"
codesign --force --sign - "$APP/Contents/MacOS/node"
codesign --force --sign - "$RUNTIME/native/build/tp-asr"

# icon
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$PROJ/tools/icon/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$PROJ/tools/icon/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Teleprompter</string>
  <key>CFBundleIdentifier</key><string>local.claude-jev.teleprompter</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>提词器在本机识别语音来跟随讲稿；启用 Jev 智能辅助时，会发送少量讲稿和识别文字进行判断。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>提词器在本机识别你的语音来跟随讲稿。</string>
  <key>NSAppleEventsUsageDescription</key><string>提词器读取 Keynote 或 PowerPoint 的当前页，用于幻灯片联动。</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>local.claude-jev.teleprompter</string>
    <key>CFBundleURLSchemes</key><array><string>tp-shell</string></array>
  </dict></array>
</dict>
</plist>
PLIST

# Generated bundles may inherit Finder metadata from a file-provider folder.
# Strip it before signing and verify again after copying to the final location.
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

verify_copy() {
  # File providers can add an empty FinderInfo attribute on a new .app root.
  if xattr -p com.apple.FinderInfo "$1" >/dev/null 2>&1; then
    xattr -d com.apple.FinderInfo "$1"
  fi
  codesign --verify --deep --strict "$1"
}

if [ -n "$OUTPUT" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
  if [ "$FORMAT" = "zip" ]; then
    # A zip avoids Finder attributes being reattached to .app directories in
    # synced Desktop folders. Verify the exact archive after extraction.
    ditto --noextattr --norsrc -c -k --keepParent "$APP" "$OUTPUT"
    mkdir "$WORK/verify"
    ditto --noextattr -x -k "$OUTPUT" "$WORK/verify"
    codesign --verify --deep --strict "$WORK/verify/$NAME.app"
  else
    ditto --noextattr "$APP" "$OUTPUT"
    verify_copy "$OUTPUT"
  fi
  echo "built $OUTPUT"
  exit 0
fi

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
# stop a running copy and its server (a plain signal: an AppleScript "quit"
# would ask the user for automation permission after every rebuild)
if pgrep -x Teleprompter >/dev/null; then
  pkill -x Teleprompter || true
  for i in $(seq 1 50); do pgrep -x Teleprompter >/dev/null || break; sleep 0.1; done
fi
pkill -f "server/main.mjs --idle-exit" 2>/dev/null || true
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:5217/api/health || break; sleep 0.1; done
rm -rf "$DEST/$NAME.app"
ditto --noextattr "$APP" "$DEST/$NAME.app"
verify_copy "$DEST/$NAME.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST/$NAME.app" >/dev/null 2>&1 || true
rm -rf "$WORK"
echo "installed $DEST/$NAME.app"
