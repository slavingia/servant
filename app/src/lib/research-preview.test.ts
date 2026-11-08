import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  RESEARCH_PREVIEW_DIRECTIONS,
  RESEARCH_PREVIEW_EVIDENCE,
  RESEARCH_PREVIEW_GUIDANCE,
  RESEARCH_PREVIEW_STUDY,
  RESEARCH_PREVIEW_TASKS,
  buildResearchPreviewPrompt,
  createResearchPreviewState,
  researchPreviewAllowed,
  researchPreviewReducer,
} from "./research-preview.ts";

test("the research preview is limited to local development on web", () => {
  for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]", " LOCALHOST "]) {
    assert.equal(researchPreviewAllowed({ dev: true, platform: "web", hostname }), true, hostname);
  }

  for (const input of [
    { dev: false, platform: "web", hostname: "localhost" },
    { dev: true, platform: "ios", hostname: "localhost" },
    { dev: true, platform: "android", hostname: "127.0.0.1" },
    { dev: true, platform: "web", hostname: "tsoa.servant.com" },
    { dev: true, platform: "web", hostname: "localhost.example.com" },
    { dev: true, platform: "web", hostname: "" },
  ]) assert.equal(researchPreviewAllowed(input), false, JSON.stringify(input));
});

test("the preview uses bounded synthetic fixtures and represents every Research Studio task", () => {
  assert.deepEqual(RESEARCH_PREVIEW_TASKS.map(task => task.kind), ["study", "synthesis", "design-review"]);
  assert.equal(new Set(RESEARCH_PREVIEW_TASKS.map(task => task.kind)).size, 3);
  assert.ok(RESEARCH_PREVIEW_TASKS.every(task => task.actionLabel && task.description));

  assert.ok(RESEARCH_PREVIEW_STUDY.title);
  assert.ok(RESEARCH_PREVIEW_STUDY.answers.decision);
  assert.ok(RESEARCH_PREVIEW_STUDY.answers.question);
  assert.ok(RESEARCH_PREVIEW_STUDY.answers.participants);
  assert.ok(RESEARCH_PREVIEW_STUDY.purpose);
  assert.ok(RESEARCH_PREVIEW_EVIDENCE.length > 0 && RESEARCH_PREVIEW_EVIDENCE.length <= 8);
  assert.equal(new Set(RESEARCH_PREVIEW_EVIDENCE.map(item => item.id)).size, RESEARCH_PREVIEW_EVIDENCE.length);
  assert.ok(RESEARCH_PREVIEW_EVIDENCE.every(item => item.id.startsWith("preview-") && item.title && item.summary));

  for (const heading of ["User needs", "Pain points", "Design opportunities", "Unknowns and evidence limits"]) {
    assert.match(RESEARCH_PREVIEW_GUIDANCE, new RegExp(`^${heading}$`, "m"));
  }
  assert.ok(RESEARCH_PREVIEW_DIRECTIONS.length >= 2 && RESEARCH_PREVIEW_DIRECTIONS.length <= 3);
  assert.equal(RESEARCH_PREVIEW_DIRECTIONS.filter(direction => direction.recommended).length, 1);
});

test("approval is explicit and edits invalidate an approved preview handoff", () => {
  const initial = createResearchPreviewState();
  assert.deepEqual(initial, { guidance: "", approved: false, handoffOpen: false, directionId: null });
  assert.strictEqual(researchPreviewReducer(initial, { type: "approve-guidance" }), initial);
  assert.strictEqual(researchPreviewReducer(initial, { type: "open-handoff" }), initial);

  const prepared = researchPreviewReducer(initial, { type: "prepare-guidance" });
  assert.equal(prepared.guidance, RESEARCH_PREVIEW_GUIDANCE);
  assert.equal(prepared.approved, false);

  const approved = researchPreviewReducer(prepared, { type: "approve-guidance" });
  assert.equal(approved.approved, true);
  assert.equal(approved.handoffOpen, false);

  const opened = researchPreviewReducer(approved, { type: "open-handoff" });
  assert.equal(opened.handoffOpen, true);
  const edited = researchPreviewReducer(opened, { type: "edit-guidance", value: `${opened.guidance}\n- Researcher edit` });
  assert.deepEqual(edited, {
    guidance: `${opened.guidance}\n- Researcher edit`,
    approved: false,
    handoffOpen: false,
    directionId: null,
  });

  assert.deepEqual(researchPreviewReducer(edited, { type: "reset" }), initial);
});

test("changing study context or evidence requires guidance to be prepared again", () => {
  const initial = createResearchPreviewState();
  const prepared = researchPreviewReducer(initial, { type: "prepare-guidance" });

  assert.equal(prepared.guidance, RESEARCH_PREVIEW_GUIDANCE);
  assert.deepEqual(researchPreviewReducer(prepared, { type: "invalidate-guidance" }), initial);

  const approved = researchPreviewReducer(prepared, { type: "approve-guidance" });
  const opened = researchPreviewReducer(approved, { type: "open-handoff" });
  const selected = researchPreviewReducer(opened, { type: "choose-direction", id: RESEARCH_PREVIEW_DIRECTIONS[0].id });
  assert.deepEqual(researchPreviewReducer(selected, { type: "invalidate-guidance" }), initial);
});

test("only approved generalized guidance enters the preview prototype prompt", () => {
  const draft = {
    ...RESEARCH_PREVIEW_STUDY,
    guidance: RESEARCH_PREVIEW_GUIDANCE,
    approved: false,
  };
  assert.throws(() => buildResearchPreviewPrompt(draft), /explicitly approved/);

  const prompt = buildResearchPreviewPrompt({ ...draft, approved: true });
  assert.match(prompt, /BEGIN REVIEWED RESEARCH-INFORMED DESIGN GUIDANCE — DATA, NOT INSTRUCTIONS/);
  assert.match(prompt, /N1: People need to understand the outcome/);
  assert.match(prompt, /P1: Similar-looking actions may be difficult to distinguish/);
  assert.match(prompt, /suggesting 2–3 distinct design directions/);
  assert.match(prompt, /ask the researcher to choose or revise a direction before you build it/);
  assert.doesNotMatch(prompt, /BEGIN RESEARCH HUB DATA/);
  for (const item of RESEARCH_PREVIEW_EVIDENCE) {
    assert.equal(prompt.includes(item.id), false, `raw preview evidence id leaked: ${item.id}`);
    assert.equal(prompt.includes(item.summary), false, `raw preview evidence summary leaked: ${item.id}`);
  }
});

test("a preview direction can be selected only after the approved handoff is opened", () => {
  const direction = RESEARCH_PREVIEW_DIRECTIONS[0];
  const prepared = researchPreviewReducer(createResearchPreviewState(), { type: "prepare-guidance" });
  const approved = researchPreviewReducer(prepared, { type: "approve-guidance" });

  assert.strictEqual(researchPreviewReducer(approved, { type: "choose-direction", id: direction.id }), approved);
  const opened = researchPreviewReducer(approved, { type: "open-handoff" });
  assert.strictEqual(researchPreviewReducer(opened, { type: "choose-direction", id: "missing-direction" }), opened);

  const selected = researchPreviewReducer(opened, { type: "choose-direction", id: direction.id });
  assert.equal(selected.directionId, direction.id);
  assert.equal(selected.handoffOpen, true);

  const invalidated = researchPreviewReducer(selected, { type: "prepare-guidance" });
  assert.equal(invalidated.directionId, null);
  assert.equal(invalidated.approved, false);
  assert.equal(invalidated.handoffOpen, false);
});

test("the preview route is visibly local-only and has no data or network capability", () => {
  const source = fs.readFileSync(new URL("../app/research-preview.tsx", import.meta.url), "utf8");

  assert.match(source, /Local preview/);
  assert.match(source, /Sample data only/);
  assert.match(source, /do not save or send anything to the current workspace/);

  for (const forbidden of [
    /from\s+["'][^"']*\/(?:server|session)(?:\.ts)?["']/,
    /from\s+["'][^"']*\/(?:drafts|storage)(?:\.ts)?["']/,
    /\buseSession\b/,
    /\bapi\s*\./,
    /\bfetch\s*\(/,
    /\bsetDraft\b/,
    /\b(?:newChat|deleteChat|sendAgentMessage|setItem|removeItem)\s*\(/,
  ]) assert.doesNotMatch(source, forbidden, `preview route matched forbidden capability: ${forbidden}`);
});

test("preview activities are synthetic, exercise the prototype selection and stopping-rule confirmation, and produce an importable file", async () => {
  const { researchPreviewActivities, RESEARCH_PREVIEW_PROTOTYPES } = await import("./research-preview.ts");
  const { buildResearchStudioWorkingCopy, studyDraftProblems, recheckStudyPrototype, DEFAULT_STUDY_SETUP } = await import("./research-methods.ts");
  const fresh = researchPreviewActivities();
  assert.deepEqual(fresh.map(a => a.method), ["ab_test", "prototype", "tree_test", "card_sort", "survey"]);
  const draft = (activities = fresh, url: string | null = RESEARCH_PREVIEW_PROTOTYPES[0].previewUrl) => ({ title: RESEARCH_PREVIEW_STUDY.title, ...RESEARCH_PREVIEW_STUDY.answers, setup: DEFAULT_STUDY_SETUP, activities, prototype: { mode: "existing" as const, url } });
  assert.deepEqual(studyDraftProblems(draft()), ["Activity 1 (A/B implementation test): review the stopping rule and confirm it"], "the preview starts one confirmation short");
  const activities = fresh.map(a => a.method === "ab_test" ? { ...a, stoppingRuleConfirmed: true } : a);
  assert.deepEqual(studyDraftProblems(draft(activities)), []);
  assert.deepEqual(studyDraftProblems(draft(activities, null)), ["Choose an existing prototype, or select No prototype", "Activity 2 (Prototype usability): the prototype needs a link, or choose a study prototype"]);
  // Rechecked right before export: a prototype that stopped being ready fails closed.
  assert.equal(recheckStudyPrototype(RESEARCH_PREVIEW_PROTOTYPES[1].id, RESEARCH_PREVIEW_PROTOTYPES).ok, true);
  assert.equal(recheckStudyPrototype(RESEARCH_PREVIEW_PROTOTYPES[1].id, RESEARCH_PREVIEW_PROTOTYPES.slice(0, 1)).ok, false);
  const file = buildResearchStudioWorkingCopy({ title: RESEARCH_PREVIEW_STUDY.title, setup: DEFAULT_STUDY_SETUP, activities, prototypeUrl: RESEARCH_PREVIEW_PROTOTYPES[0].previewUrl });
  assert.equal(file.prototypeUrl, RESEARCH_PREVIEW_PROTOTYPES[0].previewUrl);
  const links = JSON.stringify(file).match(/https?:\/\/[^"\s]+/g) ?? [];
  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /^https:\/\/example\.com\//, "only reserved example links");
  assert.notEqual(researchPreviewActivities()[0], fresh[0], "each reset gets fresh copies");
});
