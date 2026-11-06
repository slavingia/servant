# Projects

A project is a body of work the team shares: a name and a line of description, notes and reference files that every agent chat in it sees, usually a GitHub repo and the path on the owner's Mac where the agent works on it, the rules both people and the agent follow, who can read, write or merge, and its releases: what ships when, and who owns each step of each item.

Projects replaced folders (November 2026). Agent chats belong to a project instead of a folder, and sharing a chat with the project replaces sharing it with a folder. In the app, projects sit in the sidebar above Channels (on phones, a **Projects** section at the top of Home), and the Agent tab's New chat picker offers them. A project's page has three tabs: **Releases** (first, and the default when the project has any), **Chats** (your agent chats in it, teammates' shared ones, New chat) and **About** (the description, a **How we work** block with the workflow, repo, rules and stages, the notes and files, and a **People** list with **Can read** / **Can write** / **Can merge** chips).

## Where projects live

Servant ships no projects. Each server reads them from `projects.json` in its data directory (`server/data/projects.json`), or from the file named by `"projectsFile"` in `config.json` (a relative path is inside the data directory; `~` works). Projects made or edited in the app are saved to the same file, and the server re-reads the file whenever it changes on disk, so you can edit it by hand without a restart. A broken file is logged and the last good copy stays in use.

Reference files added in the app are stored under `project-files/<project id>/` beside the file.

## The file

```json
{
  "people": { "slavingia": "Sahil Lavingia" },
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
      "stages": ["Build", "Design", "Functional/508 QA", "SAT", "Content"],
      "releases": [
        { "id": "rel_november-17", "name": "November 17", "date": "2026-11-17", "items": [
          { "id": "itm_trump-accounts", "title": "Trump accounts", "stages": { "SAT": { "status": "blocked", "owner": "usr_abc123", "note": "Waiting on test accounts" } } }
        ] }
      ],
      "owners": ["slavingia"],
      "access": { "merge": ["slavingia"], "write": ["gianfrancopiana"], "read": [] }
    }
  ]
}
```

- `people` maps GitHub logins to Servant people, by display name or user id. A login that isn't mapped still counts for the rules and shows in the app as "GitHub: login"; it just isn't anyone's Servant account.
- `id` is a lowercase slug (letters, digits, dashes); the app makes one from the name. It is what chats point at, so don't rename ids casually.
- `repo` is `owner/name` on GitHub. `path` is where the agent works, on the Mac that runs the server. `pages` is an optional published site; prototyping no longer needs it (see below).
- `workflow` is `"main"` (straight to main: commit and push to main, no branches or pull requests) or `"pr"` (pull requests: branch, open a PR, merge after checks and review).
- `rules` are free-text lines everyone in the project sees and the agent follows in every chat in the project.
- `stages` are the steps every release item goes through, in order (up to 10, each up to 30 characters, no duplicates). New projects have none; the IRS app uses the five above. Owners set them in About.
- `releases` are the project's dated drops (up to 50). Each has an `id`, a `name`, a `date` (`YYYY-MM-DD`) and `items` (up to 50), and each item has an `id`, a `title` and `stages`: one cell per stage name, `{ "status", "owner", "note"? }`. `status` is `todo`, `doing`, `done` or `blocked`; `owner` is a Servant user id or `null`; `note` is up to 200 characters. A stage with no cell reads as to do, nobody yet. Ids are any strings; the app makes `rel_…` and `itm_…` ones.
- `owners` can edit everything about the project and can merge. Servant admins (the owner role) can also see and edit every project, listed or not.
- `access` lists who can `read`, `write` or `merge`. Each level includes the ones before it. Entries are GitHub logins, Servant user ids or Servant display names. Nobody else sees the project.

What the levels mean inside Servant: anyone listed sees the project, can start chats in it and can read chats others shared with it; `write` also edits the notes and files; the rest (name, description, repo, path, workflow, rules, people) is for owners. For the repo, the levels tell the agent what it may do on that person's behalf, below.

The full example for our three projects is [projects.example.json](projects.example.json). Copy it to `server/data/projects.json` and fix the `people` names to match the names people use on your server. The IRS app project in it carries the five stages and the November 17 release (Trump accounts, DMAF, DUT, Guest mode, every stage to do and unowned). Nothing copies that into a live file on its own: paste the `stages` and `releases` keys into your `expo-irs` project by hand, or add the release in the app.

## Releases

A release is a date and the items shipping in it; an item is a feature ("Trump accounts"). Every item moves through the project's stages, and each stage of each item is one cell: a status (**To do**, **Doing**, **Done**, **Blocked**), an owner and an optional note. Those cells are the per-person to-dos.

In the app's **Releases** tab, upcoming releases come first (soonest first, today counts), then past ones. On phones each item is a card with a chip per stage (a short stage name, the status word and the owner's initials); on wide screens each release is a table of items by stages. Tapping a cell opens its editor: status, owner (anyone in the project) and note. The **My to-dos** strip at the top lists every cell assigned to you that isn't done, across the project's releases ("Trump accounts · SAT · Nov 17"). Status colors are done green, doing IRS blue, blocked red, to do neutral, always with the word beside the color.

Who can do what: anyone who can read sees releases; anyone who can write adds, renames and removes releases and items and changes any cell; the person a cell is assigned to can change that cell (status, owner, note) even with read access only; stages are the owners' call, like the rules. The page re-reads the project every few seconds while open, so teammates' changes show up without a pull.

## What the agent is told

Every turn of a chat in a project starts with the project's instructions (they are never saved in the transcript). In order:

1. Which project this is, its description, and where to work: `Work in /Users/you/servant (GitHub: slavingia/servant) unless asked otherwise, and follow its AGENTS.md if it has one.`
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
   - November 17 (2026-11-17): Trump accounts: Design doing (Sahil Lavingia), Functional/508 QA to do (nobody yet), SAT blocked (Josh Struble: Waiting on test accounts), Content to do (nobody yet); DMAF: all done
   ```
   A project with no upcoming releases gets no such block; prototyping chats never do.
6. The project notes, then the reference files: paths for the full agent; small text files inline, and only the names of the rest, for the restricted member agent (which never gets local paths).

A project without a repo or path (notes and files only) skips the workflow and access lines. If the person who started a chat is no longer in its project, the chat carries no project context.

Prototyping chats (called vibe coding before 11/6) always belong to the `design-prototypes` project, and need its `path`: the checkout's `components/` and `assets/` are the design kit. Each chat builds its prototype as plain files in `<data dir>/prototypes/<random folder>/`, and the server itself serves them at `<publicUrl>/p/<folder>/` (so through the same Cloudflare tunnel as everything else: no git, no GitHub, no Pages). The kit is served beside them at `/p/components/` and `/p/assets/`, so the starter page's relative links work. Anyone with a link can view a prototype; folder names are 18 random hex characters and nothing lists them. Pages are served with a `sandbox` Content-Security-Policy, so a prototype can't reach the server's API or storage. Also: search engines are told not to index `/p/` (robots.txt and `X-Robots-Tag`), forms and `<base>` can only point at the page itself, each visitor is limited to 600 requests a minute (far more than a person opening pages uses), files over 25 MB aren't served, and deleting a chat deletes its prototype files. The agent gets a prototyping brief (build only in the chat's own folder, plain HTML/CSS/JS, end with the `PREVIEW:` link, never use git for it) plus the project's rules, but no access line. Chats made before this keep their old GitHub Pages link (`pages`). The New chat picker hides **Prototyping** when the project isn't set up.

## Moving from folders

The first time a server with folders starts on this version, each folder becomes a project: the person who made it is its owner (and can merge), its members can write, and its notes and files come along. Chats move with them (`folderId` becomes `projectId`, `folderShared` becomes `projectShared`), and older chats that carried one of the hard-coded project ids keep it when the file has a project with that id. Folders are appended to a `projects.json` written by hand beforehand, so set the file up first if you want.

For one release the old `/v1/folders` routes answer as projects under the old names (`folder`, `folders`, `members`, `role`, `owner`), and chats report `folderId` / `folderShared` beside `projectId` / `projectShared`, so phones on the previous build keep working.

## API

- Agent tiers: 0 no agent (where new people start; `defaultAgentTier` in config.json), 1 tester (files GitHub issues only), 2 prototyper (design prototypes only), 3 design engineer (everything; owners). Owners set one with `PATCH /v1/people/<id>` `{ agentTier }`. Daily token limits scale with the tier (`TIER_TOKEN_LIMITS` in usage.mjs). People who joined before tiers keep what they had: vibe coders are tier 2, everyone else tier 1.
- `GET /v1/projects` lists the projects you can see, plus `vibeCoder` and `vibe` (whether prototyping is set up).
- `POST /v1/projects` `{ name, description?, notes?, repo?, path?, workflow?, rules?, stages? }` makes one you own.
- `GET /v1/projects/<id>` returns the project (with `stages` and `releases`, soonest first; every item carries a cell for every stage, `{ status, owner, ownerName, note? }`) and `sharedChats` (teammates' chats shared with it).
- `PATCH /v1/projects/<id>`: `notes` with write access; the rest (including `stages`) as an owner.
- `DELETE /v1/projects/<id>` (owner): chats stay, they just leave the project.
- `POST /v1/projects/<id>/people` `{ userId | github | key, level, owner? }` (owner) sets one person's level; `DELETE /v1/projects/<id>/people/<key or me>` removes them, or you leave (the only owner can't).
- `POST /v1/projects/<id>/files` `{ name, data }` and `DELETE /v1/projects/<id>/files/<fileId>` with write access.
- Releases, all with write access and all answering with the whole project again: `POST /v1/projects/<id>/releases` `{ name, date }`, `PATCH /v1/projects/<id>/releases/<rid>` `{ name?, date? }`, `DELETE /v1/projects/<id>/releases/<rid>`; items: `POST …/releases/<rid>/items` `{ title }`, `PATCH …/items/<iid>` `{ title }`, `DELETE …/items/<iid>`.
- `PATCH /v1/projects/<id>/releases/<rid>/items/<iid>/stages` `{ stage, status?, owner?, note? }` sets one cell (the stage goes in the body because names like `Functional/508 QA` have slashes). Allowed for the cell's current owner or anyone with write access; `owner` must be someone in the project (or `null`), `status` one of the four words, unknown stages are rejected.
- `POST /v1/chats` `{ projectId }` starts a chat in a project; `PATCH /v1/chats/<id>` `{ projectId }` moves one (null takes it out), `{ projectShared: true }` opens it, read only, to everyone in the project.
