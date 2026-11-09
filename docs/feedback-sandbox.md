# Feedback sandbox

A private copy of Servant on your Mac for feedback sessions on the Servant
Studio features. It has made-up people, a made-up design and stand-in agents that
never call a model. It runs only on this Mac (127.0.0.1), and everything in it
is deleted when it stops.

```sh
cd app
npm run sandbox
```

It starts the sandbox server (port 8790), the app (http://localhost:8099) and a
start page (http://localhost:8098), which it opens in your browser. The start
page has a **Sign in as Preview Researcher** button that works every time, a
link to every feature, the made-up files for study readouts, and the tasks to
try. Options: `--port`, `--app-port`, `--start-port`, `--no-open` (don't open
the browser), and `--no-app` if the app is already running on the app port.

## The preview persona

The start page (or the link in the terminal) signs in as **Preview Researcher**: a workspace member with the
Researcher agent tier. The sandbox's server grants that tier to new people (its
`defaultAgentTier`), the way an owner grants it on a real server. Nothing in the
app or onboarding grants it. The research pilot hold is on, as in the pilot
build.

That one persona can reach every Servant Studio feature (grouped under that
heading in the sidebar and the Agent tab) and the rest of the app:

- Sign-in, the terms, onboarding and the start page.
- Research Studio: build a study plan, create a prototype from what the
  research found, saved forms ("Continue where you left off"), study activities
  and the working draft for Civic Research Studio.
- Study readouts: a study's Qualtrics results as charts and a checked readout,
  saved as a Word document or a PDF, with ratings and the comments coded into
  themes and reviewed quotes. The sandbox prints where its made-up files are (a study and its two
  exports, `app/src/lib/fixtures/`).
- Design Studio: new designs, the preview, Adjust design, versions, rename,
  duplicate, archive and share for review.
- Reviewing a teammate's design: the "Balance due page" review in #general,
  with Open preview and Suggest adjustments.

The workspace also has three made-up teammates: Olive Owner (owner), Dev
Designer and Rhea Researcher. Dev's "Balance due page" design is published, has
two versions and is shared for review in #general.

## The stand-in agents

They show how each conversation works, with sample content:

- A study prototype prompt gets three directions to compare (A balance first,
  B due date first, C options first), each tied to the numbered findings.
- Naming directions ("Build direction A", "Build A and B to compare") publishes
  the sample balance page in that layout, or one page per layout.
- An Adjust design request or a suggestion republishes the page with the
  requested change noted at the bottom. The stand-in can't make the exact
  change.
- Researcher Agent chats get a short sample answer.

Every reply says it's from the stand-in agent, so nobody mistakes it for real
output.

## Running sessions

- Sign in from the start page as often as you like; each time is a new
  Preview Researcher. The link in the terminal works once; press Enter there
  for a new one.
- For the next participant, sign out first (You tab), or use a private window.
  Signing out also clears that person's saved research forms.
- To give the next participant a fresh workspace, stop the sandbox (Ctrl+C) and
  start it again.
- Adjust design works in the browser and the Mac app. It isn't available on
  phones yet.

### Tasks to try

1. Sign in, then choose a role and goals during onboarding.
2. In Research Studio, start a study plan. Add what the research found (try a
   number, a quote or "Form 1040"), then create a prototype workspace and send
   the prompt.
3. Pick one or two directions for the agent to build, and open the preview.
4. Leave the study plan part-way, then find your way back to it.
5. Adjust the design (change the heading's text), add the request to the design
   chat and send it. Then look at the design's versions.
6. In #general, open the "Balance due page" review and suggest an adjustment.
7. Back in the study plan, add a study activity and save the working draft.
8. In Research Studio, write a study readout from the made-up study and its two
   exports. Write the summary, then save it as a Word document and as a PDF.
9. Write another readout from the made-up study and its survey export with
   Research Studio inside (`qualtrics-embedded-SYNTHETIC.csv`): look at the
   ratings, give a few comments themes, and quote one.

## What isn't in the sandbox

- Real agents, real Research Hub evidence or any real data.
- Research Hub, Researcher Agent design guidance and Hub-to-prototype handoffs:
  they're on hold in the pilot build.
- Anything another computer or phone can reach.
