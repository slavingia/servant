#!/usr/bin/env bash
# Install or upgrade a Servant server on a Linux host with systemd.
#
#   sudo deploy/linux/install.sh --public-url https://servant.example.gov
#
# Run it again from a newer checkout to deploy that code: the API switches with
# no downtime (same supervisor as the Mac), the worker drains its current job
# and restarts on the new release. Data stays in /var/lib/servant/data.
#
# Options (all optional):
#   --public-url URL    Address phones use. Default https://<host IP>:8443
#   --domain NAME       Serve https://NAME on 443 with an automatic certificate
#                       (Let's Encrypt; needs public DNS + ports 80/443 open)
#   --https-port N      Port for the default self-signed HTTPS listener (8443)
#   --proxy caddy|none  TLS front door. "none" if your load balancer terminates
#                       TLS and forwards to 127.0.0.1:8787 (set X-Forwarded-For)
#   --tunnel            Also run a Cloudflare quick tunnel (needs cloudflared)
#   --name NAME         Server name shown in the app (first install only)
#   --owner-url URL --owner-key KEY
#                       Hermes API server for the agent (first install only)
#   --node PATH         Use this Node 22.13+ instead of installing one
set -euo pipefail

die() { echo "servant install: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[[ "$(uname -s)" == Linux ]] || die "this installer is for Linux; the Mac uses launchd (docs/deployment.md)"
[[ $EUID -eq 0 ]] || die "run as root (sudo)"
command -v systemctl >/dev/null || die "systemd is required"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$REPO/server/server.mjs" ]] || die "run from a Servant checkout"

PUBLIC_URL="" DOMAIN="" HTTPS_PORT=8443 PROXY=caddy TUNNEL=0 NAME="Servant" OWNER_URL="" OWNER_KEY="" NODE_BIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --tunnel) TUNNEL=1; shift ;;
    --name) NAME="$2"; shift 2 ;;
    --owner-url) OWNER_URL="$2"; shift 2 ;;
    --owner-key) OWNER_KEY="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    -h|--help) sed -n 2,26p "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$PROXY" == caddy || "$PROXY" == none ]] || die "--proxy must be caddy or none"
[[ "$HTTPS_PORT" =~ ^[0-9]+$ ]] || die "--https-port must be a number"

ROOT=/var/lib/servant
RUNTIME=$ROOT/runtime
DATA=$ROOT/data
ETC=/etc/servant
NODE_DIR=/opt/servant/node
NODE_VERSION=22.21.1

# ---------- Node 22.13+ (node:sqlite, built-in WebSocket) ----------
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
if [[ -z "$NODE_BIN" ]]; then
  if [[ -x $NODE_DIR/bin/node ]] && node_ok $NODE_DIR/bin/node; then NODE_BIN=$NODE_DIR/bin/node
  elif command -v node >/dev/null && node_ok "$(command -v node)"; then NODE_BIN="$(command -v node)"
  else
    case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
    say "Installing Node $NODE_VERSION to $NODE_DIR"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    BASE="https://nodejs.org/dist/v$NODE_VERSION"
    FILE="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
    curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node download failed its checksum"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
    tar -xJf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
    NODE_BIN=$NODE_DIR/bin/node
  fi
fi
node_ok "$NODE_BIN" || die "$NODE_BIN is older than Node 22.13"
say "Node $("$NODE_BIN" -v) at $NODE_BIN"

# ---------- service account and private directories ----------
if ! id servant >/dev/null 2>&1; then
  say "Creating the servant system user"
  useradd --system --home-dir $ROOT --shell /usr/sbin/nologin --user-group servant
fi
install -d -m 0755 $ROOT
chown servant:servant $ROOT
install -d -o servant -g servant -m 0700 $RUNTIME $RUNTIME/bootstrap $RUNTIME/logs $DATA
install -d -o root -g servant -m 0750 $ETC
as_servant() { runuser -u servant -- env HOME=$ROOT SERVANT_RUNTIME_DIR=$RUNTIME SERVANT_DATA_DIR=$DATA "$@"; }

# ---------- bootstrap (supervisor, deploy CLI, tunnel) ----------
BOOT_FILES=(supervisor.mjs deploy.mjs tunnel.mjs publish.mjs relay.mjs relay-client.mjs relay-protocol.mjs
  run-supervisor.sh run-worker.sh run-tunnel.sh)
BOOT_CHANGED=0
for f in "${BOOT_FILES[@]}"; do
  if ! cmp -s "$REPO/server/$f" "$RUNTIME/bootstrap/$f"; then BOOT_CHANGED=1; fi
done
if [[ $BOOT_CHANGED == 1 ]]; then
  say "Updating bootstrap in $RUNTIME/bootstrap"
  for f in "${BOOT_FILES[@]}"; do install -o servant -g servant -m 0500 "$REPO/server/$f" "$RUNTIME/bootstrap/$f"; done
fi

# ---------- stage this checkout as an immutable release ----------
# SERVANT_REVISION names copies without .git (a tarball or CI artifact).
SHA="${SERVANT_REVISION:-$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo local)}"
[[ "$SHA" =~ ^[A-Za-z0-9._-]+$ ]] || die "SERVANT_REVISION may use letters, digits, . _ -"
[[ -z "$(git -C "$REPO" status --porcelain -- server 2>/dev/null)" ]] || SHA="$SHA-dirty"
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-linux-$SHA"
STAGE_SRC="$(mktemp -d)"; chmod 755 "$STAGE_SRC"
cp "$REPO"/server/*.mjs "$REPO/server/package.json" "$STAGE_SRC/"; chmod 644 "$STAGE_SRC"/*
say "Staging release $RELEASE"
as_servant "$NODE_BIN" $RUNTIME/bootstrap/deploy.mjs stage --source "$STAGE_SRC" --id "$RELEASE" >/dev/null
rm -rf "$STAGE_SRC"

# ---------- public address and config.json (first install only) ----------
if [[ -z "$PUBLIC_URL" ]]; then
  if [[ -n "$DOMAIN" ]]; then PUBLIC_URL="https://$DOMAIN"
  else PUBLIC_URL="https://$(hostname -I | awk '{print $1}'):$HTTPS_PORT"; fi
fi
if [[ ! -f $DATA/config.json ]]; then
  say "Writing $DATA/config.json"
  as_servant "$NODE_BIN" -e '
    const [file, name, publicUrl, ownerUrl, ownerKey] = process.argv.slice(1);
    const cfg = { name, agentName: "Agent", publicUrl, discovery: "off", discoveryUrl: "" };
    if (ownerUrl) cfg.upstreams = { owner: { url: ownerUrl, key: ownerKey }, member: { url: ownerUrl, key: ownerKey } };
    require("fs").writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' $DATA/config.json "$NAME" "$PUBLIC_URL" "$OWNER_URL" "$OWNER_KEY"
fi

# ---------- environment files read by the units ----------
write_env() { # file, contents (only rewritten when it changes)
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$2" > "$tmp"
  if ! cmp -s "$tmp" "$1"; then install -o root -g servant -m 0640 "$tmp" "$1"; fi
  rm -f "$tmp"
}
write_env $ETC/servant.env "# Shared by every Servant service. Managed by deploy/linux/install.sh.
NODE=$NODE_BIN
HOME=$ROOT
SERVANT_RUNTIME_DIR=$RUNTIME
SERVANT_DATA_DIR=$DATA
SERVANT_PORT=8787
SERVANT_PUSH_CONFIG=$ETC/push.json
CF=$(command -v cloudflared || echo cloudflared)"
FIRST_INSTALL=0
[[ -f $RUNTIME/deployment.json ]] || FIRST_INSTALL=1
[[ $FIRST_INSTALL == 0 ]] || write_env $ETC/supervisor.env "SERVANT_INITIAL_RELEASE=$RELEASE"
[[ -f $ETC/supervisor.env ]] || write_env $ETC/supervisor.env "SERVANT_INITIAL_RELEASE=$RELEASE"
write_env $ETC/worker.env "SERVANT_WORKER_RELEASE=$RELEASE"

# ---------- systemd units ----------
UNITS_CHANGED=0
for u in "$REPO"/deploy/linux/systemd/*.service; do
  dest=/etc/systemd/system/$(basename "$u")
  if ! cmp -s "$u" "$dest"; then install -m 0644 "$u" "$dest"; UNITS_CHANGED=1; fi
done
[[ $UNITS_CHANGED == 0 ]] || systemctl daemon-reload

# ---------- admin command ----------
install -m 0755 "$REPO/deploy/linux/servant" /usr/local/bin/servant

# ---------- start or upgrade ----------
if systemctl is-active --quiet servant-supervisor && [[ $BOOT_CHANGED == 0 ]]; then
  say "Deploying $RELEASE to the running API (no downtime)"
  as_servant "$NODE_BIN" $RUNTIME/bootstrap/deploy.mjs deploy --release "$RELEASE" >/dev/null
else
  [[ $FIRST_INSTALL == 1 ]] || say "Bootstrap changed: restarting the supervisor (a few seconds offline)"
  systemctl enable --quiet servant-supervisor
  systemctl restart servant-supervisor
  # A restart keeps deployment.json's selection; move it to this release.
  for _ in $(seq 60); do curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1 && break; sleep 1; done
  if ! curl -fsS http://127.0.0.1:8787/ready | grep -q "\"$RELEASE\""; then
    as_servant "$NODE_BIN" $RUNTIME/bootstrap/deploy.mjs deploy --release "$RELEASE" >/dev/null
  fi
fi
# The worker drains its current job on stop (SIGTERM), then starts on the new release.
systemctl enable --quiet servant-worker servant-feedback
systemctl restart servant-worker servant-feedback

if [[ $TUNNEL == 1 ]]; then
  command -v cloudflared >/dev/null || die "--tunnel needs cloudflared installed"
  systemctl enable --quiet servant-tunnel; systemctl restart servant-tunnel
fi

# ---------- TLS front door ----------
if [[ "$PROXY" == caddy ]]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy"
    if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
    elif command -v dnf >/dev/null; then dnf install -y -q caddy
    else die "install Caddy, or rerun with --proxy none behind your own TLS proxy"; fi
  fi
  if [[ -n "$DOMAIN" ]]; then SITE="$DOMAIN"; TLS=""
  else SITE="https://:$HTTPS_PORT"; TLS="tls internal {
		on_demand
	}"; fi
  CADDY="# Managed by Servant deploy/linux/install.sh
$SITE {
	$TLS
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787 {
		# Servant rate-limits pairing per client address.
		header_up Cf-Connecting-Ip {remote_host}
		# Agent replies and live events stream; never buffer them.
		flush_interval -1
		transport http {
			read_timeout 0
		}
	}
}"
  tmp="$(mktemp)"; printf '%s\n' "$CADDY" > "$tmp"
  if ! cmp -s "$tmp" /etc/caddy/Caddyfile; then
    caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>&1 || { cat "$tmp"; die "generated Caddyfile is invalid"; }
    install -m 0644 "$tmp" /etc/caddy/Caddyfile
    systemctl enable --quiet caddy; systemctl reload-or-restart caddy
  fi
  rm -f "$tmp"
fi

# ---------- check ----------
for _ in $(seq 30); do curl -fsS http://127.0.0.1:8787/ready 2>/dev/null | grep -q "\"$RELEASE\"" && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/ready | grep -q "\"$RELEASE\"" || die "API did not become ready on $RELEASE (journalctl -u servant-supervisor)"
say "Servant is running release $RELEASE"
echo "    Address:   $PUBLIC_URL"
echo "    Data:      $DATA"
echo "    Logs:      journalctl -u 'servant-*'   and $RUNTIME/logs/"
echo "    Invite:    sudo servant invite"
[[ -n "$DOMAIN" || "$PROXY" == none ]] || echo "    TLS:       self-signed (Caddy internal CA). Phones need a real certificate: use --domain, or your own proxy with --proxy none"
