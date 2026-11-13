#!/usr/bin/env bash
# Install or upgrade a Servant server on this Mac (launchd), then sign the Mac
# app in as the owner. No phone and no QR code needed.
#
#   deploy/mac/install.sh
#
# Run it again from a newer checkout to deploy that code: the API switches with
# no downtime, and the worker finishes its current job, then restarts on the new
# release. Data stays where it is.
#
# Options (all optional):
#   --name NAME         Server name shown in the app (first install only)
#   --tunnel            Also run a Cloudflare quick tunnel so phones and other
#                       computers can reach this Mac (needs cloudflared)
#   --owner-url URL --owner-key KEY
#                       Hermes API server for the agent (first install only)
#   --port N            Local port (8787)
#   --runtime DIR       Runtime directory (~/.local/share/servant)
#   --data DIR          Data directory (kept from an existing install, else
#                       <runtime>/data)
#   --label PREFIX      launchd label prefix (kept from an existing install,
#                       else $SERVANT_BUNDLE_ID, else com.example.servant)
#   --node PATH         Use this Node 22.13+
#   --no-open           Print the sign-in link without opening the Mac app
set -euo pipefail

die() { echo "servant install: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[[ "$(uname -s)" == Darwin ]] || die "this installer is for macOS; Linux uses deploy/linux/install.sh"
[[ $EUID -ne 0 ]] || die "run as your own user, not with sudo"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$REPO/server/server.mjs" ]] || die "run from a Servant checkout"

NAME="Servant" TUNNEL=0 OWNER_URL="" OWNER_KEY="" PORT=8787 NODE_BIN="" OPEN=1
RUNTIME="$HOME/.local/share/servant" DATA="" LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --tunnel) TUNNEL=1; shift ;;
    --owner-url) OWNER_URL="$2"; shift 2 ;;
    --owner-key) OWNER_KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --no-open) OPEN=0; shift ;;
    -h|--help) sed -n 2,25p "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
# An upgrade keeps the label the last install wrote, so it replaces those jobs instead of adding a second set.
if [[ -z "$LABEL" && -f "$RUNTIME/servant.env" ]]; then
  LABEL="$(sed -n "s/^SERVANT_LABEL='\(.*\)'\$/\1/p" "$RUNTIME/servant.env" | head -n 1)"
fi
LABEL="${LABEL:-${SERVANT_BUNDLE_ID:-com.example.servant}}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ "$LABEL" =~ ^[A-Za-z0-9.-]+$ ]] || die "--label may use letters, digits, . and -"
[[ "$RUNTIME" = /* ]] || die "--runtime must be an absolute path"

AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
plist() { echo "$AGENTS/$LABEL.$1.plist"; }

# Keep the data directory of an existing install.
if [[ -z "$DATA" && -f "$(plist supervisor)" ]]; then
  DATA="$(plutil -extract EnvironmentVariables.SERVANT_DATA_DIR raw -o - "$(plist supervisor)" 2>/dev/null || true)"
fi
DATA="${DATA:-$RUNTIME/data}"
[[ "$DATA" = /* ]] || die "--data must be an absolute path"

# ---------- Node 22.13+ (node:sqlite, built-in WebSocket) ----------
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
if [[ -z "$NODE_BIN" ]]; then
  for n in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -n "$n" && -x "$n" ]] && node_ok "$n"; then NODE_BIN="$n"; break; fi
  done
fi
[[ -n "$NODE_BIN" ]] || die "Servant needs Node 22.13 or later. Install it (brew install node) and run this again"
node_ok "$NODE_BIN" || die "$NODE_BIN is older than Node 22.13"
say "Node $("$NODE_BIN" -v) at $NODE_BIN"

# A fresh install needs its port free. An existing install of this label owns it.
if ! launchctl print "gui/$(id -u)/$LABEL.supervisor" >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already in use by another program. Pick a free one with --port N"
fi

umask 077
mkdir -p "$RUNTIME/bootstrap" "$RUNTIME/logs" "$DATA" "$AGENTS"
chmod 700 "$RUNTIME" "$RUNTIME/bootstrap" "$RUNTIME/logs" "$DATA"
export SERVANT_RUNTIME_DIR="$RUNTIME" SERVANT_DATA_DIR="$DATA" SERVANT_PORT="$PORT"

# ---------- bootstrap (supervisor, deploy CLI, tunnel) ----------
BOOT_FILES=(supervisor.mjs deploy.mjs tunnel.mjs publish.mjs relay.mjs relay-client.mjs relay-protocol.mjs
  run-supervisor.sh run-worker.sh run-tunnel.sh)
BOOT_CHANGED=0
for f in "${BOOT_FILES[@]}"; do cmp -s "$REPO/server/$f" "$RUNTIME/bootstrap/$f" || BOOT_CHANGED=1; done
if [[ $BOOT_CHANGED == 1 ]]; then
  say "Updating bootstrap in $RUNTIME/bootstrap"
  for f in "${BOOT_FILES[@]}"; do install -m 0500 "$REPO/server/$f" "$RUNTIME/bootstrap/$f"; done
fi

# ---------- stage this checkout as an immutable release ----------
SHA="${SERVANT_REVISION:-$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo local)}"
[[ "$SHA" =~ ^[A-Za-z0-9._-]+$ ]] || die "SERVANT_REVISION may use letters, digits, . _ -"
[[ -z "$(git -C "$REPO" status --porcelain -- server 2>/dev/null)" ]] || SHA="$SHA-dirty"
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-mac-$SHA"
STAGE_SRC="$(mktemp -d)"
cp "$REPO"/server/*.mjs "$REPO/server/package.json" "$STAGE_SRC/"
say "Staging release $RELEASE"
"$NODE_BIN" "$RUNTIME/bootstrap/deploy.mjs" stage --source "$STAGE_SRC" --id "$RELEASE" >/dev/null
rm -rf "$STAGE_SRC"

# ---------- config.json (first install only) ----------
if [[ ! -f "$DATA/config.json" ]]; then
  say "Writing $DATA/config.json"
  # No public address until a tunnel publishes one; invites then point at this Mac.
  "$NODE_BIN" -e '
    const [file, name, ownerUrl, ownerKey, tunnel] = process.argv.slice(1);
    const cfg = { name, agentName: "Agent", publicUrl: "", discovery: tunnel === "1" ? "on" : "off", discoveryUrl: "" };
    if (ownerUrl) cfg.upstreams = { owner: { url: ownerUrl, key: ownerKey }, member: { url: ownerUrl, key: ownerKey } };
    require("fs").writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$DATA/config.json" "$NAME" "$OWNER_URL" "$OWNER_KEY" "$TUNNEL"
fi

# ---------- launch agents ----------
xml() { local s="${1//&/&amp;}"; s="${s//</&lt;}"; echo "${s//>/&gt;}"; }
agent() { # name, script, keepalive xml, exit timeout, extra env xml
  local file; file="$(plist "$1")"
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Servant deploy/mac/install.sh -->
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL.$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(xml "$RUNTIME/bootstrap/$2")</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$(xml "$HOME")</string>
    <key>PATH</key><string>$(xml "$(dirname "$NODE_BIN")"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE</key><string>$(xml "$NODE_BIN")</string>
    <key>SERVANT_RUNTIME_DIR</key><string>$(xml "$RUNTIME")</string>
    <key>SERVANT_DATA_DIR</key><string>$(xml "$DATA")</string>
    <key>SERVANT_PORT</key><string>$PORT</string>
$5
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>$3
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>$4</integer>
  <key>StandardOutPath</key><string>$(xml "$RUNTIME/logs/$1.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$RUNTIME/logs/$1.log")</string>
</dict></plist>
PLIST
  plutil -lint -s "$tmp" || die "generated $1 launch agent is invalid"
  if cmp -s "$tmp" "$file"; then rm -f "$tmp"; return 1; fi
  mv "$tmp" "$file"; chmod 600 "$file"; return 0
}
loaded() { launchctl print "$DOMAIN/$LABEL.$1" >/dev/null 2>&1; }
reload() { # bootout waits for the job to exit (up to its ExitTimeOut)
  if loaded "$1"; then launchctl bootout "$DOMAIN/$LABEL.$1" 2>/dev/null || true; fi
  launchctl bootstrap "$DOMAIN" "$(plist "$1")"
}
ready() { curl -fsS "http://127.0.0.1:$PORT/ready" 2>/dev/null; }

FIRST_INSTALL=0
[[ -f "$RUNTIME/deployment.json" ]] || FIRST_INSTALL=1
INITIAL="$RELEASE"
if [[ $FIRST_INSTALL == 0 && -f "$(plist supervisor)" ]]; then
  INITIAL="$(plutil -extract EnvironmentVariables.SERVANT_INITIAL_RELEASE raw -o - "$(plist supervisor)" 2>/dev/null || echo "$RELEASE")"
fi
SUP_CHANGED=0
agent supervisor run-supervisor.sh "<true/>" 310 "    <key>SERVANT_INITIAL_RELEASE</key><string>$INITIAL</string>" && SUP_CHANGED=1
if loaded supervisor && [[ $BOOT_CHANGED == 0 && $SUP_CHANGED == 0 ]]; then
  say "Deploying $RELEASE to the running API (no downtime)"
  "$NODE_BIN" "$RUNTIME/bootstrap/deploy.mjs" deploy --release "$RELEASE" >/dev/null
else
  [[ $FIRST_INSTALL == 1 ]] || say "Bootstrap changed: restarting the supervisor (a few seconds offline)"
  reload supervisor
  for _ in $(seq 60); do ready >/dev/null && break; sleep 1; done
  ready | grep -q "\"$RELEASE\"" || "$NODE_BIN" "$RUNTIME/bootstrap/deploy.mjs" deploy --release "$RELEASE" >/dev/null
fi

# The worker drains its current job on stop, then starts on the new release.
agent worker run-worker.sh "<dict><key>SuccessfulExit</key><false/></dict>" 310 "    <key>SERVANT_WORKER_RELEASE</key><string>$RELEASE</string>" || true
reload worker

if [[ $TUNNEL == 1 ]]; then
  CF_BIN="$(command -v cloudflared || true)"
  [[ -n "$CF_BIN" ]] || die "--tunnel needs cloudflared (brew install cloudflared)"
  agent tunnel run-tunnel.sh "<true/>" 30 "    <key>CF</key><string>$(xml "$CF_BIN")</string>" || loaded tunnel || true
  loaded tunnel && [[ $BOOT_CHANGED == 0 ]] || reload tunnel
fi

# ---------- admin command ----------
ENV_FILE="$RUNTIME/servant.env"
printf '%s\n' "# Managed by deploy/mac/install.sh" "NODE='$NODE_BIN'" "SERVANT_RUNTIME_DIR='$RUNTIME'" \
  "SERVANT_DATA_DIR='$DATA'" "SERVANT_PORT='$PORT'" "SERVANT_LABEL='$LABEL'" "SERVANT_REPO='$REPO'" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
BIN_DIR=/opt/homebrew/bin
[[ -w "$BIN_DIR" ]] || BIN_DIR=/usr/local/bin
[[ -w "$BIN_DIR" ]] || { BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; }
SERVANT_CMD="$BIN_DIR/servant"
if [[ "$RUNTIME" != "$HOME/.local/share/servant" ]]; then SERVANT_CMD="$RUNTIME/servant"; fi
sed "s|^ENV_FILE=.*|ENV_FILE='$ENV_FILE'|" "$REPO/deploy/mac/servant" > "$SERVANT_CMD.tmp"
chmod 755 "$SERVANT_CMD.tmp"; mv "$SERVANT_CMD.tmp" "$SERVANT_CMD"

# ---------- check ----------
for _ in $(seq 30); do ready | grep -q "\"$RELEASE\"" && break; sleep 1; done
ready | grep -q "\"$RELEASE\"" || die "API did not become ready on $RELEASE (see $RUNTIME/logs/supervisor.log)"
say "Servant is running release $RELEASE"
echo "    Data:      $DATA"
echo "    Logs:      $RUNTIME/logs/"
echo "    Command:   $SERVANT_CMD"

# ---------- sign this Mac in as the owner ----------
INVITE="$("$SERVANT_CMD" invite --owner --local)"
LINK="$(printf '%s\n' "$INVITE" | sed -n 's/^Link: *//p')"
echo
echo "Sign in on this Mac (works only here, single use):"
echo "    $LINK"
if [[ $OPEN == 1 && -d "/Applications/Servant.app" ]]; then
  open -a Servant "$LINK" && echo "    Opened the Servant app. If it shows the sign-in screen, choose Paste an invite link and paste the link above."
else
  echo "    Open the Servant Mac app, choose Paste an invite link, and paste the link above."
fi
echo
echo "Invite others with:   $SERVANT_CMD invite"
[[ $TUNNEL == 1 ]] || echo "Other devices need a public address first: run this again with --tunnel"
