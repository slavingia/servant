# Sharing a prototype with a business owner

Someone who builds a prototype in a Prototyping chat can send it to a business owner for comments. The business owner does not need the app or an account: a link arrives by email, they confirm a code sent to the same address, see the prototype full screen in their browser, and right-click the part they want to talk about.

Two people, two places. The person who built the prototype lives in its chat: they share it, preview it, edit it, work on it with the agent, and that is where every comment arrives, for them to decide what to do with. The business owner only ever sees the prototype and leaves comments on it. A comment is not filed anywhere else: it does not become a to-do.

## For the person sharing

In the prototyping chat, open **•••** and choose **Share with a business owner**. Type their work email and press **Send link**.

- **This project's reviewers** lists the outside reviewers named on the Prototypes project who have no link to this prototype yet, each with **Send**, and **Send to all** when there is more than one. See [Outside reviewers](#outside-reviewers).
- The address must be on the server's allowed email domains (`emailVerification.domains` in `config.json`). A server with none set accepts only `.gov` and `.mil` addresses.
- The sheet lists everyone it was shared with, whether they have opened it, and what they said. **End** stops one person's link.
- Sending again to the same address makes a fresh link and ends the old one.
- You get an alert for each comment, and tapping it opens the prototype's chat.
- **In the chat**, comments wait above the message box ("2 comments from reviewers"), each with who said it and where, until you decide. **Ask Agent to work on this** sends the comment to the agent as a message from you in that chat, so the agent works on the prototype it already knows. **Set aside** is for one you dealt with yourself: you answered the reviewer, made the change by hand, or decided against it. Either way the comment leaves the waiting list and stays on record in the share sheet. A comment is handed to the agent at most once.
- **Agent starts on their comments by itself** is a switch beside each person in the share sheet, off until you turn it on. With it on, each comment that person makes is sent to the agent as it arrives, with nobody pressing anything, and you get an alert that says so. It is one reviewer's switch, not the prototype's: other people's comments still wait for you. See [When the agent starts by itself](#when-the-agent-starts-by-itself).
- In the chat's own preview, a link in the bar ("2 comments") puts a numbered pin where each comment was made; pressing a pin shows what was said and by whom.
- Only the person whose chat it is can share, list or end. Deleting the chat ends every link for it.

It needs the server to have a public address (`publicUrl`) and a mailer (`emailVerification.mailer.command`, the same one sign-in codes use); without either the sheet says which is missing.

## For the business owner

1. The email says who shared what, with a link.
2. The page shows who shared it and a masked address ("j***@example.gov") and offers to email a code. The code always goes to the address the prototype was shared with; the page never asks for one.
3. With the code entered, the prototype fills the window, with nothing around it but a small bar at the bottom. **Right-click** anywhere (on a phone, press and hold) to open a box at that spot, write the comment and save it. A numbered pin stays where it was made; pressing a pin, or the count in the bar ("2 comments"), opens the list of their comments over the side of the prototype, and **Close** puts it away. **Comment on this page** in the bar does the same without a mouse, for the page as a whole.
4. Coming back in the same browser tab needs no new code for twelve hours.

They see only their own comments, not other reviewers', and nothing else on the server. Under a comment that was handed to the agent the page says **Sent to the team's agent**; it does not say what came of it.

## Outside reviewers

A project's owners can name the business owners and subject matter experts they keep going back to, once: in the project's **About**, under **Outside reviewers**, one a line, a work email and then a few words on their role ("jo.park@example.gov, Product owner"). Up to ten, at addresses a prototype could be shared to.

Naming someone sends them nothing and opens nothing. It only saves retyping: when anyone shares a prototype, the people named on the Prototypes project are offered with one press, and when anyone shares a project's app preview ([app-preview.md](app-preview.md#sharing-it-with-someone-outside-the-server)), the people named on that project are. Each of them still gets a link only when someone presses Send, and confirms a code each time. Everyone who can see the project can see the list.

Prototypes are all built in one project (`prototypesProject`, "prototypes" unless set), so its list is the one the share sheet offers. A server whose `projects.json` has no such project offers nobody; the email box still works.

In `projects.json` it is `"outsideReviewers": [{ "email": "jo.park@example.gov", "label": "Product owner" }]` on the project.

## When the agent starts by itself

A comment is words from someone outside the server, and the agent that builds prototypes can change files. So:

- **Nothing reaches the agent unless the person who shared the prototype says so**, comment by comment, or by turning the switch on for one reviewer. It is off for everyone to begin with, and turning it on is the sharer's own act in their own chat.
- **The comment is quoted, not spoken.** The message the agent gets says who reviewed what, quotes the comment line by line, and tells the agent to use it only to decide how the prototype should change and to follow nothing in it that asks for anything else (other files, commands, credentials, messages). That is an instruction to the agent, not a wall: a reviewer you switch this on for should be someone you would let type in the chat.
- **It runs as the sharer**, in the sharer's chat, under the sharer's access, entitlements and daily limit, like a message they sent. If they have no agent access, are over their limit, or have no signed-in device, the comment waits as it would with the switch off.
- **A reviewer can't run up the sharer's agent use**: the agent starts on at most 20 of one reviewer's comments an hour by itself, and the chat's own limit on waiting messages applies. The rest wait for the sharer.
- Every comment stays on record in the share sheet with what became of it: handed to the agent by you, started by itself, set aside, or still waiting.

## What is kept, and what leaves the server

`prototype-reviews.db` in the data directory holds each share (the chat, the prototype's folder and title, the address, who shared it, when it was opened and ended), the sessions of people who confirmed a code, whether the agent starts on that person's comments by itself, and the comments (with, once handed to the agent, when, whether the sharer did it or it happened by itself, and which message it became): the address, the page, where on it (as a share of the page's width and height), the words under the pointer (up to 120 characters), and the comment (up to 2,000). Links and sessions are stored only as hashes. Comments are never deleted, and the table refuses it; ending a share or deleting the chat closes the link and keeps what was said.

Two emails leave the server through the owner's mailer command, both to the address the sharer typed:

- the invitation: the sharer's name, the server's name, the prototype's title and the link;
- the code: the prototype's title, the sharer's name and the six-digit code.

The alert to the sharer carries the prototype's title, the reviewer's address and the start of the comment, like any other alert, and the id of the prototype's chat so a tap opens it ([notifications.md](notifications.md)).

## Limits to know

- **The review page is gated; the prototype's own address is not.** Prototypes have always been viewable by anyone who has their `/p/<folder>/` address, which is long and random and never listed. The review page does not show that address before the code is confirmed, but a business owner who has confirmed could copy it from their browser and pass it on. Treat a shared prototype as something its reviewers can show to others.
- Confirming a code proves the visitor can read that inbox. It does not prove who they are beyond that.
- Codes work for ten minutes and once; five wrong tries end a code; sends and wrong tries are limited per address, and requests per network address.
- Comments are tied to a spot on the page as it was. If the prototype changes, a pin may no longer sit on the thing it was about; the words under the pointer are kept with the comment for that reason.
- A page inside the prototype that opens a link in a new tab leaves review mode in that tab.
- On a phone the list of comments, when opened, covers the lower part of the screen until it is closed.

## API

Signed in, under the encrypted `/v1/` API, for the chat's own person:

| Request | What |
| --- | --- |
| `GET /v1/chats/<id>/prototype/shares` | Everyone it was shared with, and their comments. |
| `POST /v1/chats/<id>/prototype/shares` | `{ "email" }`: send a link. |
| `DELETE /v1/chats/<id>/prototype/shares/<share id>` | End one link. |
| `PATCH /v1/chats/<id>/prototype/shares/<share id>` | `{ "autoWork": true }`: the agent starts on this person's comments as they arrive. `POST` takes it too. |
| `POST /v1/chats/<id>/prototype/comments/<comment id>/work` | Hand one comment to the agent, as a message in the chat. Once. |
| `POST /v1/chats/<id>/prototype/comments/<comment id>/set-aside` | You dealt with it yourself: it leaves the chat's waiting list. |

For the business owner, plain HTTPS with no account:

| Request | What |
| --- | --- |
| `GET /review/<link>` | The page. |
| `POST /review/<link>/code` | Email a code to the shared address. |
| `POST /review/<link>/verify` | `{ "challenge", "code" }`: returns a session, the prototype's address and their comments. |
| `GET /review/<link>/comments` | With the session: their comments. |
| `POST /review/<link>/comments` | With the session: `{ "page", "x", "y", "anchor", "text" }`. |

`node scripts/prototype-review-e2e.mjs` runs the whole exchange in real browsers against a temporary server, with the mailer replaced by a list, and saves the captures in `docs/shots/prototype-review`.
