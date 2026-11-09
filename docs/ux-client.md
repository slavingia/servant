# Servant UX client identity and builds

Servant UX is a client flavor, not a new server protocol. It uses the existing
encrypted pairing, API, live-update, and account formats, so a UX client can
join an ordinary Servant server without a server migration.

## Identities

| Surface | Servant UX identity | Upstream core identity |
| --- | --- | --- |
| Expo display name | `Servant` | `Servant` |
| Expo slug | `servant-ux` | `servant` |
| iOS bundle ID | `gov.irs.servant.ux` | `gov.irs.servant` |
| Android package | `gov.irs.servant.ux` | `gov.irs.servant` |
| Mobile URL scheme | `servant-ux` | `servant` |
| Electron display name (windows, dialogs, prompts) | `Servant` | `Servant` |
| Electron product (app bundle, Keychain name) | `Servant UX` | `Servant` |
| Electron app ID | `gov.irs.servant.ux.desktop` | `gov.irs.servant.desktop` |
| Electron URL scheme | `servant-ux` | `servant` |
| Electron storage | `~/Library/Application Support/Servant UX/` | `~/Library/Application Support/Servant/` |

The distinct native identifiers, URL handlers, storage path, and OTA runtime
versions allow both clients to be installed at the same time without sharing an
account file or claiming each other's direct links. Both show the name Servant;
only the internal identifiers differ. The Mac app bundle stays `Servant UX.app`
so it doesn't replace `/Applications/Servant.app`, and its internal name stays
`Servant UX` because macOS keeps the encrypted sign-in in the Keychain under it.

### Servant Studio

Servant Studio is the name of the app's UX research and design features: Design
Studio, Research Studio and study readouts. They're part of the app, not a
separate product, and the app itself is just called Servant; the Mac sidebar and the Agent tab
group these features under a Servant Studio heading (`studioName` in
`app/src/lib/app-identity.ts`). The planned web address for them is
`studio.servant.com`. Pointing it at a server (DNS and the server's public URL)
is a deployment step and isn't part of this checkout.

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
  or direct message, then opens its ordinary Servant thread for feedback. Only
  a design with a live preview page can be shared; a draft whose page hasn't
  been published yet is never shared with a link that doesn't work. Older
  and upstream clients therefore receive a useful title, status, preview URL,
  review focus, and thread instructions without needing a new card renderer.
- Workspace owners may see private teammate designs through their existing
  admin visibility. The UX library labels these as private and does not offer
  them for resharing.

### Adjust design (web and Mac app)

People can make quick manual changes on a design's live preview, then hand
them to the design's agent to implement. Nothing changes the design's page
until the agent does. Words used throughout: a **design** is the thing made in
Design Studio, its **page** is what's published, and its **design chat** is
the conversation with its agent. A design with a page is **Published**.

- **What can change:** an element's text (when it holds only text); text and
  background color, font size and weight, text alignment, corner radius,
  padding and margin; width and height; its order among its siblings (move
  earlier or later); and hiding it. Selecting is on as soon as the preview
  connects: click anything in it (**Selecting: on** turns it off to use the page
  normally), use **Layers**, or from the keyboard **Select first element** and
  Parent, Previous, Next and Inside.
- **The panel** has three tabs: **Edit** (Content, Style, Layout, Comment),
  **Changes** (one row per element with one remove button, **Remove all**, and
  a note) and **Accessibility**. **Cancel** and **Review request** (or **Review
  suggestion**) stay pinned at the bottom.
- **Nothing goes anywhere without a review step.** Review request shows the full
  request for the agent; **Add to design chat** puts it in the design chat's
  message box, after anything already typed, unsent. A reviewer's **Review
  suggestion** shows it as teammates will read it; **Post to the thread** posts
  it and returns to the thread. Leaving with changes that haven't gone anywhere
  (Cancel, Back, closing the tab) asks first.
- **Authors** open it with **Adjust design** in the preview bar, on a design that
  has a page but no conversation yet, or on the design-review card. **Reviewers**
  open it with **Suggest adjustments** on the card. A suggestion is an ordinary
  plain-text reply ("Suggested adjustments for …", each element's CSS path and
  exact values, an optional "Reviewer's note: …"), so original Servant clients
  read it too; this app shows it as a card without the CSS paths, and the author
  gets **Add to design chat** on it. Replies from before this release that say
  "Note: …" still work.
- **Exact values for the agent, rounded ones for people:** the panel and cards
  show 13.3333px as 13.3px; the request and suggestion text keep 13.3333px so
  the agent can find it in the source.
- **More tools:**
  - **Undo** (or ⌘Z / Ctrl+Z outside a text field) and **Show original** /
    **Show changes**.
  - **Edit on page** (or double-clicking text) types straight into the preview;
    Enter keeps it, Escape cancels.
  - **Comments** on an element, for things that aren't a quick change. They
    change nothing on the page and reach the agent as notes.
  - **Preview sizes** (Full width, Phone 390px, Tablet 768px, Desktop 1280px,
    scaled to fit). At a size, the selected element's style or hide can apply
    to that size only; a bar above the preview says so, and selecting another
    element goes back to all sizes. The page previews it with an `@media` rule
    and the request says which widths.
  - **Design kit:** CSS custom properties the page defines on `:root` (from its
    own same-origin stylesheets) are offered as one-tap values (shown without
    their `--`), the one in use is shown, and a typed color or size outside the
    kit is pointed out.
  - **Contrast and the accessibility check:** the selected text's WCAG contrast
    ratio (4.5:1, or 3:1 for large text, shown to one decimal and rounded down)
    with a warning when it's too low. **Check accessibility** lists low
    contrast, missing alt text, unnamed buttons and links, unlabeled fields, a
    missing `lang` or main heading, skipped heading levels and tap targets under
    24 × 24 px. **Add as a comment** asks the agent to fix one with the other
    changes (a page-wide one goes in the note). It's an automated check, not an
    audit.
  - A width or height nobody set reads as `auto`; areas that hold other
    elements are named by their label or id, not their combined text.
- **How it works:** a page opened with `?servant-adjust=1` also loads
  `server/prototype-adjust.mjs` from `/p/_servant/adjust.js`, in the same
  sandbox as every prototype page. The script previews changes in that browser
  only and talks only to the window that embeds the page (`postMessage`); the
  app checks every message (`app/src/lib/prototype-adjustments.ts`) and opens
  adjustments only for pages under the server's own address, which
  `GET /v1/projects` reports as the optional `prototypeOrigin`. Older servers
  leave it out, and adjustments stay off. The author is checked against the
  design chat on the server, and a reviewer against the review thread's
  message. A design started from a Research Hub handoff stays paused during
  the research pilot.
- **Not yet:** iOS and Android keep the view-only preview. Moves are within the
  same parent; dragging elements freely isn't supported, so requests describe
  changes an agent can make cleanly in the page's source.
- `npm run test:web:signed-in` covers both flows end to end.

### Design Studio library, versions and reviews

- **Library:** published designs show a small live picture of the top of their
  page at phone width (web and Mac; scaled, lazy-loaded, not interactive), with
  search over titles and authors and **All / Mine / Shared with me / Archived**
  lists. Each design's **More** menu offers **Rename** (author), **Duplicate**
  ("Make your own copy to change", named "Copy of …"), **Version history**,
  **Use in a study plan** (Researcher tier, published designs; opens the study
  builder with that prototype chosen, checked again there) and **Archive** /
  **Move back to designs** (author; the page and link keep working). Wider
  screens show **Share for review** on the row; on phones it's in More, so
  titles have room. Rename and Duplicate are also in the design workspace's
  options.
- **Version history:** after each agent reply in a design workspace, Servant
  copies the published files when they changed (ordinary files only: no
  dotfiles, no symlinks, at most 500 files and 50 MB), keeping the last 20 under
  `<data dir>/prototype-versions/<folder>/`, with the message that led to it
  (up to 140 characters) shown under the version. Listing versions also catches
  changes made outside a reply. Each version is served read-only at
  `/p/<folder>.v<n>/` with the same sandbox as the live page. Anyone who can
  see the design can list and open versions and compare one with the latest;
  only the author can **Restore**, with the same access as sending in the
  workspace, never while the agent is working on it, and not for a design
  started from a Research Hub handoff while the research pilot holds it. Restoring saves the current page as a
  version first, leaves the agent's dotfiles alone, says which version to
  restore to go back, and leaves a note for the agent (unsent) in the design
  chat's message box. Deleting the design deletes its versions. API:
  `GET /v1/chats/:id/versions`, `POST /v1/chats/:id/versions/:n/restore`.
- **Rename and duplicate API:** `PATCH /v1/chats/:id` accepts `title` (author,
  1–80 characters). `POST /v1/chats/:id/prototype/copy` with `{ from }` copies
  a design the person can see into their own new, empty design.
- **Review cards:** a design-review message from this server shows as a card
  in place of its text, in channels and its thread: a picture of the page, its
  review focus, **Open preview** and **Suggest adjustments** (or **Adjust
  design** for the author). The message text is unchanged, so original Servant
  clients still show it and the link.
- **New designs** are titled "Untitled design" until named, start with
  "What should we build?" and starters that only fill the message box ("From a
  sketch or screenshot" also opens the photo picker), and show **Preview** only
  once a page is published. A design that already has a page but no
  conversation (a duplicate, say) says so and offers Open preview and Adjust
  design instead of starters. The workspace refreshes after each reply, so a
  newly published preview appears without reopening it. However a design is
  opened, the sidebar keeps **Design** selected (marked with `aria-current`).
- **Onboarding and the start page:** the role step says a role only shapes
  starting points. The last step ("You're all set") shows the person's agent
  access tier ("Design engineer tier"), separate from their role, and **See your
  starting points** opens the start page ("Your product designer workspace"),
  which is where a new person lands, not a gate: the sidebar works from it, and
  going anywhere else counts as having picked a starting point. For product
  designers and design engineers, the accessibility goal leads to **Check a
  design's accessibility** in Design Studio.

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

## Research pilot build

This build is the research-safe pilot. Features on hold stay off unless the
owner sets `"researchHold": false` in `config.json` (it defaults to on).

- **On hold, enforced by the server:** Research Hub routes (status, evidence,
  resolve, design guidance) and Research Hub prototype handoffs: creating a
  chat with a `researchHandoff` (refused before the handoff touches the Hub),
  and sends and other agent work in a design started from one (`research-vibe`).
  These return `research_paused`. `GET /v1/projects` reports `researchHold` so
  the app can hide them.
- **On hold in the app:** Research Studio's Researcher Agent actions (synthesis,
  design review, and "Review in researcher chat") and the Research Hub
  evidence section, including the Researcher Agent's design guidance.
- **Researchers can make prototypes during the pilot.** The Researcher
  prototype lane is open: researchers create designs in Design Studio, adjust
  them, and start a new prototype from a study plan ("Create a new prototype").
  For a study prototype they can add **What the research found**: findings
  from any research, in their own general words. The app checks them first
  (`researchFindingsProblems` in `research-studio.ts`, the same kinds of detail
  the server keeps out of Hub guidance: links, email addresses, record IDs,
  numbers and spelled-out numbers, month names, quotation marks, and claims that
  research validates, approves or proves a design; "no one" isn't counted,
  fractions such as "half", "a third" or "a quarter" are flagged, but
  "third-party" isn't; a form named by its number, like "Form 1040" or "Forms
  W-2 and 1099-K", is allowed, and the message for "W-2" on its own says to
  write "Form W-2")
  and won't create the workspace until they're fixed. Each problem quotes what
  it found, so it's easy to fix. Findings that pass go into the build prompt
  inside their own data boundary, one per line, numbered F1, F2… The prototype
  agent suggests two or three directions, each tied to the findings it
  addresses, and builds the one the researcher picks (or each one, as its own
  page, when the study compares them). **Show the build prompt** shows the
  exact prompt before anything is created. "What you already know" stays with
  the study plan and isn't sent to the prototype agent. The prompt is placed
  unsent in the new design chat's composer, which then says "Your build prompt
  is ready" instead of offering starters (in the browser and Mac app, the
  message box grows with its text up to 40% of the window, and **Larger** makes
  it up to 70% to read a long prompt through); nothing reaches the agent until the
  researcher reviews and sends it. Going back without sending discards the
  empty workspace (the form, findings included, is kept). No Research Hub records
  or Researcher Agent output are involved. Everything else in the study builder
  stays local. Researchers using ordinary Servant chats, on any client, are not
  affected.
- **Access changes take effect immediately (UX-B01–B03).**
  - Researcher and prototype chats are purpose-bound. When the person who
    started one no longer qualifies, they lose read and write access: no
    listing, reading, sending, uploading, sharing, forwarding, deleting or agent
    work on hosted files. Collaborators lose the plan too.
  - Nothing is deleted. The owner can still open the chat for audit, and
    restored access brings it back.
- **One purpose-chat rule everywhere (`canReadChat`).** Reading, attachments,
  media, uploads, forwards, workspace and project sharing (including a
  project's `sharedChats`, `chatCount` and `sharedCount`), collaborator access,
  notifications and agent delivery all ask the same question: does the chat's
  author still qualify for its lane? If not, everyone but the owner loses it.
- **Rechecked after every await.** Routes recheck access after the request
  body arrives and after agent-history calls, immediately before each read
  response, mutation, forward or upload.
- **Waiting work is cancelled the moment eligibility changes.** Any state
  change to people (tier, removal), devices or chats re-checks every waiting
  turn (`turnEligible`), and cancels the ones that no longer qualify, with their
  steers and unsaved drafts (`revokeChatWork`). A downgrade followed by a
  restore never runs the old request. A waiting turn that already holds a run
  has that run stopped too.
- **Researcher and prototype chats run only as durable runs with run keys.**
  Their work can be stopped and the stop confirmed, so on a bridge without
  durable runs or run keys they fail closed (`durable_runs_required`); legacy
  streams are never used for them. Running work is watched every 200 ms: on a
  change, the bridge is told to stop the run and Servant polls its status until
  the bridge confirms it ended (an unconfirmed stop is logged). Nothing more
  the agent says is saved, and the turn ends as cancelled.
- **Run keys (`servant_run_keys`).** Servant names each run before starting it
  (`X-Servant-Run-Key: servant_<turn id>`), so it never depends on the "run
  created" reply. If access changes while the start is on its way, Servant
  stops the key at once (`POST /v1/runs/servant-key.<key>/stop`) without
  waiting for the reply: the bridge stops the run if it exists, stops it as
  soon as it starts if the start is in progress, or refuses a start that
  hasn't arrived yet. A lost or failed reply is looked up by key
  (`GET /v1/runs/servant-key.<key>`), including a reply that arrives cut off:
  an existing run is used, never started twice; otherwise the key is stopped
  and the turn fails, so nothing is left running. A worker that restarts
  mid-start stops that turn's key, retrying for about a minute while the bridge
  comes back and logging if it can't confirm the stop. A run the bridge reports
  as `interrupted` (Hermes 0.22, after a gateway restart) or `expired` ends the
  turn as interrupted instead of waiting on it. The bridge
  keeps keys in `server/servant_run_keys.py` and serves them on Hermes' own
  run routes, so the launcher needs no extra route.
  **Deploying:** researchers' Agent tab chats need the updated bridge. Until
  the Mac's Researcher bridge (and the prototype bridge, when the hold lifts)
  runs this version, their sends fail with "update the agent bridge to one with
  durable runs and run keys"; ordinary member and owner chats are unaffected.
  Run `scripts/test-hermes-compat.py` with the installed Hermes before
  restarting the bridges (it couldn't be run in the cloud workspace, which has
  no Hermes install).
- **Channel `@agent` is paused for Researcher-tier askers during the pilot.**
  Channel answers use the legacy stream, which can be abandoned but not
  confirmed stopped, so while `researchHold` is on a Researcher's `@agent` in a
  channel or DM gets "Asking the agent in channels is paused for Researcher
  access during the research pilot. Ask in your Agent tab chat instead." and
  no agent is asked. Other people's channel answers are unchanged. With the
  hold off, an access change abandons the answer within half a second and
  posts "Your access changed, so this question wasn't answered."; that doesn't
  confirm the agent stopped working.
- **Work chats and chat creation recheck after their agent calls.** An `@s`
  work chat is saved only if the asker still has the same access and a
  signed-in device after the agent session is opened, and a new chat is
  refused if the research hold was turned on meanwhile; the unused session is
  deleted.
- **Notification previews are resolved on every delivery attempt** (queued or
  retried) by `agentNotificationFor`, so a revoked chat sends no preview.
- **The hold never covers prototypes without a Research Hub handoff.** Tier 2,
  3 and 4 prototype users keep building while the pilot is on.
- **Approved Answers reject unknown fields** (see `approved-answers.md`).
- **Web accessibility (research pilot screens, onboarding, design review):**
  radio groups use `useRadioGroup` (role and `aria-checked` rendered on the web,
  one Tab stop per group, Arrow/Home/End/Space), custom checkboxes render
  `aria-checked` and toggle with Space. Where choosing has side effects
  (Method, Sort type, and "Prototype for this study", which opens the
  prototype picker or clears a chosen prototype), arrow keys only move focus
  and Space or Enter chooses (`activation: "manual"`); the group's help text
  says so. Switching an activity's method sets its details aside, and
  switching back restores them (editor only; not exported).
  `npm run test:web` checks the rendered DOM and keyboard behaviour in
  Chromium against `/research-preview`, using the shared components the live
  screens use (`StudyActivities`, `PrototypeModeOptions`, `DraftChecklist`,
  `useRadioGroup`). `npm run test:web:signed-in` checks the signed-in screens
  themselves against a local loopback server with synthetic people and fake
  agents (`app/scripts/signed-in-harness.mjs`): the study builder (prototype
  picker, Save and the recheck before saving), onboarding, and Design Studio
  (creating, sharing for review, the Researcher hold, owner visibility and
  sandboxed prototype pages). Neither covers iOS or Android screen readers.

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
- **Save working draft** builds a working copy (study plus plan) that
  Research Studio's builder accepts through **Import JSON**. It is built on the
  device from that form only and never includes Research Hub records. Welcome
  and consent text are left blank; with Qualtrics, consent is marked as
  collected in the survey. The button lists anything Research Studio's import
  would reject, such as missing HTTPS links, instructions, cards, a correct tree
  destination, or survey questions. First-click target areas are drawn in
  Research Studio after import.
- This is client-only: no server, endpoint, message, or pairing change.
- **Research pilot scope (UX-H01–H04, M03):**
  - A/B tests compare exactly two designs, a control and one alternative. The
    control is always Design A: "Make Design B the control" swaps the two
    designs in the editor, so the editor, hypotheses, file and Research Studio
    all show the same letters. The change is announced.
  - Direction choices name the primary outcome ("Higher task success",
    "Higher self-reported completion"). Measured success is a secondary measure
    only when the activity has a valid success signal.
  - There is one prespecified primary outcome: task success (needs a success
    signal) or self-reported completion.
  - The planning direction (higher, lower, or either way) drives the sample
    size. A target outside 0–100% is a problem, never a silent swap; "either
    way" plans for the harder change. Inference is two-sided, and comparison
    wording uses the real number of comparisons.
  - Preference tests support powered claims only with two options. Three or more
    are exploratory: no split, no sample size, no winner.
  - **A/B denominator:** randomized eligible participants per design. Everyone
    randomized stays in their design's denominator; anyone who doesn't finish
    (or whose success can't be measured) counts as not successful, as the
    analysis rule says, so no extra is added for them and the expected control
    rate should already include them.
  - **Loss allowance** is a separate, editable study setting (default 20%,
    0–50): the share of recruits expected not to reach each activity's analysis
    denominator. It applies to every method with a target, including prototype
    discovery rounds (per round) and exploratory card sorts. Each size states
    its denominator: randomized eligible participants per design (A/B); everyone
    who starts (prototype tasks, tree tests, first clicks); people completing a
    usable session per round (discovery); completed sorts; people choosing an
    option; completed responses (surveys). Recruitment shows `n ÷ (1 − loss)`,
    worded "allowing for 20% of recruits not reaching the analysis", applied
    once and never again to the largest need. A blank or out-of-range
    allowance shows no recruit numbers (and blocks saving) rather than wrong
    ones.
  - **Stopping rule:** nothing is filled in. "Use the standard rule" offers one,
    and the researcher must tick "I've reviewed this stopping rule" before the
    draft can be saved. Editing it clears the tick.
  - The file is a **working draft** (`*.working-draft.json`). Save stays
    disabled until the title, decision, research question, intended
    participants, loss allowance and every activity are valid. The reason is
    shown under the button and linked to it (`aria-describedby` on the web,
    accessibilityHint on iOS and Android). Newly appearing problems are
    announced (`DraftChecklist`).
  - **Saving** (`app/src/lib/working-draft-save.ts`) locks every brief,
    activity and prototype control, rechecks the chosen prototype, and compares
    a revision of the whole form after each await: if anything changed, nothing
    is saved.
  - **Existing prototype:** the chosen Design Studio prototype becomes the
    study's `prototypeUrl`; prototype activities without their own link use it,
    as Research Studio does. It is checked again against the live library
    immediately before saving and the save fails closed if it's gone, not ready
    or not HTTPS.
  - These rules intentionally go beyond Research Studio v0.3.24, which ignores
    the planning direction.
- **Research Studio handoff (supported version 0.3.24, commit `03cfcb2`, the
  latest on its main branch on November 7, 2026).** On Import JSON, 0.3.24 sizes
  every A/B test without a direction and every preference test as two options
  with a 60/40 default. `app/src/lib/research-studio-compat.ts` models that
  import and gates the export: a lower or either-way plan whose size or target
  0.3.24 would change, and any three-or-more-option preference test, are listed
  as problems and not saved. Research Studio edits a plan's Recruitment and
  Exclusions in one-line boxes (line breaks are dropped), so each is one short
  line: how many to recruit for the largest need, with the loss allowance, and
  who is excluded before randomization or start. The loss assumption and each
  activity's analysis denominator, target and recruit number go at the top of
  the analysis plan, which Research Studio shows as a multi-line box and in its
  plan document in place of its standard plan. Two of 0.3.24's own displays
  differ in wording only, so the plan explains them instead of blocking the
  export: its sample-size summary shows each analysis target "plus extra for
  drop-out" (the recruitment line names that number, and the activity it
  belongs to when the largest recruit number is a different one, and says
  Servant's number already includes the extra), and its size text calls
  prototype-task, tree-test and first-click targets "people completing the
  activity" (the analysis plan says to read them as people who start, as its own
  standard analysis does). Everything else imports with its meaning intact,
  including two-sided inference. `research-studio-compat.test.ts` compares the
  numbers, hypothesis sentences and visible text with what Research Studio shows
  after import, using
  `research-studio-golden.json`, produced by Research Studio's own code with
  `app/scripts/research-studio-golden.mjs`; regenerate it when the supported
  version changes. A Research Studio update that keeps the direction and
  exploratory preference would let these plans export.

## Research form drafts

The research forms (Build a research study, and the other Research Studio
starting points) are kept as a draft on the device as they're filled in, so
leaving part-way (another screen, a closed tab, a restart) doesn't lose them.

- Saved shortly after typing stops, and right away when leaving the form,
  closing, reloading or hiding the page, or when the app goes to the
  background, in
  the same device storage as unsent messages (`servant.formDrafts`, see
  `app/src/lib/form-drafts.ts`). One draft per form, per person and server; at
  most 12 drafts, each kept for 60 days. Signing out clears that person's
  drafts.
- Kept: the title, written answers, study activities and setup, the prototype
  choice and purpose, and what the research found. Prototypes are kept by id
  only and checked again when the draft is restored: a chosen prototype that's
  no longer published isn't chosen, and a prototype workspace this form created
  is picked up again (and selected once it has published). Never kept: Research
  Hub evidence, Hub metadata or design guidance; those are chosen and reviewed
  again. A restored draft is checked field by field
  (`app/src/lib/research-form-draft.ts`), so an old or damaged one can't put
  unexpected values on screen.
- The screens avoid calling this a "draft", since the study form's working
  draft is the Research Studio file. The form says "Your answers are saved on
  this device as you go (last saved at 12:45 PM)", or "Picked up where you left
  off (last saved yesterday)" when it's restored, with **Start over**, which
  clears the form after a confirmation. Prototypes it created stay in Design
  Studio, and saved working drafts aren't affected. Research Studio shows
  "Continue where you left off: <title> (last saved …)" on the form's card.
  The form's bottom link is "Back to Research Studio" (not "Cancel"), since
  leaving keeps it. Sending the brief to a researcher chat ends the saved form;
  creating a prototype or saving a working draft doesn't.
- **Use in a study plan** from Design Studio with a plan already in progress
  doesn't change it silently: the form asks "You have a study plan in
  progress", naming the plan and when it was last saved, with **Use it in this
  plan** and **Start a new study plan** (which confirms first, then clears the
  plan in progress and starts a new one with that prototype). Nothing changes
  until one is chosen. If the plan already uses that prototype, nothing is
  asked.
- The loopback `/research-preview` keeps nothing.

## Study readouts

Research Studio's **Write a study readout** (`app/src/app/readout.tsx`) turns a
Civic Research Studio A/B study's Qualtrics results into charts and a readout
the researcher checks and saves as a Word document or a PDF. It's the first
slice of the report builder and data visualizer plan, built on its
recommendations: in Research Studio, starting with an A/B readout, with Word
and PDF export.

- **In:** the study's JSON (a Research Studio working copy or published study,
  or a working draft saved here) and the Qualtrics CSV exports: Survey 2 (with
  the `rs_` fields) and, optionally, Survey 1 for drop-out. Files are read on
  the device and never sent anywhere. Browser and Mac app only for now.
- **Numbers:** computed by Civic Research Studio 0.3.24's own code, copied
  unchanged into `app/src/lib/research-studio-vendor/` (CC0; see its README):
  the Qualtrics import, event flattening and A/B analysis. So a readout shows
  what Research Studio's results dashboard shows for the same files: each
  design's main measure counts everyone assigned, ranges are 95% (Wilson for
  rates, Newcombe for differences, wider with 3+ designs), comparisons need 10
  people per design, the data checks and planned hypotheses are Research
  Studio's, and no winner is declared. The study plan is used only when it's
  locked or edited, as in Research Studio.
- **Previews and tests:** like Research Studio, results leave out Qualtrics
  survey previews and test responses. An export that has only those says so
  (rather than "no usable rows") and offers **Include Qualtrics preview and
  test responses (a practice run)**. They're then read as live, in memory only,
  and the readout is marked throughout: a practice banner over the results, a
  "Practice readout:" title, the first limit, and a note at the top of the Word
  and PDF files saying they aren't study results.
- **Kept:** only totals, rates, ranges, check text and the readout's text, saved
  on the device as the form drafts are (`servant.formDrafts`, key `readout`):
  never the exports, response IDs, sessions, per-person times or answers
  (`readoutResults` in `app/src/lib/readout.ts` drops them). Coming back picks
  up where the researcher left off; updating the results needs the exports
  chosen again. Start over clears it; signing out does too.
- **Charts:** per design, the main measure with its range (a dot and a range,
  `ReadoutCharts.tsx`), then each design compared with A in percentage points
  with a dashed no-difference line, then each design's median active time for
  people who finished (a secondary measure). Every number is also ordinary text
  beside the mark, read by screen readers; the drawn marks are hidden from
  them.
- **Ratings and choices:** the study's own questions, read from the session
  data a survey with Civic Research Studio inside saves (`rs_data_*`): each
  1-to-5 or 1-to-7 rating per design as a median and how many gave each
  rating, and single or multiple choices as counts per option
  (`summarizeAnswers` in `app/src/lib/readout-answers.ts`). Questions asked
  after an activity are grouped by that activity's design; those before or
  after all of them, by the one design each person saw (someone who saw more
  than one isn't counted under either). Drafted findings get one line per
  rating question, and both exports get a table per question.
- **What people said:** written answers are read on the device and shown only
  while the export is loaded; they're never saved or exported. The researcher
  gives each comment one or more themes of their own (`CommentCoding.tsx`);
  the same words for the same question and design show once, with how many
  wrote them; **Show only comments without a theme** narrows a long list to
  what's left to code. The loaded files and comments are held in memory for
  the app session (`readout-session.ts`), so a redraw of the page, such as the
  window crossing between the phone and desktop layouts, keeps them; a reload,
  Start over or signing out clears them. Kept with the readout: theme names, each coded comment's themes
  keyed by a fingerprint (the first 24 hex characters of a SHA-256 of the
  question, design and words, not the words), the theme counts, and quotes. A
  quote is added only after the researcher edits out identifying details and
  ticks that they've checked it, and not while it looks like it has a
  Social Security, taxpayer or employer ID number, an email address, a phone
  number or a response ID. Choosing the export again brings the codes back.
  The exports add a "What people said" section: a theme table per question
  with counts per design (under `SMALL_THEME_MIN`, 3, they show as "Fewer than
  3"; a placeholder until the disclosure review team sets it) and the quotes.
  Hidden designs' counts and quotes aren't shared.
- **Small groups:** a design with fewer than `SMALL_GROUP_MIN` people (10,
  Research Studio's minimum for comparing designs, until the disclosure review
  team sets the threshold; it and `SMALL_THEME_MIN` live in
  `app/src/lib/disclosure-rules.ts`) is shown to the researcher but hidden in what's
  shared: the Word and PDF tables say "Not shown: fewer than 10 people", its
  drafted finding says so, and the PDF chart leaves it out.
- **Readout:** title, summary (required), what we tested and why (drafted from
  the plan), findings and limits (drafted from the results and checks, without
  Research Studio's own tool instructions), next steps. "Redraft findings and
  limits from the results" replaces only those two after a confirmation.
  When the results are shown again (Survey 1 added, a new export), the drafted
  sections the researcher hasn't edited follow the new numbers; the summary and
  next steps are always kept. Edited sections are kept too, but if the numbers
  changed they're flagged and sharing waits until they're redrafted or the
  researcher chooses **Numbers checked** (`updateReadout`).
- **Checks before sharing:** title, summary, findings and limits written; no
  "validated", "proven", "approved", "winner", "significant",
  "outperformed", "superior" and the like; no quotation marks (participants' words wait for quote review); and
  early comparisons said to be too early; participants' words only as reviewed
  quotes (no quotation marks in the summary or findings), with theme names and
  quotes checked too; and nothing that looks like a detail
  about a person (a Social Security, taxpayer or employer ID number, an email
  address, a phone number or a Qualtrics response ID) in any section.
- **Sharing:** the Word document carries the text and each activity's results
  as tables (`readoutDocx`, written by `app/src/lib/word-document.ts`, which
  follows Research Studio's Word writer and reuses its ZIP packaging but writes
  bullet points as real Word list items and sets the language). **Print or
  save as PDF** prints the same content from a hidden frame, as a standalone
  page (`readoutHtml`): language set, headings in order, a chart per activity
  with a text description, and captioned tables with header cells. The person
  chooses Save as PDF in the print window; if no print window can open, the
  page is saved as an `.html` file to print. Both are held back by the same
  checks.
- **Not yet:** theme dashboards, other methods than A/B, sharing inside Servant
  (needs a server-side store), turning findings into "What the research found"
  for a new prototype, decision logging. The PDF path hasn't been tried in the
  Mac app yet.

## Research plan collaborators

The author of a Research Studio study plan (a `[Research study]` chat on the
restricted Researcher lane) can add up to ten teammates as viewers from the
chat's options. **During the research pilot, collaborators can view only.** The
server rejects `edit` (`collaborator_view_only`) and treats grants saved as
`edit` earlier as view. Collaborators can't send to the Researcher Agent or
change anything. This adds one optional `collaborators` field to the
existing `PATCH /v1/chats/:id` request; there is no new endpoint, chat, message
type, or pairing change.

- Only people the server currently treats as Researchers (tier 4, not admins)
  can be added. Onboarding preferences never qualify someone. The server
  re-evaluates every collaborator on every request, so a tier change, removal,
  a private forward into the plan, or deletion ends access without rewriting
  the stored list. The author sees a paused collaborator as paused.
- Collaborators read the plan, with **Refresh** in its banner and the plan's
  real update time from the server ("Plan updated 2:14 PM · Checked at 2:20 PM");
  the load time is only ever labeled "Checked at".
  Each refresh asks the server again, so access is rechecked; if it ended, the
  plan closes. Only the author changes collaborators or sharing, archives, or
  deletes the plan. An author who loses Researcher access loses the plan, and so
  do its collaborators. The owner keeps the record for audit.
- Every file and message is credited to whoever sent it, from the
  message-author record, never to the person reading (UX-M01).
- Collaborators do not share the plan with the workspace. Research Studio lists
  plans opened to you under **Shared with you**. Once anyone other than the
  author writes in a plan, each user message names its sender.
- Original clients ignore the new fields. Collaborator chats still report
  `readOnly: true`, so an older client shows the plan read-only. A server without collaborator support
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

## Feedback sandbox

`cd app && npm run sandbox` runs a private, made-up copy of Servant on the Mac
for feedback sessions, with a preview persona (Preview Researcher) who can reach
every Servant UX feature. See [Feedback sandbox](feedback-sandbox.md).

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
