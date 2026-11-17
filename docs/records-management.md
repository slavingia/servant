# Records preservation

Messages, agent chats and recordings in Servant can be **federal records**. Under the Federal Records Act (44 U.S.C. chapters
31 and 33, and NARA's rules at 36 CFR chapter XII, subchapter B), an agency may not destroy a federal record except under a
NARA-approved schedule, and messaging that meets the definition of a record has to be captured and managed. 44 U.S.C. 2911
adds duties for messages sent through non-official accounts. Unscheduled records are treated as permanent until NARA approves
a disposition.

**This feature does not make Servant compliant, and it does not decide what is a record.** That is a determination for your
agency's records officer, your general counsel and NARA. What it does is stop Servant itself from being the thing that quietly
destroys content. It is off by default. Turn it on in `config.json` (read per request, no restart):

```json
"recordsPreservation": { "enabled": true }
```

## What it does

When on, the content a person authored is **copied into an append-only archive before** it is edited, deleted or dropped. The
copy is made in the same database transaction as the change, so they succeed or fail together: if the archive cannot be written,
**the edit or delete does not happen** and the person is told ("This can't be changed or deleted right now because its record
could not be saved"). People see no difference otherwise: an edited message shows the edit, a deleted one disappears.

| What happens | What is kept |
|---|---|
| A message is **edited** | the wording before the edit, who wrote it, who edited it, when |
| A message is **deleted** (by its author or the owner) | its text, author, time, thread, attachments (the bytes), and who deleted it |
| A **DM or channel is deleted** (by a participant, the creator or the owner) | every message in it, with authors and times, its name and topic, whether it was private, and who was in it |
| An **agent chat is deleted** | its messages and attachments, every prompt and reply, and the chat's title, owner and share state |
| A chat message **disappears from the agent's own history** (the mirror used to delete its copy) | the message, archived first; if archiving fails the copy is left alone |
| An agent turn **ends** | the full approval record (what the agent asked to run, and the person's allow or deny decision) and the names, types and sizes of what was attached, which used to be blanked |
| A **personal recording** is deleted | hidden from the person, but the audio, transcript and notes stay |
| A **to-do** is edited, deleted, or removed with its recording | its full earlier row (type, priority, estimate, description and epic included; for a deleted to-do, its comments too) is copied into `records_archive` in `messages.db`, in the same transaction as the to-do change; archive failure refuses the change |
| A **project file or project** is deleted | moved into `project-files/.removed/`, out of view and out of every listing |
| A **wiki page** is edited or deleted | its title and Markdown text as they were, who last wrote them, who changed or deleted the page, when. Moving a page under another changes neither, so it archives nothing |

The archive lives in `messages.db` (`records_archive`, `records_archive_files`). It cannot be edited or erased through SQL:
triggers refuse `UPDATE` and `DELETE`. Each entry also carries the hash of the one before it and its own hash, so a change made
by someone with direct access to the file is **detectable**.

## For the records officer

Secure case messages, team notes, attached file bytes, task wording, and case activity remain in `inbox.db`. The case workspace has no edit or delete path for authored content. Task status, assignment and due-date changes append a full before/after record in the same transaction as the change; if that record cannot be written, the change is refused. SQL triggers reject changing or removing the original notes, files, task wording and activity records. This applies with preservation on or off. Disabling `secureInbox` hides these records without deleting them.

These originals and activity records are kept in the live inbox database, separate from the hash-chained `records_archive` export in `messages.db`; the case activity log is not claimed to be hash-chained. Include `inbox.db`, `inbox-key` and the rest of the private server data in backups. This adds no records schedule, retention policy or disposition action.

Saved-task work notes and original completion times stay in `saved_message_completions` in `messages.db`. Reopening records a separate time; removing a saved reference or deleting its source message leaves this work log intact. SQL triggers reject rewriting the authored notes or original times and reject deleting completion entries. This applies with preservation on or off. Because there is no path to edit or delete the notes, their original content stays in the live database rather than being copied into `records_archive`. Backups of `messages.db` include both. The personal **Work log → Copy to clipboard** action exports only that person's selected completion history and currently accessible source information.

To-do completion events also stay in `messages.db`: their original times, participants and actor kind cannot be rewritten or deleted, and a reopening adds its own time. They remain after the current to-do is removed. Uploaded-recording events are immutable in `recordings/recordings.db`. Include this database in backups. These events store identity and timing metadata, not copies of transcripts or source content. Work-log reads recheck current access; removed sources become unavailable. This personal clipboard export is separate from the records archive export below.

```sh
node server.mjs records status          # on or off, how many entries by kind, whether the chain is intact
node server.mjs records verify          # recompute every link and attachment checksum; exits 1 if anything changed
node server.mjs records export [dir]    # records.jsonl (oldest first), files/, and a MANIFEST.txt, all readable only by you
```

An export has one JSON object per line. Each has the event, conversation (id, kind, name), author, the person who acted, the
text, the original time, when it was preserved, and its two hashes. Attachment files are in `files/`, with sizes and SHA-256 in
the entries. The export is a copy of what Servant held; it is not a finding about what is or is not a record.

## What it does not do

Read this part before relying on it.

- **It is not a records schedule.** Nothing is ever deleted from the archive. There is no retention period and no disposition.
  Applying your agency's NARA-approved schedule (and destroying anything on schedule) is the agency's job and is not built.
- **It does not decide what is a record.** It preserves everything people wrote that gets edited or deleted, record or not. That
  is the cautious default, and it also means the archive holds casual chat and anything sensitive someone pasted. Servant is still
  not approved for sensitive information.
- **It only captures what is edited or deleted.** Content that is never changed stays where it always was, in the live
  databases. It is a **preservation hook, not a capture system**: it does not export messages to your records system as they are
  sent, and it does not replace one.
- **Someone with the database file can still alter it.** The hash chain makes a change detectable by `records verify`; it does
  not prevent it. For real tamper resistance, export regularly and keep the exports somewhere write-once.
- **Copies elsewhere are not reached.** A deletion here does not reach, and preservation does not capture: the agent's own
  transcript upstream in Hermes (for channel and DM `@agent` threads it is never deleted, and for agent chats the delete is
  best-effort), forwarded copies, push notification previews on devices, the GitHub issue a feedback report becomes, or your own
  backups. If those matter for a record, they are outside this feature.
- **It is not retroactive.** Anything destroyed before you turned it on is gone.
- **Agent chats with no mirrored copy.** If the agent's history never returned a message to Servant, only the upstream transcript
  holds it.
- **Three paths still reduce content and are not archived**, because they change what is *stored* rather than what a person
  *deleted*: posts and edits are cut to 8,000 characters, recording notes are condensed by design, and the agent's
  progress steps keep the last 40. Raw recording audio is kept (see above), so the full content survives there.
- **Not tested with a real records system, and not reviewed by a records officer or counsel.** Treat the claims in this file as
  engineering statements about the code.

## Turning it on is a decision for your agency

- It increases what the server keeps. Tell people: the app does not say that deleted messages are retained, and it should, in your
  terms of use, before you rely on this. (Today the app shows "delete" and the message disappears from view.)
- It makes deletion a request to hide, not an erasure. That may conflict with a person's expectation or another rule (a privacy
  request, a legal order to destroy). Decide who can approve a true deletion; none is built, deliberately.
- Back up `messages.db` and the data directory. The archive is only as safe as the disk.
