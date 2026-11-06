# Servant design system

Servant uses Slack-like workspace navigation and message density with brand blue
and native system type. Home acts as a workspace sidebar:
compact channels and direct messages lead into a shared message stream. Navigation,
status, and management actions help people reach conversations without competing
with their content.

The source of truth is `app/src/lib/theme.tsx`, with palettes in
`app/src/lib/theme-colors.ts`. Shared interaction components live
in `app/src/components/`. Use those tokens and components for new screens.

## Foundations

### Type

Keep the platform's system font and text scaling. Do not disable font scaling or
shrink text to fit fixed-height controls. Let labels wrap and controls grow.

| Role | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `display` | 28 / 34 | 700 | Occasional introductory headline |
| `title` | 22 / 28 | 700 | Page title |
| `heading` | 18 / 24 | 700 | Section or empty-state heading |
| `workspace` | 20 / 26 | 700 | Retained type role; unused by the fixed search strip |
| `body` | 15 / 22 | 400 | Messages, descriptions, field values |
| `bodyStrong` | 15 / 22 | 600 | Authors, section names, and button labels |
| `label` | 13 / 18 | 600 | Field and list section labels |
| `caption` | 13 / 18 | 400 | Previews, counts, helpers, and status |
| `captionStrong` | 13 / 18 | 600 | Compact actions and badges |
| `meta` | 12 / 16 | 400 | Timestamps, presence, receipts, and toolbar hints |

Letter spacing is -0.5 for `display`, -0.3 for `title`, -0.15 for `heading`, and
-0.2 for `workspace`; other roles use the platform default. Unread conversation
names use weight 700. Native tab label typography and selection styling are
managed by the platform.

Use sentence case. Reserve bold for titles, primary actions, and unread content.
Essential explanations remain readable body or caption text; color alone never
communicates selection, errors, or unread state.

### Color

Appearance always follows the device's light or dark setting, including changes
while the app is open. There is no in-app appearance preference. Use `useTheme()`
for inline colors and `createThemedStyles()` for styles so mounted screens update
without resetting navigation or message drafts. Typography, spacing, and radii
remain shared across appearances.

The values below describe the light palette. In dark mode, `background` is
`#12161C`, `surface` is `#1B222C`, `ink` is `#F0F3F7`, `muted` is `#ADB8C7`,
and actionable `blue` is `#80C7FF`. Use `background` for content surfaces;
`white` remains literal white for QR codes and media overlays. Use `primary` /
`onPrimary` for filled actions, `danger` for destructive fills, and `brandText`
for brand-colored text. These are separate from link and error foregrounds so
text keeps its contrast in both modes. Avatar tone pairs also adapt.

Native configuration uses automatic appearance and `expo-system-ui`. A new
native build is required to replace older binaries that force light appearance.
The full-screen media viewer retains its dark canvas in both modes.

| Token | Value | Purpose |
| --- | --- | --- |
| `navy` | `#004C97` | Brand blue fixed search strip and brand surfaces |
| `blue` | `#0071BC` | Primary actions, links, and unread badges |
| `blueDark` | `#205493` | Pressed actions and selected foregrounds |
| `blueSoft` | `#E8F2FC` | Selected filters and quiet blue surfaces |
| `gold` | `#FDB81E` | Retained brand accent token; unused by the fixed search strip |
| `green` | `#2E8540` | Online presence indicator, accompanied by text |
| `onBrandMuted` | `#DCEBFA` | Retained supporting brand color; unused by the fixed search strip |
| `ink` | `#1D1C1D` | Main content |
| `muted` | `#5B616B` | Supporting text and icons |
| `background` | `#FFFFFF` | Main content and message backgrounds |
| `white` | `#FFFFFF` | Fixed white for QR codes and media overlays |
| `primary` / `onPrimary` | `#0071BC` / `#FFFFFF` | Filled actions and their labels |
| `surface` | `#F7F8FA` | Quiet fills and pressed rows |
| `subtle` | `#EEF1F5` | Disabled send and supporting fills |
| `line` | `#E6E7EB` | Quiet separators |
| `borderStrong` | `#8B929B` | Fields and secondary button boundaries |
| `red` | `#D11242` | Destructive actions and errors |
| `redSoft` | `#FDECEF` | Failed-message background |
| `bubbleMine` | `#0071BC` | Retained token; current message streams do not use bubbles |
| `bubbleAgent` | `#F4F7FA` | Retained token; current message streams do not use bubbles |

Keep blue for actionable or selected content. Archived navigation uses muted text
and a neutral count. Check foreground/background combinations for text contrast;
thin decorative separators need not look like form boundaries.

### Space and shape

Spacing tokens are `xxs: 4`, `xs: 8`, `sm: 12`, `md: 16`, `side: 16`, `lg: 24`,
`xl: 32`, and `xxl: 48`. Screens have 16-point side gutters. Related content uses
4–12 points; larger separations use 24–32 points. Radius tokens are `sm: 6`,
`md: 10`, `lg: 12`, `xl: 24`, and `pill: 999`. People avatars are circles; agent
avatars, buttons, and reaction chips use small rounded corners. Unread badges and
date labels use pills. The signed-in
content shell uses `radius.xl` on its top-left and top-right corners, with
brand blue behind it. Content is clipped to those corners; bottom corners remain
square.

Controls have at least a 44-point target. Primary buttons and fields are at least
48 points high, with vertical padding rather than a fixed height. Compact Home
rows are at least 44 points high and omit separators. Standard conversation rows
are at least 72 points; agent history rows are at least 64. These are minimums,
so text scaling can increase row height. Use cards for grouped settings or
attachment previews, not every message.

### Icons and avatars

Use `AppIcon` for the shared in-screen outline icon set. Icons are decorative
inside a control whose accessible label explains its action. Keep custom
icon-only controls at least 44 by 44 points. Native tabs use platform symbols
and system-managed touch targets.

`Avatar` uses initials in a circle for people, with a radius of half its size.
Agent avatars use rounded squares. A stable name hash selects one of five
`avatarTones` background/foreground pairs:

| Background | Foreground |
| --- | --- |
| `#E8F2FC` | `#004C97` |
| `#E6EEEB` | `#24634D` |
| `#FFF2CD` | `#6B4E00` |
| `#EEEAF5` | `#584574` |
| `#E9EDF2` | `#3B4B63` |

Compact DM rows use 26-point avatars, standard conversation rows use 40, and
message authors use 34. Agent avatars show `AI` in white on the brand blue.

## Shared components

- `Band`: small brand header for Welcome before pairing.
- `AppChrome` and `Omnibar`: a fixed brand blue search strip above navigation on
  every signed-in screen. Its 44-point search control uses the placeholder
  **Search**. Consume the top safe inset once; conversation keyboard offsets
  include the measured chrome height. The search panel supports Cmd/Ctrl+K,
  arrow keys, Enter, Escape, touch, and labelled controls. Creation actions stay
  on their existing screens, and the **You** tab provides profile access.
  `AppChrome` gives the themed signed-in content area its rounded top corners.
- `PageTitle`: title, optional description, and an optional page action. Actions
  stay next to their page context; they can wrap on narrow screens.
- `Button`: blue primary, bordered secondary, link, and danger treatments
  with shared loading, disabled, accessibility, and 44-point compact variants.
- `controls.input`: shared field surface, boundary, padding, and body type.
  Combine it with `inputMultiline` or `inputFocused` as needed. Always give fields
  persistent labels and an accessible name, not only a placeholder.
- `ConfirmDialog`: consistent cancel/confirm interaction, busy state, and errors
  for actions such as deleting, signing out, or leaving a channel. The content
  scrolls when large text or a small viewport requires it.
- `ConversationRow`: standard rows show an avatar or channel glyph, title,
  timestamp, and one-line preview. `compact` rows show only a hash/lock or small
  avatar, name, and unread count. Unread names use weight 700. Optional trailing
  actions are siblings of the row button, avoiding nested interactive controls.
- `SwipeChannelRow`: archive/restore and permitted delete actions, reachable by
  swipe, long press, assistive actions, or the web overflow button. Revealed
  controls follow the trigger in keyboard order.
- `Composer`: a bordered message box with a multiline field above a small
  toolbar. The plus control opens Photos & videos/Files choices, mention suggestions
  appear while typing `@`, and the send icon reflects disabled and sending
  states. Attachment previews remain inside the box. Agent chats accept photos and videos
  through the same composer; channel and direct messages also accept files.
  Editing adds a clear label and Cancel action.
- `Attachments` and `MediaGalleryProvider`: images from people and the agent
  share prominent inline previews; video cards have a clear play action and file
  details. Tapping media opens a full-screen gallery
  with horizontal paging, sender information, and a position indicator. The
  gallery includes earlier conversation media and thread attachments, with
  explicit loading and retry states. Video pages use native playback controls,
  with only the current item loaded and playback stopped on navigation or app
  backgrounding. File pages retain open/share actions.
  Attachment bytes use the authenticated transport, and cached previews stay
  scoped to the signed-in account. Video playback uses temporary private files
  or browser Blob URLs, released when the player closes.

## Information architecture

Primary tabs, in order:

1. **Home** — compact Channels and Direct messages sections.
2. **DMs** — direct and small-group conversations with message previews.
3. **Agent** — private agent chats.
4. **People** — find people and invite teammates.
5. **You** — profile, Preferences, Workspace, and Help & updates.

The tab bar uses `NativeTabs`, preserving native platform appearance and iOS
Liquid Glass where supported. All tab icons use filled symbols in both selected
and unselected states; the Agent sparkle is solid in both. Labels, selection treatment,
touch targets, and safe-area behavior remain system-managed. Home and DMs badges
show channel and direct-message unread counts respectively. Existing route names
remain `channels`, `messages`, `agent`, `members`, and `you`. The fixed Search
strip and rounded content shell remain above the native tab navigation.

Home begins with **All** and **Unread** beneath the fixed search strip. These
filter active channels and direct messages; the Unread filter count
is the number of unread conversations. Both sections can be collapsed with
labelled disclosure controls. Their plus buttons create a channel or message.
**Add channels** expands public discovery inline, with preview navigation,
Create new, loading/error feedback, and an explicit Load more action when another
page exists. Pagination does not depend on scrolling past the DM section.
The DMs screen also supports All/Unread and a compact compose action; Agent has
a matching header and recent-conversation list.

The fixed omnibar is available above all signed-in tabs and detail screens. It
offers recent conversations and quick actions before typing, then groups results
into Channels, Direct messages, People, Agent chats, Messages, and Quick actions.
Typing two characters searches the server; local navigation still works if that
request fails. Message results open the thread at the matching message and
highlight it, preserving that position during initial layout.
Agent chats are searched by title. Search only returns messages in conversations
the current person has joined, including their personally archived channels.
Private unjoined channels, deleted messages, and other people's DMs are excluded.
Public channel results can be previewed before joining. Search is debounced,
bounded, and uses the existing encrypted transport; the server must include the
`/v1/search` endpoint for message and people results.

Archived channels are a secondary screen reached through a quiet row below
the expanded **Channels** section on Home. They do not appear as a competing
filter or contribute unread emphasis. Their messages remain accessible, and
existing restore and delete actions remain available. `/browse` continues to
open Home; **Add channels** opens discovery.

Creation and detail flows use stack navigation. Contextual controls sit with the
content they affect. Destructive actions are separated from everyday actions
and describe their consequence before confirmation.

## Message streams

Channels, DMs, threads, and private agent chats use a left-aligned author/avatar
stream on the content background. Author names lead, timestamps stay secondary, and body text uses
15/22 system type. Channel and thread streams use date separators. Consecutive
messages by the same person within five minutes can share a compact author group;
day changes and thread context preserve the appropriate separation.

Replies, mentions, reaction chips, delivery/read status, typing, and presence
remain contextual to their conversation. Reaction chips retain 44-point hit
targets around their smaller visible shape. Failed agent messages use the error
surface, and the current draft remains available after failed sends. Do not add
decorative toolbar actions that have no working behavior.

## Screen states

- Explain what an empty screen is for and offer the next useful action.
- Show initial loading separately from an empty result.
- Keep existing content visible during refresh and reconnection.
- Put errors near the affected content, announce them accessibly, and offer
  retry where appropriate.
- Preserve drafts when a send fails. Clearly show pending operations and prevent
  duplicate submissions.
- Keep captions secondary through weight, placement, and color rather than tiny
  type. Keep interactive controls reachable with keyboard and screen reader.

## Validation

Run `npm run typecheck`, `npm run lint`, and `npm test` from `app/`. Export all
platforms with `npx expo export --platform all` when shared UI or routing changes.
Before release, inspect narrow and wide screens, large system text, keyboard
appearance, empty/error states, and archive/restore navigation on device. Build
and type checks do not replace that visual and interaction review.
