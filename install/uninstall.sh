#!/bin/zsh
# Mac Scheduler — uninstaller
# Removes the app, the keep-alive LaunchAgent, and stops the background server.
set -e

echo "==> Stopping background server"
pkill -f "Mac Scheduler.app/Contents/Resources/server.js" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.praveenkay.macscheduler.keepalive" 2>/dev/null || true

echo "==> Removing keep-alive agent"
rm -f "$HOME/Library/LaunchAgents/com.praveenkay.macscheduler.keepalive.plist"

echo "==> Removing app data (config, logs) — your scheduled tasks are kept"
rm -rf "$HOME/.config/macscheduler"
rm -f /tmp/macsched.log /tmp/macscheduler-keepalive.log

echo "==> Removing app"
rm -rf "/Applications/Mac Scheduler.app"

echo "==> Unregistering URL scheme"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "/Applications/Mac Scheduler.app" 2>/dev/null || true

echo "==> ✅ Mac Scheduler uninstalled. Your scheduled tasks (launchd plists + crontab) were left untouched."