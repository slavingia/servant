# PR 74: before and after

These are actual browser screenshots from two clean checkouts, each running its own server and its own web build. They are not mockups or edited images.

- **Before:** `main` at `6f5f3cb3ff27f548c216c0e739e195902d68e37d`, the PR's base. It already includes Cases.
- **After:** the branch at `0b738714277ca687ca0894396c6b9d34231578a2`.
- **Desktop:** 1280 × 900. **Phone:** 390 × 844. Device scale 1, light appearance, English.
- Both sides run on copies of the same made-up data. The browser version, capture times, routes, HTTP status and image checksums are in [manifest.json](manifest.json).

## Where the places are

One list of places feeds the sidebar, You and search. The sidebar keeps its compact rows and draws the list in three groups with no gap between them; You gives each group a heading. Cases sits with the other conversations. The work email nudge is the small pill again.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop: Home with the sidebar | ![The sidebar on main](before/navigation-desktop.png) | ![The sidebar on the branch](after/navigation-desktop.png) |
| Phone: the places on You | ![One long Workspace list on You](before/navigation-phone.png) | ![Three headed groups on You](after/navigation-phone.png) |

## A page the server renders

The landing, join, support, privacy, terms and public survey pages share one stylesheet with the app's palette, type and controls. The join page also shows what an invite link looks like.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | ![The join page on main](before/join-desktop.png) | ![The join page on the branch](after/join-desktop.png) |
| Phone | ![The join page on main, on a phone](before/join-phone.png) | ![The join page on the branch, on a phone](after/join-phone.png) |

## A form and rows with actions

Text fields are the one shared field. In a wide window Edit and Delete sit on the entry's line; on a phone they wrap under it as before.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | ![Text shortcuts on main](before/text-shortcuts-desktop.png) | ![Text shortcuts on the branch](after/text-shortcuts-desktop.png) |
| Phone | ![Text shortcuts on main, on a phone](before/text-shortcuts-phone.png) | ![Text shortcuts on the branch, on a phone](after/text-shortcuts-phone.png) |

## The checkbox and a text field

To-dos uses the one checkbox picture, and **Add a to-do** is the shared field with its outline instead of a grey fill.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | ![To-dos on main](before/todos-desktop.png) | ![To-dos on the branch](after/todos-desktop.png) |
| Phone | ![To-dos on main, on a phone](before/todos-phone.png) | ![To-dos on the branch, on a phone](after/todos-phone.png) |

## The switch, in a browser

A browser drew its own 40 by 20 switch. The branch draws the same track as Deep work inside a 44-point control.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | ![The browser's switch on New channel](before/new-channel-desktop.png) | ![The shared switch on New channel](after/new-channel-desktop.png) |
| Phone | ![The browser's switch on a phone-width window](before/new-channel-phone.png) | ![The shared switch on a phone-width window](after/new-channel-phone.png) |

## What these do not show

Dark appearance, the other server pages, the Cases screens (unchanged apart from the dimming behind a dialog in dark appearance), and changes with nothing to see in a still image: 44-point targets around smaller shapes, the state a chosen button reports to a screen reader, and colors and type moving from written-out values to tokens. The tests named in the pull request cover those.

## How they were made

Each side ran `server/server.mjs` on a loopback address with a throwaway data directory, and Expo web for that checkout. The data was seeded once through the server's own API and copied, so both sides show the same team, messages, to-dos and shortcuts: Pat Tester, Jo Park, Ana Ruiz and other invented teammates, with `example.gov` addresses. Push delivery and discovery were off.

The capture script signed in as the same owner on both sides, refused a checkout with changed app or server source, and failed on any sideways overflow. Every image was reviewed for readability and private information; none shows a real person, address or credential.

## Keyboard follow-up

The review found that changing a web Pressable from button to radio removed its
Space-key action. Commit `9d90bab` adds one Radio component used by all nine
converted choices. It keeps the same appearance and native behavior while
restoring web Space activation without repeated actions. The original twenty
layout captures above remain representative.

On source `6afbf05e3aa5b51bbfef1765cc82849b7fcaa903`, the running app was checked using a
separate synthetic server and an isolated dependency install. Space selected
**Custom** in Saved → Work log, displayed the date inputs and set the radio's
checked state. Enter selected **All time** and removed the inputs. Space and
Enter also toggled **Private channel** on and off. There were no browser app errors.

The matched keyboard comparison uses the same synthetic Pat Tester account and
purple test server at 1116 × 902 in dark appearance. **Before** runs merged main
`9ba545c485014debed3ea847508d9e92e62636b3`: after pressing Space on Custom, Past 7
days stays selected and no date inputs appear. **After** runs `6afbf05` with the
fix: the same key selects Custom and displays the date inputs. The subsequent
merge-only commit `8ac4b1f` has identical app/server/script source to that tested
version. These captures prove browser keyboard behavior, not native-device behavior.

| Before | After |
| --- | --- |
| ![Before: Space leaves Custom unchecked](keyboard-space-before.jpg) | ![After: Space selects Custom](keyboard-space-after.jpg) |
