#!/bin/bash
# Starts the teleprompter server if needed and opens it in a Chrome app
# window. Legacy source-checkout launcher; the standalone app embeds its server.
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-5217}"
URL="http://127.0.0.1:${PORT}/"
if ! curl -s -o /dev/null "${URL}api/health"; then
  mkdir -p data
  nohup node server/main.mjs --idle-exit "${IDLE_EXIT:-900}" >> data/server.log 2>&1 &
  for i in $(seq 1 60); do curl -s -o /dev/null "${URL}api/health" && break; sleep 0.1; done
fi
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1280,860
else
  open "$URL"
fi
