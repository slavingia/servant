# Sharing a prototype with a business owner

Someone who builds a prototype in a Prototyping chat can send it to a business owner for comments. The business owner does not need the app or an account: a link arrives by email, they confirm a code sent to the same address, look at the prototype in their browser, and right-click the part they want to talk about. Each comment is kept on the server and becomes a to-do for the person who shared it.

## For the person sharing

In the prototyping chat, open **•••** and choose **Share with a business owner**. Type their work email and press **Send link**.

- The address must be on the server's allowed email domains (`emailVerification.domains` in `config.json`). A server with none set accepts only `.gov` and `.mil` addresses.
- The sheet lists everyone it was shared with, whether they have opened it, and what they said. **End** stops one person's link.
- Sending again to the same address makes a fresh link and ends the old one.
- Each comment becomes a to-do of yours ("Comment on Refund tracker: This should say Pay in full"), with who said it, where on which page, and a link to that page. From To-dos you can hand it to the agent like any other. You also get an alert that opens To-dos.
- Only the person whose chat it is can share, list or end. Deleting the chat ends every link for it.

It needs the server to have a public address (`publicUrl`) and a mailer (`emailVerification.mailer.command`, the same one sign-in codes use); without either the sheet says which is missing.

## For the business owner

1. The email says who shared what, with a link.
2. The page shows who shared it and a masked address ("j***@example.gov") and offers to email a code. The code always goes to the address the prototype was shared with; the page never asks for one.
3. With the code entered, the prototype opens. **Right-click** anywhere (on a phone, press and hold) to open a box at that spot, write the comment and save it. A numbered pin stays where it was made, and the comments are listed beside the prototype.
4. Coming back in the same browser tab needs no new code for twelve hours.

They see only their own comments, not other reviewers', and nothing else on the server.

## What is kept, and what leaves the server

`prototype-reviews.db` in the data directory holds each share (the chat, the prototype's folder and title, the address, who shared it, when it was opened and ended), the sessions of people who confirmed a code, and the comments: the address, the page, where on it (as a share of the page's width and height), the words under the pointer (up to 120 characters), and the comment (up to 2,000). Links and sessions are stored only as hashes. Comments are never deleted, and the table refuses it; ending a share or deleting the chat closes the link and keeps what was said.

Two emails leave the server through the owner's mailer command, both to the address the sharer typed:

- the invitation: the sharer's name, the server's name, the prototype's title and the link;
- the code: the prototype's title, the sharer's name and the six-digit code.

The alert to the sharer carries the prototype's title, the reviewer's address and the start of the comment, like any other alert ([notifications.md](notifications.md)).

## Limits to know

- **The review page is gated; the prototype's own address is not.** Prototypes have always been viewable by anyone who has their `/p/<folder>/` address, which is long and random and never listed. The review page does not show that address before the code is confirmed, but a business owner who has confirmed could copy it from their browser and pass it on. Treat a shared prototype as something its reviewers can show to others.
- Confirming a code proves the visitor can read that inbox. It does not prove who they are beyond that.
- Codes work for ten minutes and once; five wrong tries end a code; sends and wrong tries are limited per address, and requests per network address.
- Comments are tied to a spot on the page as it was. If the prototype changes, a pin may no longer sit on the thing it was about; the words under the pointer are kept with the comment for that reason.
- A page inside the prototype that opens a link in a new tab leaves review mode in that tab.
- On a phone the comments list sits under the prototype and takes part of the screen.

## API

Signed in, under the encrypted `/v1/` API, for the chat's own person:

| Request | What |
| --- | --- |
| `GET /v1/chats/<id>/prototype/shares` | Everyone it was shared with, and their comments. |
| `POST /v1/chats/<id>/prototype/shares` | `{ "email" }`: send a link. |
| `DELETE /v1/chats/<id>/prototype/shares/<share id>` | End one link. |

For the business owner, plain HTTPS with no account:

| Request | What |
| --- | --- |
| `GET /review/<link>` | The page. |
| `POST /review/<link>/code` | Email a code to the shared address. |
| `POST /review/<link>/verify` | `{ "challenge", "code" }`: returns a session, the prototype's address and their comments. |
| `GET /review/<link>/comments` | With the session: their comments. |
| `POST /review/<link>/comments` | With the session: `{ "page", "x", "y", "anchor", "text" }`. |

`node scripts/prototype-review-e2e.mjs` runs the whole exchange in real browsers against a temporary server, with the mailer replaced by a list, and saves the captures in `docs/shots/prototype-review`.
