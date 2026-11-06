# Sign in with a PIV card (federal identity)

Status: proposal. Nothing here is built yet.

## What this is

Today a person joins Servant with an invite link or code, types their own name, and the server hands their device a token (`POST /v1/pair`, `server/server.mjs`). Nothing proves who they are beyond holding the link. For federal teams the goal is to prove it with the identity they already have: a PIV or CAC card, backed by the agency's Active Directory.

## How PIV actually works for an app

An app does not read the card. The card signs in at the **identity provider** (IdP), and the app trusts the IdP's answer. So Servant needs to be an OpenID Connect (OIDC) client of the agency IdP, not a smart card reader:

| Where | What happens |
| --- | --- |
| Mac app and web | The sign-in opens the IdP in the system browser. The browser does the TLS client-certificate step with the card, the IdP issues an ID token, and the app gets it back through a loopback or `servant://` redirect. |
| Phone | Same flow in the system browser sheet. Phones have no card reader, so this relies on the agency's derived PIV credential (Intune or a similar manager) or a remembered session at the IdP. |

IdPs this covers with the same code: Microsoft Entra ID (Active Directory) with certificate-based authentication, AD FS, Okta or Ping set up for PIV, and Login.gov or agency ICAM. Servant never sees the card, the PIN or the certificate.

## Proposed design

1. **OIDC authorization code with PKCE.** One configured issuer, client ID and allowed domain in `server/data/config.json`. Discovery from `/.well-known/openid-configuration`; signature check against the issuer's JWKS; `iss`, `aud`, `exp`, `nonce` all verified on the server. No client secret on devices.
2. **A stable identity key.** Store `{issuer, sub}` on the user record, plus the UPN or email as a display and recovery hint. Never key on name. Optional: also record the certificate-derived claim (EDIPI or the PIV assurance level `amr`/`acr`) when the IdP provides it, and refuse tokens below the required assurance.
3. **Invites keep deciding who may join.** PIV proves who you are; the owner still decides who is allowed. A signed-in identity joins when it matches a pending named invite, the team link, or an allowed-domain rule the owner switches on. This keeps today's "owner is never asked to type a name" rule: the name comes from the IdP.
4. **A new route, not a changed one.** `POST /v1/pair/oidc` takes the authorization code and PKCE verifier, does the exchange server-side, then creates or finds the user by `{issuer, sub}` and returns the same device token as `/v1/pair`. Rate limit and terms acceptance (`validTermsAcceptance`) apply exactly as they do now. Existing invite pairing keeps working for people without a card.
5. **Devices stay tokens.** After sign-in a device holds a Servant token as today, so offline use, push and the secure transport are unchanged. Re-auth with the card is required to add a new device, and an optional owner setting can require it again after N days.
6. **Removing a person** (`removePerson`) already revokes every device. When the IdP disables the account, the next re-auth fails and the device is revoked.

## What I need from the agency before building

- Which IdP and tenant (issuer URL), and an app registration with a redirect URI (`servant://auth` plus the Mac loopback).
- Which claim is the identity (UPN, email or EDIPI) and which allowed domain(s).
- Whether certificate-based sign-in is enforced at the IdP for that app (it should be, with a Conditional Access policy or the IdP's own rule), so Servant does not have to trust a self-reported level.
- Whether phones are in scope on day one (needs derived credentials) or Mac and web first.

## Build order

1. Server: OIDC verifier module with unit tests against a local mock IdP (discovery, JWKS rotation, bad `aud`, expired, replayed nonce).
2. `POST /v1/pair/oidc` and the user-record fields, with integration tests beside the existing pairing tests.
3. App and Mac: "Sign in with your agency account" on the join screen, next to the invite code.
4. Owner settings: allowed domain, require card for new devices.
5. Document it in `docs/ato-data-flows.md` (new external flow to the IdP) and `docs/member-security.md`. This needs the owner's security review; it is an authentication change.

## Not in scope

Reading the card directly, storing certificates or PINs, replacing invites, or any claim of FedRAMP or ATO coverage. The IdP carries the PIV assurance.
