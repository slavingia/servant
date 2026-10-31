#!/usr/bin/env bash
# Install beside supervisor.mjs in the stable runtime/bootstrap directory.
set -euo pipefail
: "${SERVANT_RUNTIME_DIR:?Set SERVANT_RUNTIME_DIR to the absolute runtime directory}"
: "${SERVANT_DATA_DIR:?Set SERVANT_DATA_DIR to the absolute shared data directory}"
[[ "$SERVANT_RUNTIME_DIR" = /* && "$SERVANT_DATA_DIR" = /* ]] || { echo 'Servant paths must be absolute' >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
exec "$NODE" "$HERE/supervisor.mjs"
