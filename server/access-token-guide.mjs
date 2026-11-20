// What GET /api/v1 says: how to use a personal access token (docs/access-tokens.md), written to be read by a person
// or handed to a coding agent on the computer where the token lives. The examples are PowerShell, because the
// reason this exists is a work computer where nothing can be installed; curl works the same way.
export function apiGuide({ origin, name = "Servant" }) {
  const base = `${String(origin).replace(/\/+$/, "")}/api/v1`;
  return `# ${name}: using Servant from a shell

Plain HTTPS with a personal access token. Nothing to install.

Make a token in the Servant app: **You**, then **Access tokens**. It is shown once. Keep it like a password: it
acts as you. Do not paste it into chats, files that are shared, or code.

## Set up (PowerShell)

\`\`\`powershell
$Servant = "${base}"
$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }   # set SERVANT_TOKEN in your own environment
Invoke-RestMethod "$Servant/me" -Headers $Headers
\`\`\`

Every answer is JSON. An error has \`error.code\` and \`error.message\`; the message says what to do.

## What there is

| Request | What it does |
| --- | --- |
| \`GET /me\` | Who the token acts as. |
| \`GET /prototypes?q=words\` | Prototypes you can see: yours, ones shared with everyone, and all of them if you own the server. Each has \`id\`, \`title\`, \`by\`, \`url\`, \`canShare\` and, when you can share it, who it is shared with. |
| \`POST /prototypes/<id>/shares\` | Body \`{ "emails": ["name@example.gov"] }\` or \`{ "people": [{ "name": "Jo Park", "email": "jo.park@example.gov" }] }\` (one to ten). Sends each person a link to review the prototype; they need no account. Each result has \`sent\`, the \`link\`, and a \`message\` ready to paste into a chat or an email of your own. Add \`"invite": true\` (server owners only, names required) to also invite each person onto the server: it is still one link, which opens on the prototype straight away; once they type the code emailed to them on that page, it offers to join the team (once, for a week). Their comments arrive in the chat of the person who made the prototype. |
| \`POST /agent\` | Body \`{ "text": "…" }\` starts a new chat with your agent; add \`"chatId"\` to continue one of yours. Answers at once with \`chatId\` and \`turnId\`; the agent works in the background. |
| \`GET /agent/<chatId>\` | \`working\` (true while the agent is busy), \`needsApproval\`, and the messages so far with the agent's \`reply\` to each. |
| \`POST /feedback\` | Body \`{ "kind": "bug", "text": "what happened", "where": "what you were doing" }\`. Tells the people who run Servant that something broke, was slow, got in the way or was confusing. \`kind\` is \`bug\`, \`friction\`, \`slow\`, \`confusing\` or \`idea\`. Up to 4,000 characters, five reports an hour. |
| \`GET /feedback\` | Your own reports and what became of each. |

## Examples

Find a prototype and send it to two people:

\`\`\`powershell
$found = Invoke-RestMethod "$Servant/prototypes?q=refund" -Headers $Headers
$found.prototypes | Format-Table id, title, by, canShare
$body = @{ emails = @("jo.park@example.gov", "sam.lee@example.gov") } | ConvertTo-Json
Invoke-RestMethod "$Servant/prototypes/$($found.prototypes[0].id)/shares" -Method Post -Headers $Headers -ContentType "application/json" -Body $body
\`\`\`

Invite someone who has no account, by name and email, to review a prototype and join the team if they wish, then
show the message to send them (show the user \`message\` exactly as returned, so they can copy it):

\`\`\`powershell
$body = @{ invite = $true; people = @(@{ name = "Jo Park"; email = "jo.park@example.gov" }) } | ConvertTo-Json -Depth 4
$sent = Invoke-RestMethod "$Servant/prototypes/$($found.prototypes[0].id)/shares" -Method Post -Headers $Headers -ContentType "application/json" -Body $body
$sent.results | ForEach-Object { if ($_.sent) { $_.message } else { "$($_.email): $($_.error)" } }
\`\`\`

Report something that got in the way. If you are a coding agent, do this yourself, without being asked, whenever
this API or Servant fails, is slow, or leaves you unsure what to do: say what you tried, what came back, and what
you expected. Leave out tokens, people's details and the content of the work itself.

\`\`\`powershell
$body = @{ kind = "confusing"; where = "sharing a prototype"; text = "POST /prototypes/<id>/shares answered 400 with no error for the second address. Expected each result to say why it was not sent." } | ConvertTo-Json
Invoke-RestMethod "$Servant/feedback" -Method Post -Headers $Headers -ContentType "application/json" -Body $body
\`\`\`

Ask your agent something and wait for the answer:

\`\`\`powershell
$body = @{ text = "Summarize what changed in the refund prototype this week" } | ConvertTo-Json
$sent = Invoke-RestMethod "$Servant/agent" -Method Post -Headers $Headers -ContentType "application/json" -Body $body
do { Start-Sleep 5; $chat = Invoke-RestMethod "$Servant/agent/$($sent.chatId)" -Headers $Headers } while ($chat.working -and -not $chat.needsApproval)
$chat.turns[-1].reply
\`\`\`

## Limits

- A token works only at \`${base}\`. It cannot read channels, direct messages, cases or other people's chats.
- You can share a prototype you made, or any prototype if you own the server. Nobody else's. Only a server owner can add \`"invite": true\`.
- The review \`link\` shows the prototype to whoever opens it. Leaving a comment, and joining when invited, need a code sent to the person's own address, typed on that page; the invite is never in the message.
- A message to the agent is checked the way one typed in the app is: a credential in it is refused, and personal
  information gets a warning (send again with \`"confirmPii": true\` to send it anyway).
- When the agent needs an approval, \`needsApproval\` is true: approve it in the Servant app.
- Requests are limited per token each minute. A token ends on the day chosen when it was made, or when you revoke it.
`;
}
