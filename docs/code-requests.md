# Code requests

Automation you run as yourself sometimes hits a step that needs a one-time code: "enter the code we texted you". A code request lets that automation ask your phone instead of stopping.

1. The automation is signed in to Servant as you, like the [MCP server](mcp.md) or anything built on its client. It asks for a code, saying what it is for ("Login.gov sign-in") and, optionally, a hint ("Texted to the number ending 0000").
2. Your phone gets a push: **Code needed** / *QA runner is waiting for your Login.gov sign-in code*.
3. You tap it, type the code in Servant and tap **Send code**. Or **Cancel request** if you did not start it.
4. The automation picks the code up and continues.

From a script:

```sh
CODE=$(node mcp/src/index.ts code "Login.gov sign-in" "Texted to the number ending 0000")
```

From an MCP tool: call `request_code` with `label` (and optionally `hint` and `timeout_seconds`).

## What protects the code

- **It never travels in a push.** The alert names the device and what the code is for; the code goes from your phone to the server over the app's encrypted connection, and from the server to the automation the same way.
- **Only you.** A request belongs to the person whose device made it. Nobody else sees it, can answer it, or is alerted.
- **Only the device that asked, and only once.** Other devices of yours can answer but not pick up. The asking device cannot answer its own request. After pickup the code is gone.
- **Memory only.** Codes are never written to disk or logs, and a server restart forgets every request. Answers are never sent back to the phone.
- **Short-lived.** Requests last ten minutes by default and fifteen at most; finished ones are forgotten a minute after they expire. A person can have five waiting at a time.
- Removing a person drops their requests.

Hints are shown on the phone, so keep them to partial values (last digits, a masked address).

## API

All routes need a device token, like the rest of `/v1/`.

| Route | Who | What |
| --- | --- | --- |
| `POST /v1/code-requests` `{ label, hint?, ttlSeconds? }` | the automation | Make a request; your other devices are alerted |
| `POST /v1/code-requests/<id>/claim` | the asking device | `{ status: "pending" }`, then `{ status: "answered", code }` once, then the final status |
| `GET /v1/code-requests` | you | Your requests still waiting |
| `GET /v1/code-requests/<id>` | you | One request, without the code |
| `POST /v1/code-requests/<id>/answer` `{ code }` | your other devices | Give the code: 4 to 12 letters or numbers; spaces and dashes are dropped |
| `POST /v1/code-requests/<id>/cancel` | you | Cancel it; an unclaimed answer is dropped |
