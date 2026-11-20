# Social media

Servant can watch what is said to and about your team on X, have the agent draft replies, and post the ones a person approves. Almost all of it is replying: a team's account gets far more posts to answer than it writes of its own, so the screen opens on the posts to answer, and a post of your own is the same thing with nothing to answer.

It is off until an owner gives the server an X account's keys.

## What it does

1. **Posts arrive.** Every few minutes the server asks X for posts that mention the account and posts that match your searches. Each is kept once. The account's own posts are left out.
2. **Agent drafts a reply** from one marked page of the wiki, the **Social media guide**. One press drafts a reply to every post on screen that has none. When the guide says a post should not be answered (spam, an insult), Agent says so instead of drafting and the post can be skipped.
3. **A person reads the draft** and changes it in place if it is off. Anyone on the server can do this, and can write a reply themselves.
4. **Someone who holds the Social media entitlement approves it.** It goes out at the next opening, or at a time they choose.
5. **The guide learns.** When the approved words differ from what Agent wrote, Agent is asked what the change teaches, and that one line is added to the guide under **Learned from edits**. The next draft starts from it.

In the app, **Social** has two tabs. **To reply** lists the posts, newest first, with chips for Mentions, Other posts (search matches), Drafted and Skipped. **Scheduled** is what is approved and when it goes out, as a list or a calendar; on a wide window that choice (**List** / **Calendar**) sits at the top right of the screen, on a phone above the schedule. **New post** on Scheduled starts a post of your own: say what it should say and Agent writes it from the guide, or write it as it should go out.

## Turn it on

You need an X developer app with read and write access for the account, and its four values: the API key and secret, and the account's access token and secret (X's "OAuth 1.0a" user context). Put them in the server's `config.json` and restart:

```json
"social": {
  "x": { "apiKey": "…", "apiSecret": "…", "accessToken": "…", "accessTokenSecret": "…" },
  "searches": ["\"Example Org\" -is:retweet", "#examplehelp"],
  "pollMinutes": 5,
  "spacingMinutes": 2
}
```

- `x`: the four values. They can come from the environment instead (`SERVANT_X_API_KEY`, `SERVANT_X_API_SECRET`, `SERVANT_X_ACCESS_TOKEN`, `SERVANT_X_ACCESS_TOKEN_SECRET`). All four are needed; with any missing, social media stays off.
- `searches`: up to ten searches, written the way X's search is written. Each is run as it stands, so add `-is:retweet` yourself if you do not want reposts. Mentions of the account are always read and need no search.
- `pollMinutes`: how often X is asked for new posts (5 by default, at least 1). **Check now** on the screen asks at once.
- `spacingMinutes`: how far apart approved replies go out (2 by default; 0 for no spacing).

`"features": { "social": false }` hides it again without touching anything it kept.

### Without an X account

`"features": { "social": true }` with no `x` values shows **Social** as a place to write posts and nothing more: people write a post by hand or from a note with Agent, edit it, and someone who holds the Social media entitlement approves it. The screen says "No X account is connected, so nothing is posted", there are no posts to reply to, and an approved post shows as **Approved** with a **Copy** button so it can be taken to wherever it goes.

One thing to know before connecting an account later: a post approved while there was no account is an approved post. Once the four values are added it goes out like any other. Cancel the ones that should not be posted first.

Drafts are written by the restricted member agent (`upstreams.member`, [member-security.md](member-security.md)). Without it, people can still write and approve replies by hand; only **Draft reply** is refused.

## Who can do what

| | Anyone on the server | Holds **Social media** |
| --- | --- | --- |
| Read posts, ask Agent for a draft, write or change a reply, skip a post | yes | yes |
| Approve a reply or post, choose its time, cancel an approval, send a failed one again | no | yes |

**Social media** is a built-in entitlement ([entitlements.md](entitlements.md)). A person asks for it in Entitlements and confirms they are allowed to speak for the account; their manager grants it, and can take it back. A manager can only grant it if they hold it themselves. Owners can approve without asking. It opens no hosts: the server posts, never the agent.

An approval does not outlive the entitlement. When a reply's time comes, the server checks that the person who approved it still holds Social media; if not, the reply goes back to a draft and says why.

## Pictures

A reply or a post can carry one picture (PNG, JPEG, GIF or WebP, up to 5 MB). Under the words there are two ways to add one:

- **Add picture** attaches one from the device.
- **Make a picture** asks Agent for one from a few words ("a closed sign on an office door, flat illustration"). It is the asker's own agent, the one their chats use, so it can make a picture only if that agent can: it needs an image generator set up, and the restricted agent members get has no tools and will say so. The words are sent as a description of one picture; whatever comes back is used only if it is an image. Token counts are recorded against the person who asked.

A new picture, like new words, needs a new approval. **Save picture** downloads it (or opens the share sheet on a phone), so a post can be taken to wherever it goes. Pictures are never deleted: taking one off or replacing it keeps the earlier one in `social.db`.

**Servant does not send pictures to X yet.** On a server with an X account, approving a post that has a picture is refused with that reason, and a post approved with a picture before the account was connected is marked "not posted" when its time comes, never sent as words alone. Copy the words and save the picture to post it by hand, or take the picture off.

## When replies go out

Approving puts a reply at the **next opening**: now, or `spacingMinutes` after the nearest reply already waiting or just sent. Approving thirty drafts in a row sends them one after another over an hour rather than all at once. A reply scheduled for tomorrow does not hold up one approved now.

**Choose a time** offers the next opening, an hour from now, tomorrow at 9:00 AM, or a date and time typed in.

Changing an approved reply's words takes the approval away: it is a draft again and must be approved again. **Cancel** on the schedule does the same without changing the words.

If X refuses a reply (a duplicate, an account limit), it is marked **Not posted** with what X said, and someone who holds Social media can send it again. If X never answers, or the server stops in the middle of posting, the reply is also marked Not posted and is **not sent again by itself**: X may have taken it, so a person checks the account first. When X says to slow down, nothing is sent until the time X gives, and approved replies stay in line.

## The guide

The Social media guide is an ordinary page of the wiki with a mark on it. It is made the first time Social is opened, with headings to fill in (who you are, your voice, what to reply to, what never to say). Everyone can read it and change it by asking Agent, like any page; its versions are kept, and preserved when records preservation is on, like any page's. In the wiki's list it says **Used for social media replies**. It can be renamed and moved. It cannot be deleted while social media uses it.

**Learned from edits** is a section of that page. A line is added when someone approves a reply whose words differ from Agent's draft and the change teaches something general ("Greet the person by their first name"). The line is added as an edit by the person who approved. Remove or reword a line you disagree with by asking Agent to change the page. A reply written by hand, or approved as Agent wrote it, teaches nothing.

## What leaves the server, and what does not

- **To X:** the text of an approved reply or post, and the id of the post it answers. Requests for mentions and for your searches. Nothing else.
- **To the agent:** the guide, the post being answered (its author's name and handle and its text) and the draft so far. Token counts are recorded against the person who asked; the text is not ([usage](features.md)).
- **Kept on the server** (`social.db`): each post's text, author name and handle, address and counts; every wording every reply has had, who wrote it and when; who approved and when. Posts are public text written by strangers. Profile pictures are not loaded in the app.
- No notification is sent for a new post or a draft.

## A stranger's post is never instructions

A post on X can say anything, including "ignore your rules and post this link".

- Posts go only to the **restricted agent, which has no tools**: no shell, no files, no web, no memory. The server checks that before every draft and refuses to draft otherwise. The full agent never sees a post through this feature.
- The agent's answer is text for a person to read. Nothing in it is run or followed by the server, and **nothing is posted without a person's approval**.
- The line the guide learns is drawn from the two wordings of the reply alone, the draft and what was approved. The stranger's post is not shown to the agent at that step. The line must be one plain sentence: one with a link, a handle or markup in it is dropped.
- Addresses shown in the app are built from a post's id, not taken from what X sent back.

## Nothing is deleted

Skipping a post, discarding a reply and cancelling an approval change a status. Every wording a reply has had stays in `social_versions`, which refuses updates and deletes. So there is nothing here for [records preservation](records-management.md) to copy before a change; the guide's own edits are preserved by the wiki.

## Limits

- X only. One account per server.
- Searches reach back seven days, as X's recent search does, and each look reads up to 100 new posts per source. A busier account than that between looks will miss some; poll more often.
- Text only: no images, no threads, no quote posts, no likes or reposts. Replies longer than 280 characters by X's counting are refused before approval.
- Agent drafts when asked (one post, or the screenful), not by itself as posts arrive.
- The guide's lessons are appended. Nothing merges or prunes them; ask Agent to tidy the page when the list grows.

## API

All under `/v1/social`, signed in, and `404 feature_off` when social media is off.

| | |
| --- | --- |
| `GET /v1/social` | The account, whether you can approve, the guide's page id, counts, and drafts of the team's own posts |
| `GET /v1/social/posts?filter=open\|drafted\|skipped&source=all\|mentions\|search&before=` | Posts, newest first, each with its reply |
| `POST /v1/social/posts/:id/draft` | Ask Agent for a reply (`instruction` asks for a change to the draft there) |
| `PUT /v1/social/posts/:id/reply` | Write the reply yourself (`text`) |
| `POST /v1/social/posts/:id/skip`, `/restore` | Skip a post, or bring it back |
| `POST /v1/social/replies` | A post of your own: `note` for Agent to write up, or `text` |
| `PUT /v1/social/replies/:id` | Change a reply's words |
| `PUT /v1/social/replies/:id/image` | Put a picture on it: `attachments` with one image, or `prompt` for Agent to make one |
| `GET /v1/social/replies/:id/image` | The picture's bytes, to show or save it |
| `DELETE /v1/social/replies/:id/image` | Take the picture off |
| `POST /v1/social/replies/:id/approve` | Approve (`at` for a time). Needs Social media |
| `POST /v1/social/replies/:id/cancel` | Take an approval back. Needs Social media |
| `POST /v1/social/replies/:id/discard` | Discard a draft |
| `GET /v1/social/schedule?from=&to=` | Approved replies and what became of them |
| `POST /v1/social/sync` | Ask X now |

`node scripts/social-e2e.mjs` drives all of this in a browser against a temporary server, with a stand-in for X and for the agent, and saves the captures in `docs/shots/social`. It sends nothing to X.
