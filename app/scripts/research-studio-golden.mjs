// Regenerates src/lib/research-studio-golden.json from a Civic Research Studio
// checkout, by importing Servant working drafts with Research Studio's own code.
//
//   node --experimental-strip-types scripts/research-studio-golden.mjs ../../research-studio
//
// The checkout must be the supported version (see research-studio-compat.ts).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildResearchStudioWorkingCopy, chooseControl, changeSortMode, newStudyActivity, DEFAULT_STUDY_SETUP } from "../src/lib/research-methods.ts";
import { SUPPORTED_RESEARCH_STUDIO_COMMIT, SUPPORTED_RESEARCH_STUDIO_VERSION } from "../src/lib/research-studio-compat.ts";

const root = path.resolve(process.argv[2] || "");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
if (version !== SUPPORTED_RESEARCH_STUDIO_VERSION || !commit.startsWith(SUPPORTED_RESEARCH_STUDIO_COMMIT)) throw new Error(`Expected Research Studio ${SUPPORTED_RESEARCH_STUDIO_VERSION} (${SUPPORTED_RESEARCH_STUDIO_COMMIT}), found ${version} (${commit})`);
// Research Studio runs in a browser; its validators resolve links against the page.
globalThis.location ??= new URL("https://research-studio.example/admin.html");
const load = file => import(path.join(root, "src", file));
const [{ validateStudy }, plan, methodPlans] = await Promise.all([load("shared.js"), load("plan.js"), load("method-plans.js")]);
// src/admin.js normalizeStudy (not importable outside a browser), verbatim.
function normalizeStudy(item){return {schemaVersion:item.schemaVersion||3,id:item.id || 'new-study',version:item.version||'1.0.0',title:item.title || '',description:item.description||'',prototypeUrl:item.prototypeUrl || '',welcome:item.welcome||'',consent:item.consent||'',...(item.consentMode==='external'?{consentMode:'external'}:{}),...(item.allowedDevices==='desktop'?{allowedDevices:'desktop'}:{}),preQuestions:item.preQuestions || [],tasks:item.tasks || [],postQuestions:item.postQuestions || [],...(item.plan&&typeof item.plan==='object'?{plan:item.plan}:{})};}

const ab = (key, extra) => ({ ...newStudyActivity("ab_test", key), title: `AB ${key}`, instructions: "Pay the sample balance.", successSignal: "paid",
  stoppingRule: "Analyse once after both designs reach the target.", stoppingRuleConfirmed: true,
  designs: [{ label: "Current flow", url: "https://example.com/a/" }, { label: "New flow", url: "https://example.com/b/" }], ...extra });
const pref = (key, options, extra = {}) => ({ ...newStudyActivity("preference", key), title: `Pref ${key}`, instructions: "Choose the layout you prefer.",
  designs: Array.from({ length: options }, (_, i) => ({ label: `Layout ${i + 1}`, url: `https://example.com/${i}.png` })), ...extra });
const activity = (method, key, extra) => ({ ...newStudyActivity(method, key), title: `${method} ${key}`, instructions: "Do the sample task.", ...extra });
const cases = [
  ["higher, control A", [ab("higher-a", { baseline: 60, difference: 15, direction: "higher" })]],
  ["higher, Design B chosen as control", [chooseControl(ab("higher-b", { baseline: 60, difference: 15, direction: "higher" }), 1)]],
  ["self-reported primary without a success signal", [ab("self", { baseline: 60, difference: 15, primary: "self", successSignal: "" })]],
  ["recruitment for every method", [
    activity("prototype", "discover", { url: "https://example.com/p/", goal: "discover", perRound: 5, rounds: 3 }),
    changeSortMode(activity("card_sort", "explore", { cards: "Pay\nRecords" }), "open"),
    activity("tree_test", "tree", { tree: "Home\n  Records *", benchmark: 70 }),
    activity("survey", "survey", { questions: "How confident are you?" }),
  ]],
  ["lower 60/15 (Research Studio plans a rise)", [ab("lower-rise", { baseline: 60, difference: 15, direction: "lower" })]],
  ["lower 90/15 (Research Studio also plans the drop)", [ab("lower-drop", { baseline: 90, difference: 15, direction: "lower" })]],
  ["different 30/10 (the harder change is the rise, which Research Studio also plans)", [ab("different-rise", { baseline: 30, difference: 10, direction: "different" })]],
  ["different 70/10 (the harder change is the drop; Research Studio plans a rise)", [ab("different-drop", { baseline: 70, difference: 10, direction: "different" })]],
  ["two-option preference 65/35", [pref("two", 2, { split: 65 })]],
  ["three-option exploratory preference", [pref("three", 3, { split: null })]],
];
const out = [];
for (const [name, activities] of cases) {
  const draft = buildResearchStudioWorkingCopy({ title: "Golden study", decision: "Decide", question: "Question", participants: "People", setup: DEFAULT_STUDY_SETUP, activities });
  const esc = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const study = normalizeStudy(structuredClone(draft));
  validateStudy(study); plan.validatePlan(study.plan, study);
  plan.ensurePlan(study);
  const experiments = plan.experimentsOf(study).map(exp => {
    const e = study.plan.experiments[exp.id], s = plan.plannedSize(e, exp.variants.length);
    return { id: exp.id, variantIds: exp.variants.map(v => v.id), labels: exp.variants.map(v => v.label), controlId: e.controlId, directions: e.hypotheses.map(h => h.direction),
      perDesign: s?.perDesign ?? null, target: s ? Math.round(s.target * 100) : null, stoppingRule: e.stoppingRule,
      hypotheses: e.hypotheses.map(h => plan.hypothesisSentence(exp, e, h)) };
  });
  const preferences = plan.plannedActivities(study).filter(t => t.method === "preference").map(t => {
    const ap = study.plan.activities[t.id], s = methodPlans.activitySize(t, ap);
    return { id: t.id, options: t.variants.length, split: Math.round((Number(ap.split) || 60)), n: s.n, text: s.text };
  });
  // Its planner's own numbers and size text, beside which the recruitment field must make sense.
  const summary = plan.sampleSummary(study);
  const sizes = {
    summary: { rows: summary.rows.map(r => ({ name: r.name, n: r.n })), top: summary.top ? { name: summary.top.name, n: summary.top.n } : null },
    texts: study.tasks.map(t => t.method === "ab_test"
      ? { id: t.id, text: plan.sizeText(study.plan.experiments[t.experimentId || t.id], t.variants.length) }
      : { id: t.id, text: study.plan.activities[t.id] ? methodPlans.activitySize(t, study.plan.activities[t.id]).text : "" }),
  };
  // What a person sees: the plan editor (planHTML) and the plan document (planBlocks).
  const html = plan.planHTML(structuredClone(study));
  const blocks = JSON.stringify(plan.planBlocks(structuredClone(study), new Date("2026-11-07T12:00:00Z")));
  const p = study.plan;
  const shown = {
    recruitment: p.participants.recruitment, exclusions: p.participants.exclusions,
    analysis: p.analysis.trim() || plan.standardAnalysisPlan(study),
    inEditor: { recruitment: html.includes(esc(p.participants.recruitment)), exclusions: html.includes(esc(p.participants.exclusions)), analysis: html.includes(esc(p.analysis)) },
    // The kind of box each field is edited in. A one-line <input> drops line breaks from its value.
    editedIn: Object.fromEntries(["participants.recruitment", "participants.exclusions", "analysis"].map(field => [field.replace("participants.", ""),
      new RegExp(`<input[^>]*data-plan-field="${field}"`).test(html) ? "input" : new RegExp(`<textarea[^>]*data-plan-field="${field}"`).test(html) ? "textarea" : "missing"])),
    inDocument: { analysis: blocks.includes(JSON.stringify(p.analysis).slice(1, -1)) },
  };
  out.push({ name, activities, draft, studio: { experiments, preferences, sizes, shown } });
}
const file = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/lib/research-studio-golden.json");
fs.writeFileSync(file, `${JSON.stringify({ researchStudio: { version, commit }, cases: out }, null, 2)}\n`);
console.log(`Wrote ${out.length} cases from Research Studio ${version} (${commit})`);
