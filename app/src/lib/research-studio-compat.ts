// What Civic Research Studio does with a Servant working draft on Import JSON.
//
// The supported version is 0.3.24 (ash-webb/research-studio, commit 03cfcb2,
// the latest release on its main branch, checked November 7, 2026). On import
// it validates the file and then runs ensurePlan(), and its builder sizes every
// A/B experiment and preference activity with its own planner. Two of its rules
// differ from the plan Servant drafts:
//   - planStudy() ignores the planning direction. It plans baseline + difference,
//     or baseline − difference only when the rise would reach 100%.
//   - Preference sizing always assumes two options and fills a 60/40 split when
//     none is given, so a three-option exploratory plan gains a powered size.
// When a draft would change meaning on import, Servant does not save it: the
// export is gated by researchStudioImportChanges().
//
// Two of its displays differ in wording only, so the export explains them in
// the recruitment line and the analysis plan instead of being blocked
// (studioPlanTexts):
//   - Its sample-size summary and size text give each analysis target "plus
//     extra for drop-out"; Servant's recruitment numbers include that extra.
//   - Its size text calls prototype-task, tree-test and first-click targets
//     "people completing the activity", while its own standard analysis (and
//     Servant's) counts everyone who starts.
// Everything else survives
// unchanged; research-studio-compat.test.ts checks this against values produced
// by Research Studio 0.3.24's own code (research-studio-golden.json).
import { planStudy, sampleSizeForMargin, sampleSizePerGroup, sampleSizeVsHalf } from "./research-stats.ts";

export const SUPPORTED_RESEARCH_STUDIO_VERSION = "0.3.24";
export const SUPPORTED_RESEARCH_STUDIO_COMMIT = "03cfcb2";

type Variant = { id: string; label?: string };
type Task = { id: string; method: string; title?: string; experimentId?: string; variants?: Variant[]; successSignal?: string };
type Experiment = { controlId: string; hypotheses: { treatmentId: string; direction: string; measure?: string }[]; baseline: number | null; difference: number | null; power: number; stoppingRule?: string };
type ActivityPlan = { method: string; split?: number | null; power?: number; goal?: string; margin?: number | null; benchmark?: number | null; perRound?: number | null; rounds?: number | null; target?: number | null };
export type WorkingDraft = {
  tasks: Task[];
  plan: { experiments: Record<string, Experiment>; activities: Record<string, ActivityPlan>; analysis: string; participants: { recruitment: string; exclusions: string } };
};
const letter = (index: number) => String.fromCharCode(65 + index);

/** Research Studio 0.3.24 src/abstats.js planStudy: no planning direction. */
export function studioPlanStudy({ baseline, difference, designs = 2, power = 0.8, alpha = 0.05 }: { baseline: number; difference: number; designs?: number; power?: number; alpha?: number }) {
  if (!(baseline > 0 && baseline < 1) || !(difference > 0 && difference < 1)) return null;
  let target = baseline + difference;
  if (target >= 1) target = baseline - difference;
  if (!(target > 0 && target < 1)) return null;
  const perComparison = designs <= 2 ? alpha : alpha / (designs - 1);
  const n = sampleSizePerGroup(baseline, target, { alpha: perComparison, power });
  return n ? { perDesign: n, total: n * designs, alpha: perComparison, power, target, direction: target > baseline ? "up" as const : "down" as const } : null;
}
/** Research Studio 0.3.24 src/plan.js plannedSize. */
export function studioPlannedSize(e: Experiment, designs: number) {
  return studioPlanStudy({ baseline: Number(e.baseline) / 100, difference: Number(e.difference) / 100, designs, power: Number(e.power) || 0.8 });
}
/** Research Studio 0.3.24 src/method-plans.js activitySize for preference: two options, 60/40 when unset. */
export function studioPreferenceSize(ap: ActivityPlan) {
  const split = (Number(ap.split) || 60) / 100, power = Number(ap.power) || 0.8;
  const n = sampleSizeVsHalf(split, { power });
  return { split: Math.round(split * 100), n,
    text: n ? `About ${n} people choosing between two options, to tell a ${Math.round(split * 100)}/${100 - Math.round(split * 100)} split from 50/50 with ${Math.round(power * 100)}% power. "No preference" answers and a third option need more people.` : "Enter a split other than 50%." };
}
/** Research Studio 0.3.24 src/plan.js sizeText, as its plan editor and document show it for an A/B experiment. */
export function studioSizeText(e: Experiment, designs: number) {
  const s = studioPlannedSize(e, designs);
  if (!s) return "Enter an expected control rate between 1 and 99% and a difference that keeps the target between 0 and 100%.";
  return `Recruit about ${s.perDesign} people assigned per design (${s.total} in total), plus extra for drop-out. This gives ${Math.round(s.power * 100) === 80 ? "an" : "a"} ${Math.round(s.power * 100)}% chance of detecting a change from ${e.baseline}% to ${Math.round(s.target * 100)}%${s.direction === "down" && Number(e.baseline) + Number(e.difference) >= 100 ? ` (planned as a drop, since ${Number(e.baseline) + Number(e.difference)}% is not possible)` : ""}${designs > 2 ? `, with significance adjusted for ${designs - 1} comparisons with the control` : ""}.`;
}
const STUDIO_BENCH_LABEL: Record<string, string> = { prototype: "task success", tree_test: "task success (correct destination)", first_click: "first-click success (click in a target area)" };
const studioNumber = (value: unknown) => value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
/** Research Studio 0.3.24 src/method-plans.js activitySize, for every planned method. */
export function studioActivitySize(task: Task, ap: ActivityPlan): { n: number | null; total?: number; text: string } {
  const m = task.method, margin = (studioNumber(ap.margin) || 10) / 100;
  const benchmark = studioNumber(ap.benchmark);
  const p = benchmark != null ? Math.min(0.95, Math.max(0.05, benchmark / 100)) : 0.5;
  if (m === "prototype" && ap.goal === "discover") {
    const per = Math.max(1, studioNumber(ap.perRound) || 6), rounds = Math.max(1, studioNumber(ap.rounds) || 2);
    return { n: per, total: per * rounds, text: `${per} people per round, ${rounds} round${rounds === 1 ? "" : "s"} (${per * rounds} in total), fixing problems between rounds. Small rounds find many of the most common problems; problems few people meet need more participants. Results describe problems, not rates for the whole population.` };
  }
  if (m === "card_sort" && ap.goal === "explore") {
    const n = Math.max(5, studioNumber(ap.target) || 20);
    return { n, text: `About ${n} people completing the sort. For open card sorts, 15–30 is common practice; similarity scores tend to settle at around 15–20 participants (Tullis & Wood, 2004).` };
  }
  if (m === "preference") return studioPreferenceSize(ap);
  const n = sampleSizeForMargin(p, margin);
  if (!n) return { n: null, text: "Enter a margin between 1 and 49 points." };
  const what = m === "card_sort" ? "the share placing a card in a category" : m === "survey" ? "a percentage answer" : `${STUDIO_BENCH_LABEL[m] || "the rate"}`;
  const extra = m === "tree_test" ? " Many teams recruit about 50 per tree." : "";
  return { n, text: `About ${n} people completing the activity, so that ${what} near ${Math.round(p * 100)}% is estimated to within about ±${Math.round(margin * 100)} points (95% interval).${extra} Recruit extra for drop-out.` };
}
const STUDIO_PLANNED_METHODS = ["prototype", "card_sort", "tree_test", "first_click", "preference", "survey"];
/** Research Studio 0.3.24 src/plan.js sampleSummary: every analysis target, and the largest, which it shows "plus extra for drop-out". */
export function studioSampleSummary(draft: WorkingDraft) {
  const rows: { name: string; n: number }[] = [];
  for (const task of draft.tasks.filter(item => item.method === "ab_test")) {
    const e = draft.plan.experiments[task.experimentId || task.id];
    const s = e && studioPlannedSize(e, task.variants?.length ?? 0);
    if (s) rows.push({ name: `A/B experiment ${task.experimentId || task.id}`, n: s.total });
  }
  for (const task of draft.tasks.filter(item => STUDIO_PLANNED_METHODS.includes(item.method))) {
    const ap = draft.plan.activities[task.id];
    const s = ap && studioActivitySize(task, ap);
    if (s?.n) rows.push({ name: task.title || task.id, n: s.total || s.n });
  }
  const top = rows.reduce<{ name: string; n: number } | null>((a, r) => (!a || r.n > a.n ? r : a), null);
  return { rows, top };
}

/** Research Studio 0.3.24 src/plan.js hypothesisSentence: letters by position, control first. */
export function studioHypothesisSentence(variants: readonly Variant[], controlId: string, h: Experiment["hypotheses"][number]) {
  const label = (id: string) => { const i = variants.findIndex(v => v.id === id); return i < 0 ? id : `Design ${letter(i)} (${variants[i].label})`; };
  const what = h.measure === "time"
    ? ({ higher: "more active time on the task", lower: "less active time on the task", different: "a different active time on the task" } as Record<string, string>)[h.direction]
    : `a ${({ higher: "higher", lower: "lower", different: "different" } as Record<string, string>)[h.direction]} ${h.measure === "self" ? "self-reported completion rate" : "task success rate"}`;
  return `Compared with ${label(controlId)}, the control, ${label(h.treatmentId)} will ${h.measure === "time" ? "need" : "have"} ${what}.`;
}
/** Servant's plan for the same experiment: the planning direction is kept. */
export function servantPlannedSize(e: Experiment, designs: number) {
  const direction = e.hypotheses[0]?.direction;
  return planStudy({ baseline: Number(e.baseline) / 100, difference: Number(e.difference) / 100, designs, power: Number(e.power) || 0.8,
    direction: direction === "lower" || direction === "different" ? direction : "higher" });
}

/**
 * Ways this draft's meaning would change if Research Studio imported it now,
 * keyed by task ID. An empty result means it imports unchanged.
 */
export function researchStudioImportChanges(draft: WorkingDraft): { taskId: string; problem: string }[] {
  const changes: { taskId: string; problem: string }[] = [];
  const v = SUPPORTED_RESEARCH_STUDIO_VERSION;
  for (const task of draft.tasks) {
    if (task.method === "ab_test") {
      const e = draft.plan.experiments[task.experimentId || task.id];
      const designs = task.variants?.length ?? 0;
      if (!e) continue;
      const ours = servantPlannedSize(e, designs), theirs = studioPlannedSize(e, designs);
      if (ours && (!theirs || theirs.perDesign !== ours.perDesign || Math.round(theirs.target * 100) !== Math.round(ours.target * 100))) {
        changes.push({ taskId: task.id, problem: `Research Studio ${v} ignores the planning direction, so it would plan a change from ${e.baseline}% to ${theirs ? Math.round(theirs.target * 100) : "?"}% (${theirs?.perDesign ?? "no"} per design) instead of ${e.baseline}% to ${Math.round(ours.target * 100)}% (${ours.perDesign} per design). Plan for higher success, or set this activity up in Research Studio directly` });
      }
    }
    if (task.method === "preference" && (task.variants?.length ?? 0) !== 2) {
      const theirs = studioPreferenceSize(draft.plan.activities[task.id] ?? { method: "preference" });
      changes.push({ taskId: task.id, problem: `Research Studio ${v} treats every preference test as two options, so it would add a ${theirs.split}/${100 - theirs.split} split and a sample size of ${theirs.n} to this exploratory test. Use two options, or set this activity up in Research Studio directly` });
    }
  }
  return changes;
}

/**
 * The parts of a draft Research Studio 0.3.24 keeps on import, after its
 * ensurePlan(): control first, hypotheses pointing at treatments, and its
 * own sizing. Used to prove round trips.
 */
export function researchStudioImportView(draft: WorkingDraft) {
  return {
    experiments: draft.tasks.filter(task => task.method === "ab_test").map(task => {
      const e = draft.plan.experiments[task.experimentId || task.id];
      const ids = (task.variants ?? []).map(variant => variant.id);
      const controlId = ids.includes(e.controlId) ? e.controlId : ids[0] ?? "";
      const ordered = [controlId, ...ids.filter(id => id !== controlId)];
      const size = studioPlannedSize(e, ids.length);
      const variants = ordered.map(id => task.variants!.find(variant => variant.id === id)!);
      return { id: task.experimentId || task.id, variantIds: ordered, labels: variants.map(variant => variant.label ?? ""), controlId,
        directions: e.hypotheses.map(h => h.direction), perDesign: size?.perDesign ?? null, target: size ? Math.round(size.target * 100) : null, stoppingRule: e.stoppingRule ?? "",
        hypotheses: e.hypotheses.map(h => studioHypothesisSentence(variants, controlId, h)) };
    }),
    preferences: draft.tasks.filter(task => task.method === "preference").map(task => {
      const size = studioPreferenceSize(draft.plan.activities[task.id] ?? { method: "preference" });
      return { id: task.id, options: task.variants?.length ?? 0, split: size.split, n: size.n, text: size.text };
    }),
    // Its planner's numbers and size text, as its plan editor and plan document show them.
    sizes: {
      summary: studioSampleSummary(draft),
      texts: draft.tasks.map(task => task.method === "ab_test"
        ? { id: task.id, text: studioSizeText(draft.plan.experiments[task.experimentId || task.id], task.variants?.length ?? 0) }
        : { id: task.id, text: draft.plan.activities[task.id] ? studioActivitySize(task, draft.plan.activities[task.id]).text : "" }),
    },
    // Research Studio shows the plan's own analysis text in place of its standard plan.
    shown: { recruitment: draft.plan.participants.recruitment, exclusions: draft.plan.participants.exclusions, analysis: draft.plan.analysis.trim() },
  };
}
