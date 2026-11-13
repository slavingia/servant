# Secure inbox

The secure inbox accepts public live conversations and gives signed-in team members a shared place to respond. Visitors can send messages and files without becoming members of the server. Each visitor credential opens exactly one conversation. Each conversation also has a private case workspace for the team. Messages and files never travel by email. When the owner sets up a mailer, a visitor who confirms an address gets a short email each time the team replies, with a private link back to the page; see [Reply emails](#reply-emails). No email is received.

## Enable and share

The `secureInbox` feature is on by default, independently of channels, direct messages and meetings. The explicit configuration is:

```json
{
  "features": {
    "secureInbox": true
  }
}
```

Set `publicUrl` to the server's direct HTTPS origin, for example `https://chat.example.gov`, and share that origin followed by `/contact`. The team opens **Cases** in Servant and copies the public link reported by the server. The origin must serve both `/contact` and `/v1/secure`; a subdirectory address is not supported. The optional stable relay serves encrypted API traffic, not this public HTML page, so relay-only deployments need a separate direct HTTPS origin for public contact. If the server has no supported public origin configured, the inbox explains that setup is needed instead of copying a broken link. A visitor enters a name, an optional contact email, a subject and their first message. Names and contact addresses are self-reported and are not proof of identity. Do not use them to authorize a sensitive action.

Replies appear while the conversation is open. Both sides can attach up to four files per message, no larger than 5 MiB each or 10 MiB in total. Files download as attachments rather than executing inside the page. Staff can assign a conversation to a teammate, leave it unassigned, resolve it or reopen it. A new visitor reply reopens a resolved conversation. Open, resolved and all filters, search and unread counts help the team work through the inbox. When a visitor writes, the team's phones are alerted as for a direct message: the assignee if the case has one, otherwise every team member. See [When a visitor writes to the secure inbox](notifications.md#when-a-visitor-writes-to-the-secure-inbox).

The visitor's browser remembers their private conversation credential. A saved recovery link can open the same conversation in another browser. Anyone holding that link can read and reply to that conversation, so treat it like a password. Its credential is in the URL fragment, which is removed from the address bar when opened and is not sent as part of the HTTP request. Clearing browser storage without keeping the recovery link or a reply email loses the visitor's access. An address alone cannot recover a conversation: the server emails the link only to an address the visitor confirmed from inside that conversation, and only when the team replies.

Set `features.secureInbox` to `false` to hide the inbox and refuse its public and authenticated routes. Messages and files remain stored; turning it back on restores access. Disabling the feature does not revoke existing visitor credentials.

## Work a case together

Start from an incoming visitor conversation, or choose **New case** to create a case proactively with a name, an optional contact email and a subject. A staff-created case starts empty and is assigned to its creator. Use **Copy visitor link** in Conversation when you are ready to give that person access. On a phone, open **Case details** for the owner, next action and visitor link. Anyone holding this private link can read and reply to the visitor conversation, so share it through an appropriate trusted channel. The link never grants access to team notes, files, follow-ups or activity.

Every conversation has a stable team-only reference such as `CASE-000001`. Search by that reference, the visitor's name, email or subject. Assign a case to a team member, and use the scope filters alongside Open, Resolved or All:

- **All cases** shows the shared inbox.
- **My cases** includes cases assigned to you and cases with an open follow-up assigned to you.
- **Unassigned** means the case itself has no owner.
- **Due follow-ups** includes cases with open work due today or earlier, using the server's UTC date.

Inside a case, **Conversation** contains messages shared with the visitor. **Team** contains private notes and files visible only to signed-in team members. The team composer says **Private to your team** and sends with **Add team note**. The visitor reply composer sends with **Send reply**. Switching tabs keeps each draft and its selected files in its own lane. A failed send keeps the draft for retry; a private note is never converted into a visitor reply. On a small screen, **Done writing** restores the tabs after focusing the composer; the audience remains labeled while you write.

Use **Follow-ups** to add the next step, assign an owner and choose an optional due date in `YYYY-MM-DD` format. Complete or reopen a follow-up as work progresses. The case's details and the list of cases show the open follow-up count and the next action; an overdue date is marked. In a wide window the details (the person, the owner, the next action and the visitor link) sit beside the conversation; on a phone or a narrow window they are under **Details**. Resolving a conversation does not delete its follow-ups or private notes. **Activity** records the team's case actions, including follow-up changes, with the actor and time.

Case references, notes, private file identifiers and bytes, follow-ups, owners, dates and activity never appear in visitor API responses. Private work also leaves the visitor conversation's last-message preview, update time and unread count unchanged. All signed-in team members can work the same case; assigning an owner helps coordinate work and does not make the case exclusive to that person.

## Reply emails

Without email a visitor has to remember to come back, because replies appear only on the page. With a mailer set up, the page offers to email them when the team replies.

1. The visitor gives an address, with their first message or later on the conversation page.
2. The server emails that address a six-digit code, and the visitor types it into the conversation they have open. This proves the person writing can read that mailbox, so a mistyped address gets one code it cannot use and never a link. A code works for 30 minutes and five tries.
3. From then on, when the team replies and the visitor has not read the reply on the page within a minute, the server emails them the team's name and their private return link. Several replies in that minute are one email. Someone reading along on the open page gets none.
4. The link opens the conversation on any device. **Stop emails** on the page turns them off.

The email never contains message text, the subject, a file name, a teammate's name or the case reference. Its link is the same private return link the team can copy. Anyone who can read that mailbox can read and reply to the conversation, and mail is not end-to-end encrypted. A private team note, a follow-up, assigning a case or resolving it never sends an email.

In a case, the details say whether the visitor will be told: "Emailed at … when the team replies", or that they see a reply when they come back to the page. A contact address reads **Confirmed** only when the visitor confirmed that same address. **Activity** records when reply emails were turned on or off, each one that was sent and to which address, and one that could not be sent.

Reply emails use the owner's mailer command, the same kind used for [email sign-in](email-sign-in.md) and [surveys](surveys.md), and need the direct HTTPS `publicUrl` that the email links to:

```json
{
  "publicUrl": "https://chat.example.gov",
  "secureInbox": {
    "mailer": { "command": "/path/to/send-mail.sh" },
    "noticeDelaySeconds": 60
  }
}
```

`secureInbox.mailer` defaults to `emailVerification.mailer`. Visitors may use any email domain; the domains allowed for staff sign-in do not apply. The command gets JSON on stdin and must send the subject and text it is given: `{to, subject, text, code, minutes}` for a code and `{to, subject, text, url}` for a reply. Exit zero means delivered. When a reply email fails or takes longer than 30 seconds the server tries again later; when a code fails the visitor is told it could not be sent. `noticeDelaySeconds` (default 60, at most 3600) is how long a reply waits unread before it is emailed. With no mailer, or without a public address, no email is sent and the page tells visitors there are no email notifications. Servant does not include a delivery provider.

A conversation and a mailbox can each be sent five codes an hour, and the server 200. A conversation can be sent six reply emails an hour, and the server 500. These limits survive a restart. Turning `features.secureInbox` off stops reply emails; a reply that was waiting is emailed when the feature is back on.

**Decision:** the secure inbox first shipped with no email at all, so a visitor was never told about a reply. Reply emails change that on purpose. What leaves the server is the address the visitor confirmed, the team's name and the visitor's own return link, and nothing from the conversation.

## Public browser trust decision

Existing member devices continue to use public-key pins delivered by trusted invites, as described in [App-to-server encryption](encryption.md). The public browser entry point adds a separate initial trust boundary: the visitor trusts the operator's HTTPS origin to deliver the first page, its JavaScript and the server's public key. The browser then pins that key for that origin and refuses an unexpected replacement. Production access requires HTTPS; loopback HTTP is allowed for local development.

All inbox requests, including first contact and file transfer, use the existing P-256/HKDF/AES-GCM encrypted transport at `/v1/secure`. Credentials, message text and file data are inside encrypted envelopes. The public page has no external scripts, analytics or third-party resources. There is no plaintext fallback, and the server's private key stays in its data directory.

This public entry point cannot provide the same independent key delivery as a trusted native-app invite. A party that can replace the public page or its JavaScript can read input before encryption or change its pinning logic; that includes a compromised serving origin or an actively malicious intermediary serving the page. The first HTTPS visit and subsequent executable page delivery are trusted. A modified web client, a compromised browser or a compromised server can read content. This decision does not change the member app's trust rules. The existing transport also does not provide forward secrecy or encryption at rest.

Visitor tokens grant no access to people, channels, direct messages, agent tools, team credentials, private case workspaces or other visitor conversations. A team file is accessible only through authenticated case-file routes; passing its identifier to a visitor file route does not expose it. Team replies require a valid member device session. Every signed-in member can access the shared inbox; assignment is a work queue aid, not an access restriction. A visitor's contact address is optional and self-reported. The server sends reply emails to an address only after the visitor types a code sent to it into their open conversation. It is never a login, and it proves nothing about who the person is.

## Storage and operational limits

Authored inbox messages, team notes, follow-up text, activity records and file bytes are immutable. Follow-up status, owner and due-date changes append an activity record in the same transaction; if recording the action fails, the change is refused. The feature provides no content-editing, deletion or retention action. Resolving, assigning, reading and disabling the inbox do not remove content. Any future destructive path must follow the existing [records preservation](records-management.md) transaction and refusal requirements. The inbox is not a records schedule or a compliance claim.

Back up `inbox.db` and `inbox-key` together with the rest of the private server data and the transport key. Keep its filesystem access restricted. A case holds up to 1,000 public messages and private notes combined, and 100 MiB of public and private file data combined. To continue after either limit, start another conversation; existing content stays readable. Public creation allows 10 conversations per connection address per hour and 100 total per hour. Sending allows 30 messages per actor per minute and 2,000 visitor messages per server per hour. A server also caps inbox storage at 1 GiB of public message text, private note and task text, file bytes and visitor metadata, 10,000 conversations and 100,000 public messages and private notes combined. Reaching a storage cap refuses new content with `inbox_full`; it does not remove old content, and reading or changing workflow metadata remains possible. Each case allows up to 200 follow-ups and 2,000 activity events; the server allows 20,000 follow-ups and 200,000 activity events in total. Task changes are limited to 60 per staff member per minute, and staff can create up to 100 cases per hour. Activity snapshots are additional bounded metadata governed by the event caps. Reaching an activity limit refuses changes that need a history record, preserving existing content. These limits persist across server restarts. Shared reverse-proxy addresses may share a rate limit; operators should also enforce appropriate limits at their trusted edge. Attachments are not scanned for malware. Downloading a file does not establish that it is safe to open.

This delivers public conversation intake, a shared team inbox, two-way replies and files, case ownership and references, private team notes and files, follow-ups with owners and due dates, activity history and resolution. It does not implement email ingestion, identity proofing, campaign automation, external CRM synchronization, advanced routing, service-level timers or a full customer-record system. It can replace workflows that only need this secure conversation loop; it is not a claim of complete CRM feature parity.

## Verification

Run server and app tests, the app typecheck and lint, and `bash scripts/scrub-check.sh`. The focused browser check starts an isolated server and an Expo web app, uses only synthetic people and files, and exercises public and staff screens:

```sh
node scripts/secure-inbox-e2e.mjs
node scripts/secure-inbox-cases-e2e.mjs
node scripts/secure-inbox-reply-email-e2e.mjs
```

It requires the app dependencies, the desktop Playwright dependency and an installed Chromium browser. `SERVANT_E2E_BROWSER=chrome` selects installed Chrome. `SERVANT_INBOX_WEB_URL` can point to a development server for this checkout. The case check uses two staff browsers and a separate visitor to verify private collaboration, follow-up ownership and completion, draft separation, scope filters, restart persistence and the absence of private data from all visitor responses. The reply email check follows one visitor from their first message through the code, a reply email read on another device, their answer and **Stop emails**, with mail written to a file by a mailer command instead of being sent. Screenshots are written to the gitignored `desktop/dist/secure-inbox-e2e/`, `desktop/dist/secure-inbox-cases-e2e/` and `desktop/dist/secure-inbox-reply-email-e2e/` directories.
