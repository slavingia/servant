# While the agent replies: before, main now, and after

These are actual browser screenshots from running builds. They are not mockups or edited images.

There are three sides, because `main` moved while this branch was in progress: it gained a first cut of the same change (steer by default, Stop on the Send button, `/queue`, hold to queue) in the app alone.

- **Before:** `main` when the work began, `d45805bf287312aad643fbd67543f5813762083a`.
- **Main now:** `main` at `49d4d2ac3f2c0db8fcd65b5bb18978b263e4e305`, which this branch has merged.
- **After:** the branch `ux/human-thinking` at `2b2d7a341955cd4801d2a34fef6377a9d6d0f0fd`.
- Each side ran its own app build and its own server from that commit.
- **Phone:** 393 × 852. **Desktop:** 1280 × 800. Device scale 1, English, light and dark appearance.
- Every server ran on a throwaway data directory with the same made-up workspace: Ana Ruiz owns it and uses the full agent, Jo Park is a member on the restricted agent. The agent is a scripted stand-in that takes its steps when the capture script tells it to, so all sides are caught at the same moments. It holds a message sent mid-reply for a second and a half before taking it, so that moment can be photographed. Its replies, file names and figures are made up.
- The same script drove every side: send a message, let the agent take two steps, send a second message while it works, send a third (by holding Send where that exists), let it finish.
- Each test server ran the API and the worker in one process. With the worker as its own process, as deployed, a steered message was never recorded before this branch; that is covered by a test, not by these pictures.

Commits, routes and checksums are in [manifest.json](manifest.json).

## The agent is working

Before: a step count, a stopwatch and a red **Stop** button. Main now: the line counts seconds and Send is Stop, drawn as an outlined square. After: one plain line with a soft light passing over the words (a still catches one moment of it; with Reduce Motion on the words do not move), and Stop is a solid square.

| | Before | Main now | After |
| --- | --- | --- | --- |
| Light | ![A counter and a red Stop button](before/light-working.png) | ![A seconds counter and an outlined square](main/light-working.png) | ![One plain line and a solid square](after/light-working.png) |
| Dark | ![The same, dark](before/dark-working.png) | ![The same, dark](main/dark-working.png) | ![The same, dark](after/dark-working.png) |

## The steps so far

Before and on main now: a boxed list with a dot and a time for each step. After: plain lines under a quiet rule, saying what the agent did and, for the owner, what it worked on.

| | Before | Main now | After |
| --- | --- | --- | --- |
| Light | ![A boxed list with times](before/light-steps.png) | ![The same boxed list](main/light-steps.png) | ![Plain lines](after/light-steps.png) |
| Dark | ![The boxed list, dark](before/dark-steps.png) | ![The boxed list, dark](main/dark-steps.png) | ![Plain lines, dark](after/dark-steps.png) |

## A message sent while the agent replies

Before, it waited with a **Steer** pill (see the next section). On main now and after, it is added to the reply. Main shows it below the working line; after shows it above, where it will stay.

| | Main now | After |
| --- | --- | --- |
| Light | ![Below the working line: Adding this to the reply](main/light-joining.png) | ![Above the working line: Adding this to the current reply](after/light-joining.png) |
| Dark | ![The same, dark](main/dark-joining.png) | ![The same, dark](after/dark-joining.png) |

## A few seconds later, with a second message held for afterwards

Before: both messages wait, each with a Steer pill and a close. Main now: the message that joined the reply has dropped out of the list on the phone that sent it, and comes back only when the reply ends; the held one waits. After: the first message is part of the conversation above the working line, and the held one waits below it with a small close.

| | Before | Main now | After |
| --- | --- | --- | --- |
| Light | ![Two waiting messages with Steer pills](before/light-queued.png) | ![The joined message is missing; one waits](main/light-queued.png) | ![One joined, one waits](after/light-queued.png) |
| Dark | ![Two waiting messages, dark](before/dark-queued.png) | ![The joined message is missing, dark](main/dark-queued.png) | ![One joined, one waits, dark](after/dark-queued.png) |

While something is typed the button is Send again. After adds **Hold to queue** beside it; on main the hold works but nothing on screen says so.

| Light | Dark |
| --- | --- |
| ![Hold to queue beside the Send button](after/light-hold-hint.png) | ![Hold to queue, dark](after/dark-hold-hint.png) |

## When it finishes

Before, the message sent meanwhile got a second reply of its own. On main now and after it was folded into the first reply. After also says how long the agent worked, and that line opens to the steps.

| | Before | Main now | After | After, summary opened |
| --- | --- | --- | --- | --- |
| Light | ![Three replies, nothing about the work](before/light-finished.png) | ![Two replies, nothing about the work](main/light-finished.png) | ![Worked for 16 seconds above the reply](after/light-finished.png) | ![The summary opened to its steps](after/light-summary-open.png) |
| Dark | ![The same, dark](before/dark-finished.png) | ![The same, dark](main/dark-finished.png) | ![The same, dark](after/dark-finished.png) | ![The summary opened, dark](after/dark-summary-open.png) |

## A long reply

Past a minute the line says how long it has been, in words. The turn's start was moved back two minutes in the test server's journal to reach this.

| Light | Dark |
| --- | --- |
| ![Searching the web, two minutes](after/light-two-minutes.png) | ![Searching the web, two minutes, dark](after/dark-two-minutes.png) |

## A member on the restricted agent

A member's line says "Working on it" for every tool and the steps never say what ran. That agent cannot take a message mid-reply, so both messages wait. Before, a member saw the same Steer pill as the owner, and tapping it answered "Steering needs the full agent".

| Working | Steps opened | Two messages waiting |
| --- | --- | --- |
| ![Working on it](after/light-member-working.png) | ![Thinking, Working on it](after/light-member-steps.png) | ![Both messages wait](after/light-member-queued.png) |

## The wide layout

| | Before | After |
| --- | --- | --- |
| Working | ![Wide layout before](before/wide-light-working.png) | ![Wide layout after](after/wide-light-working.png) |
| Sent while it works | ![Two Steer pills](before/wide-light-queued.png) | ![One joined, one waits](after/wide-light-queued.png) |
| Finished | ![No summary](before/wide-light-finished.png) | ![Worked for … above each reply](after/wide-light-finished.png) |

## What these do not show

A browser at phone size is not a phone. The haptic on a held Send, VoiceOver and TalkBack, the native animation driver, and the touch that iOS takes away after swipe typing were not exercised on a device.
