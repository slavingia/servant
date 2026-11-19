# Servant

Agents for public servants.

Servant gives a public-sector team an agent it can ask for help, on a server the team runs. It is a phone app, a Mac app and a small server that runs on a computer you control. The people you invite can ask the agent running on that computer for help from anywhere, in private agent chats or alongside colleagues in channels, direct messages and threads, without putting the conversation through a consumer chat service. Messages are encrypted from the app to your server inside HTTPS, and the server's private key never leaves your machine. There is no hosted Servant service in the message path: the only addresses the project maintains are the optional browser join page and the Mac download page, and `webUrl` and `downloads` in `config.json` point an instance at your own.

Servant is an independent open-source project and is not affiliated with any government agency.

**Status:** early software, released into the public domain under [CC0 1.0](LICENSE). Expect rough edges. The encryption protocol has not had an independent audit. Read [SECURITY.md](SECURITY.md) before you put real work through it, and note that organizations handling regulated data need their own security review before putting it through Servant.

| Agent chat with a photo | Approval before anything runs |
| --- | --- |
| ![Agent conversation with a whiteboard photo attached and a request typed](docs/readme/01-agent-photo-draft.jpg) | ![Approval card asking to save files to the Desktop, showing the exact command, with Deny and Allow once](docs/readme/03-agent-approval.jpg) |

More captures of channels, threads, direct messages and invites are in [docs/shots/](docs/shots/).

## Contents

- [Get the apps](#get-the-apps)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Self-hosting](#self-hosting)
- [Features](#features)
- [Security notes](#security-notes)
- [Build your own client (MCP)](#build-your-own-client-mcp)
- [Repository layout](#layout)
- [What's next](#whats-next)
- [Contributing, security and license](#contributing-security-and-license)

## Get the apps

You always run your own server (see [Quickstart](#quickstart)). For the apps, you can use the project's builds or make your own.

| Where | Today | Notes |
| --- | --- | --- |
| iPhone and iPad | [Public TestFlight beta](https://testflight.apple.com/join/6NWcgydj) | Install TestFlight, open the link, then paste an invite link from your server. |
| Android | Build it yourself | No public download yet. `cd app && npm ci && npx expo run:android` (step 2 below). |
| Mac | [Download page](https://servant-mac.web.app) | An unsigned preview: the page says how to open it. Or build it (step 3 below). |
| Browser | Run it yourself | `cd app && npm ci && npx expo start --web`. |

Two things to know about the project's phone builds:

- **Notifications do not reach them from your server.** Apple and Google deliver a notification only when it is sent with the keys of whoever published the app, and those keys are not shared. Messages still arrive while the app is open. For notifications, build the app under your own bundle id with your own keys ([Notifications](docs/notifications.md)).
- **They update themselves.** The project's builds load interface updates from the project's update server ([OTA updates](docs/ota.md)). Your messages never go there. A build you make yourself has updates off unless you set `SERVANT_OTA_URL`.

## Quickstart

You need a Mac or Linux computer, Node 22.13 or newer, and an agent that speaks the [Hermes](https://github.com/NousResearch/hermes-agent) API on `127.0.0.1:8642` (see [supported Hermes versions](docs/supported-hermes-versions.md)).

**1. Run the server.** It has no npm dependencies.

```sh
git clone https://github.com/slavingia/servant.git
cd servant/server
node server.mjs                     # starts on 127.0.0.1:8787; data goes to server/data/
node server.mjs invite --owner      # in a second terminal: a one-time sign-in link for you, the owner
node server.mjs invite              # a join link for your team
```

Server settings live in `server/data/config.json` (or `$SERVANT_DATA_DIR/config.json`); every key is optional. Until you give the server a public address (a [stable relay](docs/relay-transport.md) or a tunnel), invite links work only on the same computer.

**2. Build the phone app.** Use the download link your team provides, or build the Expo app in `app/` under your own bundle id and accounts.

```sh
cd app
npm ci
SERVANT_BUNDLE_ID=com.yourorg.servant npx expo run:ios      # or run:android, or eas build
```

`SERVANT_BUNDLE_ID` (default `com.example.servant`) sets the iOS bundle id and Android package; the share extension is `<id>.share`, and its app group `group.<id>`. Run the server with the same value so push notifications reach the app. `npx expo start --web` gives you a browser build for trying things out. See [app/AGENTS.md](app/AGENTS.md).

**3. Build the Mac app (optional).**

```sh
npm ci --prefix app && npm ci --prefix desktop
npm run dist:preview --prefix desktop     # unsigned preview build; see desktop/README.md for signing
```

Open the invite link, or in the Mac app choose **Paste an invite link**. On a phone, **You → Link a computer** scans and approves a Mac sign-in.

## How it works

```
 Phone (Servant app)
   │  pinned app-to-Mac encryption inside HTTPS
   ▼
 Relay (stable address, or legacy cloudflared tunnel)
   │
   ▼
 Server (server/, on the owner's Mac)        invites, device tokens, who can do what
   │  localhost only, server key never leaves the Mac
   ▼
 Agent (Hermes API server)             one conversation history per person
```

- **App** (`app/`): an Expo app for iOS, Android and the web. Build and distribute it under your own Apple and Google accounts (TestFlight, Firebase App Distribution or the stores).
- **Mac app** (`desktop/`): the same app packaged with Electron, with Keychain-backed storage. Phones approve its sign-in with **You → Link a computer**. See [desktop builds and distribution](desktop/README.md).
- **Server** (`server/`): a Node server with no dependencies. It pairs devices from one-time invites, issues a token for each device, keeps each person's conversations separate, and passes messages to the agent. The agent's API key stays on the server's machine.
- **Relay** (`relay/`): the optional [stable relay](docs/relay-transport.md), a Cloudflare Worker, gives the server a fixed address and forwards encrypted traffic over an outbound connection. It needs no gist or GitHub login. Legacy quick tunnels remain supported.
- **MCP** (`mcp/`): an MCP server and client library so other tools can sign in like the Mac app. See [MCP](docs/mcp.md).

## Self-hosting

- [Deployment](docs/deployment.md): running the server as macOS services, staged API releases, traffic switching, durable workers and rollback
- [Linux](docs/linux.md): running the server on a Linux host (cloud VM or data center) with systemd
- [To-dos as your tracker](docs/jira.md): keys, types, priority, estimates, epics and comments, and a one-command copy into Jira
- [Stable relay](docs/relay-transport.md): a fixed public address without exposing the machine
- [Notifications](docs/notifications.md): APNs and FCM credentials, browser notifications (web push), and exactly what Apple, Google and browser push services can see
- [Performance](docs/performance.md): what was measured in a browser, how to measure it again, and what is not known about phones.
- [Public testing](docs/public-testing.md): a public TestFlight link and Play open testing, from the release scripts
- [Email sign-in](docs/email-sign-in.md): work-email codes, allowed domains and the mailer command
- [Encryption](docs/encryption.md) and [member security](docs/member-security.md): the protocol and the restricted member agent
- [Sharing a prototype with a business owner](docs/prototype-reviews.md): a link by email, a code to confirm, right-click to comment, comments become to-dos
- [Entitlements](docs/entitlements.md) and the [agent's network gate](docs/agent-egress.md): who may have the agent work with what, and a sandbox that refuses everything else
- [Connections](docs/connections.md): each person's own GitHub or Jira token, so the agent works as them, with only their access
- [Code requests](docs/code-requests.md): automation running as you asks your phone for a one-time sign-in code instead of stopping
- [Records preservation](docs/records-management.md) and the [business information filter](docs/business-info-filter.md)
- [Architecture diagrams](docs/architecture/README.md): current system, security, design and technical diagrams (Mermaid sources and renders)
- [Projects](docs/projects.md), [OTA updates](docs/ota.md) and the [design system](docs/design-system.md)

## Features

The feature guide, [docs/features.md](docs/features.md), covers each of these:

- [Reliable agent conversations](docs/features.md#reliable-agent-conversations)
- [Last seen and read receipts](docs/features.md#last-seen-and-read-receipts)
- [Saved messages](docs/features.md#saved-messages)
- [Attachments](docs/features.md#attachments)
- [Roles](docs/features.md#roles)
- [Encryption through the tunnel](docs/features.md#encryption-through-the-tunnel)
- [When someone leaves the team](docs/features.md#when-someone-leaves-the-team)
- [Sessions that end](docs/features.md#sessions-that-end)
- [Secure case workspace](docs/features.md#secure-case-workspace)
- [Features an instance doesn't use](docs/features.md#features-an-instance-doesnt-use)
- [A banner for everyone](docs/features.md#a-banner-for-everyone)
- [A warning before personal information](docs/features.md#a-warning-before-personal-information)
- [Records preservation](docs/features.md#records-preservation)
- [Deep work](docs/features.md#deep-work)
- [Notetaker](docs/features.md#notetaker)

## Security notes

- Every request to the server needs a device token. Personal invites are single-use, team join links expire, and every invite carries the server's public key.
- Message traffic is encrypted from the app to a key held by your server, inside HTTPS. The app pins that key from the invite and never falls back to plaintext. The server's private key never leaves its machine. See [Encryption through the tunnel](docs/features.md#encryption-through-the-tunnel).
- The agent API listens on localhost only. Only the server can reach it.
- The owner can revoke any device, or remove a person, right away.
- Crash diagnostics are sent to Google Firebase Crashlytics in native builds that include your Firebase config. Message encryption does not cover crash telemetry, push notification previews or the model provider. The [external-service inventory](docs/ato-data-flows.md) records those boundaries for security review.
- Organizations handling regulated data need their own security review before putting it through Servant. Until then, use it only for non-sensitive work.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Build your own client (MCP)

Anyone on a server can connect Claude, Codex, Cursor or their own vibe-coded app to it.
The `mcp/` server signs in like the Mac app (you approve it on your phone) and uses the
same encrypted API, with your permissions. See [MCP](docs/mcp.md).

## Layout

```
server/    Node server (no npm dependencies) and its tests
app/       Expo app for iOS, Android and the web
desktop/   Electron Mac app that packages the web build
relay/     optional Cloudflare Worker relay (tests use Miniflare)
mcp/       MCP server and client library: build your own client (docs/mcp.md)
deploy/    Mac installer (deploy/mac) and Linux installer and systemd units (deploy/linux)
config/    reproducible restricted member profile and supported Hermes versions
scripts/   release helpers, Hermes compatibility tests and the scrub check
docs/      design notes, operator guides and captures
```

For shared UI tokens, components, and navigation patterns, see the [design system](docs/design-system.md).

## What's next

Not done yet, roughly in order:

- **App Store and Google Play listings**, so installing does not need TestFlight or a build from source. Both stores review the app against a demo server first.
- **Notifications for the project's builds on your own server.** This needs a relay that sends on the publisher's behalf without seeing message text. Until then, only apps you build yourself get notifications.
- **A signed and notarized Mac app**, so macOS opens it without the extra steps.
- **An independent audit of the encryption protocol** ([docs/encryption.md](docs/encryption.md)).

If you want to help with one of these, open an issue first ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md): how to send a pull request, and the checks to run first
- [SECURITY.md](SECURITY.md): report vulnerabilities privately, never in a public issue
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we treat each other
- [AGENTS.md](AGENTS.md): the repository map and rules, for people and coding agents alike

Servant is dedicated to the public domain under [CC0 1.0 Universal](LICENSE). By contributing you release your work the same way.
