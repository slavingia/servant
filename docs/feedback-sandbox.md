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

## Every feature, shared with other people

```sh
cd app
npm run sandbox:share
```

This is the sandbox with two more options, which also work on their own:

- `--full` turns the research pilot hold off, so people can try everything you
  added: Researcher Agent chats (Synthesize existing evidence and Run a
  research-informed design review), Research Hub evidence in study plans, and
  the Researcher Agent's design guidance that the researcher reviews before it
  goes to the prototype agent. The Research Hub has five made-up records, and
  the Researcher Agent's replies and guidance are scripted samples.
- `--share` opens two temporary Cloudflare quick tunnels with `cloudflared`
  (`brew install cloudflared`; set `CF` to use another copy). One serves the
  start page and the app, exported for the web once at start (a few minutes);
  the other is the sandbox server. The terminal prints the start page's
  `https://….trycloudflare.com` link to send to testers.

Things to know before sharing the link:

- Anyone who has it can sign in as a new Preview Researcher, so send it only
  to the people testing. Quick tunnel links are hard to guess, but they aren't
  private.
- It works only while the sandbox runs and the Mac stays awake and online.
  The link changes every time the sandbox starts, and Ctrl+C deletes
  everything in it.
- Quick tunnels are Cloudflare's free test tunnels, with no uptime guarantee.
  For a permanent address, use a named tunnel (see
  [deployment.md](deployment.md)).
- Everything in it is made up. Don't add real data, even though other people
  can reach it.

## Your own agents

`--agents <file>` swaps the stand-ins for your own Hermes agents. The file is
private JSON with the URL and `API_SERVER_KEY` of each bridge you run; leave a
lane out to keep its stand-in. Keep it out of the repository and `chmod 600` it.

```json
{
  "researcher": { "url": "http://127.0.0.1:8646", "key": "<the researcher bridge's API_SERVER_KEY>" },
  "prototype": { "url": "http://127.0.0.1:8642", "key": "<that bridge's API_SERVER_KEY>" }
}
```

```sh
npm run sandbox -- --full --agents ~/servant-sandbox-agents.json
```

- **researcher** is the restricted Researcher Agent (web, search and vision;
  no shell, files or GitHub). It answers Researcher chats and writes the
  design guidance. Make its profile with
  `node scripts/member-profile.mjs <new-directory> <model> researcher` and run
  it with `scripts/run-hermes-servant.py --researcher` (port 8646). Use a
  distinct key, not your main agent's. The profile comes with the Civic
  Research Studio skill (see [research-hub.md](research-hub.md#researcher-skills)).
  Run the bridge with the Python of your Hermes installation: older installs
  have it at `~/.hermes/hermes-agent/venv/bin/python`, newer ones under
  `~/.hermes/installs/*/environments/*/venv/bin/python`. The launcher sets
  `HERMES_DISABLE_LAZY_INSTALLS=1` for `--researcher` and `--member`: a
  restricted bridge never installs packages while it runs, and newer Hermes
  installs would otherwise restart it under a Python without its libraries.
  Anything the model provider needs (for Vertex, `google-auth`) must already
  be in that environment.
- **prototype** builds and changes the designs. It is a full-access agent: it
  writes the page files and can run commands on this Mac. Use it only when you
  are the one testing.
- `--share` accepts only `researcher`. A shared link can't reach your
  prototype agent, because anyone with the link could use it.
- The sandbox won't start until each of your agents answers with its key. The
  start page's **Agents in this sandbox** shows, each time it loads, which agent
  answers each kind of chat and whether yours is answering. The terminal says so
  when one stops or starts answering. Stand-in replies end with "(This is the
  feedback sandbox's stand-in agent…)"; your agent's replies don't.
- A real agent calls its model, so anything typed to it goes to that model's
  provider and uses your account. Its replies are its own, not the scripted
  samples.

## The preview persona

Testers sign in on the start page with their own name. The same name signs in
to the same account again, with its work and its daily token allowance, so the
allowance follows the person; a new name is a new account. The made-up
teammates' names can't be used. The terminal's sign-in link (and a sign-in
without a name) is a fresh **Preview Researcher**. Everyone is a workspace
member with the Researcher agent tier. The sandbox's server grants that tier to new people (its
`defaultAgentTier`), the way an owner grants it on a real server. Nothing in the
app or onboarding grants it. The research pilot hold is on, as in the pilot
build, unless the sandbox runs with `--full`.

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
- Researcher Agent chats get a short sample answer: a synthesis plan or a
  design review plan with `--full`, and otherwise a sentence or two.
- With `--full`, the Researcher Agent's design guidance is a fixed sample of
  needs, pain points, opportunities and unknowns.

Every reply says it's from the stand-in agent, so nobody mistakes it for real
output.

## Running sessions

- Sign in from the start page as often as you like, with the same name each
  time. The link in the terminal works once; press Enter there for a new one.
- **Daily tokens:** each person can use up to 2,000,000 tokens a day
  (`--daily-tokens <n>` to change it). Only real agents use tokens, so with
  `--agents` it's your own agent's usage; the stand-ins count almost nothing.
  The day resets at midnight on the Mac running the sandbox. A person over the
  limit sees "You've reached today's limit of 2,000,000 tokens. It resets at
  midnight". The sandbox sets it with the server's `dailyTokenLimit` setting.
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
7. Back in the study plan, choose a few methods under Choose your methods, replace the [bracketed] starting text, and save the working draft.
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
