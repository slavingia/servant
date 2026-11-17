# Servant MCP server

Build your own Servant client, or let any MCP-capable tool (Claude, Codex, Cursor, a vibe-coded app) read and post in your team's Servant, and run agent chats, as you.

It signs in like the Mac app: you approve it on your phone. After that it talks to the owner's server over the same end-to-end encrypted channel as the app (see [encryption.md](encryption.md)). It uses the same API, with your permissions, and the owner can sign it out like any other device.

## Set up

Needs Node 22.18 or newer and a clone of this repo (the MCP reuses the app's encryption code).

```sh
cd servant/app && npm ci --ignore-scripts      # the encryption libraries
cd ../mcp && npm ci
node src/index.ts link "<your workspace link>" "Ana's laptop"
```

The workspace link is any Servant invite link, or `{"server":"https://…","serverKey":"02…","discovery":"https://…"}` from the owner. The command prints a `servant://link-device?…` link and a code:

1. On your phone: You → Link a computer, then scan or open the link.
2. Check that the code matches, then tap Approve.

The device token is saved to `~/.config/servant-mcp/account.json` (mode 600). To sign it out, use People → your devices on your phone, or ask the owner.

## Connect a tool

Claude Code:

```sh
claude mcp add servant -- node /path/to/servant/mcp/src/index.ts
```

Any MCP client (stdio):

```json
{ "mcpServers": { "servant": { "command": "node", "args": ["/path/to/servant/mcp/src/index.ts"] } } }
```

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The signed-in person and server |
| `list_people` | Everyone on the server |
| `list_conversations` | Your channels and DMs, with unread counts |
| `read_messages` | Recent messages in a channel or DM (`before` pages back) |
| `read_thread` | A message and its replies |
| `send_message` | Post, or reply in a thread. `@agent` calls the agent |
| `open_dm` | Start a DM with people by id |
| `create_channel` | Make a channel (public channels include everyone) |
| `search` | Channels, people and messages you can see |
| `list_agent_chats` | Your agent chats |
| `new_agent_chat` | Start one; `shared: true` lets everyone follow it |
| `ask_agent` | Send a message in an agent chat and wait for the reply |
| `read_agent_chat` | The messages in an agent chat |
| `request_code` | Ask your phone for a one-time sign-in code and wait for it ([code-requests.md](code-requests.md)) |

There is also one resource, `servant://conversations`.

## Handing work to reviewers from an agent

`mcp/src/handoff.ts` is a small command for agents and scripts that work with a team in Servant: it reads and posts in conversations (with pictures attached), updates a project's release checklist, and shows what people replied since an ask.

```sh
node mcp/src/handoff.ts help
node mcp/src/handoff.ts releases example-app
node mcp/src/handoff.ts post <conversation> "Dark mode is ready for your design step." --attach light.png dark.png
node mcp/src/handoff.ts ask-log <conversation> "Dark mode" "Pat Tester" "branch dark-mode"
node mcp/src/handoff.ts replies
```

Messages it posts are labelled **Posted by agent**. Open asks are kept beside the device token in `~/.config/servant-mcp/handoffs.json`. [skills/review-handoff/SKILL.md](../skills/review-handoff/SKILL.md) is the skill that tells an agent when to ask, where to post, what the message must contain and how to act on replies; point your agent at it, or copy the folder into your agent's skills directory.

## What it can't do

It has exactly your access, no more: no admin routes, no other people's private chats, and no reaching the agent outside Servant. Everything it posts shows as you, labelled with the device name you gave it.

## Writing your own client without MCP

`mcp/src/client.ts` is a small library you can use directly:

- `link()` signs in.
- `call(account, method, path, body)` makes any encrypted API call.
- `streamAgent()` runs an agent turn.

The API is the one the app uses; see `app/src/lib/server.ts` for every route.
