# Email code sign-in

Joining Servant can require a six-digit code sent to a work email. Off by default.

Turn it on in `server/data/config.json`:

    "emailVerification": {
      "enabled": true,
      "domains": ["example.gov"],
      "mailer": { "command": "/path/to/send-mail.sh" }
    }

- `domains` (required when `enabled` is true): exact domain or a subdomain (`mail.example.gov`); look-alikes such as `example.gov.evil.com` are refused. There is no default domain: an empty or missing list lets nobody join with an email code, so list your organization's own domains.
- `mailer.command`: run with `/bin/sh -c`; gets JSON on stdin `{to, code, subject, text}`. Exit 0 = sent. The server never stores or logs the code.

Flow: invite link, terms, then `POST /v1/pair/email {code, email}` emails a code and returns a challenge id. `POST /v1/pair` then needs `emailChallenge` and `emailCode`. A correct code is used once; ten minutes; five wrong tries; five sends per address per ten minutes. The verified address is saved as `user.email` and `user.emailVerifiedAt`. The invite is still required: the code proves the mailbox, the invite proves you were asked.

`GET /v1/pair/email` tells a client whether it is required. Challenges live in server memory, so a restart means asking for a new code.

Not built: the mailer itself (needs an approved sending path, which is an owner call).

Signing in on another device when you already have an account:

- A sign-in link (You, then Link a computer, then Make a link; `POST /v1/sign-in-links`) is an invite for the existing person. It needs no email code, because it was made on a device that is already signed in. If an older app sends a code anyway it is checked and the address kept. `GET /v1/sign-in-links` tells the phone whether its newest link is `live`, `used` (with the `device` that used it) or `expired`.
- A dead link says why: `invite_used` (each link works once), `invite_replaced` (a new link cancels the old one), `invite_expired` (ten minutes), or `invalid_invite` (unknown). All are 403, as before, so older apps still show the message.
- Joining with the team link and a confirmed email, with a name that is already here, answers 409 `name_taken` plus `existing: { hasEmail }`. The name never hands the account over. If the account has no email, the app offers the two paths that prove control of it: approve the sign-in from a device that is already signed in (`/v1/device-links`, the same flow the Mac app uses), or paste a sign-in link made there. Once signed in, the app asks for the work email so the code alone signs in next time.

People who joined before email codes: while it is on, `GET /v1/me` returns `emailRequired: true` until they confirm an email, and the You tab shows "Confirm your work email". `POST /v1/people/me/email {email}` sends the code, `POST /v1/people/me/email/confirm {challenge, code}` saves it. An address someone else already confirmed is refused (`email_taken`). Once saved, joining with that email on a new device signs in as the same person.

Sessions that end (`sessionMaxHours`, docs/features.md "Sessions that end"): once a device's session is over, `POST /v1/session/email` (device token, no body) sends a code to the account's own confirmed address and returns `{challenge, email (masked), expiresInSeconds, resendAfterSeconds}`; `POST /v1/session/verify {challenge, code}` makes that same device fresh again. Same code format, ten minutes, five tries, five sends per address per ten minutes, per-address failure throttle as pairing; the challenge is bound to the device and the person. A held device gets 401 `session_expired` (403 for builds without the re-entry screen) on every other `/v1/` route except `/v1/signout`, and, when the account has no email yet, `POST /v1/people/me/email` and its confirm, which doubles as the re-entry. The mail for re-entry names the person and the device and carries no link.
