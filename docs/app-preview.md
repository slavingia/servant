# App preview

A project's app, running in the browser inside Servant, so the team can change it right on the screen instead of marking up screenshots.

Open a project and choose **Open app preview**. The app opens at phone size (or tablet size on a wide screen) with sample data. Three modes sit above it:

| Mode | What clicking does |
| --- | --- |
| **Use** | The app works as normal. Right-click anything (or press and hold on a phone) to comment on it |
| **Comment** | Any click opens a comment box at that spot |
| **Edit** | Click words to change them in place. A small bar above them makes them bigger or smaller, adds or removes space, and changes their color |

- **A comment** becomes an ask for the agent: a new agent chat in the project, with the comment, the page, the words under the pointer (a button's label, a heading), where it was and a link to the same page in the preview. The message waits in the box so you can read or change it, then send it.
- **Edits** collect in a tray under the preview ("2 changes"). **Send to the agent** writes each one out the same way ("Words (button): "Make a payment" → "Pay now"", "text size 16px → 18px") with an optional note. **Discard** puts the screen back.

The agent is asked to find the screen in the code, make the change (words in the translation files, sizes and colors from the app's design system) and reply with before and after screenshots of the same screen.

**Go to** opens any page of the app by its path, such as `/refund-status` or a sample-account link like `/notices?persona=sample`.

## Putting an app on the server

The server serves `<data>/app-previews/<project id>/` at `/a/<project id>/`. Export the app for the web with that base path:

```sh
scripts/app-preview-export.sh <project id> <path to the app checkout> [export command]
```

The default export command is `npx expo export --platform web --output-dir dist`. The app must take its base path from `EXPO_BASE_URL` (Expo's `experiments.baseUrl`); an app with its own export script can be given that script instead. The new export replaces the old one in one step. Re-run it whenever main changes; the project page shows which commit the preview was built from.

## What it can and can't reach

- Preview pages are served sandboxed with no access to this server's origin, the same as prototypes ([prototype-reviews.md](prototype-reviews.md)). The app can't call Servant's API or read anyone's session.
- A sandboxed page has no storage, so a small script gives it in-memory storage and cookies for the visit. Nothing persists.
- A second script, the bridge, reports clicks, comments and edits to the Servant screen around it by `postMessage`. It never calls a server. Asks go through the person's own signed-in agent chat.
- `/a/<project id>/` is public to anyone who has the address, like a prototype link, and is never listed (`robots.txt` disallows `/a/`). Only export builds that use sample data. Never put a build that signs in to real accounts on the server.
