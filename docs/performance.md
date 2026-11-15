# Performance

What was measured, how, and what it showed. The scripts are in [scripts/perf](../scripts/perf/README.md); the raw medians and ranges are in [captures/performance/measurements.json](captures/performance/measurements.json).

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

Opening a channel shows its newest message at the same moment on both: 854–862 ms from the press on the new build and 877–911 ms on `main`, four opens each with no slowing. Most of that is the request for the messages.

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
