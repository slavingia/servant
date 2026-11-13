// Which survey-feedback theme (and kind of work) a request was about, so token
// use can be read against what real users say hurts. Matching is by keyword on
// the request, once, when the reply is recorded; only the labels are kept, never
// the text. The patterns come from survey-themes.mjs (build-survey-themes.mjs):
// a request must match its `context` to count as product work, then the first
// theme whose `match` hits wins (else `fallback`). Everything else is "other".
import SURVEY from "./survey-themes.mjs";

export const OTHER_THEME = "OTHER";

const PRODUCT_CONTEXT = SURVEY.context ? new RegExp(SURVEY.context, "i") : null;
// First match wins, in the dataset's order (most specific first).
const THEMES = SURVEY.themes.filter(t => t.match).map(t => [t.id, new RegExp(t.match, "i")]);
const FALLBACK = SURVEY.fallback || SURVEY.themes.at(-1)?.id || OTHER_THEME;
const THEME_IDS = new Set(SURVEY.themes.map(t => t.id));
const BUG = /\bfix\b|\bbug\b|broken|doesn'?t work|not working|isn'?t working|not able|unable|error|crash|fail|can'?t |won'?t |regress|not saving|wrong/i;
const FEATURE = /\badd\b|\ballow\b|\bwant\b|should|\bmake\b|can we|new |\bbuild\b|create|design|support for|improve|enable/i;

export function classifyTopic(text) {
  const t = String(text || "");
  const kind = BUG.test(t) ? "technical_bug" : FEATURE.test(t) ? "feature_request" : "other";
  if (!PRODUCT_CONTEXT || !PRODUCT_CONTEXT.test(t)) return { theme: OTHER_THEME, kind };
  const hit = THEMES.find(([, re]) => re.test(t));
  return { theme: hit ? hit[0] : FALLBACK, kind };
}

// Joins token totals by theme with what survey respondents said about the same
// themes. share = share of product tokens; feedbackShare = share of survey
// comments. index above 1 means more tokens than the feedback volume suggests.
// Any row whose theme isn't in the dataset (OTHER, or a label from an older
// dataset) counts as other.
export function topicReport(rows) {
  const by = new Map(rows.map(r => [r.theme, r]));
  const productTotal = rows.filter(r => THEME_IDS.has(r.theme)).reduce((n, r) => n + r.total, 0);
  const comments = SURVEY.all.comments || 1;
  const themes = SURVEY.themes.map(t => {
    const r = by.get(t.id) || { total: 0, turns: 0, bug: 0, feature: 0 };
    const share = productTotal ? r.total / productTotal : 0, feedbackShare = t.comments / comments;
    return { id: t.id, name: t.name, tokens: r.total, turns: r.turns, bugTokens: r.bug, featureTokens: r.feature,
      comments: t.comments, bugSignals: t.technical_bug, featureSignals: t.feature_request, highRisk: t.high_risk,
      share, feedbackShare, index: feedbackShare ? share / feedbackShare : 0,
      tokensPerThousandComments: t.comments ? Math.round(r.total / (t.comments / 1000)) : 0 };
  }).sort((a, b) => b.tokens - a.tokens);
  const other = rows.filter(r => !THEME_IDS.has(r.theme)).reduce((o, r) => ({ total: o.total + r.total, turns: o.turns + r.turns }), { total: 0, turns: 0 });
  return { source: { name: SURVEY.source, dataset: SURVEY.dataset, build: SURVEY.build, period: SURVEY.period, comments: SURVEY.all.comments },
    productTokens: productTotal, otherTokens: other.total, otherTurns: other.turns, themes };
}
