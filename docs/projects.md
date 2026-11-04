# Projects

A project is a body of work the team shares: a name and a line of description, notes and reference files that every agent chat in it sees, usually a GitHub repo and the path on the owner's Mac where the agent works on it, the rules both people and the agent follow, and who can read, write or merge.

Projects replaced folders (November 2026). Agent chats belong to a project instead of a folder, and sharing a chat with the project replaces sharing it with a folder. In the app, the Agent tab lists your projects, the New chat picker offers them, and each project has its own screen with a **How we work** block and a **People** list with **Can read** / **Can write** / **Can merge** chips.

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
      "owners": ["slavingia"],
      "access": { "merge": ["slavingia"], "write": ["gianfrancopiana"], "read": [] }
    }
  ]
}
```

- `people` maps GitHub logins to Servant people, by display name or user id. A login that isn't mapped still counts for the rules and shows in the app as "GitHub: login"; it just isn't anyone's Servant account.
- `id` is a lowercase slug (letters, digits, dashes); the app makes one from the name. It is what chats point at, so don't rename ids casually.
- `repo` is `owner/name` on GitHub. `path` is where the agent works, on the Mac that runs the server. `pages` is an optional published site (GitHub Pages); vibe coding needs it.
- `workflow` is `"main"` (straight to main: commit and push to main, no branches or pull requests) or `"pr"` (pull requests: branch, open a PR, merge after checks and review).
- `rules` are free-text lines everyone in the project sees and the agent follows in every chat in the project.
- `owners` can edit everything about the project and can merge. Servant admins (the owner role) can also see and edit every project, listed or not.
- `access` lists who can `read`, `write` or `merge`. Each level includes the ones before it. Entries are GitHub logins, Servant user ids or Servant display names. Nobody else sees the project.

What the levels mean inside Servant: anyone listed sees the project, can start chats in it and can read chats others shared with it; `write` also edits the notes and files; the rest (name, description, repo, path, workflow, rules, people) is for owners. For the repo, the levels tell the agent what it may do on that person's behalf, below.

The full example for our three projects is [projects.example.json](projects.example.json). Copy it to `server/data/projects.json` and fix the `people` names to match the names people use on your server.

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
5. The project notes, then the reference files: paths for the full agent; small text files inline, and only the names of the rest, for the restricted member agent (which never gets local paths).

A project without a repo or path (notes and files only) skips the workflow and access lines. If the person who started a chat is no longer in its project, the chat carries no project context.

Vibe-coding chats always belong to the `design-prototypes` project and need its `path` and `pages`. They get the vibe-coding instructions (build inside the chat's own folder, push to main, end with the `PREVIEW:` link) plus the project's rules, but no access line: vibe coders build in their own folder whatever their repo access is. The New chat picker hides **Vibe coding** when that project isn't set up.

## Moving from folders

The first time a server with folders starts on this version, each folder becomes a project: the person who made it is its owner (and can merge), its members can write, and its notes and files come along. Chats move with them (`folderId` becomes `projectId`, `folderShared` becomes `projectShared`), and older chats that carried one of the hard-coded project ids keep it when the file has a project with that id. Folders are appended to a `projects.json` written by hand beforehand, so set the file up first if you want.

For one release the old `/v1/folders` routes answer as projects under the old names (`folder`, `folders`, `members`, `role`, `owner`), and chats report `folderId` / `folderShared` beside `projectId` / `projectShared`, so phones on the previous build keep working.

## API

- `GET /v1/projects` lists the projects you can see, plus `vibeCoder` and `vibe` (whether vibe coding is set up).
- `POST /v1/projects` `{ name, description?, notes?, repo?, path?, workflow?, rules? }` makes one you own.
- `GET /v1/projects/<id>` returns the project and `sharedChats` (teammates' chats shared with it).
- `PATCH /v1/projects/<id>`: `notes` with write access; the rest as an owner.
- `DELETE /v1/projects/<id>` (owner): chats stay, they just leave the project.
- `POST /v1/projects/<id>/people` `{ userId | github | key, level, owner? }` (owner) sets one person's level; `DELETE /v1/projects/<id>/people/<key or me>` removes them, or you leave (the only owner can't).
- `POST /v1/projects/<id>/files` `{ name, data }` and `DELETE /v1/projects/<id>/files/<fileId>` with write access.
- `POST /v1/chats` `{ projectId }` starts a chat in a project; `PATCH /v1/chats/<id>` `{ projectId }` moves one (null takes it out), `{ projectShared: true }` opens it, read only, to everyone in the project.
