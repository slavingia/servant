# To-dos as your tracker, with a copy in Jira

Servant's **To-dos** board holds what a team usually opens Jira for, so the work can be planned and tracked in Servant
and copied into Jira in one batch when Jira has to be kept current.

Servant does not sign in to Jira or send it anything. The copy is a file: one command writes it, and you import it
in Jira.

## What a to-do holds

| In Jira | In Servant |
| --- | --- |
| Issue key | Every to-do has a key such as `EA-42`: its project's initials (`TODO` without a project) and a number that never changes. |
| Issue type | **Type** in Details: Task, Bug, Story or Epic. |
| Status | The board's columns: **To do**, **In progress**, **Done**. |
| Priority | **Priority** in Details: High, Medium, Low, or none. |
| Story points | **Estimate (points)** in Details. A column's heading adds up its points. |
| Description | **Description** in Details. |
| Comments | **Comments** in Details. Anyone who can see the to-do can comment. A comment is not edited or deleted afterwards. |
| Epic | A to-do of type Epic. Other to-dos choose it under **Epic** in Details, and the board can show one epic. |
| Sprint or fix version | A project's **release**, which has a date. A to-do without a due date of its own is due with its release. |
| Assignee, due date | **For** and **Due** in Details. |

The board's options (the button at the top right) filter by person, project, release and epic, and sort To do and
In progress by priority or due date. Finished to-dos also appear in each person's **Work log**.

## Copy to Jira in one command

Run this on a computer that can reach both your Servant server and Jira, such as a work laptop. It uses the same
client as [MCP](mcp.md), signed in once as you:

```sh
cd mcp && npm ci
node src/index.ts link "<invite or workspace link>"     # once; approve it on your phone
node src/index.ts jira-export                            # writes servant-jira-YYYY-MM-DD.csv
node src/index.ts jira-export launch.csv example-app     # a file name and one project, if you want
```

The file holds every to-do you can see (up to 500), one row each. Import it in Jira with its CSV importer
(**External System Import**, CSV), and give the date format `yyyy-MM-dd HH:mm`. The columns are named as Jira names
them, so most map on their own:

`Issue Key, Issue Id, Parent Id, Summary, Issue Type, Status, Priority, Description, Assignee, Reporter, Due Date,
Created, Resolved, Story Points, Fix Version, Labels`, then one `Comment` column for each comment.

- **Issue Id** and **Parent Id** are the to-do's number and its epic's number; map them so to-dos land under their epics.
- **Labels** is `servant-<number>`, so the issue a to-do became can be found again.
- **Issue Key** is empty for a to-do that is not in Jira yet, which creates an issue. Once a to-do has a Jira key,
  the row carries it and the import updates that issue instead.
- **Assignee** and **Reporter** are names as Servant knows them. Map them to Jira users in the importer, or leave
  the columns unmapped.
- Times are in UTC.

### Record which issue each to-do became

After the first import, export those issues from Jira as CSV (all fields, so the file has `Issue key` and `Labels`)
and run:

```sh
node src/index.ts jira-keys jira-export.csv
```

It reads the `servant-<number>` labels and saves each issue's key on its to-do (you can also type one into
**Jira issue** in Details). From then on `jira-export` updates those issues rather than creating them again.

## What this does not do

- It does not read changes made in Jira back into Servant, apart from the issue keys. Servant is the place to edit.
- It does not call Jira's API. If your network allows an API token, that could replace the import step later; the
  file format would stay the same.
- It has been tested against the file format, not against a live Jira: the import screen's mapping, your Jira's
  issue types, statuses and required fields may need choices made the first time.
- Attachments, watchers, issue links, custom workflows and time tracking are not in Servant's to-dos.
