# Surveys and the feedback queue

Surveys collect private feedback. Open **Surveys** in the desktop sidebar or
**You → Workspace → Surveys** on a phone. Each survey currently has a name,
a question, five faces scored 1–5 and an optional comment. Results show the
response count, average and distribution. **Feedback queue** shows individual
responses, private reply addresses and internal review notes.
Rampart Edge removes detected personal information from submitted comments
before they are saved.

## Access

| Person | Access |
| --- | --- |
| Administrator (server owner) | Create and edit surveys, open or close collection, view results and manage feedback |
| User researcher (tier 4) | Create and edit surveys, open or close collection, view results and manage feedback |
| Business owner (tier 2) | View surveys, results and feedback; cannot create, edit, review or delete |
| Other members | No access to private surveys, results or feedback |
| Respondent | Open a shared survey, verify an email, submit feedback and read their own response |

These permissions are enforced by the server, including after an uploaded
request body finishes. Read-only access cannot be turned into editing access
by calling an endpoint directly.

The survey link is public so people can respond without joining Servant.
**Responses, contact addresses and results are not public.** A respondent must
verify an email address using a single-use magic link before submitting. Any valid email
domain is accepted. This verification does not grant membership or access to
chats, staff tools, results or anyone else's responses. There is one response
per verified mailbox per survey. Closing a survey stops new responses; a
verified respondent can still read their own saved response.
The verified address is retained privately so the team can reply.

Researchers and administrators can mark feedback Pending, Reviewed or Hidden,
track its status as Open, Planned or Resolved, and add an internal team note.
These review details and notes are visible only to authorized staff, including
business owners with read access. They are not shown to respondents and do not
send email notifications. Hidden feedback remains available to authorized
staff and still counts in results.

**Reply by email** opens the researcher's or administrator's email app with the
stored address and survey title. The person writes and sends the reply there;
the response text is not copied into the email link. Saving a **Team note** only
saves an internal note. Business owners can view the address but have no reply
action. Legacy responses without a stored address remain readable and have no
email reply action.

There is no public feedback board, publishing or voting. Previously published
responses are treated as reviewed internally and are no longer exposed through
public routes. Existing feedback and legacy vote records are retained; the
old voting endpoints are unavailable. Rating-only responses count in results.

## Public hosting and email

The API serves the public page at `/s/<survey-id>` and its browser endpoints at
`/public/surveys/<survey-id>`. These routes use HTTPS and a separate scoped bearer
session. Staff management stays on the encrypted, authenticated `/v1/surveys`
API. No existing staff sign-in or allowed-domain rules change.

Set a stable HTTPS address that reaches this server and a delivery command in
the server's private `config.json`:

```json
{
  "surveys": {
    "publicUrl": "https://feedback.example.org",
    "mailer": { "command": "/path/to/send-mail.sh" }
  }
}
```

`surveys.publicUrl` defaults to `publicUrl`. `surveys.mailer` defaults to
`emailVerification.mailer`, but public surveys always allow all email domains
and always require verification, even when staff email verification is off.
The sender receives JSON on stdin with `to`, `subject`, `text`, `url` and
`minutes`; it must use the supplied subject and text (there is no six-digit
`code` for this flow). Exit zero means delivered; failures and a 30-second
timeout return a generic error without exposing provider diagnostics. Servant
does not include a delivery provider. No mail is sent when the configuration is
missing.

The encrypted-only stable relay (`/hubs/<id>`) cannot serve public survey pages.
For a relay installation, configure `surveys.publicUrl` to a separate HTTPS
reverse proxy or tunnel to the API. The interface does not generate a share link
from a relay-only address. Loopback HTTP is allowed for local testing. A URL
prefix is supported when the reverse proxy strips the prefix before forwarding
to this server. Do not log request bodies or authorization headers at the proxy.
Restrict direct origin access and have the trusted ingress replace, rather than
forward caller-supplied, `CF-Connecting-IP` headers so IP rate limits cannot be
bypassed by spoofing that header.

Magic tokens live in a URL fragment rather than the query string. The page
removes the fragment immediately and exchanges the token only when the person
presses **Verify email**, so merely fetching a link does not consume it. Links
expire after ten minutes, and survey sessions expire after 24 hours. A new link
reopens the same person's response. Mail sends are limited per mailbox and IP;
the budgets survive a server restart.

## Personal information

Forms ask people to keep personal and account information out of comments.
Every nonempty submitted comment passes through the local
[Rampart Edge span redactor](https://github.com/nationaldesignstudio/rampart-edge#span-redactor)
before storage. Detected names, contact details and other personal identifiers
are replaced with `[REDACTED]`, preserving the remaining feedback. Additional
survey rules remove all email domains and long numeric identifiers, including
values written with full-width characters or hidden separators. Survey titles,
questions, staff edits and team notes retain their existing identifier rejection
checks. The separate verified email field remains available privately for replies.

Install the pinned Rampart Edge runtime, model and vocabulary using the
[server model setup](features.md#a-warning-before-personal-information).
Survey redaction always runs, independently of the optional `piiWarning` chat
setting. Model and vocabulary checksums must match the installed package's pins;
no text or model request goes to an external service. Surveys do not fall back to
the chat warning's rules-only mode. If loading or redaction fails, the server
returns `503 survey_pii_unavailable` and saves no response, so the person can
retry. Rating-only submissions do not need inference.

Only sanitized comment text is written to `surveys.db` and returned to the
respondent or authorized staff. The raw comment is processed in request memory;
it is not copied to an archive or logged. Intake redaction happens before a
response is accepted. A keyed fingerprint of the original payload supports
idempotent retries without storing its original text. Exact retries return the
saved response even if the model is later unavailable, while changing personal
details under the same request ID is rejected. Existing responses are not
rewritten by this change.

Detection can miss personal information or remove harmless text; it does not
guarantee that a comment is free of PII. Authorized staff should review written
responses for personal information.
Researchers and administrators can delete a response if it contains information
that should not be retained. Deletion also removes the response's contact
address, any legacy votes and the response rating from results. Administrators
remain responsible for server backups, delivery-provider records and email
correspondence.

**Contact storage:** `surveys.db` retains the email address on the verification
challenge, survey session and submitted response so authorized staff can reply.
The response's address comes from the verified session; an address supplied in
the submission body cannot replace it. The database and its backups therefore
contain contact information. This extends the earlier verification-only use of
email. Older challenges and sessions without a stored address continue to work
without inventing a contact address. Existing responses are preserved, including
unverified contact addresses from earlier submissions; verifying that same
address does not grant access to an earlier unverified response. Expired
challenges and sessions are removed during later verification requests and new
submissions, rather than by a background timer.

The database also stores survey-specific keyed mailbox identifiers, hashed
magic/session tokens and keyed rate-limit identifiers; raw IP addresses are not
stored. The mail provider receives email addresses to deliver links.
Identifiers are pseudonymous, not a guarantee of anonymity. Raw free-text drafts
may briefly exist in the respondent's tab session storage to preserve them while
verifying; they are cleared after successful submission. There are no analytics
or external scripts on the public page.

## Checks

```sh
node --test server/survey-pii.test.mjs server/surveys.test.mjs server/surveys-http.test.mjs server/survey-page.test.mjs
```

The HTTP test uses a throwaway real server, encrypted staff requests and injected
email/redaction fixtures. It walks creation, public access, verification, submission,
private review, results, internal notes, editing, closing and deletion. It checks
role permissions, authorization changes during uploads, verified contact-address
isolation, unavailable voting endpoints and that public credentials cannot reach
the staff API. The other tests cover model failures and output validation,
identifier redaction, expiry or closure during inference, concurrent submissions,
keyed retries, persistence, rate limits, legacy published-response privacy and
browser client behavior. A real-model test can run with `SERVANT_PII_REAL=1`
when the pinned local model is installed.
