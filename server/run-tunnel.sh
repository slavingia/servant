#!/usr/bin/env bash
# Tunnel-only launchd entrypoint. API restarts must not restart this service.
set -euo pipefail
: "${SERVANT_DATA_DIR:?Set SERVANT_DATA_DIR to the absolute shared data directory}"
[[ "$SERVANT_DATA_DIR" = /* ]] || { echo 'SERVANT_DATA_DIR must be absolute' >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
exec "$NODE" "$HERE/tunnel.mjs"
