# Performance

What was measured, how, and what it showed. The scripts are in [scripts/perf](../scripts/perf/README.md); the raw medians and ranges are in [captures/performance/measurements.json](captures/performance/measurements.json).

## 11/15: every press under 300 ms

The owner's target: everything should feel instant, under 300 ms. Measured from inside the page (`scripts/perf/instant.cjs`): from the pointer going down until what the press was for is on screen and opaque, checked on every frame, plus one frame for it to be painted. A phone-sized page, the same server and channel as below, three runs, the median. "Before" is `main` at `f9d0263`; "after" is this change together with the three below.

### What was slow, and why

The first visit to each kind of screen took 340–520 ms; every later visit took 30–60 ms. In a browser a screen's code arrives the first time the screen is opened. While it is on its way the screen is an empty placeholder, and React then keeps a placeholder up for about 300 ms even when the code arrived in ten. The browser's own timeline showed nothing running for about 260 ms of the wait.

The fix: in a browser, every screen's code is loaded ahead of its first use (`app/src/lib/preload-order.ts`): channels, agent chats, threads and the tabs at once when the signed-in app comes up, the rest one at a time when the page is quiet. Sign-in and pairing screens are left for when they are needed. This fetches about 260 KB (compressed) in the background that used to be fetched screen by screen. Phones are not affected: their screens' code is in the app.

Time labels on message rows now put each minute into words once (`app/src/lib/local-format.ts`). They were about a tenth of the script in a profile of opening a channel; the gain was too small to tell apart from run-to-run differences in these timings.

### Results

At normal speed:

| Press | Before | After |
| --- | --- | --- |
| Open a channel, first visit | 354 ms | 107 ms |
| Open a thread, first visit | 440 ms | 137 ms |
| People tab, first visit | 342 ms | 58 ms |
| You tab, first visit | 335 ms | 35 ms |
| Details | 78 ms | 108 ms |
| Open a channel again | 39 ms | 42 ms |
| Back to the channel, back to Home, the other tabs, a second channel, the agent chat | 13–45 ms | 15–55 ms |

**After, nothing measured is over 300 ms at normal speed; the slowest is 137 ms.** A sent message is drawn 11 ms after Enter and is in its place at 27 ms (one run, after).

With 150 ms added to every answer from the server, to stand in for a real network: the same four first visits go from 358, 426, 516 and 348 ms to 106, 126, 208 and 34 ms. Details takes 260 ms (228 before), because it waits for the server. Nothing is over 300 ms after. A channel that was not among the few loaded ahead on Home still waits for the server when opened; that case is not in these timings.

### Still over 300 ms: a processor slowed four times

| Press | Before | After |
| --- | --- | --- |
| Open a channel, first visit | 510 ms | 486 ms |
| Open a thread, first visit | 808 ms | 450 ms |
| Details | 249 ms | 365 ms |
| Back to the channel from Details | 234 ms | 302 ms |
| Open a channel again | 166 ms | 230 ms |
| People tab, first visit | 447 ms | 150 ms |
| You tab, first visit | 411 ms | 155 ms |
| Everything else | 13–220 ms | 13–245 ms |

On a device that slow, drawing a screen of messages for the first time takes about half a second, as it did before. Details, coming back from it, and reopening a channel are 60–115 ms **slower** than before: the recycling list measures itself again each time a screen covers or uncovers it. Three variations of how the list starts were tried and made no difference outside the noise.

### Not known

How any of this feels on a phone. The apps were not run, and the preloading does not apply there.

## 11/15: React Compiler, a recycling list for conversations, and the swipe row on Gesture Handler and Reanimated

Three changes, measured in a browser only. **Nothing here was measured on a phone**, and the phone-only change has no number at all.

| Change | Where it applies | Measured |
| --- | --- | --- |
| React Compiler (`"reactCompiler": true` in `app/app.json`) | Everywhere | Browser |
| Recycling list (FlashList) for channels and direct messages | Browser and Mac app; phones keep the list they had (`app/src/lib/conversation-list.ts`) | Browser |
| Swipe on a conversation's row handled by Gesture Handler and Reanimated | Phones only; the browser keeps its own copy (`SwipeSurface.web.tsx`) | Not measurable here |

### How

A production web build (`expo export -p web`) of `main` at `f9d0263` and of this change, served in turn on the same address, against a throwaway local server with 2,000 seeded messages in #general and two people signed in. Chromium, a 390 × 844 page, the processor slowed four times to stand in for a slower device. Five runs of each build, alternated so drift in the machine falls on both; the table gives the median and, in brackets, the lowest and highest run. "Script" is the browser's own count of time spent running script.

### Results (processor slowed four times)

| | `main` | Compiler only | Compiler and list | Change |
| --- | --- | --- | --- | --- |
| **Open the channel**: script until the page is quiet | 655 ms (505–693) | 616 ms (583–653) | 565 ms (543–603) | −14% |
| **Type 60 characters**: script | 649 ms (569–687) | 589 ms (566–633) | 591 ms (535–628) | −9% |
| Key press to next painted frame, median | 24.0 ms | 23.3 ms | 24.5 ms | none |
| **15 messages arrive**: script for each | 45.7 ms (39.8–48.0) | 47.0 ms (39.6–49.1) | 25.0 ms (18.9–27.8) | −45% |
| **Scroll back about 1,270 messages**: time, wheeling without a pause | 63 s | 63 s | 26 s | −59% |
| Script spent doing it | 25.9 s | 25.3 s | 16.2 s | −37% |
| **In the first 12 s of that scroll**: frames longer than 100 ms | 2 (0–3) | 2 (0–3) | 25 (24–25) | worse |
| Longest frame | 117 ms | 117 ms | 300 ms (250–383) | worse |
| Time in tasks over 50 ms | 1.4 s | 1.7 s | 5.0 s | worse |

With no slowing (three runs each): a message arriving costs 6.8 ms of script against 9.8; the same scroll back takes 24 s against 60 s and 3.2 s of script against 6.9; no frame was over 50 ms on `main` and at most one was on the new build (longest frame 50 ms against 33 ms).

How long a press takes to show its screen is measured separately, and more exactly, in the next section. An earlier version of this page gave 854–862 ms for opening a channel on both builds; that figure came from polling the page from outside and was too high by about half a second.

### What that means

- **The list is where the gain is.** Messages arriving cost a little over half the script, and going back through history is more than twice as fast, because the old list stopped and waited each time it reached the end of what it had loaded.
- **The list has a cost on a slow device**: each time a page of 50 older messages is added above, the page holds for a quarter to a third of a second (with the processor slowed four times). On a fast computer this did not show. The old list had fewer and shorter holds because it stopped scrolling instead.
- **React Compiler alone is a small gain here**: 9% less script while typing, 6% opening a channel, and nothing outside the noise for arriving messages or scrolling. The screens it would help most were already memoised by hand.
- **Download size went up.** The browser's script is 849 KB compressed, from 753 KB: 73 KB from compiled components and 22 KB for the list. Gesture Handler and Reanimated would have added about 290 KB more to every first load, which is why the browser does not load them.

### Not known

- Anything about a phone: the list was not changed there, the compiler's effect was not measured there, and the swipe on Gesture Handler and Reanimated has not been run on a device. The iPhone bundle builds (`expo export -p ios`), and the same component was run in a browser before the browser was given its own copy, where every swipe came to rest exactly as on `main`.
- Threads and agent chats, which still use the list they had.
- Memory: the readings after scrolling ranged too widely on both builds (17–48 MB) to say anything.

### Releasing it

Turning the compiler on changes the app's native fingerprint ([ota.md](ota.md)), although no native code changed. Phones get all of this with the next App Store or Play build, not over the air, and builds from before it stop receiving updates made after it.
