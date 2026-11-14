# A/B/n tests: assignment, measures and Qualtrics (Civic Research Studio 0.3.24)

## Study definition

- A between-participants comparison of 2+ working designs on identical tasks.
  Set the research question and primary outcome before launch.
- Keep tasks, follow-up questions, devices, task data, recruitment and
  instrumentation the same across designs. Every design loads the tracker and
  signals success at an equivalent end state. Use version-pinned URLs and record
  a revision for each.
- The control is design A in every activity and in the results.

## Assignment

- Without Qualtrics: a hash of session, study and experiment IDs picks one
  design with equal probability. Per session, not quotas, so groups won't be
  exactly even; a new session may get another design. It's public and not
  tamper-resistant: not for production or adversarial tests.
- With Qualtrics: a Randomizer with "Evenly Present Elements" picks the design
  and passes it in the link (`variant=`). An unknown value is replaced at random
  and flagged.

## Measures in the results

- **Assigned:** people who started that design's activity, once per session
  (with Qualtrics Survey 1, people who never reached Survey 2 too).
- **Finished**, and **dropped out** = assigned − finished.
- **Main measure:** success signal ÷ everyone assigned (drop-outs and
  unmeasured count as not successful). Without a signal, self-reported
  completion ÷ everyone assigned.
- **Secondary:** success ÷ measured finishers. If it disagrees with the main
  measure, rely on the main measure.
- **Self-reported complete:** "Yes, I completed it" ÷ finishers. Also shown:
  people who said they completed it but didn't, with a range.
- **Median active time** (finishers, time away removed; missing times left out,
  never 0), **median time to success**, **median clicks**.

## Ranges and comparisons

- Each rate: 95% Wilson score interval. Difference from design A: Newcombe
  hybrid score interval; with three designs, 97.5% (Bonferroni over two
  comparisons). Medians: fixed-seed percentile bootstrap, at least 5 values.
- Comparisons only when every design has at least 10 people assigned.
- A range excluding zero: a gap that large would be unusual if the designs
  performed the same. A range including zero is **not** evidence they're the
  same. Overlapping per-design ranges aren't a test. Secondary measures aren't
  adjusted for multiple looks. No winner is declared.

## Data checks

- Group sizes: chi-square sample-ratio check, flagged at p < 0.01.
- Drop-out by design: flagged when the difference's range excludes zero.
- Tracking: flagged when under 90% of a design's finishers were measurable, or
  when that differs between designs.
- Devices: phone share by design, flagged when the difference's range excludes
  zero.

## Sample size

- Two-proportion normal approximation (Fleiss, no continuity correction):
  people **assigned** per design, from the expected control rate, the smallest
  difference worth finding, significance and power (80% by default); with three
  designs, significance is split across comparisons.
- Fix the size before fielding and judge results once it's reached. Stopping
  when results look good raises false positives. Recruit for drop-out on top.
- Everyone takes every activity, so recruit for the activity with the largest
  need. While the smallest group is below the planned size, results are marked
  provisional.

## Qualtrics, route A: two surveys and links

- Survey 1: consent, PRA notice, screener, Randomizer setting `Variant`, then a
  redirect to `study.html?study=<id>&variant=${e://Field/Variant}&pid=${e://Field/ResponseID}&return=<Survey 2 link, URL-encoded>`.
- Civic Research Studio runs the tasks, then returns to Survey 2 with results in
  the link: `rs_pid`, `rs_session`, `rs_status`, `rs_variant`, `rs_device`, and
  per A/B activity `rs_ab1_task`, `rs_ab1_variant`, `rs_ab1_success`,
  `rs_ab1_self`, `rs_ab1_time`, `rs_ab1_tts`, `rs_ab1_clicks`.
- Survey 2 declares those fields as Embedded Data, then the follow-up questions.
- Questions written into the Civic Research Studio study and click histories
  are **not** sent in route A: ask questions in the surveys, or use route B.
- Join Survey 1 `ResponseID` to Survey 2 `rs_pid`. Compare drop-off by design
  before outcomes.

## Qualtrics, route B: inside one survey

- A survey page shows Civic Research Studio with a provided script (custom
  JavaScript must be allowed). It stores everything: route A fields plus
  `rs_q_<question>` answers and the full session in `rs_data_1`…`rs_data_8` with
  a checksum. About 60 embedded data fields for a four-task study; the setup page
  (`qualtrics-embed.html?study=<id>`) lists them, and a starter survey (.qsf) has
  them declared.
- Results go only to approved survey hosts (`embedHosts` in `settings.js`).
- Laptop/desktop-only studies screen devices in the survey before the
  Randomizer.
- Tick "Consent is collected in the survey before this study" so people aren't
  asked twice.

## Results

Export Survey 2 (and Survey 1, or include incomplete responses for route B) as
CSV and import them in Results & insights. Files are read in the browser only.
Survey previews and tests are left out; previews can be included on purpose for
a practice run.
