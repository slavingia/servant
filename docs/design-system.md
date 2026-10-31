# Servant design system

Servant uses native system type, a restrained navy and blue palette, and clear
reading order. The conversation is the primary content. Navigation, status, and
management actions should help people reach it without competing for attention.

The source of truth is `app/src/lib/theme.ts`. Shared interaction components live
in `app/src/components/`. Use those tokens and components for new screens.

## Foundations

### Type

Keep the platform's system font and text scaling. Do not disable font scaling or
shrink text to fit fixed-height controls. Let labels wrap and controls grow.

| Role | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `display` | 32 / 40 | 700 | Occasional introductory headline |
| `title` | 28 / 34 | 700 | Page title |
| `heading` | 20 / 28 | 600 | Section or empty-state heading |
| `body` | 16 / 24 | 400 | Messages, descriptions, field values |
| `bodyStrong` | 16 / 24 | 600 | Conversation titles and button labels |
| `label` | 14 / 20 | 600 | Field and list section labels |
| `caption` | 14 / 20 | 400 | Dates, counts, helpers, and status |
| `captionStrong` | 14 / 20 | 600 | Compact actions and badges |

Use sentence case. Reserve bold for titles, primary actions, and unread content.
Essential explanations remain readable body or caption text; color alone never
communicates selection, errors, or unread state.

### Color

| Token | Purpose |
| --- | --- |
| `navy` | Brand band and navigation headers |
| `blue`, `blueDark` | Primary actions, links, and pressed states |
| `blueSoft` | Secondary controls and selected surfaces |
| `ink`, `muted` | Main content and supporting text |
| `white`, `surface`, `subtle` | Content, grouped backgrounds, and quiet fills |
| `line`, `borderStrong` | Separators and identifiable input boundaries |
| `red`, `redSoft` | Destructive actions and errors |
| `bubbleMine`, `bubbleAgent` | Private agent chat bubbles |

Keep blue for actionable or selected content. Archived navigation uses muted text
and a neutral count. Standard foreground/background combinations are checked for
text contrast; thin decorative separators need not look like form boundaries.

### Space and shape

Use the 4, 8, 12, 16, 20, 24, 32, and 48 spacing scale. Screens have 20-point side
gutters. Related content uses 8–12 points; sections use 24–32 points. Corners use
8, 12, or 16 points. Pills are reserved for reactions and small selection markers.

Controls have at least a 44-point target. Primary buttons and fields are at least
52 points high, with vertical padding rather than a fixed height. Lists separate
items with quiet rules; use cards for grouped settings or attachment previews.

## Shared components

- `Band`: small brand header for Welcome before pairing.
- `AppChrome` and `Omnibar`: fixed search above navigation on every signed-in
  screen. Consume the top safe inset once; conversation keyboard offsets include
  the measured chrome height. The search panel supports Cmd/Ctrl+K, arrow keys,
  Enter, Escape, touch, and labelled controls.
- `PageTitle`: title, optional description, and an optional page action. Actions
  stay next to their page context; they can wrap on narrow screens.
- `Button`: primary, secondary, link, and danger treatments with shared loading,
  disabled, accessibility, and compact variants.
- `controls.input`: shared field surface, boundary, padding, and body type.
  Combine it with `inputMultiline` or `inputFocused` as needed. Always give fields
  persistent labels and an accessible name, not only a placeholder.
- `ConfirmDialog`: consistent cancel/confirm interaction, busy state, and errors
  for actions such as deleting, signing out, or leaving a channel.
- `ConversationRow`: title and timestamp above a one-line preview; unread
  conversations use weight and a count. Optional trailing actions are siblings
  of the row button, avoiding nested interactive controls.
- `Composer`: the shared message field, send state, attachment controls, and
  mention suggestions. Agent chats use the same component without attachments.

## Information architecture

Primary tabs, in order:

1. **Channels** — your joined, active conversations; then channel discovery.
2. **Messages** — direct and group conversations.
3. **Agent** — private agent chats.
4. **Members** — find people and invite teammates.
5. **You** — profile, Preferences, Workspace, and Help & updates.

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
**Your channels**. They do not appear as a competing filter or contribute unread
emphasis. Their messages remain accessible, and existing restore and delete
actions remain available. `/browse` continues to route to Channels.

Creation and detail flows use stack navigation. Contextual controls sit with the
content they affect. Destructive actions are separated from everyday actions
and describe their consequence before confirmation.

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
