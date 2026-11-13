# Business-information filter

Servant already warns before a chat message with personal information (README, "A warning before personal
information", [Rampart Edge](https://github.com/nationaldesignstudio/rampart-edge)). That check does not recognise
sensitive **business** information: a password, a bid price, an unreleased budget, a pen-test finding. This is a second,
small model for that, trained entirely on synthetic data and run on the same machine as the server.

It warns, never blocks: the sender sees "Send with sensitive information?" and can send anyway. The warning is in
general terms and does not repeat or guess at what was typed.

## What it looks for

Eight kinds, defined in `taxonomy.py` (edit it, regenerate, retrain):

| Kind | Examples |
|---|---|
| CREDENTIAL | API keys, tokens, passwords, private keys, connection strings with a password |
| PROCUREMENT | bid or proposal prices, government cost estimates, evaluation scores, pre-award rankings |
| BUDGET | unreleased budget and spend figures, forecasts, reprogramming plans |
| SECURITY | unpatched vulnerabilities, pen-test and audit findings, incident details, internal hosts with architecture |
| CONTROLLED | CUI/FOUO, embargoed or pre-decisional text, unreleased policy, rules or press |
| PERSONNEL | layoff lists, performance ratings, misconduct investigations, individual pay, clearances |
| PROPRIETARY | trade secrets, unreleased roadmaps, customer lists, NDA-covered material |
| TAX_RETURN_INFO | return details tied to a named person or business, or a case |

Personal identifiers (SSNs, cards, phone numbers, home addresses) are deliberately left to Rampart Edge.

## Turning it on

Install the files (below), then in `config.json` (read per request, no restart):

```json
"piiWarning": { "enabled": true, "businessInfo": true }
```

`businessInfo` does nothing unless `enabled` is also true. If the files are missing, fail their checksum or do not load,
only the personal-information check runs and sending works as before. Personal information is checked first and still
names what it found.

Files live beside the Rampart Edge model, in `<SERVANT_PII_DIR>/business/` (default
`~/.local/share/servant/models/rampart-edge/business/`): `business-int8.onnx` (13 MB), `vocab.txt` and `threshold.json`
(the cut-off and a SHA-256 for each file, checked on load). The runtime is the `onnxruntime-node` already installed for
Rampart Edge. Nothing leaves the machine.

## How it was built

- **Model:** `microsoft/xtremedistil-l6-h256-uncased` (12.8M parameters, the same base family as Rampart Edge), fine-tuned
  with an 8-way category head and one "any" output, then int8-quantized (about 13 MB, about a millisecond a message).
- **Data:** about 7,000 messages written by Claude (`gen.py`) from the taxonomy: positives per kind and in pairs, in nine
  writing styles including Spanish, and about 4,000 negatives of fourteen kinds, most of them *hard*: public tax and
  government facts, placeholder secrets, numbers-heavy public text, labelled-fake sample data, public reference numbers,
  technical documentation. Every name, key and figure is invented. Splits are by generation call, so near-duplicates never
  straddle train and validation.
- **Threshold:** the highest cut-off that keeps validation catch at 98% or better, picked on validation only
  (`pick_threshold.py`). Picking it by false-warn rate instead let a handful of examples move it into quantization noise.
- **Independent test:** 600 messages written by a different model (Claude Fable 5.2) from a different prompt, with
  personas instead of styles (`gen_ood.py`, `final_eval.py`). Its messages were never trained on, but **it is no longer a
  clean test**: after the first round I read its false warns and generated new training data for those families
  (labelled-fake sample data, public reference numbers). The same is true of the two real-world rows below: the repo
  documentation and the real-format secrets each showed a weakness that I then trained against (technical documentation,
  real credential formats). Treat those three rows as "checked after fixing what they exposed", not as untouched
  held-out results. The first two rows were never used to decide what data to generate, but I scored them after each
  retrain and watched them while choosing the recipe (the output-layer learning rate and the quantization setting), so
  they are held out from the data, not perfectly blind. Only the threshold and checkpoint were chosen on validation alone.

The datasets are **not** committed: they contain strings shaped like real provider keys (invented, but a secret scanner
cannot tell). Regenerate them with `gen.py`.

## How well it works

Measured on the int8 graph that ships, at the one threshold above. "Catch" is the share of sensitive messages warned;
"false warn" is the share of benign ones warned.

| Test set | Messages | Catch | False warn | Rampart Edge alone (same set) |
|---|---:|---:|---:|---|
| Held-out, same generator, new seed (held out from the data) | 1,096 | 98.9% | 0.7% | 29.8% catch |
| Hard set: sensitive text with no digits; numeric and long benign (held out from the data) | 276 | 96.2% | 0.8% | 25.9% catch |
| Independent (different model, different prompts; steered, see above) | 600 | 100% | 6.0% | 34.0% catch |
| Real prose: 73 paragraphs of this repository's own README and docs (steered) | 73 | n/a | 4.1% | n/a |
| Real-format secrets (AWS, GitHub, Slack, Stripe, Google, JWT, PEM, npm, SendGrid, DB URL, password) (steered) | 12 | 11 of 12 | n/a | n/a |

Rampart Edge alone catches about a third of sensitive business messages. That is expected, not a defect: it was built for
personal identifiers.

## Letting people say a warning was wrong

The check will over-warn, and the people who see it first know best. This lets them say so, and lets the owner decide
what the check learns. It is off unless you turn it on:

```json
"piiWarning": { "enabled": true, "businessInfo": true, "reportFalseAlarms": true }
```

**What people see.** The warning still lets them send anyway. When reporting is on, the dialog also has "This wasn't
sensitive": send it, and tell the owner the warning was wrong. The send is never delayed or blocked by the report.

**What happens to a report.** It is a review queue, not training data:

1. The server re-checks. Only a message the business check really flagged is queued (so the app cannot be made to submit
   arbitrary text), and a message holding personal information (an SSN, a card, a phone number) is never kept.
2. It waits as `pending`. The owner reads it with `node server.mjs business-reports list` and either
   `approve <id>` or `reject <id>` (`all` works for both).
3. **Reject erases the text** and keeps only a hash, so the same message is not queued again.
4. `node server.mjs business-reports export` writes the approved ones to a private file. `python train.py --extra <file>`
   adds them to the next training run as benign examples. Nothing else ever trains the model.

**Why the owner is the gate.** People press "Send anyway" for convenience, and one person could try to teach the check to
ignore a real secret. A report that reached training without a person reading it would let that happen. When you review,
reject anything that is actually sensitive; an approved report tells the model "this kind of message is fine".

**What it keeps, and for how long.** This is a store of message text outside any chat, so it holds as little as it can:
only flagged messages the sender chose to report, never personal information; at most 20 reports per person per day and
2,000 waiting; waiting reports are deleted after 30 days; the file (`business-reports.db`) is readable only by the server's
user. Approved reports are kept, because they are the training set. Tell your people the message is kept for review: the
dialog says so.

**What it does not do.** It does not retrain by itself. The model files only change when someone runs the training and
installs the result. It also cannot learn *new* sensitive patterns from "send anyway": a report only ever says "this
message was fine". To teach it something new that is sensitive, add examples to the taxonomy and regenerate. Reports are
benign-only for that reason, and a report file with labelled rows is ignored.

## Limits, in plain words

- **This is trained on synthetic data and measured on synthetic data.** The 98.9% and 100% describe how well it separates
  messages like the ones Claude writes. They are not a promise about messages real people write, and no real chat was used.
  Before it was trained on technical documentation, the same real prose gave 22% false warns. After, 4.1%, on text it was steered by; a fresh set of real documents would likely do worse.
- **Measure it on your own traffic before relying on it.** Turn it on, keep it warn-only, and look at which warnings people
  send anyway.
- **It can miss.** The one real-format secret it missed was a bare AWS access key ID with no secret, and a message like
  "here is the key: AKIA..." scored well under the cut-off. Pair it with a secret scanner for repositories.
- **It cannot tell what the information is.** The category head names the right kind only about 48% of the time (41% on the
  independent set), mostly confusing near neighbours such as procurement and budget. That is why the warning does not name a
  category. Detection is the part that works; do not build on the category.
- **It over-warns on a few public lookalikes:** court citations and statutory dollar amounts, port and status-code cheat
  sheets, and "fake example" salaries are the recurring false warns. They cost the sender one tap on Send anyway.
- **Only the first 256 word pieces are read.** Something sensitive placed after roughly 150 words is not seen.
- **English and Spanish only**, and Spanish is covered mostly by synthetic text.
- **A person can rephrase.** This is a safety net for accidents, not a control against someone who means to leak.
- **It is not an approval.** Servant is still not approved for sensitive information; this reduces accidents.

## Rebuilding

```sh
python -m venv .venv && . .venv/bin/activate
pip install torch transformers onnx onnxruntime scikit-learn numpy
mkdir data && python gen.py '{"pos_calls":12,"multi_calls":16,"neg_calls":14,"n":20}' 6   # needs the claude CLI; about $12
EPOCHS=10 LR=6e-5 OUT=model python train.py
python export.py model && python pick_threshold.py && python final_eval.py
```

Then copy `business-int8.onnx` and `vocab.txt` to the server's `business/` folder and write `threshold.json` with the
`threshold`, `maxTokens` (256) and each file's `bytes` and `sha256`.
