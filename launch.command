#!/bin/zsh
# Mac Scheduler — launch script
# Starts the local server and opens the app in your default browser.
DIR="${0:A:h}"
PORT="${MAC_SCHEDULER_PORT:-8742}"
URL="http://127.0.0.1:${PORT}"

# If the server is already running, just open the browser.
if curl -s -o /dev/null -m 1 "$URL/api"; then
  open "$URL"
  echo "Mac Scheduler already running. Opened ${URL}"
else
  cd "$DIR"
  ( node server.js > /tmp/macscheduler.log 2>&1 & )
  # wait for it to come up
  for i in {1..25}; do
    if curl -s -o /dev/null -m 1 "$URL/api"; then
      open "$URL"
      echo "Mac Scheduler started. Opened $URL"
      echo "Log: /tmp/macscheduler.log"
      exit 0
    fi
    sleep 0.2
  done
  echo "Timed out. See /tmp/macscheduler.log"
  exit 1
fi