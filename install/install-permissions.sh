#!/bin/zsh
# Mac Scheduler — permissions & always-running setup
#
# 1. Registers a per-user LaunchAgent so Mac Scheduler's web server keeps
#    running in the background even after you close its window.
# 2. Grants the Full Disk Access hint (TCC prompt) so the app can read
#    ~/Library/LaunchAgents, /Library/Launch*, and cron tables.
#
# Usage:  ./install-permissions.sh [on|off]
set -e
MODE="${1:-on}"
LABEL="com.praveenkay.macscheduler.keepalive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_PATH="/Applications/Mac Scheduler.app"

if [ "$MODE" = "off" ]; then
  echo "==> Removing keep-alive agent and reloading launchd"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Done."
  exit 0
fi

echo "==> Installing keep-alive LaunchAgent"
if [ ! -d "$APP_PATH" ]; then
  echo "!! Warning: $APP_PATH not found. LaunchAgent will still be written."
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec /usr/local/bin/node "/Applications/Mac Scheduler.app/Contents/Resources/server.js"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/tmp/macscheduler-keepalive.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/macscheduler-keepalive.log</string>
</dict>
</plist>
PLISTEOF

# pick whichever node exists
NODE=$(command -v node || echo "/opt/homebrew/bin/node")
if [ -f "$PLIST" ]; then
  sed -i '' "s|/usr/local/bin/node|$NODE|" "$PLIST"
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl load "$PLIST"
echo "==> Keep-alive agent installed & loaded: $LABEL"
echo "    Server logs: /tmp/macscheduler-keepalive.log"

echo
echo "==> Requesting Full Disk Access (so the app can read launchd/cron files)"
echo "    If a System Settings prompt appears, enable 'Mac Scheduler' for"
echo "    'Files and Folders' → 'Full Disk Access'."
open -a "Mac Scheduler" 2>/dev/null || true

echo
echo "==> Done."
echo "    The app is now a running background service."
echo "    Open the UI any time at  http://127.0.0.1:8742  or run:"
echo "        open -a 'Mac Scheduler'"