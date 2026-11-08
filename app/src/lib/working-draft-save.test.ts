import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STUDY_SETUP, STOP_DEFAULT, newStudyActivity, type StudyActivity } from "./research-methods.ts";
import { saveWorkingDraft, type WorkingDraftForm } from "./working-draft-save.ts";

const PROTO = { id: "proto-1", previewUrl: "https://servant.example.test/p/proto-aaaaaaaaaaaaaaaaaaaa/" };
const prototypeTask: StudyActivity = { ...newStudyActivity("prototype", "p"), title: "Find balance", instructions: "Find it.", goal: "measure", url: "" };
const abTask: StudyActivity = { ...newStudyActivity("ab_test", "ab"), title: "Pay", instructions: "Pay.", successSignal: "paid", stoppingRule: STOP_DEFAULT, stoppingRuleConfirmed: true,
  designs: [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }] };
const form = (extra: Partial<WorkingDraftForm> = {}): WorkingDraftForm => ({
  title: "Payment study", decision: "Ship it?", question: "Can people pay?", participants: "People paying", background: "Earlier survey",
  setup: DEFAULT_STUDY_SETUP, activities: [prototypeTask, abTask], prototype: { mode: "existing", url: PROTO.previewUrl }, prototypeId: PROTO.id, ...extra,
});
// A deferred stands in for the network: the test decides when it answers and what changes meanwhile.
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

test("the save handler rechecks the prototype, then saves the file it built from the current plan (blocker 2)", async () => {
  const saved: { name: string; text: string }[] = [];
  const result = await saveWorkingDraft({ current: () => form(), loadReadyPrototypes: async () => [PROTO], save: async (name, text) => { saved.push({ name, text }); } });
  assert.deepEqual(result, { ok: true, fileName: "payment-study.working-draft.json", prototypeUrl: PROTO.previewUrl, prototypeId: PROTO.id });
  assert.equal(saved.length, 1);
  const file = JSON.parse(saved[0].text);
  assert.equal(file.prototypeUrl, PROTO.previewUrl, "the chosen prototype is the study prototype");
  assert.match(file.plan.participants.recruitment, /^Recruit about \d+ people for the largest need/);
  assert.doesNotMatch(file.plan.participants.recruitment, /\n/, "one line: Research Studio edits it in a one-line box");
  assert.match(file.plan.analysis, /Each design's denominator is every eligible participant randomized to it/);
});

test("anything that changes during the final recheck aborts the save (blocker 2)", async () => {
  for (const change of [
    (f: WorkingDraftForm) => ({ ...f, title: "Payment study v2" }),
    (f: WorkingDraftForm) => ({ ...f, activities: [{ ...prototypeTask, benchmark: 90 }, abTask] }),
    (f: WorkingDraftForm) => ({ ...f, prototypeId: "proto-2" }),
    (f: WorkingDraftForm) => ({ ...f, setup: { ...f.setup, lossAllowance: 10 } }),
  ]) {
    let state = form();
    const network = deferred<{ id: string; previewUrl: string }[]>();
    let saves = 0;
    const saving = saveWorkingDraft({ current: () => state, loadReadyPrototypes: () => network.promise, save: async () => { saves++; } });
    state = change(state);
    network.resolve([PROTO, { id: "proto-2", previewUrl: "https://servant.example.test/p/proto-bbbbbbbbbbbbbbbbbbbb/" }]);
    const result = await saving;
    assert.deepEqual([result.ok, !result.ok && result.reason, saves], [false, "changed", 0]);
  }
});

test("a prototype that's gone, not ready, or can't be checked fails closed (blocker 2)", async () => {
  let saves = 0;
  const save = async () => { saves++; };
  const gone = await saveWorkingDraft({ current: () => form(), loadReadyPrototypes: async () => [], save });
  assert.deepEqual([gone.ok, !gone.ok && gone.reason, !gone.ok && gone.clearPrototype], [false, "prototype", true]);
  const offline = await saveWorkingDraft({ current: () => form(), loadReadyPrototypes: async () => { throw new Error("Server unreachable."); }, save });
  assert.deepEqual([offline.ok, !offline.ok && offline.reason], [false, "check_failed"]);
  assert.match(!offline.ok ? offline.message : "", /^Server unreachable\. The chosen prototype couldn't be checked/);
  const insecure = await saveWorkingDraft({ current: () => form(), loadReadyPrototypes: async () => [{ id: PROTO.id, previewUrl: "http://servant.example.test/p/x/" }], save });
  assert.equal(insecure.ok, false);
  const blocked = await saveWorkingDraft({ current: () => form({ question: "" }), loadReadyPrototypes: async () => [PROTO], save });
  assert.deepEqual([blocked.ok, !blocked.ok && blocked.reason], [false, "problems"]);
  assert.equal(saves, 0);
  const failing = await saveWorkingDraft({ current: () => form(), loadReadyPrototypes: async () => [PROTO], save: async () => { throw new Error("Disk full."); } });
  assert.deepEqual([failing.ok, !failing.ok && failing.message], [false, "Disk full."]);
});

test("without a chosen prototype, nothing is fetched and the draft has none (blocker 2)", async () => {
  let fetched = 0;
  const result = await saveWorkingDraft({ current: () => form({ prototype: { mode: "none" }, prototypeId: null, activities: [abTask] }),
    loadReadyPrototypes: async () => { fetched++; return []; }, save: async () => {} });
  assert.deepEqual([result.ok, fetched], [true, 0]);
});
