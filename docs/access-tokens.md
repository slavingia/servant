# Access tokens

A personal access token lets you use Servant from a script or a shell, without the app. It exists for one situation: a computer where nothing can be installed, so neither the app nor the MCP server can run there, but a shell can send web requests. With a token you can, from that shell, see the prototypes on your server, send one to people for review, and message your own agent and read its answer.

A coding agent in that shell can do the same on your say-so ("send the refund prototype to Jo and Sam for review"): `GET /api/v1` on your server is a short guide written for it, with PowerShell examples.

## Turning it on

Off by default. An owner adds this to the server's `config.json`; no restart is needed:

```json
"accessTokens": { "enabled": true, "requestsPerMinute": 60 }
```

While it is off, `/api/v1/` does not exist (every request gets the same 404 as any unknown address) and no token can be made. Turning it off again stops every token at once and deletes nothing.

## Making and revoking a token

In the app: **You**, then **Access tokens**. Name it after where you will use it, choose how long it lasts (a week to a year; 90 days unless you say), and press **Make token**. The token is shown once, with the lines to paste into PowerShell. After that the screen shows only its first and last characters, when it ends and when it was last used. **Revoke** stops it at once.

From the server's own terminal, for someone who can't get to the app:

```sh
node server/server.mjs token create --user "Pat Tester" --name "Work laptop" --days 90
node server/server.mjs token list --user "Pat Tester"
node server/server.mjs token revoke <token id> --user "Pat Tester"
```

A person can have 20 live tokens. A token also stops when its person is removed from the server.

## Using it

```powershell
$Servant = "https://team.example.gov/api/v1"
$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }
Invoke-RestMethod "$Servant/me" -Headers $Headers
```

| Request | What it does |
| --- | --- |
| `GET /api/v1` | The guide. No token needed; it names nobody on the server. |
| `GET /api/v1/me` | Who the token acts as. |
| `GET /api/v1/prototypes?q=words` | Prototypes you can see: yours, ones shared with everyone, and all of them if you own the server. |
| `POST /api/v1/prototypes/<id>/shares` | `{ "emails": [...] }` or `{ "people": [{ "name", "email" }] }`, one to ten: sends each the review link ([prototype-reviews.md](prototype-reviews.md)) and returns, for each, the `link` and a `message` to paste. With `"invite": true` (owners), also a `join` link. |
| `POST /api/v1/agent` | `{ "text": "…" }` starts a new private chat with your agent; add `"chatId"` to continue one of yours. Answers at once; the agent works in the background. |
| `GET /api/v1/agent/<chatId>` | Whether the agent is still working, whether it is waiting for an approval, and the messages with its replies. |

### Sharing someone else's prototype

A prototype is shared by the person who made it, or by a **server owner on their behalf**. The second is new with tokens and only there: an owner can say "send the prototype Pat is working on to these two people" without going through Pat. The share still belongs to Pat: it appears in Pat's share sheet, the reviewers' comments arrive in Pat's chat, and Pat can end it. The email says who sent the link. Someone who is not an owner can share only their own.

### A message to copy, and inviting someone onto the server

Each person the link was sent to comes back with the review `link` and a `message` ready to paste into a chat or an email of your own, beside the email Servant sent: "Hi Jo, I've shared the prototype "Refund tracker" with you for review: … It will ask you to confirm your email with a code…". A name, when given, is used to greet them there and in Servant's email; it is not kept.

The review link is returned only here, to the person who asked for it; the app's own share sheet never shows it. It opens nothing by itself: the prototype still needs a code confirmed from the address it was shared with.

With `"invite": true`, a **server owner** also invites each person onto the server in the same request, for someone who has no account and may want more than the full-screen prototype. Names are required. Each gets a single-use invite in their name, good for a week, that starts them as a member at the **Business owner** access level, with the owner who invited them deciding their entitlement requests. The `join` link is in the result, in the message and in Servant's email. No invite is made for an address a prototype can't be shared with, or for someone who is already a member (`alreadyMember`). Unlike the review link, **whoever has a join link can use it once**: send it only to the person it is for.

Bringing people onto a server is an owner's job in the app (Invite people), and it is here: anyone else's token is refused `invite`.

## What a token can and can't do

- It works **only at `/api/v1/`**. The app's own API (`/v1/`) does not accept it, even over the encrypted transport, and `/api/v1/` does not accept a device's credential. So a token cannot read or post in channels, direct messages or cases, cannot read anyone else's agent chats (not even an owner's token can), and cannot change people, projects, entitlements or settings.
- A message to the agent runs as you, in a private chat of yours, under your access, entitlements and daily limit, like one typed in the app. It gets the same two checks: a credential in it is refused, and personal information gets a warning (send again with `"confirmPii": true`). Approvals are still given in the app.
- Each token has a number of requests a minute (`requestsPerMinute`, 60 unless set).

## The decision this records: not app-encrypted

Everything the app sends is encrypted to the server's own key on top of HTTPS, so a relay or tunnel in between cannot read it ([encryption.md](encryption.md)). **`/api/v1/` is not.** It is ordinary HTTPS: whatever carries the connection to the server (the tunnel or relay in front of it) can read these requests and answers, and the token in them. That is the price of working from a shell with nothing installed, and it is why:

- it is off unless an owner turns it on;
- it is a short list of things, not the app's API under another name;
- nothing under `/v1/` changed: it still refuses anything unencrypted, and still does not take a token.

Decided by the maintainer on 2026-11-20, in place of running the MCP server, which would have to be installed on the computer in question. If your server sits behind a relay you do not run, weigh that before turning this on, and keep what you send through it to what you would be content for the relay to see.

Use the server's `https://` address. A token sent to an `http://` address crosses the network in the clear.

## What is kept

`access-tokens.db` in the data directory holds, for each token: its hash (never the token), whose it is, its name, its first eight and last four characters, when it was made, when it ends, when it was last used (to the minute) and when it was revoked. Tokens are revoked, never deleted; the table refuses deletes.

`node scripts/access-tokens-e2e.mjs` makes a token in the app in a browser against a temporary server, uses it with `curl`, and saves captures to `docs/shots/access-tokens`.
