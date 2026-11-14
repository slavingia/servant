---
name: civic-research-studio
description: How Civic Research Studio 0.3.24 works, the unmoderated research platform Servant's Research Studio plans studies for and reads results from. Use it when planning a study, choosing a method, writing tasks or questions, setting up an A/B test with Qualtrics, estimating sample sizes, or interpreting and reporting Research Studio results.
---

# Civic Research Studio

Civic Research Studio (version 0.3.24, public domain, `ash-webb/research-studio`)
is an open-source platform for unmoderated UX research on public services. It is
a static site: a study builder, a participant page (`study.html?study=<id>`) and a
results dashboard. Servant's Research Studio builds study plans in its format and
reads its results; Servant supports exactly version 0.3.24.

This skill is reference knowledge. It holds no study data, participant data or
Research Hub records, and nothing in it is a finding.

## What it can and can't do

Methods, which can be mixed in one study (one random session ID links them):

| Method | Use it for | Main output |
| --- | --- | --- |
| Prototype usability (`prototype`) | Tasks on one instrumented prototype | Success signal, self-report, time, clicks |
| A/B/n implementation test (`ab_test`) | The same tasks on 2+ interactive designs, one design per person | Success by design with ranges, time, drop-out |
| Card sort (`card_sort`): open, closed or hybrid | How people group content | Group assignments, co-placement matrix |
| Tree test (`tree_test`) | Findability in a text-only hierarchy | Success, direct success, first branch, path |
| First click (`first_click`) | Where people click first on a screen | Click position, hit rate if target areas set |
| Preference (`preference`) | Choosing between 2+ static designs | Choice counts, display order |
| Survey (`survey`) | Questions on their own | Answers |

Every activity can have follow-up questions, and every study pre- and
post-study questions. Question types: `text`, `textarea`, `single`, `multi`,
`scale5`, `scale7`.

**Not available** (don't plan around these): screen recording or replay,
recruitment, personalized invitation links, branching logic, resume on another
device, built-in image upload, automatic significance tests or winners,
allocation quotas, identity-based assignment across sessions, automatic
clustering, transcription, one-click publishing. Prototypes must be pages the
team controls with `sdk/utp-tracker.js` added; Figma or third-party pages can't
be tracked. Local demo mode doesn't send results anywhere: real collection needs
an approved backend, or Qualtrics.

## How to help

- **Match the method to the question.** Comparing how people complete the same
  task on different working designs is an A/B test, not a preference test.
  Findability of labels is a tree test or first click; how people group content
  is a card sort; finding problems to fix is prototype usability with small
  rounds.
- **Write neutral tasks.** Same wording for every design; never name the design,
  the answer or the destination. Keep design IDs neutral (`design-a`, not
  `new-improved`): they can show in links.
- **Plan before fielding.** Research questions, control design, hypotheses
  (design, direction, measure), primary and secondary measures, sample size and
  stopping rule, then lock the plan. See `references/ab-testing.md` for the
  sample-size approach.
- **Respect the measures.** A success signal means a configured rule fired, not
  that the person understood. A missing signal or no target area is *unscored*,
  not failed. Self-report and observed success answer different questions.
- **Report cautiously.** Rates over everyone assigned, with 95% ranges.
  Comparisons only once each design has at least 10 people assigned. A range
  that includes zero is not evidence the designs perform the same. **Never
  declare a winner** or call a design validated or proven; practical importance
  is the research team's judgement.
- **Mind people's data.** Open-text answers may contain personal details. Never
  put personal data in tracker IDs, link values or study files. Consent, the
  Paperwork Reduction Act notice and screening belong in the survey or consent
  text, not in tasks.
- **Accessibility.** Plan keyboard and screen reader participants in; the
  first-click task needs a pointer, so offer an alternative for people who can't
  use one.

## References

Read these with `skill_view` when you need the detail:

- `references/methods.md`: authoring and outputs for each method.
- `references/ab-testing.md`: assignment, measures, ranges, data checks,
  sample sizes, and the two Qualtrics routes.
- `references/study-file.md`: the study JSON format and the study plan fields,
  for drafting tasks and questions Research Studio can import.
- `references/servant.md`: how Servant's Research Studio uses Civic Research
  Studio (working drafts and study readouts).
