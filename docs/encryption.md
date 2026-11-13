# App-to-server encryption

## Trust boundary

The native app and the owner's server are the endpoints. Cloudflare is an untrusted relay, whether the operator selects cloudflared or the optional [stable Worker relay](relay-transport.md). This protects application content through the tunnel while retaining administrative access, server-side history, agent context, and existing access controls. It is not device-to-device encryption and does not change what Hermes or a configured model provider can read.

The server generates a persistent P-256 private key in `transport-key` with mode 0600. Invites carry the compressed public key as `key`; the app saves it alongside the device credential in SecureStore (localStorage for the development web build). Initial invite delivery must be trusted. Discovery changes only the address, never the key. Keyless accounts enter the encryption upgrade screen. No automatic key discovery or plaintext fallback exists.

## Version 1 wire format

All private API traffic uses `POST /v1/secure`. The outer request has no bearer token. Its JSON envelope is `{ v: 1, publicKey, salt, data }`: an ephemeral compressed P-256 public key in lowercase hex, 32 random salt bytes in base64, and AES-GCM ciphertext plus its 16-byte tag in base64.

ECDH's 32-byte x coordinate is input to HKDF-SHA-256 with the random salt and UTF-8 info `servant-tunnel-v1:<server public key>:<client public key>`. The 64-byte output is split into request and response keys. A new ephemeral key and salt are generated using Expo's asynchronous native CSPRNG for every request. The request key is used once with a zero 12-byte nonce and AAD `servant-tunnel-v1:request`. The encrypted JSON includes method, API path, application headers, body, and millisecond timestamp.

The server validates the envelope, timestamp (two-minute tolerance), API route, and body before executing the existing authenticated handler. Only authorization and accept headers are forwarded from encrypted client input; transport identity comes from the actual connection. Encrypted requests cannot reach local admin routes. A persistent SQLite replay table records the hash of ephemeral public key and salt before dispatch. A replay remains rejected across process restarts for the request's validity window. Reads and writes both use this protection. Retry attempts create fresh envelopes; application-level idempotency remains the caller's responsibility.

Responses have outer content type `application/x-servant-encrypted`. Each newline-delimited base64 record is AES-GCM ciphertext plus tag. Response nonces are 12 bytes with a monotonically increasing unsigned big-endian 32-bit sequence in the last four bytes, starting at zero. AAD is `servant-tunnel-v1:response`. The response key is distinct from the request key. The encrypted records contain:

- A headers frame with the actual HTTP status and headers.
- Chunk frames with response text, including JSON bodies or SSE events, split into bounded frames without splitting surrogate pairs.
- An end frame required for successful completion.

Changing, reordering, or dropping records fails authentication or produces an incomplete-stream error. Cancellation closes the underlying stream. Public transport errors and draining/unavailable responses are rejected by the client, never interpreted as decrypted application data. The existing authorization, revocation, and conversation membership checks still run after decryption.

## Limits and deployment

Envelope size is capped at 56 MiB to accommodate a 30 MiB attachment total after nested base64 expansion. Cloudflare still learns traffic sizes, timing, client addresses, connection status and public routing/discovery information. Stable relay mode removes the changing tunnel address and GitHub gist requirement for new invites while preserving the same pinned key. Push services receive the alert title and body in plain text (sender, channel or chat title, and up to 240 characters of the message) unless the person turns off Show sender and message, plus opaque routing references. Encrypted native push previews are not implemented; see [notifications.md](notifications.md). Previously sent plaintext cannot be made secret retroactively. Old app builds may attempt plaintext requests before receiving an upgrade-required response; distribute the updated build before resuming use.

This protocol uses audited crypto primitive libraries on the app and Node crypto on the server, but the protocol itself has not had independent review. Long-term server key compromise can decrypt captured prior traffic: version 1 does not provide forward secrecy. A compromised app, compromised server, or modified web app can access plaintext. Native app distribution and direct trusted invites are the intended deployment.

Back up the private key with the server data. Do not rotate it merely because a tunnel URL changes. Issue an existing-user invite (`invite --user <user-id>`) for each device upgrading from keyless builds; after pairing, revoke its previous device record. New general join links create new users and do not transfer existing history.

The previous hard-coded `ITSAppUsesNonExemptEncryption: false` declaration has been removed because the app now bundles cryptographic implementations. Complete App Store Connect's encryption questionnaire for the new build; [Apple documents that omitting this key triggers the questionnaire](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption). This change does not assert a new export classification.

## Verification

`node --test server/` runs the actual app crypto/framing against the server and exercises messaging, files, agent streaming, revocation, and shutdown through encrypted requests. Security tests inspect proxy-visible traffic, reject modified/wrong-key/stale/replayed requests (including after reopening the replay database), reject plaintext API access, verify response tampering/reordering/truncation detection, and block encrypted access to local admin routes. App invite tests cover preservation and validation of public-key pins. Run `npm test`, `npm run typecheck`, and `npm run lint` in `app/` as well.

Native-device testing is still required before distributing a production build, particularly attachment memory use and streaming over a real tunnel.

## Public inbox browser trust decision

The public `/contact` inbox intentionally supports people who have no trusted invite. Its first page and JavaScript are trusted through the operator's HTTPS origin, including any proxy serving that origin. The browser pins the server public key on first use and refuses a changed key; it does not replace the pin automatically. Requests, scoped visitor credentials, replies and file bytes then use the same authenticated `servant-tunnel-v1` envelope, implemented with browser Web Crypto. A malicious origin or proxy able to replace the public page or its script can compromise this browser flow; first contact does not have the invited native app's protection from an untrusted relay.

This separate bootstrap leaves member invites, native key pinning, discovery, and the server private key unchanged. There is no plaintext private API fallback. Visitor return links contain a scoped bearer token in the URL fragment, removed immediately on load, and are stored in browser localStorage. The token grants only its conversation, never member or agent access. A reply email, when the owner has set up a mailer and the visitor has confirmed an address, carries that same link through ordinary mail, which is not end-to-end encrypted. See [secure inbox](secure-inbox.md) for operating details.
