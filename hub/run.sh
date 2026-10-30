#!/usr/bin/env bash
# launchd entrypoint: hub + cloudflared quick tunnel, with discovery publishing.
# The quick tunnel URL changes on every start, so we publish the current URL to
# a secret GitHub gist (the discovery URL) that the app reads on launch.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/data"
LOG="$DATA/cloudflared.log"
PORT="${SERVANT_PORT:-8787}"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
CF="${CF:-/opt/homebrew/bin/cloudflared}"
mkdir -p "$DATA"

"$NODE" "$HERE/server.mjs" &
HUB_PID=$!

: > "$LOG"
"$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$LOG" 2>&1 &
CF_PID=$!

publish() {
  local url
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | tail -1)
  [ -n "$url" ] || return 1
  # Publish only once the address actually reaches the hub.
  curl -fsS -m 10 "$url/health" >/dev/null 2>&1 || return 1
  "$NODE" "$HERE/publish.mjs" "$url"
}

( for _ in $(seq 1 30); do sleep 2; publish && break; done
  while kill -0 "$CF_PID" 2>/dev/null; do sleep 120; publish >/dev/null || true; done ) &

trap 'kill $HUB_PID $CF_PID 2>/dev/null' EXIT
# Exit (and let launchd restart everything) if either side dies.
while kill -0 "$HUB_PID" 2>/dev/null && kill -0 "$CF_PID" 2>/dev/null; do sleep 5; done
