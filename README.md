# Servant

Secure messaging for public servants, with an agent you can talk to.

Servant is a phone app plus a small hub that runs on your own computer. People you invite can message the agent running on that computer from anywhere, without using a consumer chat service.

Status: private while it gets good. It is meant to be open source (CC0) when it is ready.

## How it works

```
 Phone (Servant app)
   │  HTTPS
   ▼
 Tunnel (cloudflared)
   │
   ▼
 Hub (hub/, on the owner's Mac)        invites, device tokens, who can do what
   │  localhost only, server key never leaves the Mac
   ▼
 Agent (Hermes API server)             one conversation history per person
```

- **App** (`app/`): an Expo app for iOS and Android. Testers get it through TestFlight and Firebase App Distribution.
- **Hub** (`hub/`): a Node server with no dependencies. It pairs devices from one-time invites, issues a token for each device, keeps each person's conversations separate, and passes messages to the agent. The agent's API key stays on the Mac.
- **Tunnel**: a cloudflared tunnel makes the hub reachable from a phone. The hub publishes its current address so the app keeps working when the tunnel address changes.

## Roles

- **Owner**: the person whose computer runs the agent. Full agent.
- **Member**: anyone the owner invites. Members talk to a restricted agent that has no shell, no file access and no access to the owner's accounts, unless the owner grants it.

## Security notes

- Every request to the hub needs a device token. Invites are single-use and expire.
- The agent API listens on localhost only. Only the hub can reach it.
- The owner can revoke any device right away.
- Federal use needs an agency security review (ATO) before any real taxpayer data goes through Servant. Until then, use it only for non-sensitive work.

## Layout

```
hub/    Node hub (no npm dependencies)
app/    Expo mobile app
docs/   design notes and captures
```

## License

CC0 1.0 Universal. See LICENSE.
