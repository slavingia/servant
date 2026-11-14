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

Every size comes from a role; do not write a `fontSize` beside them. The wide
layout's sidebar uses `body` for its rows, `label` for its section names and
`captionStrong` for its counts, like the lists on a phone. A screen's header
title is `headerTitleType(wide)`: the `heading` role in the wide layout and
`bodyStrong` on a phone (a header takes a size and a weight, not a line
height). Emoji and an avatar's initials are sized from their container, not
from a role; initials in an avatar under 26 points are one letter at 0.55 of
the circle so they can be read (`type-roles.test.ts`).

Use sentence case. Reserve bold for titles, primary actions, and unread content.
Essential explanations remain readable body or caption text; color alone never
communicates selection, errors, or unread state.

Nothing a person needs to read is cut off with an ellipsis. Names, titles,
labels, values, statuses and options wrap, and their row grows. A line limit
(`numberOfLines`) is only for a preview whose full text is one press away (a
conversation's last message, a search snippet), a file name under a tile, and
the call and media screens. `truncation.test.ts` lists each of those with its
reason and refuses a limit anywhere else.

### Color

Appearance always follows the device's light or dark setting, including changes
while the app is open. There is no in-app appearance preference. Use `useTheme()`
for inline colors and `createThemedStyles()` for styles so mounted screens update
without resetting navigation or message drafts. Typography, spacing, and radii
remain shared across appearances.

The server owner can set `"theme": { "primaryColor": "#7C3AED" }` in the
server's `config.json`; there is no color picker in the app. Omit it to keep the
default blue (`#0071BC`). Opaque `#RGB` and `#RRGGBB` values are accepted; invalid
values fall back to blue. Each saved workspace keeps its own color. Restart or
reload the app after changing the config to refresh it from the server, without
rebuilding the app or restarting the server.

Custom colors generate the brand, action, pressed, selected and first avatar
tone in both appearances. Light fills are darkened enough for white labels and
controls; link colors are adjusted for their light or dark surfaces. Error and
success colors stay semantic. The `blue`/`navy` token names remain for existing
components, but they follow the configured hue. Cache styles by the current
theme object, not just by light/dark mode, so switching workspaces updates them.

The values below describe the default light palette. In dark mode, `background` is
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
| `navy` | `#004C97` | Brand blue (navy) fixed search strip and brand surfaces |
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
| `scrim` | navy at 42% | What dims the page behind a dialog, a sheet, a menu and search; black at 60% in dark mode, where navy would lighten the page |
| `series` | `#C2571A` | The second series in a chart, beside `blue`; `#E07B39` in dark mode. At least 3 to 1 against the track and the page |

A fill with words or an icon on it uses `primary` (or `danger`): those keep
enough contrast for white in both appearances. `blue`, `green` and `red` are
foreground colors that turn pale in dark mode, so they are never a fill behind
white (`fills.test.ts`). A done or live mark is `greenSoft` with a `greenDark`
check or icon.

White on the brand color (the sidebar and the phone's header bar) comes from
one scale, `onBrandTint`: `muted` for supporting labels and icons, `border`,
`hover` for a row under the pointer, `field` for the search field and the
workspace mark, `selected` for the open page, `pressed`, and `track` for a
switch that is off. Do not write out a white of your own there. `LAUNCH_COLOR`
is the splash screen's color from `app.json`; the launch screen and the
wordmark band on Welcome continue it, and it does not follow a workspace color
because no server is known yet. A chart's legend shows each color beside what
it measures and never names the color, since a workspace can change it
(`color-tokens.test.ts`).

Keep blue for actionable or selected content. Blue words are a link, and a link
is always underlined in a browser and the Mac app: spread `linkUnderline` from
the theme into the text style (`links.test.ts` lists the blue words that are
not links, such as a mention or the chosen tab). Archived navigation uses muted text
and a neutral count. Check foreground/background combinations for text contrast;
thin decorative separators need not look like form boundaries.

### Space and shape

Spacing tokens are `xxs: 4`, `xs: 8`, `sm: 12`, `md: 16`, `side: 16`, `lg: 24`,
`xl: 32`, and `xxl: 48`. Screens have 16-point side gutters. Related content uses
4–12 points; larger separations use 24–32 points. Radius tokens are `sm: 6`,
`md: 10`, `lg: 12`, `xl: 24`, and `pill: 999`. People avatars are circles; agent
avatars, buttons, and reaction chips use small rounded corners. Unread badges and
date labels use pills. A circle or a capsule (a dot, a bar, a switch's track, a
round mark) is `radius.pill`, not half its size written out. The signed-in
content shell uses `radius.xl` on its top-left and top-right corners, with
brand blue behind it. Content is clipped to those corners; bottom corners remain
square.

Controls have at least a 44-point target by their own size. Do not use
`hitSlop`: it does nothing in a browser or the Mac app, so a control that leans
on it is as small there as it is drawn. When the visible shape is smaller (a
stage chip, the About pill above the agent's composer, a reaction, an avatar
that opens a direct message), the smaller shape sits inside a 44-point control.
`touch-targets.test.ts` refuses `hitSlop` and any control whose own style sets a
height under 44. The one exception is the wide layout's sidebar, which stays a
dense list: rows are 32 points and section headers 26 for every pointer. Taller
rows on touch screens were tried and turned down. The test lists those styles
by name. Primary buttons and fields are at least
48 points high, with vertical padding rather than a fixed height. Compact Home
rows are at least 44 points high and omit separators. Standard conversation rows
are at least 72 points; agent history rows are at least 64. These are minimums,
so text scaling can increase row height. Use cards for grouped settings or
attachment previews, not every message.

### Icons and avatars

Use `AppIcon` for the shared in-screen outline icon set. Icons are decorative
inside a control whose accessible label explains its action. An icon alone is an
`IconButton`: a 44-point square around the icon, with `edge` to line the picture
up with the content beside it. Draw a close with the `close` icon and a menu
with `more`, never with a character such as "✕" or "•••". Native tabs use
platform symbols and system-managed touch targets.

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

### Values that are not tokens

`token-ratchet.test.ts` counts, per file, the values written out where a token
exists: a color outside the palette, a type size, weight or line height beside
the roles, a corner radius that is not from `radius`, and padding, margin or a
gap off the spacing scale. `token-ratchet.json` holds today's counts. A file
may not gain one, and when it loses one its number comes down, so the total
only falls. Most of what is left is deliberate: the call screen and the media
viewer are dark in both appearances and carry their own colors, emoji and
initials are sized from their container, and a few rows sit 2 or 6 points
apart.

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
- `Button`: the one button, in four kinds and one size (48 points, 44 when
  `compact`), with shared loading, disabled and accessibility behavior.
  `primary` is filled: the one main action of a screen, form or dialog.
  `secondary` has a grey outline: every other action. `danger` has a red
  outline: anything that deletes, removes, leaves, stops or signs out, including
  the confirm button of a `ConfirmDialog`. `link` is words only, underlined on
  the web: navigation and quiet actions such as Cancel. Do not draw a button
  with a `Pressable` and a `Text`; `button-standard.test.ts` refuses a
  destructive label anywhere but on a `danger` Button (the call screen, a swipe
  action and a menu row are listed there with their reasons).
- `IconButton`: an icon alone (close, remove, more) in a 44-point square. Its
  `label` says the action for a screen reader. Words are better when there is
  room.
- `CheckBox`: the picture of a checkbox, 24 points with the field boundary. The
  row it sits in is the control and carries the role, the label and the state.
  `choice` (the default) fills with the primary color: one of the things you
  picked. `done` is pale green with a dark green tick: a finished to-do or
  saved task.
- `Toggle`: the one switch, at the end of a row whose words say what it turns
  on. A phone draws its own switch. A browser and the Mac app draw the track and
  thumb of the Deep work switch inside a 44-point control, because the switch a
  browser draws is 40 by 20. Enter and Space flip it.
- `ButtonGroup`: buttons side by side at their own width, 8 points apart,
  wrapping when they do not fit; `align="end"` in dialogs and sheets. An
  outlined button lines its outline up with the content edge; a link lines its
  words up with it.
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

Every other place a person can go is listed once, in
`app/src/lib/destinations.ts`, with its one name, icon, address and group. The
sidebar of a wide window, the **You** tab (a phone has no sidebar) and search
all draw from that list, so a place is called the same thing everywhere and a
new one is added in one line. There are three groups, in the order a day uses
them: **Conversations** (Home, Agent, Direct messages, Cases), **Your work** (To-dos,
Saved, Meetings, and Archived on You) and **Team** (People, Surveys, Feedback
queue, Wiki, and Invite people and Agent usage on You). The sidebar
draws them as one list in that order, with no gap between groups (the groups
are named for a screen reader); You gives each a heading.

Creation and detail flows use stack navigation. Contextual controls sit with the
content they affect. Destructive actions are separated from everyday actions
and describe their consequence before confirmation.

## Message streams

Channels, DMs, threads, and private agent chats use a left-aligned author/avatar
stream on the content background. Author names lead, timestamps stay secondary, and body text uses
15/22 system type. Channel and thread streams use date separators. Consecutive
messages by the same person within five minutes can share a compact author group;
day changes and thread context preserve the appropriate separation.

A channel or DM with unread messages shows one **New** line above the first of
them (`UnreadLine`, placed by `lib/unread-line.ts`): a rule across the stream in
`primary`, ending in a filled "New" like the unread badges. It is above the date
when both fall on one message, and the message under it always shows its author.
It marks where reading started for this visit, so it does not move as messages
are read or arrive.

Replies, mentions, reaction chips, delivery/read status, typing, and presence
remain contextual to their conversation. Reaction chips retain 44-point hit
targets around their smaller visible shape. Failed agent messages use the error
surface, and the current draft remains available after failed sends. Do not add
decorative toolbar actions that have no working behavior.

In an agent chat the reply in progress is one muted line in the stream
(`AgentProgress`): what the agent is doing, in plain words, with a soft light
passing over it and no counter or stopwatch. It opens to the steps so far. The
finished reply keeps a caption-sized summary above it ("Worked for 12 seconds",
`AgentWorked`) that opens to the same steps. Reduce Motion keeps the line still.

While a reply is running the composer's Send button is the only control. A tap
sends the message into the reply, touch and hold sends it afterwards ("Hold to
queue" sits beside the button), and with nothing typed the button shows a solid
square and stops the reply. It keeps the `primary` fill instead of the red
outline of `danger`: it is the same button in the same place, on screen for as
long as the agent works, and a red control there would shout through every
reply. Do not add a Stop or Steer button to the stream.

## Pages the server renders

The landing page, join, support, privacy, terms and the public survey are plain
HTML from the server, with no app. They share one stylesheet,
`server/page-style.mjs`: the same palette as CSS variables in light and dark
(following `prefers-color-scheme`), the workspace's configured color, the type
roles, 6 and 10 pixel corners, 48-point controls, the four buttons
(`.primary`, `.secondary`, `.danger`, and plain links), and links that are
always underlined. A page adds only its own layout after it and names no color
or size of its own. `server/theme.mjs` repeats the app's palette derivation so
the server stays dependency-free; `theme.test.mjs` keeps the two equal, and
`page-style.test.mjs` checks every page. Text fields use 16 pixels so iOS does
not zoom the page on focus.

## Choices and disclosures

Radios, checkboxes, switches and tabs set `aria-checked` or `aria-selected`
beside `accessibilityState`, and anything that opens and closes sets
`aria-expanded`: `react-native-web` renders the aria props and ignores
`accessibilityState`, so without them a screen reader in a browser or the Mac
app cannot say what is chosen or open (`aria-state.test.ts`). The same goes for
a button that sets `selected`. One of several (a period, a filter, a workflow, a
status, an owner, a project) is a radio in a `radiogroup`, not a button. A
button that is on or off (a reaction you added, a muted microphone, dictation)
sets `aria-pressed`. The open page in the sidebar and the open server set
`aria-current`. When two parts of
a sheet compete for room, make them sections with one open at a time, as the
person sheet does for the role and the daily limit: the closed one says what is
chosen, the open one has room to explain each choice.

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
