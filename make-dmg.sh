#!/bin/zsh
# Builds drag-to-Applications DMG installers for all Mac architectures.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-0.4.2}"
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

  # 3. Create the final compressed DMG directly (no attach/detach — avoids
  #    "Resource temporarily unavailable" races on CI runners)
  DMG="$DMGDIR/MacScheduler-${VERSION}-${ARCH}.dmg"
  rm -f "$DMG"
  for attempt in 1 2 3; do
    if hdiutil create -volname "Mac Scheduler" -srcfolder "$STAGE" \
        -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null 2>&1; then
      break
    fi
    echo "  attempt $attempt failed, retrying…"
    sleep 3
  done
  if [ ! -f "$DMG" ]; then
    echo "!! Failed to create $DMG"
    exit 1
  fi
  echo "==> $DMG ($(du -h "$DMG" | cut -f1))"
done
echo "==> All DMGs:"; ls -la "$DMGDIR" | grep -E '\.dmg$'