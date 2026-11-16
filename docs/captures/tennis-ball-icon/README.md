# The tennis ball icon and its three colors: before and after

The app icon is now a tennis ball on a navy field whose seam is a white S (Servant helps people serve), and the default palette is the icon's three colors: navy, tennis yellow and white.

Real browser screenshots from the running app at phone size (390 × 844) and desktop size (1280 × 800), device scale 2.

- **Before:** `main` at `db1cdd6`.
- **After:** this branch.
- Made-up workspace on a throwaway local server: Pat Tester, Jo Park and Ana Ruiz. On Welcome the credit line was pointed at the placeholder name for these captures, on both sides, so no real name is pictured.
- The before run opened #general, which marked it read, so Home's unread count is 2 before and absent after. That is the fixture, not the change.

**Not pictured: a phone or the Mac app.** There is no iPhone, simulator, Android device or Mac where these were taken. The icon files were not built with Xcode or Gradle; what is shown for them is the files themselves, composed the way a launcher, a themed icon and a status bar use them.

## The icon files

The icon, the Android adaptive icon in a round launcher mask, the one-color shape for Android themed icons, the status-bar icon, and the favicon at 16, 32 and 128 pixels.

| Before (`db1cdd6`) | After |
| --- | --- |
| ![A white S on flat navy with a blue bar under it](before/icons.png) | ![A tennis ball on navy whose seam is a white S](after/icons.png) |

## The app

| | Before (`db1cdd6`) | After |
| --- | --- | --- |
| Welcome, phone | ![The wordmark on navy over a blue bar](before/welcome-phone-light.png) | ![The wordmark on the icon's navy over a yellow bar](after/welcome-phone-light.png) |
| Home, phone, light | ![Blue links, icons and counts](before/home-phone-light.png) | ![The same in the icon's lit navy; the agent's mark is yellow on navy](after/home-phone-light.png) |
| Home, phone, dark | ![Pale blue on the dark page](before/home-phone-dark.png) | ![Tennis yellow on the dark page](after/home-phone-dark.png) |
| A channel, phone, light | ![Blue links and Send](before/channel-typing-phone-light.png) | ![Lit navy links and Send](after/channel-typing-phone-light.png) |
| A channel, phone, dark | ![Pale blue links](before/channel-typing-phone-dark.png) | ![Yellow links and focus border; Send keeps a white arrow on lit navy](after/channel-typing-phone-dark.png) |
| Invite, phone | ![A blue button](before/invite-phone-light.png) | ![A lit navy button with a white label](after/invite-phone-light.png) |
| Home, desktop, light | ![A blue sidebar with a white count](before/home-desktop-light.png) | ![The icon's navy sidebar with a yellow count](after/home-desktop-light.png) |
| A channel, desktop, dark | ![A blue sidebar beside the dark page](before/channel-typing-desktop-dark.png) | ![The navy sidebar, a yellow count and yellow links](after/channel-typing-desktop-dark.png) |

## Pages outside the app

| | Before (`db1cdd6`) | After |
| --- | --- | --- |
| The public site | ![A blue header and button](before/site-phone-light.png) | ![A navy header with a yellow bar under the name](after/site-phone-light.png) |
| The secure inbox, light | ![A blue button](before/secure-inbox-phone-light.png) | ![A lit navy button](after/secure-inbox-phone-light.png) |
| The secure inbox, dark | ![A blue button](before/secure-inbox-phone-dark.png) | ![The same button on the dark page](after/secure-inbox-phone-dark.png) |
| The project page (docs) | ![Dark navy with an amber pill](before/docs-index-phone-light.png) | ![The icon's navy with a yellow pill](after/docs-index-phone-light.png) |
| The Mac download page | ![Navy and blue](before/downloads-desktop-light.png) | ![The icon's navy and lit navy](after/downloads-desktop-light.png) |

The phone pictures inside the project page are empty frames on both sides: it was opened from a file, where its screenshots do not load.

## Where each color goes

- **Navy `#1E265D`** (the average of the icon's field): the sidebar, the Welcome band, public page headers, the agent's tile.
- **White:** the light page and the label on every filled button.
- **Tennis yellow `#DEEF51`:** on navy, the bar under the wordmark, the sidebar's unread counts, the Deep work switch when on and the agent's mark; in dark mode also links, icons, the chosen tab and focus borders. Never words or a line on a white page, and never under a white label: both are 1.27 to 1.
- **Lit navy `#4E61D6`:** the icon's navy made light enough for a white label at 5.24 to 1. Filled buttons in both appearances, and links and icons on a light page.

A workspace that set its own color keeps it and is never given the yellow.
