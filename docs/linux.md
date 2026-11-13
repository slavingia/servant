# Running Servant on a Linux server

The same server that runs on the Mac runs on any Linux host with systemd: a
cloud VM (AWS EC2, Azure, GCP), an agency data-center box, or a local VM. One
script installs it and later upgrades it.

Tested on Ubuntu 24.04 (arm64) on 11/2/2026: the installer, an upgrade with no
downtime, a reboot, the full server test suite (205 of 205), and an end-to-end
run from another machine over HTTPS (pairing, #general, @agent in a channel,
and a private agent chat).

## What runs

| systemd unit | Mac (launchd) equivalent | Job |
| --- | --- | --- |
| `servant-supervisor` | `com.example.servant.supervisor` | Stable ingress on `127.0.0.1:8787`, API releases behind it |
| `servant-worker` | `com.example.servant.worker` | Channel @agent jobs and notifications |
| `servant-feedback` | `com.example.servant.feedback` | Feedback queue |
| `servant-tunnel` (optional) | `com.example.servant.tunnel` | Cloudflare quick tunnel, for hosts with no public address |
| `caddy` | none | HTTPS on the public port, forwarding to 8787 |

Everything runs as the `servant` system user with no shell. Code lives in
`/var/lib/servant/runtime` (immutable releases, the same layout as the Mac), data
in `/var/lib/servant/data`, and settings in `/etc/servant/*.env`. The units are
sandboxed: no write access outside `/var/lib/servant`, no home directories, no
privilege escalation.

## Install

On the server, from a checkout of this repository:

```sh
sudo deploy/linux/install.sh --domain servant.example.gov \
  --owner-url http://127.0.0.1:8642 --owner-key <Hermes API key>
```

The installer:

- Installs Node 22 to `/opt/servant/node` if the system Node is older than 22.13. Ubuntu 24.04 ships Node 18, which is too old. The download is checked against nodejs.org's SHA-256 list.
- Installs Caddy.
- Creates the user and directories.
- Stages this checkout as a release.
- Writes `config.json` (first install only).
- Starts the services.
- Waits until `/ready` reports the new release.

Options:

- `--domain NAME`: HTTPS on 443 with an automatic Let's Encrypt certificate. This needs public DNS and ports 80 and 443 open.
- With no `--domain`: HTTPS on 8443 with a self-signed certificate. This is for testing only, because phones won't trust it.
- `--proxy none`: an AWS ALB, an agency load balancer or nginx already terminates TLS. Point it at `127.0.0.1:8787` (or the host on 8787 with a firewall), and keep streaming responses unbuffered.
- `--public-url URL`: the address phones use, if it isn't the domain.
- `--tunnel`: also run a Cloudflare quick tunnel, like the Mac does. This needs `cloudflared`.

## Upgrade

Pull the new code and run the same command again. The API switches through the
supervisor with no downtime and accepted work finishes on the old release. The
worker gets SIGTERM, finishes its current job, and restarts on the new release.
Data is never touched. Roll back the API with `sudo servant rollback`.

## Day to day

```sh
sudo servant invite                  # team join link
sudo servant invite --name "Jordan Lee" --role owner
sudo servant devices | revoke <id>
sudo servant status                  # active and previous release
sudo servant logs                    # follow all Servant services
```

## The agent

Servant needs a Hermes API server for the agent (`upstreams` in
`/var/lib/servant/data/config.json`). On the Mac that is the owner's own Hermes.
On a server you have two options:

- Run Hermes on the same host and set `--owner-url http://127.0.0.1:<port>`.
- Point Servant at a Hermes on a private network address. Keep that traffic off the public internet; the key is a bearer secret.

Without an agent, messaging, channels and DMs still work, and agent chats answer
"The agent isn't set up on this server yet".

## Enterprise notes

- **TLS:** use `--domain` or the agency's load balancer and certificate. A self-signed certificate is only for testing.
- **Firewall:** open only 443 (and 80 for Let's Encrypt). 8787 and the API's private ports listen on loopback only.
- **Pairing rate limits** use the client address. Caddy passes the real address. Behind another proxy, set `Cf-Connecting-Ip` to the client address and strip any copy sent by the client.
- **Discovery:** it is off on Linux. A server with a fixed address doesn't need the GitHub gist, and invite links carry the address directly.
- **Backups:** back up `/var/lib/servant/data`, which holds the SQLite databases, WAL files and the transport key. Stop `servant-worker` and `servant-supervisor` for a consistent copy, or use SQLite's online backup. Losing `transport-key` means every phone must pair again.
- **Logs:** `/var/lib/servant/runtime/logs/` and `journalctl -u 'servant-*'`.
- **ATO:** the same review applies as on the Mac (see [ato-data-flows.md](ato-data-flows.md)).
