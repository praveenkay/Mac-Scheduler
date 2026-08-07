#!/bin/zsh
# Mac Scheduler — one-line installer via curl.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/praveenkay/Mac-Scheduler/main/install/uninstall.sh -o /dev/null
#   curl -fsSL .../install/install.sh | zsh
#   curl -fsSL https://github.com/praveenkay/Mac-Scheduler/releases/latest/download/... -L
#
# Detects architecture, downloads the matching DMG, mounts it, copies the app
# to /Applications, then installs keep-alive + requests permissions.
set -e

VERSION="${MAC_SCHEDULER_VERSION:-1.0.0}"
REPO="praveenkay/Mac-Scheduler"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || [ "$ARCH" = "x86_64" ] || ARCH="universal"

echo "==> Mac Scheduler installer v$VERSION ($ARCH)"

# Resolve the DMG release URL
if [ -n "${MAC_SCHEDULER_URL:-}" ]; then
  DMG_URL="$MAC_SCHEDULER_URL"
else
  DMG_URL="https://github.com/$REPO/releases/download/v$VERSION/MacScheduler-$VERSION-$ARCH.dmg"
fi

echo "==> Downloading: $DMG_URL"
TMP_DMG="$(mktemp -t macscheduler).dmg"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$DMG_URL" -o "$TMP_DMG"
else
  echo "!! curl not found. Download $DMG_URL and open the .dmg manually."
  exit 1
fi

echo "==> Mounting DMG"
MOUNT=$(hdiutil attach "$TMP_DMG" -nobrowse | sed -n 's/.*\(\/Volumes\/.*\)$/\1/p' | head -1)

echo "==> Copying app to /Applications"
rm -rf "/Applications/Mac Scheduler.app"
cp -R "$MOUNT/Mac Scheduler.app" /Applications/
ln -sf /Applications /Applications/Applications 2>/dev/null || true

hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
rm -f "$TMP_DMG"

echo "==> Registering app & URL scheme"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Mac Scheduler.app"

echo "==> Removing quarantine (unsigned app)"
xattr -dr com.apple.quarantine "/Applications/Mac Scheduler.app" 2>/dev/null || true

echo "==> Granting permissions + enabling keep-alive"
SCRIPT="$HOME/.macscheduler-installer.sh"
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/install/install-permissions.sh" -o "$SCRIPT" 2>/dev/null \
  || SCRIPT="/Applications/Mac Scheduler.app/Contents/Resources/macscheduler-install-permissions.sh" 2>/dev/null
if [ -f "$SCRIPT" ]; then
  zsh "$SCRIPT" on || true
fi

echo
echo "==> ✅ Mac Scheduler installed & running."
echo "    ➜  open -a 'Mac Scheduler'"
echo "    ➜  http://127.0.0.1:8742"