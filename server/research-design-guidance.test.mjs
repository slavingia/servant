import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchDesignGuidanceRequest,
  formatResearchDesignGuidance,
  parseResearchDesignGuidance,
  researchDesignContext,
  validateFormattedResearchDesignGuidance,
} from "./research-design-guidance.mjs";

const evidence = [{
  id: "rhe_0123456789abcdef",
  kind: "theme",
  title: "Navigation and content clarity",
  summary: "Thirty published aggregate comments concerned navigation and content clarity.",
  product: { id: "bta", name: "Business Tax Account" },
  period: { start: "2026-10-01", end: "2026-10-31", grain: "month" },
  metric: { label: "Theme comments", value: 30, unit: "comments", sampleSize: 30 },
  release: { id: "bta:release", status: "published" },
  catalogReference: "fact_theme_period • bta:theme:2026-10",
  sourcePath: "survey-research-catalog/research_catalog.sqlite",
  version: 1,
}];

const context = {
  title: "Account navigation study",
  decision: "Choose which navigation concept to test",
  question: "Can people find the account action they need?",
  participants: "People managing an account",
  purpose: "Test the minimum navigation flow",
  constraints: "Mobile first",
};

test("research design guidance uses bounded exact study context", () => {
  assert.deepEqual(researchDesignContext(context), context);
  assert.equal(researchDesignContext({ ...context, decision: "Choose a direction\nwith the team" }).decision, "Choose a direction with the team");
  assert.throws(() => researchDesignContext({ ...context, extra: "no" }), /Study context is invalid/);
  assert.throws(() => researchDesignContext({ ...context, purpose: "x".repeat(1_001) }), /purpose is invalid/);
  assert.match(buildResearchDesignGuidanceRequest(evidence, context), /selectedEvidence/);
});

test("research design guidance accepts strict de-identified JSON and formats it", () => {
  const guidance = parseResearchDesignGuidance(JSON.stringify({
    needs: ["People need to obtain a clear understanding of where they are and what they can do next."],
    painPoints: ["Similar choices may be difficult to distinguish at the moment of action."],
    opportunities: ["Hypothesis: group actions by the outcome a person is trying to reach."],
    unknowns: ["The evidence does not establish which navigation pattern will work best."],
  }, null, 2), evidence);
  const text = formatResearchDesignGuidance(guidance);
  assert.match(text, /^User needs/m);
  assert.match(text, /^Pain points/m);
  assert.match(text, /^Design opportunities/m);
  assert.match(text, /^Unknowns and evidence limits/m);
  assert.doesNotMatch(text, /rhe_|Business Tax Account|fact_theme_period|30 comments/);
});

test("research design guidance fails closed on source details and malformed output", () => {
  const valid = {
    needs: ["People need clear next steps."],
    painPoints: ["Choices may be hard to distinguish."],
    opportunities: ["Hypothesis: clarify the action hierarchy."],
    unknowns: ["More participant research is needed."],
  };
  for (const leaking of [
    "Navigation and content clarity",
    "Business Tax Account",
    "Business Tax",
    "BTA",
    "B.T.A.",
    "ＢＴＡ",
    "Business—Tax",
    "BusinessTax",
    "Busi.ness Tax",
    "Busi\u0301ness Tax",
    "Business\u200b Tax",
    "rhe_0123456789abcdef",
    "fact_theme_period • bta:theme:2026-10",
    "https://research.example.test/source",
    "30 comments reported this issue",
    "３０ comments reported this issue",
    "٣٠ comments reported this issue",
    "① group reported this issue",
    "Thirty published aggregate comments indicate confusion.",
    "n=30 users reported this issue",
    "Theme comments indicate confusion",
    "October showed this issue",
    "The source was approved for release",
    "2026-10-01",
  ]) {
    assert.throws(() => parseResearchDesignGuidance(JSON.stringify({ ...valid, needs: [leaking] }), evidence));
  }
  assert.throws(() => parseResearchDesignGuidance(JSON.stringify({ ...valid, extra: [] }), evidence), /invalid design brief/);
  assert.throws(() => parseResearchDesignGuidance("not json", evidence), /invalid design brief/);
});

test("final formatted guidance is canonicalized and checked again after human editing", () => {
  const guidance = {
    needs: ["People need clear next steps."],
    painPoints: ["Choices may be hard to distinguish."],
    opportunities: ["Hypothesis: clarify the action hierarchy."],
    unknowns: ["More participant research is needed."],
  };
  const formatted = formatResearchDesignGuidance(guidance);
  assert.equal(validateFormattedResearchDesignGuidance(formatted, evidence), formatted);

  const edited = formatted.replace(
    "- O1: Hypothesis: clarify the action hierarchy.",
    "- O1: Hypothesis: organize actions around a person's intended outcome.  ",
  );
  assert.match(validateFormattedResearchDesignGuidance(edited, evidence), /intended outcome\.$/m);

  for (const leaking of ["BTA", "Business Tax", "Business—Tax", "３０ comments"]) {
    assert.throws(
      () => validateFormattedResearchDesignGuidance(formatted.replace("People need clear next steps.", leaking), evidence),
      /source details/,
    );
  }
});

test("final formatted guidance requires four exact sections with sequential bounded labels", () => {
  const formatted = formatResearchDesignGuidance({
    needs: ["People need clear next steps."],
    painPoints: ["Choices may be hard to distinguish."],
    opportunities: ["Hypothesis: clarify the action hierarchy."],
    unknowns: ["More participant research is needed."],
  });
  for (const malformed of [
    formatted.replace("User needs", "Needs"),
    formatted.replace("\n\nPain points\n- P1: Choices may be hard to distinguish.", ""),
    formatted.replace("- N1:", "- N2:"),
    `${formatted}\nUnexpected note`,
    formatted.replace("- U1: More participant research is needed.", "- U1: "),
  ]) {
    assert.throws(() => validateFormattedResearchDesignGuidance(malformed, evidence), /invalid format/);
  }

  const tooManyNeeds = formatted.replace(
    "- N1: People need clear next steps.",
    Array.from({ length: 6 }, (_, index) => `- N${index + 1}: People need a clear path forward.`).join("\n"),
  );
  assert.throws(() => validateFormattedResearchDesignGuidance(tooManyNeeds, evidence), /invalid format/);
});
