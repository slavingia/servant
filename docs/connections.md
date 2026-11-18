# Connections

A connection is a person's own login for a tool their agent works with: a GitHub personal access token, a Jira API token, or a key for a system an owner has added. With one saved, the agent's commands for that person run with that person's credentials, so the tool sees them, with their access and nothing more.

Without connections, every person's agent works with whatever the server's own account is signed in to: one GitHub login for everyone. Whatever that login can reach, anyone's agent can reach, and the tool's own history says the server did it. A connection closes that gap one person at a time. Nothing changes for someone who has not connected a tool.

## What a person sees

When the agent needs a tool the person has not connected, its reply carries a form:

- a heading ("GitHub token for your account") and one line on why and where to make the token;
- **Open github.com**, with the exact address under it;
- a field for each thing the tool needs (GitHub: the token; Jira: the site, your email and the token), which checks the format as you type and hides what is secret;
- **Save securely**, which stays off until everything fits;
- "Kept out of chat. Only your agent's commands can use it." and **Decline**.

Saved, the form becomes one line: "GitHub token saved · ••••a1b2". The value is never shown again, to the person or to anyone else. Declined, it becomes "Declined", the agent is told, and it does not ask again in that chat.

**You → Connections** lists every tool: not connected, or connected with the last four characters, the account name when the tool gave one ("Connected as @pat"), when it was saved and when it was last used. From there a person can **Connect**, **Replace** or **Remove**. Removing takes it out of Servant; it does not revoke the token where it was made.

A token typed or pasted into any chat (an agent chat, a channel, a direct message, an edit) is refused before it is stored: "That looks like a GitHub token. Use Connections so it stays out of chat."

Someone on a restricted agent (a researcher, or a member on a server with `"agentAccess": "limited"`) has no terminal, so nothing could use a connection. The form and the screen say so: "Your agent can't run commands, so it can't use this yet. Ask an owner to give you the full agent first."

## Tool types are data

GitHub and Jira are built in. An owner adds others in `config.json`, with no code:

```json
"connections": {
  "types": [{
    "id": "tax-api",
    "name": "Tax data API",
    "help": "Needed so the agent reads tax data as you. Create a key at api.example.gov → Keys.",
    "createUrl": "https://api.example.gov/keys",
    "hosts": ["api.example.gov"],
    "fields": [{ "key": "key", "label": "API key", "placeholder": "tax_…", "pattern": "^tax_[a-z0-9]{12}$", "detect": "tax_[a-z0-9]{12}", "secret": true }],
    "env": { "TAX_API_KEY": "{key}" }
  }]
}
```

| Field | What it is |
| --- | --- |
| `id`, `name` | The type's id (lowercase letters, digits, dashes) and the name people see. |
| `heading`, `help`, `createUrl` | The form's heading (default "<name> token for your account"), its one line of help, and the https address where the token is made. |
| `hosts` | The hosts the tool lives on, for people reading the definition. With the network gate on, reaching them still takes an entitlement ([entitlements.md](entitlements.md)). |
| `fields` | One to six: `key`, `label`, `placeholder`, an optional `pattern` the value must match, and `secret` (true unless set to false). At least one is secret. |
| `fields[].detect` | Optional, for a secret field: what the value looks like inside other text. It is what refuses a token typed into chat and hides one the agent writes back. Leave it out when the value has no recognisable shape. |
| `env` | The variables the values become in that person's agent commands; `{key}` is replaced by the field with that key. Names that change how every command runs (`PATH`, `HOME`, the proxy variables and the like) are refused. |

A type that can't be used is left out and the server's log says why. Built in: GitHub sets `GH_TOKEN` and `GITHUB_TOKEN`; Jira sets `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN`.

When a GitHub token is saved the server asks GitHub whose it is (`GET https://api.github.com/user`) and keeps the login name to show. A token GitHub rejects is not saved. If GitHub can't be reached the token is saved without a name. `"connections": { "verify": false }` skips the question.

## How it works

**Storage.** Values are kept in `connections.db` in the data directory, each one encrypted with AES-256-GCM under a 32-byte key in `connections-key` beside it (made once, readable only by the server's user). The person and the tool are bound into each encrypted value, so a row copied onto another person does not open. Back up the key with the database: without it the saved values can't be read and people connect again.

**The API** (all under the encrypted `/v1/` transport) never returns a value:

| Request | What it does |
| --- | --- |
| `GET /v1/connections` | The tool types and where you stand on each: the last four characters, the account name, saved and last-used times. |
| `PUT /v1/connections/<type>` | Save or replace your values. The format is checked first. |
| `DELETE /v1/connections/<type>` | Remove yours. |
| `POST /v1/connections/requests/<id>/decline` | Decline the agent's request in a chat. |
| `GET /v1/connections/history` | What happened to your connections; an owner can add `?all=1` for everyone's. |

**History.** Every save, replacement, removal, request, refusal and use (once per tool and turn) is appended to a table that refuses changes and deletions. It holds who, which tool, what happened, in which chat and when. It never holds a value.

**Reaching the agent.** Each full-agent turn of someone with a connection carries a token that says whose turn it is and the port of a listener on this computer. The agent's bridge asks that listener (`POST /connections`) for this turn's variables and gets that person's only; a token nobody signed, or one for someone who has left, gets nothing. With the network gate or the entitlement checks on, the listener is the one they already use; otherwise the server starts one of its own on localhost.

The bridge gives that session a shell of its own whose environment holds those variables (and, with the gate on, the session's named way through it). They are never put in the bridge's own environment and never in another session's shell. When a person replaces or removes a connection, the shell that remembers the old one is closed before their next turn. If the variables can't be fetched, the turn starts without them and the bridge's log says so, without a value.

**What the agent is told.** Each turn's instructions say what its commands have ("Your commands have this person's own GitHub token in GH_TOKEN and GITHUB_TOKEN (connected as @pat). Use it; don't use any other GitHub login.") and how to ask for what is missing: by writing `[[connect:github]]` on its own line. The server turns that line into the form and takes the marker out of the text; a type nobody defined is dropped. In a channel there is no form, so the agent is only told what it has.

**Hiding.** Before anything the agent writes is stored or sent (reply text as it streams and when it ends, progress steps, an approval's command, a reply in a channel, a wiki page), the person's saved values and anything shaped like a known token are replaced with `[hidden]`. The same is done when a chat's history is read back from the agent.

**Entitlements still apply.** A person's own GitHub token is the access; the entitlement is the permission. With `agentCapabilities` on, GitHub read and write are still asked for and granted as before, and with the network gate on, a host is still reached only through an entitlement that person holds.

## What this protects against, honestly

Connections are about attribution and least privilege. They are not a wall.

What they give:

- The tool sees the person, not the server. What the agent does on GitHub for Pat is done as Pat, limited to what Pat's token allows, and shows up under Pat's name in GitHub's own history.
- Nobody's agent needs a shared login that reaches more than they do, so the shared login can be scoped down or removed.
- A token never sits in a conversation, a notification, the search index, the usage records or a records snapshot. An owner reading someone's chat does not see it.
- The server's own records say who saved, replaced, removed and used what, and when.

What they do not give:

- **The agent's commands all run as the server's user on the server's computer.** A command that goes looking can read another session's environment, or the bridge's memory, and with it another person's token. The per-session shell keeps an honest command honest about whose it is; it does not stop a dishonest one. Treat everyone whose agent runs commands on the server as able, with effort, to reach what any other such person has connected.
- **The agent itself sees the value** the moment a command prints it, and its own session history (kept by Hermes, outside Servant) may hold what it printed. Servant hides the value in everything it stores and shows, and Hermes masks token-shaped text in command output, but neither is a guarantee about what the model was shown.
- **The server's owner can decrypt.** The key is a file on the same computer. Encryption at rest protects a copied database or a backup without the key, not against whoever runs the server.
- **A value with no recognisable shape** (no `detect`) is hidden only where it appears exactly as saved, and is not refused when typed into chat.

So: prefer narrow tokens (a fine-grained GitHub token for the repositories the work needs, with an expiry), and revoke one where it was made if you think it was exposed. Removing it in Servant only stops Servant using it.

See also [entitlements.md](entitlements.md), [agent-egress.md](agent-egress.md) and [member-security.md](member-security.md).
