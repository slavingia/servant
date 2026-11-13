# Multiple servers

Servant keeps one signed-in account for each server. Open the server name in the
sidebar or in You → Servers to switch, or choose **Join another server** and paste
that team's invite. Joining leaves the other servers signed in. Signing out removes
only the selected server. Switching servers leaves an active call.

The app migrates the previous single account automatically. Native credentials
stay in SecureStore, and the Mac bridge encrypts each account separately. The
`servant.accounts` manifest stores the active server and the list of server IDs;
individual account keys are derived from the pinned server key. A changed tunnel
address, profile name or token does not add a duplicate server. A new sign-in for
an already saved server replaces that server's credential.

The Mac app needs the version 2 storage bridge for multiple accounts. An older
installed binary receiving a web update continues using its existing encrypted
single account and displays an update message before adding another server.

Server switches remount the conversation and profile state. Drafts and project
caches are scoped by server and user; session expiry is scoped by server and
credential. Browser tabs serialize account changes and reload the shared saved
list after another tab changes it. A late request from a server you left cannot sign you back in or
expire another server's session. Notifications and icon badges cover all saved
servers; notification routing selects the originating server before opening its
conversation. While iOS is suspended or closed, the icon keeps the last computed
combined total until the app resumes; alert notifications continue to arrive.

Checks live in `accounts-store.test.ts`, `session-expiry-state.test.ts`,
`drafts.test.ts`, and the notification and desktop policy tests. They cover legacy
migration, failed storage writes, cancelled pairing, concurrent account writes,
per-server sign-out, stale credential responses, and inactive session expiry.
