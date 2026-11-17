# Projects

A project is a body of work the team shares: a name and a line of description, notes and reference files that every agent chat in it sees, usually a GitHub repo and the path on the owner's Mac where the agent works on it, the rules both people and the agent follow, who can read, write or merge, and its releases: what ships when, and who owns each step of each item.

Projects replaced folders (November 2026). Agent chats belong to a project instead of a folder, and sharing a chat with the project replaces sharing it with a folder. In the app, projects sit in the sidebar above Channels (on phones, a **Projects** section at the top of Home), and the Agent tab's New chat picker offers them. A project's page has three tabs: **Releases** (first, and the default when the project has any), **Chats** (your agent chats in it, teammates' shared ones, New chat) and **About** (the description, a **How we work** block with the workflow, repo, rules and stages, the notes and files, and a **People** list with **Can read** / **Can write** / **Can merge** chips).

## Where projects live

Servant ships no projects. Each server reads them from `projects.json` in its data directory (`server/data/projects.json`), or from the file named by `"projectsFile"` in `config.json` (a relative path is inside the data directory; `~` works). Projects made or edited in the app are saved to the same file, and the server re-reads the file whenever it changes on disk, so you can edit it by hand without a restart. A broken file is logged and the last good copy stays in use.

Reference files added in the app are stored under `project-files/<project id>/` beside the file.

## The file

```json
{
  "people": { "pat-example": "Pat Tester" },
  "projects": [
    {
      "id": "servant",
      "name": "Servant",
      "description": "The team chat app",
      "notes": "",
      "repo": "slavingia/servant",
      "path": "~/servant",
      "pages": "",
      "workflow": "main",
      "rules": ["Iterate on main with small follow-up commits. Never rewrite pushed history."],
      "stages": ["Build", "Design", "QA", "Accessibility", "Content"],
      "releases": [
        { "id": "rel_november-17", "name": "November 17", "date": "2026-11-17", "items": [
          { "id": "itm_guest-mode", "title": "Guest mode", "stages": { "QA": { "status": "blocked", "owner": "usr_abc123", "note": "Waiting on test accounts" } } }
        ] }
      ],
      "owners": ["pat-example"],
      "access": { "merge": ["pat-example"], "write": ["jo-park"], "read": [] }
    }
  ]
}
```

- `people` maps GitHub logins to Servant people, by display name or user id. A login that isn't mapped still counts for the rules and shows in the app as "GitHub: login"; it just isn't anyone's Servant account.
- `id` is a lowercase slug (letters, digits, dashes); the app makes one from the name. It is what chats point at, so don't rename ids casually.
- `repo` is `owner/name` on GitHub. `path` is where the agent works, on the Mac that runs the server. `pages` is an optional published site; prototyping no longer needs it (see below).
- `workflow` is `"main"` (straight to main: commit and push to main, no branches or pull requests) or `"pr"` (pull requests: branch, open a PR, merge after checks and review).
- `rules` are free-text lines everyone in the project sees and the agent follows in every chat in the project.
- `stages` are the steps every release item goes through, in order (up to 10, each up to 30 characters, no duplicates). New projects have none; the example app uses the five above. Owners set them in About.
- `reviewers` (optional) says who signs off each stage on every feature: stage name to a list of GitHub usernames (up to five per stage, an `@` is fine), for example `{ "Copy": ["annie-content"], "Design": ["jo-park"], "Eng": ["slavingia"], "QA": ["sam-qa"], "UT": ["pat-tester", "ana-ruiz"] }`. Stages not in `stages` are dropped. A username is matched to a Servant account through `people` (or the account's own GitHub username); one that matches nobody still shows as `@name` but can't tick anything until it does. Owners set them in About, under **Reviewers**.
- `releases` are the project's dated drops (up to 50). Each has an `id`, a `name`, a `date` (`YYYY-MM-DD`) and `items` (up to 50), and each item has an `id`, a `title`, optional `parts` (up to 30, each `{ "id", "title", "done" }`), an optional `done` (used only when the project has no stages and the item has no parts) and `stages`: one cell per stage name, `{ "status", "owner", "note"? }`. `status` is `todo`, `doing`, `done` or `blocked`; `owner` is a Servant user id or `null`; `note` is up to 200 characters. A stage with no cell reads as to do, nobody yet. A release may carry `shipped`, `{ "at", "by" }`, once its final box is ticked. Ids are any strings; the app makes `rel_…` and `itm_…` ones.
- `owners` can edit everything about the project and can merge. Servant admins (the owner role) can also see and edit every project, listed or not.
- `access` lists who can `read`, `write` or `merge`. Each level includes the ones before it. Entries are GitHub logins, Servant user ids or Servant display names. Nobody else sees the project.

What the levels mean inside Servant: anyone listed sees the project, can start chats in it and can read chats others shared with it; `write` also edits the notes and files; the rest (name, description, repo, path, workflow, rules, people) is for owners. For the repo, the levels tell the agent what it may do on that person's behalf, below.

The full example for our three projects is [projects.example.json](projects.example.json). Copy it to `server/data/projects.json` and fix the `people` names to match the names people use on your server. The `example-app` project in it carries the five stages and the November 17 release (Guest mode, Dark mode, Payments v2, Accessibility pass, every stage to do and unowned). Nothing copies that into a live file on its own: paste the `stages` and `releases` keys into your own project by hand, or add the release in the app.

The file may also carry an optional `legacy` map at the top level, beside `people` and `projects`:

```json
"legacy": { "<oldChatProjectId>": "<projectId>" }
```

It is read once, when old chats that still carry a hard-coded project id are moved into projects (see Moving from folders): a chat whose old id is a key moves into the project named by its value. Leave it out if your server never had such chats.

## Releases

A release is a date and the items shipping in it; an item is a feature ("Guest mode"). Every item moves through the project's stages, and each stage of each item is one cell: a status (**To do**, **Doing**, **Done**, **Blocked**), an owner and an optional note. Those cells are the per-person to-dos.

In the app's **Releases** tab, upcoming releases come first (soonest first, today counts), then past ones. On phones each item is a card with a chip per stage (a short stage name, the status word and the owner's initials); on wide screens each release is a table of items by stages. Tapping a cell opens its editor: status, owner (anyone in the project) and note. A cell with no owner belongs to its stage's reviewers (see `reviewers` above): the chip shows the first reviewer's initials (and `+1` for each other), the editor says "Reviewer: …", and the cell is on each reviewer's **My to-dos**. Setting an owner on one cell overrides the reviewers for that cell only. The **My to-dos** strip at the top lists every cell assigned to you that isn't done, across the project's releases ("Guest mode · QA · Nov 17"). Status colors are done green, doing brand blue, blocked red, to do neutral, always with the word beside the color.

Every release is also a checklist. Each feature has a checkbox, and under it its **parts**, each with its own checkbox ("Copy", "Spanish", "VoiceOver"; up to 30 per feature, added with **Add part**). A feature counts as checked once every stage is done and every part is checked; ticking the feature's own box sets every stage to done and checks every part (unticking puts done stages back to to do and unchecks the parts). A feature with no stages and no parts is just its box. The release head shows how many features are checked ("1 of 3 checked") over a progress bar.

The last row of every release is **Shipped**, the final box. It stays locked, with a lock and how many features are left ("Check the other 2 features first"), until every feature in the release is checked; then anyone who can write ticks it, and it records who and when ("Checked by Jordan Lee"). The server enforces the lock too (`409 not_ready`). Unticking it is always allowed.

Who can do what: anyone who can read sees releases; anyone who can write adds, renames and removes releases and items and changes any cell; the person a cell is assigned to, or one of its stage's reviewers when it has no owner, can change that cell (status, owner, note) even with read access only; stages are the owners' call, like the rules. The page re-reads the project every few seconds while open, so teammates' changes show up without a pull.

## What the agent is told

Every turn of a chat in a project starts with the project's instructions (they are never saved in the transcript). In order:

1. Which project this is, its description, and where to work: `Work in ~/servant (GitHub: slavingia/servant) unless asked otherwise, and follow its AGENTS.md if it has one.`
2. The workflow, in the same words every time:
   - main: `How we work: push to main, no PRs. Commit directly to main and push. Don't create feature branches or open pull requests.`
   - pr: `How we work: open a PR, merge after checks. Work on a branch and open a pull request; merge it only after the checks pass and it has been reviewed.`
3. The rules, as a list: `Rules for this project, for you and for the people in it:` followed by one `- ` line per rule.
4. What the person asking may do, by their access level:
   - merge: `Ana can merge: push and merge for them following the workflow above.`
   - write: `Ana can write but not merge: push following the workflow above, but never merge on their behalf; leave merging to someone who can.`
   - read: `Ana can read only: don't push or merge on their behalf; propose changes or open a PR for someone with write.`
   - not listed (an admin who isn't in the project): `Ana has no access to this project's repository: don't push, merge or change it on their behalf; propose changes instead.`
5. The next releases (up to five whose date is today or later), one line each with every item's unfinished stages and their owners; finished stages are left out, a finished item says `all done`, an empty release says `no items yet`:
   ```
   Upcoming releases (today is 2026-11-04), with what isn't done yet and who owns it:
   - November 17 (2026-11-17): Guest mode: Design doing (Pat Tester), QA blocked (Jo Park: Waiting on test accounts), Accessibility to do (nobody yet), Content to do (nobody yet); Dark mode: all done
   ```
   A stage with no owner names its reviewers instead of `nobody yet` (`Design to do (jo-park)`), and a project with reviewers adds one line listing them (`Reviewers: Copy annie-content; Design jo-park; …`). A project with no upcoming releases gets no such block; prototyping chats never do.
6. The project notes, then the reference files: paths for the full agent; small text files inline, and only the names of the rest, for the restricted member agent (which never gets local paths).

A project without a repo or path (notes and files only) skips the workflow and access lines. If the person who started a chat is no longer in its project, the chat carries no project context.

Prototyping chats (called vibe coding before 11/6) always belong to the prototypes project, and need its `path`. Which project that is comes from `"prototypesProject"` in `config.json` (a project id, default `"prototypes"`): the checkout's `components/` and `assets/` are the design kit. Each chat builds its prototype as plain files in `<data dir>/prototypes/<random folder>/`, and the server itself serves them at `<publicUrl>/p/<folder>/` (so through the same Cloudflare tunnel as everything else: no git, no GitHub, no Pages). The kit is served beside them at `/p/components/` and `/p/assets/`, so the starter page's relative links work. Anyone with a link can view a prototype; folder names are 18 random hex characters and nothing lists them. Pages are served with a `sandbox` Content-Security-Policy, so a prototype can't reach the server's API or storage. Also: search engines are told not to index `/p/` (robots.txt and `X-Robots-Tag`), forms and `<base>` can only point at the page itself, each visitor is limited to 600 requests a minute (far more than a person opening pages uses), files over 25 MB aren't served, and deleting a chat deletes its prototype files. The person who built a prototype can send it to a business owner for comments from the chat's ••• menu ([prototype-reviews.md](prototype-reviews.md)). The agent gets a prototyping brief (build only in the chat's own folder, plain HTML/CSS/JS, end with the `PREVIEW:` link, never use git for it) plus the project's rules, but no access line. Chats made before this keep their old GitHub Pages link (`pages`). The New chat picker hides **Prototyping** when the project isn't set up.

## Moving from folders

The first time a server with folders starts on this version, each folder becomes a project: the person who made it is its owner (and can merge), its members can write, and its notes and files come along. Chats move with them (`folderId` becomes `projectId`, `folderShared` becomes `projectShared`), and older chats that carried one of the hard-coded project ids keep it when the file has a project with that id, or move to the project the file's `legacy` map names for it. Folders are appended to a `projects.json` written by hand beforehand, so set the file up first if you want.

For one release the old `/v1/folders` routes answer as projects under the old names (`folder`, `folders`, `members`, `role`, `owner`), and chats report `folderId` / `folderShared` beside `projectId` / `projectShared`, so phones on the previous build keep working.

## Wiki

**Wiki**, in the sidebar and on **You**, is a tree of pages the team writes together. Pages nest under one another
up to six levels. Pages are added from the tree: **New page** adds one at the top, the **+** beside a page adds one
under it, and the arrow beside a page shows or hides what is under it.

A page is changed by asking Agent. Under the page is one box: say what the page should say, or what should change
("add a section on travel", "make this shorter", "call this page Policies"), and choose **Ask Agent**. Agent's draft
of the whole page appears where the page was, marked as a draft. **Save** keeps it, **Discard** drops it, and asking
again changes the draft further. Nothing is saved until Save. Nobody types Markdown: the page is stored as Markdown
text and shown rendered. Where Agent was not told something it needs, it leaves a placeholder in square brackets
rather than making it up; read a draft before saving it.

The request goes to your own Agent on this server, the same one that answers your agent chats and `@agent`, reached
the same way: the server opens a session on it and runs one turn. So it writes with what your agent knows and can
look up, and it can do no more than your agent already can. Each request gets a session of its own, so one page's
text is not context for the next. Each request counts toward your daily token limit, and someone with no agent
access cannot change a page. With no agent set up on the server, pages can be added and deleted but not written;
the API's `PATCH` still accepts a title and text directly.

Everyone signed in to the server can read and add pages, and anyone with agent access can change them. The person
who made a page, or an owner, can delete it, and only once it has no subpages. If someone else saved the page while
your draft was open, your save is refused, their version is shown under the draft, and nothing of theirs is
overwritten. A page says who last saved it and when. There is no version history in the app; with
[records preservation](records-management.md) on, the previous title and text are archived before every save and
delete, and the change is refused if that copy cannot be saved. A wiki holds up to 1,000 pages of up to 100,000
characters each. Pages cannot be moved in the app yet (the API can: `PATCH` with `parentId`), and the wiki is not
searched by the search bar.

The tree's first page, **Abbreviations**, is built in. It is the list this section used to call Text shortcuts, and
the old `/lexicon` address opens it.

A workspace can also turn on everyday shorthand as one group with a single setting in `config.json`:
`"expandColloquialisms": true`. The list is in `server/colloquialisms.mjs` (tmmrw and tmrw for tomorrow, lmk, imo, btw,
nvm, wdyt, thru, tho, convo, pls, ppl, PR, QA and others). `{ "enabled": true, "extra": { "ACME": "Acme Corporation" } }`
adds the workspace's own pairs to the same group. The pairs appear in the list marked `builtIn: true` and are underlined
in messages like any abbreviation; nobody can edit or delete them, a shared shortcut with the same abbreviation wins, and turning
the setting off removes them all. It is off unless set, and read on each request.

### Abbreviations

**Abbreviations** is a searchable list of abbreviations and what they stand
for, such as `API` for `Application Programming Interface`.

Messages always go exactly as typed; nothing is expanded or replaced. In a
message, a known abbreviation is shown with a dotted underline. Hovering over
it in a browser or the Mac app shows what it stands for, like an abbreviation on
Wikipedia; on a phone, tapping it does. One with several meanings shows all of
them. Code, URLs, email addresses and mentions are never marked.

Abbreviations are shared within the current server. Every signed-in person can
add one; its author or a server owner can edit or delete it. A project's
**About** tab also holds **Project shortcuts**, readable by project members and
editable by project writers; they stay private to the project.

When a message has an unfamiliar uppercase abbreviation of three or more letters, nobody is asked what
it means and sending does not wait: the message goes as written. Afterwards the
server asks Agent for its most likely meaning in that message and adds it to
**Abbreviations** marked **Agent's guess**, and the sender gets a to-do:
*Check what AAA stands for. Agent guessed "…". Keep it or fix it in Wiki,
Abbreviations.* When Agent has no guess, or no agent is set up, nothing is
added and the to-do asks the sender to add it. Each abbreviation is raised
once.

A guess is in the list so the same abbreviation is not raised again, but it
is not underlined in anyone's message until a person has looked at it. Anyone can
**Keep** it as it is, **Edit** it or **Delete** it; keeping or editing makes it
theirs, and any of the three finishes their to-do. A person adding the same
abbreviation themselves takes the place of the guess. A guess never replaces
what a person wrote. At most eight abbreviations are taken from one message.
Shared shortcuts persist in `text_shortcuts` in `messages.db`. Project
shortcuts persist in `project_glossary`, scoped to the project and its creation
time. Removing a project makes its shortcuts inaccessible; reusing a project
id does not inherit them. With records preservation enabled, edits and deletes
archive the previous entry in the same transaction and refuse the change if
archiving fails.

A server can hold 2,000 shared shortcuts and each project can hold 500 project
shortcuts. Abbreviations are limited to 32 characters and replacements to 200.
Shared abbreviations are unique without regard to letter case.

## API

- Agent tiers: 0 no agent (where new people start; `defaultAgentTier` in config.json), 1 tester (files GitHub issues only), 2 business owner (prototypes only), 3 software engineer (everything; owners), 4 researcher (web and skills, no GitHub), 5 product manager (GitHub issues, specs and research; never changes code). Owners set one with `PATCH /v1/people/<id>` `{ agentTier }`. Daily token limits scale with the tier (`TIER_TOKEN_LIMITS` in usage.mjs). An owner's `GET /v1/people` also carries `tierTokenLimits` and `tierCosts`: for each tier, the model its agent runs when `upstreams.<agent>.model` names it, that agent's prices (`usdPerMillion`, a built-in list price for a model usage-cost.mjs knows, or Claude Sonnet 5.5's when nothing is set) and a blended dollars per million tokens, which the person sheet turns into "about $… a day" (usage-cost.mjs). People who joined before tiers keep what they had: vibe coders are tier 2, everyone else tier 1.
- `GET /v1/projects` lists the projects you can see, plus `vibeCoder` and `vibe` (whether prototyping is set up).
- `POST /v1/projects` `{ name, description?, notes?, repo?, path?, workflow?, rules?, stages? }` makes one you own.
- `GET /v1/projects/<id>` returns the project (with `stages` and `releases`, soonest first; every item carries a cell for every stage, `{ status, owner, ownerName, note? }`) and `sharedChats` (teammates' chats shared with it).
- `GET /v1/wiki` returns `{ pages, limits }` for signed-in users: every page without its text (`id`, `parentId`, `title`, `position`, `updatedAt`, `updatedByName`, `version`, `canDelete`). `GET /v1/wiki/<pageId>` returns `{ page }` with its `body`. `POST /v1/wiki` accepts `{ title, body?, parentId? }`; `PATCH /v1/wiki/<pageId>` accepts any of `{ title, body, parentId }` plus the `version` the editor was looking at, and answers 409 `stale` with the newer `page` when it has changed; `DELETE` is for the page's maker or an owner and answers 409 `has_subpages` while it has any (wiki.mjs). `POST /v1/wiki/<pageId>/draft` accepts `{ instruction, draft? }` and returns `{ draft: { title, body }, version }`: the agent's version of the page with the change made, saved nowhere (wiki-draft.mjs); it answers 429 `usage_limit` for someone over their limit or with no agent, and 503 `agent_unavailable` when no agent is set up.
- `GET /v1/lexicon` returns `{ entries, canWrite: true }` for signed-in users. An entry Agent guessed carries `guessed: true` and is editable by anyone. `POST /v1/lexicon/learn` accepts `{ terms, text }` (one to eight abbreviations and the message they came from) and returns `{ entries, todos }`: the guesses it added and how many to-dos it made for the sender (lexicon-guess.mjs). `POST` accepts `{ abbreviation, fullName }`, where `fullName` is the replacement text, and returns `{ entry }`. `PATCH /v1/lexicon/<entryId>` updates those fields; `DELETE` returns `{ ok: true }`. Changes need authorship or a server owner role. Entries include `id`, `abbreviation`, `fullName`, `createdAt`, `updatedAt`, and `canEdit`. An identical existing pair is reused; a different replacement for an existing shared abbreviation is rejected.
- `GET /v1/projects/<id>/glossary` returns `{ entries, canWrite, projectRepo }`. `POST` on the same path adds `{ abbreviation, fullName }`, returning `{ entry }`. `PATCH /v1/projects/<id>/glossary/<entryId>` updates the pair and returns `{ entry }`; `DELETE` returns `{ ok: true }`. Reads need project visibility; changes need write access. Legacy metadata fields remain stored for compatibility but are not shown in the shortcut UI.
- `PATCH /v1/projects/<id>`: `notes` with write access; the rest (including `stages` and `reviewers`) as an owner. `reviewers` must be an object of stage name to GitHub usernames (up to five each); anything else is a 400.
- `DELETE /v1/projects/<id>` (owner): chats stay, they just leave the project.
- `POST /v1/projects/<id>/people` `{ userId | github | key, level, owner? }` (owner) sets one person's level; `DELETE /v1/projects/<id>/people/<key or me>` removes them, or you leave (the only owner can't).
- `POST /v1/projects/<id>/files` `{ name, data }` and `DELETE /v1/projects/<id>/files/<fileId>` with write access.
- Releases, all with write access and all answering with the whole project again: `POST /v1/projects/<id>/releases` `{ name, date }`, `PATCH /v1/projects/<id>/releases/<rid>` `{ name?, date? }`, `DELETE /v1/projects/<id>/releases/<rid>`; items: `POST …/releases/<rid>/items` `{ title }`, `PATCH …/items/<iid>` `{ title?, done? }` (`done` ticks or unticks the whole feature), `DELETE …/items/<iid>`; parts: `POST …/items/<iid>/parts` `{ title }`, `PATCH …/parts/<pid>` `{ title?, done? }`, `DELETE …/parts/<pid>`. The final box is `PATCH …/releases/<rid>` `{ shipped: true | false }`; `true` answers `409 not_ready` until every feature is checked.
- `PATCH /v1/projects/<id>/releases/<rid>/items/<iid>/stages` `{ stage, status?, owner?, note? }` sets one cell (the stage goes in the body because stage names can contain slashes, like `QA/508`). Allowed for the cell's current owner or anyone with write access; `owner` must be someone in the project (or `null`), `status` one of the four words, unknown stages are rejected.
- `POST /v1/chats` `{ projectId }` starts a chat in a project; `PATCH /v1/chats/<id>` `{ projectId }` moves one (null takes it out), `{ projectShared: true }` opens it, read only, to everyone in the project.
