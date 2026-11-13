# Onboarding guide

Open `index.html` in a browser. It covers what Servant does, the first ten
minutes for everyone, filing issues through the agent, and deep dives for
developers, functional testers, UX designers, UX content strategists and UX
researchers.

The guide is written for a team at a made-up organization, `example-org`.
Swap in your own channel names, repositories (`example-org/research`,
`example-org/prototypes`) and house rules before sharing it.

The researcher deep dive covers querying a research repository with the GitHub
CLI or the agent, asking the agent for a study draft, building a dashboard from
published aggregates, and publishing automated research reviews that tag
people for feedback.

## Captures

The Servant screens are from the web build at 393 by 852, signed in to an
isolated test server (`scripts/test-instance.mjs`) with made-up people and
messages. The test invite QR code is covered. The dev-only error toast was
hidden before capture.

The shots in `shots/` are `home.jpg`, `home-dark.jpg`, `agent.jpg`,
`feedback.jpg`, `invite.jpg` and `new-channel.jpg`. Screens that showed a real
server name or colleagues were removed before publication; re-capture them
against a test server with made-up people before adding new ones.

## Checks

Playwright at 1440, 390 and 320 wide: no console errors or failed requests, every
image loads, no horizontal scroll, role tabs switch by click and arrow keys, the
chosen role is remembered, and `#role-*` and `#rx-*` links open the right panel.
