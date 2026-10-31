#!/usr/bin/env bash
# Install beside supervisor.mjs in runtime/bootstrap. API deployments never
# change this pinned worker release; upgrade it only after its current job ends.
set -euo pipefail
: "${SERVANT_RUNTIME_DIR:?Set SERVANT_RUNTIME_DIR to the absolute runtime directory}"
: "${SERVANT_DATA_DIR:?Set SERVANT_DATA_DIR to the absolute shared data directory}"
: "${SERVANT_WORKER_RELEASE:?Set SERVANT_WORKER_RELEASE to a staged release ID}"
[[ "$SERVANT_RUNTIME_DIR" = /* && "$SERVANT_DATA_DIR" = /* ]] || { echo 'Servant paths must be absolute' >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
"$NODE" --input-type=module - "$HERE/supervisor.mjs" "$SERVANT_RUNTIME_DIR" "$SERVANT_WORKER_RELEASE" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { verifyRelease } = await import(pathToFileURL(process.argv[2]));
const { directory, manifest } = verifyRelease(process.argv[3], process.argv[4]);
if (!manifest.files['worker.mjs']) throw new Error('Release has no worker.mjs');
fs.accessSync(path.join(directory, 'worker.mjs'), fs.constants.R_OK);
JS
exec "$NODE" "$SERVANT_RUNTIME_DIR/releases/$SERVANT_WORKER_RELEASE/worker.mjs"
