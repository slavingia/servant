# Stable encrypted relay

Servant can use a fixed Cloudflare Worker address instead of a quick tunnel and a GitHub discovery gist. The implementation is checked in and tested locally; it has not been deployed to a production Worker or enabled on the live hub. Existing cloudflared installations continue to work until an operator selects relay mode.

The app still encrypts requests on the phone and pins the Mac's public key from a trusted invite. The relay forwards the existing encrypted `/v1/secure` envelopes and encrypted response frames. It has no app transport key, device credential, message content, attachment, private API path, or response plaintext. Cloudflare can observe IP addresses, hub IDs, timing, traffic size, connection status, and the relay host credential. The host credential permits connecting to a route; it cannot decrypt app traffic. Hermes and any configured model provider remain inside the plaintext processing boundary described in [encryption.md](encryption.md).

Coconut's [relay architecture](https://github.com/antiwork/coconut/blob/main/docs/relay-transport.md) informed this design. No Coconut source was copied: the reference checkout did not declare a repository-wide license. Servant retains its existing cryptographic protocol and trusted-invite format rather than adopting Coconut's Noise protocol.

## Visitor address

Pairing, email-code and device-link limits are per visitor address. The Worker passes the `CF-Connecting-IP` it saw in the relay `request` frame (only if it is a plain IP address), and the Mac hands it to the local server as `cf-connecting-ip`. Without it every phone would arrive from `127.0.0.1` and share one budget, so ten wrong pairing codes from anyone would lock pairing for everyone.

## Architecture

```text
Phone: pinned encryption
  POST https://relay.example/hubs/<hub-id>/v1/secure
    → Cloudflare Worker → one Durable Object per hub
       → authenticated outbound WebSocket from Mac
         → POST http://127.0.0.1:<port>/v1/secure
           → existing encrypted API and authorization
```

The Worker exposes only that encrypted POST route, its CORS preflight, a generic connection-health route, and the host WebSocket. It does not expose the Mac's public metadata endpoint or proxy arbitrary routes. The Mac connector fixes the local destination, method and headers; even a compromised relay cannot use it to fetch admin routes or other local services. Invalid plaintext local error responses are replaced with a generic transport failure.

The hub ID is stable and randomly generated. A separate random host credential authenticates the Mac. The Worker stores only its SHA-256 digest in a secret binding. The credential travels in the first TLS-protected WebSocket frame, never in a URL. The original app transport key remains in the Mac's private data directory and is never provisioned to the Worker.

The Durable Object uses Cloudflare's [WebSocket hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). It stores authenticated socket state in socket attachments and stores no message bodies in durable storage. Each HTTP request has a random correlation ID. Upload and download chunks are capped at 48 KiB, with one acknowledged chunk in flight per direction. Download acknowledgement follows HTTP consumption, so a slow phone cannot create an unbounded response queue. Limits are eight concurrent requests per hub, 56 MiB per encrypted envelope, 64 MiB of aggregate upload data at the Mac, 180 requests per minute per active hub, 60 seconds idle, and 15 minutes per request. A production edge should also configure per-IP abuse controls; the in-memory per-hub limiter resets on hibernation and is not an authentication control.

Host loss, an incomplete encrypted response, cancellation, or an expired request produces a failure, never a successful partial message. The connector reconnects with backoff and heartbeat detection. It does not replay writes. The app creates fresh encrypted envelopes for retries; application-level idempotency controls any repeated operation. Hub-owned agent turns can continue while the phone reconnects.

## Provisioning

Use a currently patched Node 22.13+ runtime for the connector. The server's SQLite and the app-crypto test suite also need a current Node runtime. The server and connector have no added npm runtime dependencies. `relay/` development dependencies are used only for local Worker verification; the Worker itself has none.

An operator must provide a Cloudflare Worker account and the intended HTTPS hostname. Provisioning a new cloud service and selecting its region, account and access controls are deployment decisions; this change does not create one automatically.

1. Generate a random hub ID (at least 16 random bytes, base64url encoded) and a separate host token (32 random bytes, base64url encoded). Store the token only in a mode-0600 file inside a private directory. Never commit the file or place the token in a shell argument, gist, invite, log, or issue.
2. Create the Worker's `SERVANT_RELAY_HUBS` **secret binding** as a JSON object mapping each hub ID to the SHA-256 hexadecimal digest of its host token. Use a local private file as input to the Cloudflare secret command; do not put it in `wrangler.jsonc`.
3. Review and deploy `relay/wrangler.jsonc` through the agency's normal Cloudflare process. The configuration declares one Durable Object namespace and disables application observability logs. Retain the account-level logging and retention policy in the security review.
4. Save the Mac connector's JSON configuration, for example `~/.config/servant/relay.json` (directory 0700, file 0600):

   ```json
   {
     "relay": "https://relay.example",
     "hubId": "REPLACE_WITH_RANDOM_HUB_ID",
     "hostToken": "REPLACE_WITH_RANDOM_BASE64URL_TOKEN"
   }
   ```

5. If the tunnel runs from a separate bootstrap directory, install `server/relay.mjs`, `server/relay-client.mjs`, and `server/relay-protocol.mjs` alongside the updated `tunnel.mjs` there. No Worker files or development dependencies are needed on the Mac.
6. Remove any legacy `SERVANT_DISCOVERY_URL` or conflicting `SERVANT_PUBLIC_URL` environment override from the API and tunnel services. Set `SERVANT_RELAY_CONFIG` to that file in the existing tunnel service's environment, retaining `SERVANT_DATA_DIR` and `SERVANT_PORT` as appropriate. `server/run-tunnel.sh` then starts the outbound connector; it does not start cloudflared or a gist publisher. The service remains independent of API deployments. For foreground verification, run `node server/relay.mjs` with the same environment.

Once the host authenticates successfully, the connector saves `publicUrl` as `https://relay.example/hubs/<hub-id>`, sets `discovery` to `off`, and removes `discoveryUrl` from the hub's private config. It keeps the old `gistId` solely for an explicit migration if needed. No `gh` executable or GitHub login is needed for new relay invites. It does not rotate the app's transport key.

Existing paired phones retain their old address. Issue trusted existing-user invites for the same users, then revoke superseded device records after successful pairing. Alternatively, an operator can update the old discovery gist once to the stable relay base and keep it available for old installs until they are re-paired. That is a transitional compatibility choice, not a relay dependency. Do not delete the old discovery file before its phones have migrated.

To rotate the relay host credential, update the secret digest and the private connector file, then reconnect the host. To revoke immediately, close/restart its active Worker socket as well: changing the digest alone takes effect at the next authentication. A relay credential rotation never changes the app's pinned key.

## Verification and limits

```sh
node --test server/relay.test.mjs server/push.test.mjs server/tunnel.test.mjs
npm ci --prefix relay
npm test --prefix relay
```

The server tests run actual app encryption through a relay harness into the Node crypto transport, inspect relay-visible traffic, and cover multiplexing, backpressure, cancellation, disconnects, route isolation, request bounds and stable-address publication. The Worker integration runs the actual Worker and Durable Object in Miniflare with a real WebSocket connector; it rejects an invalid host credential and tampered encrypted request, then reconnects to the same hub URL with the same app key. Development dependency overrides keep Miniflare's transitive HTTP and image libraries on patched releases; `npm audit --prefix relay` must remain clean.

These local checks do not establish production Cloudflare availability, real-device roaming behavior, an independent cryptographic review, or ATO approval. Production rollout still requires a deployed Worker, trusted migration invites, native-device traffic tests and the existing export-compliance review. Push delivery remains direct APNs/FCM with generic alerts; it is not routed through this Worker. See [notifications.md](notifications.md).
