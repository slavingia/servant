// Which survey-feedback theme (and kind of work) a request was about, so token
// use can be read against what real users say hurts. Matching is by keyword on
// the request, once, when the reply is recorded; only the labels are kept, never
// the text. Work that isn't about your product (see productContext) is "other".
import SURVEY from "./survey-themes.mjs";

export const OTHER_THEME = "OTHER";
// The label older servers wrote for "other" work: still read as OTHER, never written.
export const LEGACY_OTHER_THEMES = ["NOT_IRS_APP"];

// A request counts as product work only when it matches one of these words or
// phrases (case-insensitive regular-expression fragments), set in config.json:
// "usageTopics": { "name": "Our app", "context": ["payment plan", "refund", "\\btax\\b"] }.
// With none set, every request counts as other work (Servant, tooling and the like).
export function productContext(words) {
  const list = (Array.isArray(words) ? words : []).map(String).filter(Boolean);
  if (!list.length) return null;
  try { return new RegExp(list.join("|"), "i"); }
  catch { return new RegExp(list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i"); }
}
// First match wins, most specific first.
const THEMES = [
  ["AUTOPAY_OR_WITHDRAWAL", /autopay|auto-pay|withdrawal|direct debit|bank draft/i],
  ["ELIGIBILITY_OR_PREREQUISITE", /eligib|qualif|prerequisite|requirement/i],
  ["NOTICE_COLLECTION_OR_COMPLIANCE", /notice|collection|levy|lien|compliance|\bcp\d{2,4}\b/i],
  ["STATUS_CANCELLATION_OR_DEFAULT", /cancel|default|terminat|status|revok/i],
  ["MANAGE_MODIFY_OR_REINSTATE", /edit|modify|change|reinstate|update|scheduled payment|save the changes|not able to save|can'?t save/i],
  ["POSTING_BALANCE_OR_ALLOCATION", /balance|posting|posted|allocat|applied to|credit/i],
  ["CONFIRMATION_DOCUMENTATION_OR_HISTORY", /confirmation|receipt|history|document|letter|transcript|statement/i],
  ["TERMS_AFFORDABILITY_OR_OPTIONS", /terms|afford|interest|penalt|monthly amount|options|how much/i],
  ["PAYMENT_TYPE_TAX_PERIOD_OR_CHANNEL", /payment type|tax period|tax year|channel|debit card|credit card|\bach\b|bank account|apple pay/i],
  ["SUPPORT_OR_ESCALATION", /support|call back|phone|escalat|contact|help center|chat with/i],
  ["SETUP_APPLICATION_OR_AVAILABILITY", /appl(y|ication)|set ?up|enroll|sign ?up|start a|request a|available|request a release/i],
  ["GENERAL_INFORMATION_OR_TOPIC_REQUEST", /what is|how do|how does|explain|information|learn/i],
];
const BUG = /\bfix\b|\bbug\b|broken|doesn'?t work|not working|isn'?t working|not able|unable|error|crash|fail|can'?t |won'?t |regress|not saving|wrong/i;
const FEATURE = /\badd\b|\ballow\b|\bwant\b|should|\bmake\b|can we|new |\bbuild\b|create|design|support for|improve|enable/i;

export function classifyTopic(text, context = null) {
  const t = String(text || "");
  const kind = BUG.test(t) ? "technical_bug" : FEATURE.test(t) ? "feature_request" : "other";
  if (!context || !context.test(t)) return { theme: OTHER_THEME, kind };
  const hit = THEMES.find(([, re]) => re.test(t));
  return { theme: hit ? hit[0] : "GENERAL_INFORMATION_OR_TOPIC_REQUEST", kind };
}

// Joins token totals by theme with what survey respondents said about the same
// themes. share = share of product tokens; feedbackShare = share of survey
// comments. index above 1 means more tokens than the feedback volume suggests.
export function topicReport(rows, { name = "" } = {}) {
  rows = mergeOther(rows);
  const by = new Map(rows.map(r => [r.theme, r]));
  const productTotal = rows.filter(r => r.theme !== OTHER_THEME).reduce((n, r) => n + r.total, 0);
  const comments = SURVEY.all.comments || 1;
  const themes = SURVEY.themes.map(t => {
    const r = by.get(t.id) || { total: 0, turns: 0, bug: 0, feature: 0 };
    const share = productTotal ? r.total / productTotal : 0, feedbackShare = t.comments / comments;
    return { id: t.id, name: t.name, tokens: r.total, turns: r.turns, bugTokens: r.bug, featureTokens: r.feature,
      comments: t.comments, bugSignals: t.technical_bug, featureSignals: t.feature_request, highRisk: t.high_risk,
      share, feedbackShare, index: feedbackShare ? share / feedbackShare : 0,
      tokensPerThousandComments: t.comments ? Math.round(r.total / (t.comments / 1000)) : 0 };
  }).sort((a, b) => b.tokens - a.tokens);
  const other = by.get(OTHER_THEME) || { total: 0, turns: 0 };
  return { source: { name: SURVEY.source, dataset: SURVEY.dataset, build: SURVEY.build, period: SURVEY.period, comments: SURVEY.all.comments },
    product: name || "product", productTokens: productTotal, otherTokens: other.total, otherTurns: other.turns, themes,
    // The same number under the name app builds up to 42 read.
    irsAppTokens: productTotal };
}

// Folds rows still carrying an older "other" label into OTHER.
function mergeOther(rows) {
  const other = rows.filter(r => r.theme === OTHER_THEME || LEGACY_OTHER_THEMES.includes(r.theme));
  if (!other.some(r => r.theme !== OTHER_THEME)) return rows;
  const sum = k => other.reduce((n, r) => n + (r[k] || 0), 0);
  return [...rows.filter(r => !other.includes(r)), { theme: OTHER_THEME, total: sum("total"), turns: sum("turns"), bug: sum("bug"), feature: sum("feature") }];
}
