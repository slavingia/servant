# Email code sign-in

Joining Servant can require a six-digit code sent to a work email. Off by default.

Turn it on in `server/data/config.json`:

    "emailVerification": {
      "enabled": true,
      "domains": ["irs.gov"],
      "mailer": { "command": "/path/to/send-mail.sh" }
    }

- `domains`: exact domain or a subdomain (`mail.irs.gov`); look-alikes such as `irs.gov.evil.com` are refused. Defaults to `irs.gov`.
- `mailer.command`: run with `/bin/sh -c`; gets JSON on stdin `{to, code, subject, text}`. Exit 0 = sent. The server never stores or logs the code.

Flow: invite link, terms, then `POST /v1/pair/email {code, email}` emails a code and returns a challenge id. `POST /v1/pair` then needs `emailChallenge` and `emailCode`. A correct code is used once; ten minutes; five wrong tries; five sends per address per ten minutes. The verified address is saved as `user.email` and `user.emailVerifiedAt`. The invite is still required: the code proves the mailbox, the invite proves you were asked.

`GET /v1/pair/email` tells a client whether it is required. Challenges live in server memory, so a restart means asking for a new code.

Not built: the mailer itself (needs an IRS-approved sending path, which is an owner call), and sign-in for people who already joined (new devices still use link-a-computer).

People who joined before email codes: while it is on, `GET /v1/me` returns `emailRequired: true` until they confirm an email, and the You tab shows "Confirm your work email". `POST /v1/people/me/email {email}` sends the code, `POST /v1/people/me/email/confirm {challenge, code}` saves it. An address someone else already confirmed is refused (`email_taken`). Once saved, joining with that email on a new device signs in as the same person.
