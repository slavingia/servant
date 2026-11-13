# Sign in with a federal identity (Login.gov first, PIV and Active Directory later)

Status: proposal with research. Nothing here is built yet.

## Recommendation

Start with **Login.gov plus a federal-email check**, and build it as generic OpenID Connect (OIDC) so an agency identity provider can be added later with no new server design.

- Login.gov already does the hard part: verified email, a required second factor, and an option to require a PIV or CAC card.
- Servant can then admit a person when a verified email on their Login.gov account is on the official federal `.gov` list. No agency IT project is needed to get going.
- Agency Active Directory (Microsoft Entra ID with certificate-based sign-in, or AD FS) is the later step for teams that need their own directory, groups or disablement. It is the same OIDC flow with a different issuer.

## What the US government uses

From the sources I read (links at the end):

| Option | Who it is for | What it gives Servant | Catch |
| --- | --- | --- | --- |
| Login.gov | Public and federal workforce sites; shared across many agencies | OIDC with PKCE (the method Login.gov recommends for native mobile apps) or `private_key_jwt` (recommended for web). Verified email, a second factor always, optional PIV/CAC | Needs a Login.gov partner onboarding (team and app in their partner portal). I did not confirm the approval steps or any cost |
| Agency IdP (Entra ID, AD FS, Okta, Ping) with PIV/CAC | One agency's own staff | Directory identity, groups, account disablement, certificate sign-in enforced by the agency | Needs the agency to register the app and agree to it. One tenant per agency |
| Direct card reading in the app | Nobody | Nothing, an app should not read the card | Do not build it |

Microsoft Entra certificate-based authentication is a free Entra feature. It works through the browser (web apps and phone browsers) and with Conditional Access, and the admin decides by certificate issuer or policy OID which certificates count as multi-factor. That is how PIV-backed Entra sign-in is normally enforced.

## Login.gov facts this design relies on

- **Discovery:** sandbox `https://idp.int.identitysandbox.gov/.well-known/openid-configuration`, production `https://secure.login.gov/.well-known/openid-configuration`.
- **Client auth:** PKCE for native apps, `private_key_jwt` for a web server. Servant's phones and Mac app are native, so PKCE; the server verifies the ID token itself.
- **Assurance (`acr_values`):**
  - `urn:acr.login.gov:auth-only` means email, password and a second factor, no identity proofing. This is enough for "prove you own a federal email."
  - `http://idmanagement.gov/ns/assurance/aal/2?hspd12=true` requires a PIV or CAC card.
  - Verified identity levels exist (`verified`, `verified-facial-match-required`) but Servant does not need them.
- **Attributes (by scope):** `email` (one address), `all_emails` (every address on the account), `x509` / `x509:subject` / `x509:issuer` (the card's certificate details when a PIV/CAC was used), and the stable `sub` (a UUID). `email_verified` is always true: Login.gov only supports verified emails.

## Detecting a federal email

A Login.gov account can hold several verified emails, so ask for `all_emails` and decide on those, not just `email`.

1. **Match the domain against the official list, not a `.gov` suffix.** A bare `.gov` check would admit city, county, state, tribal and special-district staff. In CISA's published `.gov` data (cisagov/dotgov-data, `current-full.csv`, read 11/05/2026) there are 17,025 domains and only 1,319 are federal: 1,172 executive, 121 legislative, 24 judicial and 2 other. The rest are city (9,599), county (3,061), state or territory (1,488), special district (1,158), tribal (294), school district (77) and interstate (29). `current-federal.csv` is the federal-only file; it includes, for example, `gsa.gov` and `treasury.gov`. Decide which federal branches count (executive only, or all federal).
2. **Match the exact domain or a subdomain of a listed domain** (`name@example.gov`, `name@mail.example.gov`), never a substring.
3. **Federal does not mean the whole federal workforce.** Contractors usually have non-`.gov` addresses, and the military uses `.mil`, which this list does not cover. Make the allowed domains an owner setting, so `.mil` or a named contractor domain can be added deliberately.
4. **An email proves a mailbox, not employment.** Someone who leaves an agency may keep Login.gov access to that address until the agency removes it. Treat it as "can read mail at that address," and let the owner remove people (Servant already does this and revokes every device).
5. **Higher bar when it matters.** Ask for the PIV/CAC `acr_values` on the owner's own sign-in and when adding a new device, and keep the card's certificate subject (`x509_subject`) as extra evidence.

The domain list should be refreshed on a schedule (it changes), cached on the server and versioned in the audit trail, with a manual owner override.

## How it fits Servant

Today, joining is `POST /v1/pair` with an invite code and a typed name. Keep that. Add one route:

1. `POST /v1/pair/oidc` takes the authorization code and PKCE verifier. The server exchanges it, verifies the ID token (signature from the issuer's JWKS, `iss`, `aud`, `exp`, `nonce`), and reads `sub`, `all_emails` and the assurance level.
2. The user is keyed on `{issuer, sub}`. Name and email are display hints, never the key.
3. The owner chooses the join rule: invite required (a federal email only proves who you are), or a federal email is enough to join as a member. Default stays "invite required."
4. The device then holds an ordinary Servant token, so push, offline use and the encrypted transport do not change.
5. Terms acceptance and the pairing rate limit apply as they do now.

The same route works for an agency IdP later: configure another issuer, with `groups` or `upn` claims instead of an email-domain rule.

## Open questions

- Login.gov partner onboarding: who submits it (it needs an agency sponsor), how long it takes, and any cost. I could not confirm these from public pages.
- Does the owner want "federal email is enough to join" or "must also have an invite"?
- Are `.mil` and named contractor domains in scope?
- Phones: the PIV/CAC path on a phone needs a derived credential or a card reader. Login.gov's non-card second factors work on phones today.

## Build order

1. Server: OIDC verifier with tests against a mock issuer (discovery, key rotation, wrong `aud`, expired, replayed nonce) and a federal-domain matcher with tests (exact, subdomain, look-alike such as `example.gov.evil.com`, `.mil`, city `.gov`).
2. `POST /v1/pair/oidc` and the user fields, with integration tests beside the pairing tests.
3. App and Mac: "Sign in with Login.gov" next to the invite code, in the system browser.
4. Owner settings: join rule, allowed domains, require card for the owner and new devices.
5. Docs: add the external flow to `docs/ato-data-flows.md` and `docs/member-security.md`. This changes authentication and needs the owner's security review.

## Not in scope

Reading the card directly, storing certificates or PINs, ID proofing, or any claim of FedRAMP or ATO coverage.

## Sources read

- Login.gov developer guide: getting started, authorization (`acr_values`), attributes, user info (`developers.login.gov`).
- Microsoft Learn, Microsoft Entra certificate-based authentication overview.
- CISA `.gov` domain data, `current-full.csv` and `current-federal.csv`.
- IDManagement.gov PIV 101 (background only).
