#!/usr/bin/env bash
# Put a project's app on this server for App preview (docs/app-preview.md).
#
#   scripts/app-preview-export.sh <project id> <app checkout> [export command]
#
# Exports the Expo app at <app checkout> for the web with the base path /a/<project id>, then swaps it into
# <data>/app-previews/<project id>/ in one step, so people never see half an export. The default export command is
# `npx expo export --platform web`; pass your own (for example `npm run export:web:pages`) when the app has one.
# The export command must write to dist/ or dist/pages/ (or set APP_PREVIEW_OUT to where it writes) and read the
# base path from EXPO_BASE_URL. The same path is also set as IRS2GO_PAGES_BASE_PATH for apps that read that name.
set -euo pipefail
pid="${1:-}"; app="${2:-}"; shift 2 || true
cmd="${*:-npx expo export --platform web --output-dir dist}"
if ! [[ "$pid" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || [ ! -d "$app" ]; then
  echo "Usage: scripts/app-preview-export.sh <project id> <app checkout> [export command]" >&2; exit 2
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
data="${SERVANT_DATA_DIR:-$here/server/data}"
base="/a/$pid"
cd "$app"
echo "Exporting $app for $base ..."
EXPO_BASE_URL="$base" IRS2GO_PAGES_BASE_PATH="$base" CI=1 EXPO_NO_TELEMETRY=1 bash -c "$cmd"
out="${APP_PREVIEW_OUT:-}"
if [ -z "$out" ]; then for d in dist/pages dist; do if [ -f "$d/index.html" ]; then out="$d"; break; fi; done; fi
if [ -z "$out" ] || [ ! -f "$out/index.html" ]; then echo "No export found (looked in dist/pages and dist). Set APP_PREVIEW_OUT." >&2; exit 1; fi
if ! grep -q "$base/" "$out/index.html"; then echo "The export doesn't use the base path $base: set experiments.baseUrl from EXPO_BASE_URL in the app's config." >&2; exit 1; fi
if [ ! -f "$out/deployment-environment.json" ]; then
  printf '{"commit":"%s","builtAt":"%s"}\n' "$(git rev-parse HEAD 2>/dev/null || true)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/deployment-environment.json"
fi
mkdir -p "$data/app-previews"
next="$data/app-previews/.next-$pid-$$"
rm -rf "$next"; cp -R "$out" "$next"
find "$next" -name '*.map' -delete
old="$data/app-previews/.old-$pid-$$"
[ -d "$data/app-previews/$pid" ] && mv "$data/app-previews/$pid" "$old"
mv "$next" "$data/app-previews/$pid"
rm -rf "$old"
echo "App preview for $pid: $(du -sh "$data/app-previews/$pid" | cut -f1), served at $base/"
