# Onboarding guide

Open `index.html` in a browser. It covers what Servant does, the first ten
minutes for everyone, and deep dives for developers, functional testers, UX
designers, UX content strategists and UX researchers.

The researcher deep dive covers querying the Research Hub, building a study in
Research Studio, adding catalog data and dashboards, refreshing the research
insights dashboard, and publishing automated UX Research SME reviews with tags.

## Captures

All captures were taken on November 1, 2026:

- Servant screens: the web build from `main` (`ffa430a`) at 393 by 852, signed in
  to an isolated test server (`scripts/test-instance.mjs`, port 8789) with
  made-up people and messages. The test invite QR code is covered. The dev-only
  error toast was hidden before capture.
- Research Studio v0.3.5 (`ae79f19`): the live site, tree testing example.
- design-prototypes: the live research insights dashboard and the refund debt
  UX Research SME review.

Command output in the guide is from real runs that day. The dashboard refresh
check passed against research-hub branch `codex/multisurvey-onboarding-2026-10-18`;
research-hub `main` (`3d6bbca`) fails it with a `survey_id` error until #483 merges.

## Checks

Playwright at 1440, 390 and 320 wide: no console errors or failed requests, every
image loads, no horizontal scroll, role tabs switch by click and arrow keys, the
chosen role is remembered, `#role-*` and `#rx-*` links open the right panel, and
the three external pages return 200.
