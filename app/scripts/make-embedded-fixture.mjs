// Writes app/src/lib/fixtures/qualtrics-embedded-SYNTHETIC.csv: a made-up
// Qualtrics export of the demo A/B study run inside a survey (Civic Research
// Studio's embedded data, with ratings and written comments). Everything in it
// is invented; nobody took part. Re-run after changing it:
//
//   node scripts/make-embedded-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fieldNames, surveyFields } from "../src/lib/research-studio-vendor/qualtrics-embed.js";

const fixtures = new URL("../src/lib/fixtures/", import.meta.url);
const study = JSON.parse(readFileSync(new URL("research-studio-demo-ab.json", fixtures), "utf8"));

// A small fixed generator, so the file is the same every time.
let seed = 20261108;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Made-up comments, keyed by design. One has a made-up phone number, to try the
// check on quotes; one has quotation marks and a comma, to try the CSV.
const COMMENTS = {
  "design-a": [
    "I didn't see requests in the sidebar at first.",
    "The sidebar had too many links.",
    "Couldn't tell which request was the newest.",
    "Took a while to find the requests page.",
    "Call me at 555-123-4567 if you want more feedback.",
  ],
  "design-b": [
    "The shortcut on the dashboard was easy to spot.",
    "I wasn't sure \"Recent activity\" meant my requests, at first.",
    "Easy once I saw the shortcuts.",
    "Couldn't tell which request was the newest.",
  ],
};

const rows = [];
// Every comment is used, in turn, so each one is in the file.
const used = { "design-a": 0, "design-b": 0 };
for (let p = 0; p < 24; p++) {
  const variant = p % 2 ? "design-b" : "design-a";
  const sid = `00000000-0000-4000-8000-${String(p).padStart(12, "0")}`;
  const events = [];
  let i = 0;
  const at = () => new Date(Date.UTC(2026, 10, 2, 9, p, i)).toISOString();
  const add = (kind, task_id, payload) => events.push({ id: `e${p}-${i}`, study_id: study.id, session_id: sid, kind, task_id, payload, created_at: at(i++) });
  add("session_started", null, { study_version: study.version || "1.0.0", device: "desktop", external_id: `R_SYNTH${String(p).padStart(4, "0")}`, assignments: { "portal-navigation-2026": { variant_id: variant, source: "link" } } });
  const abResults = {};
  const comments = COMMENTS[variant];
  for (const task of study.tasks) {
    const success = random() < (variant === "design-b" ? 0.7 : 0.5);
    const time = Math.round(35 + random() * 60);
    add("task_started", task.id, { method: "ab_test", order: 1, experiment_id: "portal-navigation-2026", variant_id: variant, variant_revision: "demo-v1", assignment: "link" });
    add("task_ended", task.id, { method: "ab_test", result: { success_signal_received: success, success_signal_status: success ? "received" : "not_observed" }, time_seconds: time, success_at_seconds: success ? time - 5 : null, experiment_id: "portal-navigation-2026", variant_id: variant, variant_revision: "demo-v1", self_report: success || random() < 0.3 ? "completed" : "unable", observed_success: success, tracker_connected: true, click_count: 5 + Math.floor(random() * 10) });
    abResults[task.id] = { variant_id: variant, success_signal_status: success ? "received" : "not_observed", self_report: success ? "completed" : "unable", time_seconds: time, click_count: 8, success_at_seconds: success ? time - 5 : null };
    const answers = {};
    for (const q of task.questions || []) {
      if (q.type === "scale7") answers[q.id] = String(success ? 4 + Math.floor(random() * 4) : 1 + Math.floor(random() * 4));
      if (q.type === "textarea") answers[q.id] = random() < 0.6 ? comments[used[variant]++ % comments.length] : "";
    }
    add("answers", task.id, { stage: "post_task", answers });
  }
  add("answers", null, { stage: "post", answers: { "overall-clarity": String(2 + Math.floor(random() * 4)) } });
  add("session_completed", null, {});
  const { fields } = await surveyFields({ study, sessionId: sid, status: "complete", assignments: { "portal-navigation-2026": { variant_id: variant, source: "link" } }, abResults, externalId: `R_SYNTH${String(p).padStart(4, "0")}`, device: "desktop", events });
  rows.push({
    StartDate: `2026-11-02 09:${String(p).padStart(2, "0")}:00`, EndDate: `2026-11-02 09:${String(p).padStart(2, "0")}:40`,
    Status: "0", Progress: "100", Finished: "1", ResponseId: `RSYNTH_EMB${String(p).padStart(4, "0")}`, DistributionChannel: "anonymous",
    rs_embed_ok: "yes", ...fields,
  });
}

const head = ["StartDate", "EndDate", "Status", "Progress", "Finished", "ResponseId", "DistributionChannel", ...fieldNames(study)];
const cell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
const lines = [
  head.map(cell).join(","),
  head.map(h => cell(h === "StartDate" ? "Start Date" : h)).join(","),
  head.map(h => cell(`{"ImportId":"${h}"}`)).join(","),
  ...rows.map(row => head.map(h => cell(row[h])).join(",")),
];
writeFileSync(new URL("qualtrics-embedded-SYNTHETIC.csv", fixtures), `${lines.join("\n")}\n`);
console.log(`Wrote ${rows.length} made-up responses.`);
