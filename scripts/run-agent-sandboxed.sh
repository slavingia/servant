#!/bin/bash
# Run the agent (or any command) with no way out to the network except Servant's gate on localhost
# (server/egress.mjs, docs/agent-egress.md). Everything else the command could do before, it still can.
#
#   scripts/run-agent-sandboxed.sh /path/to/hermes/venv/bin/python scripts/run-hermes-servant.py --hermes-root /path/to/hermes
#
# SERVANT_EGRESS_PORT        the gate's port (default 8790; match "agentEgress.port" in config.json)
# SERVANT_SANDBOX_LOCAL_PORTS  other localhost ports the command may connect to, separated by spaces
#                              (none by default: not the Servant API, not other local services)
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
    # Outbound: only the gate (and local sockets between the agent's own processes). Listening and answering is untouched.
    profile="(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote unix-socket))(allow network-outbound (remote ip \"localhost:${port}\"))${extra}"
    exec sandbox-exec -p "$profile" "$@"
    ;;
  Linux)
    if ! command -v systemd-run >/dev/null 2>&1; then
      echo "systemd-run was not found, so the agent would run with the whole network. Not starting. See docs/agent-egress.md for the unit settings." >&2
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
