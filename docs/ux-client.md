# Servant UX client identity and builds

Servant UX is a client flavor, not a new server protocol. It uses the existing
encrypted pairing, API, live-update, and account formats, so a UX client can
join an ordinary Servant server without a server migration.

## Identities

| Surface | Servant UX identity | Upstream core identity |
| --- | --- | --- |
| Expo display name | `Servant UX` | `Servant` |
| Expo slug | `servant-ux` | `servant` |
| iOS bundle ID | `gov.irs.servant.ux` | `gov.irs.servant` |
| Android package | `gov.irs.servant.ux` | `gov.irs.servant` |
| Mobile URL scheme | `servant-ux` | `servant` |
| Electron product | `Servant UX` | `Servant` |
| Electron app ID | `gov.irs.servant.ux.desktop` | `gov.irs.servant.desktop` |
| Electron URL scheme | `servant-ux` | `servant` |
| Electron storage | `~/Library/Application Support/Servant UX/` | `~/Library/Application Support/Servant/` |

The distinct native identifiers, URL handlers, storage path, and OTA runtime
versions allow both clients to be installed at the same time without sharing an
account file or claiming each other's direct links.

The server still generates ordinary `servant://pair` invites. Servant UX accepts
those through **Paste an invite link** and its QR scanner. A link intended to
open Servant UX directly can use `servant-ux://pair` with the same query
parameters. The app does not register the ordinary `servant` scheme because two
installed apps cannot both own that handler reliably.

## Milestone 1 feature contract

The UX layer deliberately reuses existing Servant data instead of introducing a
second protocol:

- New pairings enter a resumable, device-local role and goals flow. These
  preferences personalize starting points but never grant server permissions;
  the server's agent tier remains authoritative and is shown separately.
- **Design Studio** is a library view over existing agent chats whose
  `mode` is `vibe`. Creating a design still calls the normal chat endpoint with
  `mode: "vibe"`, and the client offers that action only for server-authorized
  Design prototyper, Design engineer, and Researcher tiers when prototyping is
  configured. Researcher-created designs explicitly request the separate
  `prototype` agent lane; ordinary Researcher chats remain restricted.
- Sharing a design posts an ordinary plain-text message to an existing channel
  or direct message, then opens its ordinary Servant thread for feedback. Older
  and upstream clients therefore receive a useful title, status, preview URL,
  review focus, and thread instructions without needing a new card renderer.
- Workspace owners may see private teammate designs through their existing
  admin visibility. The UX library labels these as private and does not offer
  them for resharing.

Existing paired accounts with no onboarding record continue to their normal
home screen, so installing the UX client does not turn a local preference into a
server migration. A person can restart the flow from **You → Restart
onboarding**.

Milestone 1 intentionally deferred Research Studio. The milestone 2 implementation
follows the same compatibility rule: compose existing researcher-agent capabilities
and ordinary Servant sharing/thread primitives. Its later Research Hub guidance
extension adds one bounded, non-persistent preparation endpoint without adding a
chat, message, or pairing format.

## Milestone 2 compatibility contract

Milestone 2 adds role-aware research starting points without changing access:

- A person's onboarding role remains a local preference. Research actions are
  active only when the server reports Researcher tier 4; the client never grants,
  promotes, or infers that tier.
- **Research Studio** studies use ordinary titled, private agent chats. Starting
  one opens the existing chat composer with a prefabricated draft for the person
  to review and edit; onboarding and task shortcuts must not send it
  automatically.
- A study may use no prototype, create a new one, or reference an active Design
  Studio prototype with a live preview. Existing prototypes are loaded from the
  ordinary readable chat library and rechecked immediately before the research
  draft is created. Creating a new prototype first opens a private prototype-agent
  workspace with an unsent build draft derived from the person's written,
  public-or-made-up study context and, when requested, a generalized design
  guidance draft prepared by the restricted Researcher Agent. The person must
  review or edit that guidance and explicitly include it. Governed Research Hub
  records and citations do not enter the prototype/full-agent prompt through
  this flow; they are
  re-resolved later for the restricted Researcher chat. The study form remains
  available underneath it. On
  return, the client rechecks the workspace and selects it only after it has a
  live preview and the server's `previewReady` signal confirms a real hosted
  `index.html` artifact. It then creates the ordinary
  restricted Researcher chat; it never treats the prototype agent as the
  Researcher agent or claims participant research occurred.
- The starting task label is exactly **Run a research-informed design review**.
  Research Hub reviews must cite their evidence and sources and clearly remain a
  research-informed first pass. They must not claim or imply human validation,
  research approval, or design approval.
- Sharing continues to use normal Servant controls and ordinary channel or
  direct-message posts with threads. Upstream clients can therefore read the
  study summary, follow permitted shared chats, and participate in feedback
  without a Research Studio-specific renderer.

This milestone adds no Research Studio endpoint, message type, or pairing
change. It uses two optional, backwards-compatible role markers on the existing
chat-creation exchange. Restricted work requests and confirms `researcher`;
an explicit `mode: "vibe"` prototype workspace requests and confirms
`prototype`. Both requests are checked again in the same state transaction that
stores the chat, and every turn rechecks current eligibility before contacting
an upstream agent. Original clients ignore the optional response field and
continue to use the same chats, sharing, messages, and threads.

The `prototype` lane is immutably bound to its server-generated prototype
workspace and receives the hosted-prototype folder and safety brief. A Researcher
who loses prototype eligibility cannot continue that workspace. Unmarked older
full-agent chats do not become available merely because someone has Researcher
access. The server also persists the upstream lane that created each prototype
session, so adding or removing a dedicated prototype upstream cannot silently
reroute an existing chat to a different agent.

## Research Studio study activities

**Build a research study** can plan unmoderated activities with all seven Civic
Research Studio methods: prototype usability, A/B implementation tests, card
sorting, tree testing, first-click testing, preference testing, and surveys. A
study may mix several. Each activity uses the same fields as Research Studio's
planner, such as goal, benchmark, precision, designs and control, sort type, tree
and correct destinations, and split and power.

- Sample sizes, A/B hypotheses, and standard analyses are computed on the
  device with Research Studio's own planner rules, ported from Research Studio
  v0.3.24 into `app/src/lib/research-stats.ts` and
  `app/src/lib/research-methods.ts`. They cost no agent tokens. If Research
  Studio's formulas change, update both files.
- The person chooses how results are collected. The default is Qualtrics with
  Research Studio inside the survey (route B in Research Studio's
  `QUALTRICS-AB-SETUP.md`). The alternatives are Qualtrics with two surveys and
  links (route A), or not decided yet. They also choose any device, or laptops
  and desktops only.
- The unsent study draft for the restricted Researcher agent lists the
  activities with these fixed numbers, asks the agent not to recompute them, and
  asks for a Qualtrics setup checklist that matches the chosen route.
- **Save Research Studio file** builds a working copy (study plus plan) that
  Research Studio's builder accepts through **Import JSON**. It is built on the
  device from that form only and never includes Research Hub records. Welcome
  and consent text are left blank; with Qualtrics, consent is marked as
  collected in the survey. The button lists anything Research Studio's import
  would reject, such as missing HTTPS links, instructions, cards, a correct tree
  destination, or survey questions. First-click target areas are drawn in
  Research Studio after import.
- This is client-only: no server, endpoint, message, or pairing change.

## Research plan collaborators

The author of a Research Studio study plan (a `[Research study]` chat on the
restricted Researcher lane) can add up to ten teammates as **View** or **Edit**
from the chat's options. This adds one optional `collaborators` field to the
existing `PATCH /v1/chats/:id` request; there is no new endpoint, chat, message
type, or pairing change.

- Only people the server currently treats as Researchers (tier 4, not admins)
  can be added. Onboarding preferences never qualify someone. The server
  re-evaluates every collaborator on every request, so a tier change, removal,
  a private forward into the plan, or deletion ends access without rewriting
  the stored list. The author sees a paused collaborator as paused.
- View collaborators read the plan. Edit collaborators may also send text
  turns, with no files or forwarded messages, to the same restricted
  Researcher agent. Each turn is checked, billed, and memory-scoped to the
  person who sends it. Only the author changes collaborators or sharing,
  archives, or deletes the plan. An author who loses Researcher access may
  remove collaborators but not add them.
- Collaborators do not share the plan with the workspace. Research Studio lists
  plans opened to you under **Shared with you**. Once anyone other than the
  author writes in a plan, each user message names its sender.
- Original clients ignore the new fields. Collaborator chats still report
  `readOnly: true`, so an older client shows the plan read-only; Servant UX
  reads `canSend` for edit collaborators. A server without collaborator support
  rejects the change, and the client reports it as not saved. Rolling the server
  back to a release without this field ends collaborator access.

## Research Hub connector milestone

Research Hub evidence is an optional, backwards-compatible input to the same
ordinary Research Studio draft. The server reads a separately approved,
aggregate-only snapshot from its private data directory and offers bounded
Researcher-tier status, search, and re-resolution routes. It has no runtime
GitHub credential or generic repository/file connector, and the restricted
Researcher agent retains its existing no-GitHub, no-shell, and no-files policy.

The person explicitly selects at most eight records. Servant resolves those IDs
again under current authorization immediately before creating the chat, then
quotes the current record versions and one snapshot revision in the unsent
plain-text prompt. A design review may continue without selected evidence, but
the draft identifies that as an evidence gap instead of claiming validation.

For a new prototype, `POST /v1/research-hub/design-guidance` reauthenticates the
Researcher after reading the request, re-resolves the selected IDs and revision,
and asks only the attested restricted Researcher Agent for strict structured
guidance: generalized user needs, pain points, design opportunities, and
unknowns. The server rejects invalid output or source details instead of passing
through raw evidence. The client presents the generalized result for human
review; only the approved text is placed in the unsent prototype build draft.
Changing evidence or relevant study details invalidates that approval. The
client re-resolves the evidence and snapshot once more immediately before it
creates a prototype chat with approved guidance. It sends the exact first prompt
as part of a server-validated handoff and requires the returned chat to report a
pending handoff before saving the draft. The bound prompt must be sent unchanged;
revisions happen back in Research Studio. The server rechecks Researcher access,
the exact snapshot, the reviewed guidance, and the prompt again at first-send
enqueue and immediately before the Prototype Agent runs, so stale or revoked Hub
context cannot cross on cached or queued state. The
Prototype Agent is asked to suggest two or three evidence-informed hypotheses
with tradeoffs, assumptions, accessibility considerations, and limits before
asking the researcher to choose or revise a direction and building the selected
minimum testable direction. It receives no Hub records, summaries,
citations, IDs, paths, dates, counts, metrics, or snapshot metadata through this
handoff, and it must
not claim validation or approval.

Older clients remain compatible because the resulting prototype is still an
ordinary private agent chat and message. See [Research Hub
connector](research-hub.md) for the publication and privacy boundary.

## Local research preview

During web development, open
`http://127.0.0.1:4175/research-preview` to review the Research Studio and
research-to-prototype interactions before committing them. The route is enabled
only for a development build running on a loopback web host (`localhost`,
`127.0.0.1`, or `::1`); other builds and hosts show an unavailable state.

The preview uses clearly labeled synthetic study, evidence, guidance, and design
direction fixtures. Its route and helper do not import the server or session
clients and do not call an API, fetch data, create chats, save drafts, or persist
review changes. Reviewers prepare and approve the sample guidance, inspect the
exact prototype handoff, and choose a proposed direction without changing the
current workspace. Keep preview changes uncommitted while they are under review,
then run the normal tests, typecheck, lint, and production export before the
approved files are committed.

## Mobile builds

`app/app.config.js` defaults to the UX flavor:

```sh
cd app
npx expo config --type public
npx expo prebuild --clean
```

This configuration does not reference `GoogleService-Info.plist` or
`google-services.json`, filters the React Native Firebase and Crashlytics config
plugins, omits the PushKit/background-call config plugin, and disables remote
notifications in the notifications plugin. No Firebase or push secret is
invented or checked in.

To inspect or reproduce the upstream native identity explicitly:

```sh
SERVANT_APP_FLAVOR=core npx expo config --type public
SERVANT_APP_FLAVOR=core npx expo prebuild --clean
```

Core native builds retain their Firebase file references and therefore still
need the existing ignored service files and normal Apple/Google signing setup.
The repository's TestFlight and Firebase distribution scripts belong to the
upstream app and refuse to run unless the operator explicitly sets
`SERVANT_APP_FLAVOR=core`. Do not use those targets for a UX release.

## Push limitation

The first UX build reports native push as unsupported. It does not ask for
notification permission, obtain a device push token, or register one with the
server. Native notification alerts and background system call ringing are
therefore unavailable; in-app messaging and calls while the app is active still
use the existing server connection.

Enabling push later requires all of the following together:

1. UX-owned APNs and FCM app registrations for the new bundle/package IDs.
2. UX service files and securely managed provider credentials outside Git.
3. Server routing that selects the correct FCM project and APNs topics for each
   client. The current APNs transport targets `gov.irs.servant` and
   `gov.irs.servant.voip`, so reusing it for `gov.irs.servant.ux` would fail.
4. A UX build with the Firebase/notification configuration enabled and a
   deliberate telemetry decision for Crashlytics.

## Updates

UX mobile runtime versions are prefixed with `servant-ux-`, which prevents an
upstream binary from accepting a UX JavaScript update. The Electron package does
not point at the upstream GitHub release feed, and its downloaded web-interface
updates are disabled: the existing shared server namespace is `mac-shell-*` and
would otherwise allow one desktop flavor to receive the other's bundle.

Before distributing Electron updates, create a UX-owned signed release feed and
a flavor-specific server/runtime namespace. Until then, distribute new UX desktop
builds manually; **Check for Updates** explains that limitation instead of
contacting the upstream feed.
