#!/usr/bin/env bash
# API-only launchd entrypoint. The tunnel has its own independent service.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
exec "$NODE" "$HERE/server.mjs"
