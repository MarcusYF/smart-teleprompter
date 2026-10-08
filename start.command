#!/bin/bash
# Double-click to start the teleprompter in a Terminal window (server logs
# stay visible; close the window or press Ctrl+C to stop). Teleprompter.app
# does the same without a Terminal window.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-5217}"
URL="http://127.0.0.1:${PORT}/"
if ! curl -s -o /dev/null "${URL}api/health"; then
  node server/main.mjs &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  for i in $(seq 1 60); do curl -s -o /dev/null "${URL}api/health" && break; sleep 0.1; done
fi
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1280,860
else
  open "$URL"
fi
echo "Teleprompter at $URL (Ctrl+C to stop)."
wait
