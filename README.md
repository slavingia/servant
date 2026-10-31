# Servant

Secure messaging for public servants, with an agent you can talk to.

Servant is a phone app plus a small server that runs on your own computer. People you invite can message the agent running on that computer from anywhere, without using a consumer chat service.

Status: private while it gets good. It is meant to be open source (CC0) when it is ready.

## How it works

```
 Phone (Servant app)
   │  HTTPS
   ▼
 Tunnel (cloudflared)
   │
   ▼
 Server (server/, on the owner's Mac)        invites, device tokens, who can do what
   │  localhost only, server key never leaves the Mac
   ▼
 Agent (Hermes API server)             one conversation history per person
```

- **App** (`app/`): an Expo app for iOS and Android. Testers get it through TestFlight and Firebase App Distribution.
- **Server** (`server/`): a Node server with no dependencies. It pairs devices from one-time invites, issues a token for each device, keeps each person's conversations separate, and passes messages to the agent. The agent's API key stays on the Mac.
- **Tunnel**: a cloudflared tunnel makes the server reachable from a phone. The server publishes its current address so the app keeps working when the tunnel address changes.

## Last seen and read receipts

Members and direct messages show **Online** while a person is using the app, then their last seen time. Each device has its own presence session; a lost connection expires after about a minute.

Your messages show **Sent** until another member views them, then **Read** with reader details available in message actions. Receipts work in channels, direct messages, and threads, and persist across reconnects and server restarts. Only messages visible in the active app are marked read; background updates and off-screen messages do not create receipts. Agent messages do not have read receipts. Older app builds continue to clear unread counts without creating receipts.

## Attachments

In channels, direct messages, and threads, use **Photos** or **Files** to attach up to four files (5 MB each, 10 MB total). Preview or remove selections before sending; a caption is optional. Images appear inline and open in a larger preview. Other files download on web or open the share sheet on mobile. Failed sends retain the draft.

Attachments are stored with messages in the server database and require the same access as their conversation. Deleting a message removes its attachments. Agent conversations currently accept text only; mentioning the agent does not send attachment contents to it.

The attachment picker and sharing modules require a new native app build for existing installations.

## Roles

- **Owner**: the person whose computer runs the agent. Full agent.
- **Member**: anyone the owner invites. Members talk to a restricted agent that has no shell, no file access and no access to the owner's accounts, unless the owner grants it.

## Security notes

- Every request to the server needs a device token. Invites are single-use and expire.
- The agent API listens on localhost only. Only the server can reach it.
- The owner can revoke any device right away.
- Federal use needs an agency security review (ATO) before any real taxpayer data goes through Servant. Until then, use it only for non-sensitive work.

## Layout

For shared UI tokens, components, and navigation patterns, see the
[design system](docs/design-system.md).

For staged API releases, traffic switching, durable workers, and rollback,
see [Deployment](docs/deployment.md).

```
server/    Node server (no npm dependencies)
app/    Expo mobile app
docs/   design notes and captures
```

## License

CC0 1.0 Universal. See LICENSE.

## Encryption through the tunnel

The app encrypts API requests and responses to a key held by the owner's server, inside HTTPS. Cloudflare relays ciphertext for pairing codes, device tokens, messages, attachments, feedback, and live agent replies. The server and its admin can still read and store content and run the agent. Cloudflare can still see connection metadata, timing, and traffic sizes; discovery, health, and basic server information remain public.

New invites contain the server's public key. Share these invites directly from the admin through a trusted channel. The app pins that key and retains it when the tunnel address changes. It never learns or replaces the key from Cloudflare or the discovery file, and never falls back to plaintext. The server rejects unencrypted `/v1/` requests except public server information.

To roll out this change:

1. Build and distribute a new native app containing `expo-crypto`, and update the server. Older builds cannot use the encrypted API.
2. Existing users open a fresh invite for their **existing user ID**: `node server/server.mjs invite --user <user-id>`. The upgrade screen accepts it and preserves their server-side conversations. A general team invite creates a new account instead. Revoke the old device token after the replacement device is paired.
3. Keep `server/data/transport-key` (or the configured data directory's equivalent) private and backed up. Losing or replacing it requires fresh trusted invites. Do not publish it with the discovery file.

The protocol uses per-request ephemeral P-256 ECDH, HKDF-SHA-256, and separate AES-256-GCM request/response keys. Ordered encrypted response frames include an authenticated end marker; timestamp checks and a durable replay database prevent replayed writes. The protocol has not undergone an independent security audit and does not provide forward secrecy against later compromise of the server's long-term key. It does not encrypt server storage or native push previews, and a web build must be served from a trusted origin because its JavaScript can read plaintext. See [the protocol and verification notes](docs/encryption.md).
