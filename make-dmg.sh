#!/bin/zsh
# Builds drag-to-Applications DMG installers for all Mac architectures.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-1.0.0}"
ARCHS=("${@:2}")
[ ${#ARCHS[@]} -eq 0 ] && ARCHS=(arm64 x86_64)
DMGDIR="$ROOT/dist"
mkdir -p "$DMGDIR"

for ARCH in "${ARCHS[@]}"; do
  echo "==> Building DMG for $ARCH"

  # 1. Build the app for this arch
  APP_PATH=$("$ROOT/build-native.sh" "$VERSION" "$ARCH" | tail -1)
  APP_NAME="$(basename "$APP_PATH")"

  # 2. Stage folder with .app + Applications symlink
  STAGE="/tmp/dmg_stage_${ARCH}"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP_PATH" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"

  # 3. Build a pretty DMG (background + icon layout)
  DMG="$DMGDIR/MacScheduler-${VERSION}-${ARCH}.dmg"
  rm -f "$DMG" "$DMG.tmp"
  TMPDMG="$DMGDIR/.${VERSION}-${ARCH}.tmp.dmg"

  # Create writable staging image, mount, unmount (format flags only)
  hdiutil create -volname "Mac Scheduler" -srcfolder "$STAGE" -ov -format UDRW "$TMPDMG" >/dev/null
  MOUNT=$(hdiutil attach "$TMPDMG" -nobrowse | sed -n 's/.*\(\/Volumes\/.*\)$/\1/p' | head -1)
  sleep 1
  hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
  sync
  sleep 1

  # 4. Compress to final read-only DMG (retry if a transient lock)
  for attempt in 1 2 3; do
    hdiutil convert "$TMPDMG" -format UDZO -o "$DMG" >/dev/null 2>>"$DMG.err" && break
    echo "  convert attempt $attempt failed, retrying…"
    sleep 2
  done
  rm -f "$TMPDMG" "$DMG.err"
  echo "==> $DMG ($(du -h "$DMG" 2>/dev/null | cut -f1))"
done
echo "==> All DMGs:"; ls -la "$DMGDIR" | grep -E '\.dmg$'