#!/bin/zsh
# Builds a self-contained "Mac Scheduler.app" bundle from the web app.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$ROOT/native"
VERSION="${1:-0.4.2}"
ARCH="${2:-$(uname -m)}"
APP_NAME="Mac Scheduler.app"
STAGE="/tmp/macscheduler_build_${ARCH}"
APP="$STAGE/$APP_NAME"

echo "==> Building 'Mac Scheduler.app' ($ARCH) v$VERSION"

# Clean
rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchServices"

# 1. Compile the native shell binary
echo "==> Compiling native shell (Cocoa + WebKit)"
FLAG=()
if [ "$ARCH" = "x86_64" ] && [ "$(uname -m)" = "arm64" ]; then
  FLAG=("-target" "x86_64-apple-macosx12.0")
fi
if [ "$ARCH" = "arm64" ] && [ "$(uname -m)" = "x86_64" ]; then
  FLAG=("-target" "arm64-apple-macosx12.0")
fi
swiftc -O "${FLAG[@]}" "$NATIVE/main.swift" \
  -framework Cocoa -framework WebKit \
  -o "$APP/Contents/MacOS/MacScheduler" 2>&1 >&2
if [ ! -x "$APP/Contents/MacOS/MacScheduler" ]; then
  echo "!! Compile failed (${FLAG[*]:-host})"; exit 1
fi
echo "==> Binary arch: $(file -b "$APP/Contents/MacOS/MacScheduler" | sed 's/.*Mach-O 64-bit executable //')"

# 2. Info.plist
echo "==> Writing Info.plist"
sed -e "s|<string>0.4.2</string>|<string>$VERSION</string>|g" "$NATIVE/Info.plist" > "$APP/Contents/Info.plist"

# Use plutil to embed real version
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"

# 3. Bundle web app + server + install scripts into Resources
echo "==> Bundling web app + server + installers"
cp "$ROOT/server.js" "$APP/Contents/Resources/"
mkdir -p "$APP/Contents/Resources/public"
cp -R "$ROOT/public/." "$APP/Contents/Resources/public/"
mkdir -p "$APP/Contents/Resources/install"
cp "$ROOT/install/install-permissions.sh" "$APP/Contents/Resources/install/"
cp "$ROOT/install/uninstall.sh" "$APP/Contents/Resources/install/"

# 4. Icon (generate icns)
echo "==> Generating app icon"
ICONSET="/tmp/macs_icon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
python3 "$NATIVE/make_icon.py" "$ICONSET"
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET" 2>/dev/null

# 5. Sign ad-hoc (so Gatekeeper accepts it on this machine)
echo "==> Ad-hoc signing"
codesign --force --deep --sign - "$APP" 2>&1 | head -3

echo "==> Done: $APP"
echo "$APP"