#!/bin/bash
# Run the agent (or any command) with no way out to the network except Servant's gate on localhost
# (server/egress.mjs, docs/agent-egress.md). Everything else the command could do before, it still can.
#
#   scripts/run-agent-sandboxed.sh /path/to/hermes/venv/bin/python scripts/run-hermes-servant.py --hermes-root /path/to/hermes
#
# SERVANT_EGRESS_PORT        the gate's port (default 8790; match "agentEgress.port" in config.json)
# SERVANT_SANDBOX_LOCAL_PORTS  other localhost ports the command may connect to, separated by spaces
#                              (none by default: not the Servant API, not other local services)
# SERVANT_SANDBOX_DENY_PATHS   files and folders the command may neither read nor write, separated by colons
#                              (the server's keys and databases; see docs/agent-egress.md). A database's
#                              -wal, -shm and -journal files are closed with it. Mac only.
# SERVANT_SANDBOX_ALLOW_PATHS  folders inside a closed one that stay open, separated by colons: close the server's
#                              whole data folder, then open only the folders the agent is handed files in. Mac only.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 command [arguments...]" >&2
  exit 2
fi

port="${SERVANT_EGRESS_PORT:-8790}"
case "$port" in ''|*[!0-9]*) echo "SERVANT_EGRESS_PORT must be a port number, got: $port" >&2; exit 2;; esac
proxy="http://127.0.0.1:${port}"
# The bridge reads this to give each person's commands their own token for the gate (server/hermes_egress.py).
export SERVANT_EGRESS_PORT="$port"

# Well-behaved tools read these; the sandbox below is what stops the ones that don't.
export HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" ALL_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy" all_proxy="$proxy"
export NO_PROXY="" no_proxy=""

case "$(uname -s)" in
  Darwin)
    if ! command -v sandbox-exec >/dev/null 2>&1; then
      echo "sandbox-exec was not found, so the agent would run with the whole network. Not starting." >&2
      exit 1
    fi
    extra=""
    for local_port in ${SERVANT_SANDBOX_LOCAL_PORTS:-}; do
      case "$local_port" in ''|*[!0-9]*) echo "SERVANT_SANDBOX_LOCAL_PORTS takes port numbers, got: $local_port" >&2; exit 2;; esac
      extra="${extra}(allow network-outbound (remote ip \"localhost:${local_port}\"))"
    done
    # Files the agent must not see even when someone's entitlements let it read files: the server's own keys and
    # databases. Each path is resolved first (the sandbox matches real paths, not links), and a path that doesn't
    # exist yet is still closed for when it does.
    # real_path NAME PATH: PATH with links resolved, or stop. The sandbox matches real paths, not links.
    real_path() {
      case "$2" in /*) ;; *) echo "$1 takes absolute paths, got: $2" >&2; exit 2;; esac
      case "$2" in *\"*|*\\*) echo "$1 can't hold a path with a quote or backslash: $2" >&2; exit 2;; esac
      parent="$(cd "$(dirname "$2")" 2>/dev/null && pwd -P)" || { echo "$1: the folder holding $2 doesn't exist. Not starting." >&2; exit 1; }
      real="${parent%/}/$(basename "$2")"
      if [ -d "$real" ]; then real="$(cd "$real" && pwd -P)"; fi
    }
    denied=""
    old_ifs="$IFS"; IFS=":"
    for deny in ${SERVANT_SANDBOX_DENY_PATHS:-}; do
      [ -n "$deny" ] || continue
      real_path SERVANT_SANDBOX_DENY_PATHS "$deny"
      denied="${denied}(deny file-read* file-write* (subpath \"${real}\") (literal \"${real}-wal\") (literal \"${real}-shm\") (literal \"${real}-journal\"))"
    done
    # Opened again after everything is closed: in the sandbox's rules the later one wins.
    for open_path in ${SERVANT_SANDBOX_ALLOW_PATHS:-}; do
      [ -n "$open_path" ] || continue
      real_path SERVANT_SANDBOX_ALLOW_PATHS "$open_path"
      denied="${denied}(allow file-read* file-write* (subpath \"${real}\"))"
    done
    IFS="$old_ifs"
    # Outbound: only the gate (and local sockets between the agent's own processes). Listening and answering is untouched.
    profile="(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote unix-socket))(allow network-outbound (remote ip \"localhost:${port}\"))${extra}${denied}"
    exec sandbox-exec -p "$profile" "$@"
    ;;
  Linux)
    if ! command -v systemd-run >/dev/null 2>&1; then
      echo "systemd-run was not found, so the agent would run with the whole network. Not starting. See docs/agent-egress.md for the unit settings." >&2
      exit 1
    fi
    if [ -n "${SERVANT_SANDBOX_DENY_PATHS:-}${SERVANT_SANDBOX_ALLOW_PATHS:-}" ]; then
      echo "SERVANT_SANDBOX_DENY_PATHS and SERVANT_SANDBOX_ALLOW_PATHS aren't supported by this wrapper on Linux. Put InaccessiblePaths= and BindPaths= in the agent's unit instead (docs/agent-egress.md). Not starting." >&2
      exit 1
    fi
    # systemd filters by address, not port: the command can reach localhost only. Keep other local services behind their own keys.
    exec systemd-run --user --scope --quiet -p IPAddressDeny=any -p IPAddressAllow=localhost "$@"
    ;;
  *)
    echo "No sandbox is set up for $(uname -s), so the agent would run with the whole network. Not starting." >&2
    exit 1
    ;;
esac
