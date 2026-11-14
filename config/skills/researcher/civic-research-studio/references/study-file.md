# The study file and plan (Civic Research Studio 0.3.24)

A study is JSON. The published file goes in `studies/<id>.json` and is listed in
`studies/index.json`. The working copy also holds the study plan; "Export study
JSON" leaves the plan out, so hypotheses never reach participants.

## Study

```json
{
  "schemaVersion": 3,
  "id": "balance-page-ab",
  "version": "1.0.0",
  "title": "Researcher-facing title",
  "description": "",
  "welcome": "What participants see first",
  "consent": "What they agree to",
  "consentMode": "external",
  "allowedDevices": "desktop",
  "preQuestions": [],
  "tasks": [],
  "postQuestions": []
}
```

- `id`: unique lowercase slug, never reused for an unrelated study.
- `consentMode: "external"` only when consent is collected in a survey first.
- `allowedDevices: "desktop"` only for laptop/desktop-only studies.

## Activities (`tasks`)

Shared fields: `id`, `method`, `title`, `instructions`, `questions`.

- `prototype` (or no method): `successSignal`; the prototype URL is
  `prototypeUrl` on the study or activity.
- `ab_test`: `experimentId`, `successSignal`, `variants`:
  `[{ "id": "design-a", "label": "…", "prototypeUrl": "https://…", "revision": "…" }]`.
- `card_sort`: `sortMode` (`open`, `closed`, `hybrid`), `cards`
  `[{ "id", "label" }]`, `categories` `[{ "id", "label" }]`.
- `tree_test`: `tree` (nested `{ "id", "label", "children": [] }`),
  `correctNodeIds`.
- `first_click`: `imageUrl`, `imageAlt`, `targetAreas`
  `[{ "x", "y", "width", "height", "label" }]` in percent.
- `preference`: `variants` `[{ "id", "label", "imageUrl" }]`.
- `survey`: questions only.

## Questions

`{ "id", "type", "text", "required" }` plus, by type:

- `text`, `textarea`: nothing else.
- `single`, `multi`: `options` (list of strings).
- `scale5`, `scale7`: `lowLabel`, `highLabel`.

Question IDs become Qualtrics field names in route B (`rs_q_<id>`): keep them
short, lowercase and stable.

## Study plan (working copy only, under `plan`)

- `background`, `researchQuestions[]`, `participants` (`audience`,
  `recruitment`, `devices`: any, mostly_phone, mostly_desktop, phone or desktop,
  `exclusions`), `analysis` (blank = the standard plan), `decisions`.
- `experiments.<experimentId>`: `controlId`, `treatments` (what's different in
  each design), `hypotheses[]` (`treatmentId`, `direction`: higher, lower or
  different, `measure`: success, self or time, `rationale`), `primaryMeasure`
  (success or self), `secondary[]`, `baseline` (%), `difference` (points),
  `power`, `stoppingRule`.
- `activities.<activityId>`: `objective`, `rqs[]`, `criteria`, `margin`, and by
  method: prototype `goal` (measure or discover), `benchmark`, `perRound`,
  `rounds`; tree test `benchmark`, `directBenchmark`; first click `benchmark`;
  card sort `goal` (explore or validate), `threshold`, `target`; preference
  `split`, `power`; survey `constructs`.
- `locked {at}` and a change log of every edit after locking.

"Download plan (.docx)" makes a Word document of the plan, procedure and change
log.
