# Methods: authoring and outputs (Civic Research Studio 0.3.24)

Every activity has an ID, a title, participant instructions and optional
follow-up questions. Each one ends with a `task_ended` record holding its
outcome.

## Prototype usability (`prototype`)

- One prototype URL for the study or the activity: a page the team hosts (for
  example GitHub Pages) with the tracker script, using the exact hosting origin
  as `data-parent-origin`.
- Add `data-ut-id` to important controls for stable click IDs (never personal
  data). Call `window.UTP?.markSuccess('<signal>')` when the task's end state is
  reached.
- Outputs: success signal status (`received`, `not_observed`, `unavailable`),
  self-report (`completed` or `unable`), time, time to first success
  (`success_at_seconds`), clicks. Keystrokes, input values, page text and query
  strings aren't recorded.
- Goals in the plan: *measure* task success (benchmark and precision) or
  *discover* problems (people per round × rounds).
- A reload restarts the prototype at its first screen; time and clicks so far
  are kept.

## A/B/n implementation test (`ab_test`)

See `ab-testing.md`. Each design is `id | label | URL | revision`; labels are
researcher-only. Related activities share an `experimentId` and the same design
IDs, so a person stays on one design across them.

## Card sort (`card_sort`)

- `sortMode`: `open` (participants make and name all groups), `closed` (fixed
  groups, at least two) or `hybrid` (fixed groups plus their own).
- Cards: `card-id | label`. Categories: `category-id | label`.
- Drag and drop with mouse, pen or touch, or a "Move to" list for keyboard and
  screen reader users.
- Outputs: card-to-group assignments, group names, moves, and co-placement (the
  share of completed sorts that put two cards together). It doesn't merge
  differently named groups or infer meaning.
- Planning: explore (15–30 people is common for open sorts) or check agreement
  with your categories (agreement threshold and precision).

## Tree test (`tree_test`)

- Tree: one item per line, two spaces of indentation per level,
  `node-id | label`. Correct destination IDs are hidden from participants.
- Outputs: success (final choice is a correct destination), direct success (no
  backtracking or detours), correct first branch (independent of final success),
  path and backtracks.
- Planning: optional benchmark success and directness rates.

## First click (`first_click`)

- A public HTTPS image (or local demo asset) with alt text. Optional target
  areas as `x, y, width, height | label` in percentages.
- Participants can zoom (fit to 300%); the zoom at the click is recorded.
- Outputs: first click position in percent of the image, hit or miss when
  target areas are set; otherwise *unscored*. "I'm not sure" counts as an
  attempt without a hit.
- Needs a pointer: plan an accessible alternative.

## Preference (`preference`)

- Two or more images: `id | label | image`. Order is randomized per session
  (not balanced). Participants can choose "I do not have a preference".
- Outputs: choice, no-preference, display order. Descriptive shares, not
  significance tests.
- Planning: the smallest split worth detecting (for example 60/40) and power.

## Survey (`survey`)

- Questions only. Answer types: short text, long text, single choice, multiple
  choice, five-point and seven-point scales; any can be required.

## Across methods

- Reloading continues the same session in the same tab (within 24 hours). A new
  tab, browser or device is a new session.
- "Preview locally" runs are labeled and left out of results unless included on
  purpose.
- Exports: task outcomes, survey answers, prototype clicks, method outcomes,
  method events, A/B exposures (including unfinished tasks) as CSV, and the full
  event JSON. All keep `study_id`, `session_id` and activity IDs; the session ID
  is random, not a real-world identifier.
- Studies can be limited to laptops and desktops (`allowedDevices: "desktop"`).
