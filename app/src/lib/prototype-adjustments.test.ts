import assert from "node:assert/strict";
import test from "node:test";
import { designHeading, designReviewText, designTitle, duplicateTitle, filterDesigns } from "./designs.ts";
import {
  MAX_ADJUSTMENTS,
  addAdjustment,
  contrastCheck,
  contrastRatio,
  findingComment,
  ratioText,
  readableLine,
  groupAdjustments,
  offSystem,
  removeElementAdjustments,
  scanFindings,
  tidyValue,
  tokensFor,
  adjustmentLines,
  adjustmentPrompt,
  adjustPageUrl,
  parseDesignReview,
  parseSuggestion,
  prototypePageUrl,
  prototypeVersionUrl,
  readAdjustMessage,
  readableColor,
  removeAdjustment,
  replayChanges,
  suggestionPrompt,
  suggestionText,
  validStyleValue,
  type AdjustElement,
} from "./prototype-adjustments.ts";

const ORIGIN = "https://servant.example.test";
const PAGE = `${ORIGIN}/p/proto-0123456789abcdef01/`;
const styles = { color: "rgb(51, 51, 51)", "background-color": "rgba(0, 0, 0, 0)", "font-size": "32px", "font-weight": "700", "text-align": "start",
  padding: "0px", margin: "0px 0px 16px", "border-radius": "0px", width: "358px", height: "38px" };
const heading: AdjustElement = { id: "e1", tag: "h1", kind: "Heading", label: "Your balance", path: "main:nth-of-type(1) > h1:nth-of-type(1)", text: "Your balance",
  styles, tokens: {}, backdrop: "rgb(255, 255, 255)", original: { text: "Your balance", styles, hidden: false }, hidden: false, previous: null, next: { id: "e2", kind: "Button", label: "Pay now" }, hasParent: true, hasChildren: false };
const button: AdjustElement = { ...heading, id: "e2", tag: "button", kind: "Button", label: "Pay now", path: "main:nth-of-type(1) > button:nth-of-type(1)", text: "Pay now", original: { text: "Pay now", styles, hidden: false },
  previous: { id: "e1", kind: "Heading", label: "Your balance" }, next: null };

test("only this server's prototype pages open for adjustments", () => {
  assert.equal(prototypePageUrl(PAGE, ORIGIN), PAGE);
  assert.equal(prototypePageUrl(`${PAGE}index.html`, ORIGIN), PAGE);
  assert.equal(prototypePageUrl(`${PAGE}?v=3#top`, ORIGIN), PAGE, "query and fragment are dropped");
  for (const bad of [
    "https://evil.example/p/proto-0123456789abcdef01/", // another site
    `http://servant.example.test/p/proto-0123456789abcdef01/`, // not HTTPS
    `${ORIGIN}/p/proto-0123456789abcdef01/other.html`, `${ORIGIN}/p/components/`.replace("components", "_servant"), `${ORIGIN}/v1/chats`,
    `https://user:pass@servant.example.test/p/proto-0123456789abcdef01/`, "javascript:alert(1)", "", null,
  ]) assert.equal(prototypePageUrl(bad, ORIGIN), null, String(bad));
  assert.equal(prototypePageUrl(PAGE, null), null, "an older server that doesn't say where its pages are: off");
  assert.equal(prototypePageUrl("http://127.0.0.1:8790/p/proto-0123456789abcdef01/", "http://127.0.0.1:8790"), "http://127.0.0.1:8790/p/proto-0123456789abcdef01/", "HTTP only on this computer");
  assert.match(adjustPageUrl(PAGE, 7), /\/\?servant-adjust=1&v=7$/);
});

test("messages from the page are checked and shortened; anything else is ignored", () => {
  assert.equal(readAdjustMessage({ source: "other", version: 1, type: "ready" }), null);
  assert.equal(readAdjustMessage({ source: "servant-adjust", version: 2, type: "ready" }), null);
  assert.equal(readAdjustMessage("servant-adjust"), null);
  assert.deepEqual(readAdjustMessage({ source: "servant-adjust", version: 1, type: "ready", title: "  Balance\u0000 page  " }), { type: "ready", title: "Balance page", tokens: [] });
  const selected = readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, label: "x".repeat(500), path: "p".repeat(900), extra: "ignored", styles: { color: "red", unknown: "x" } } });
  assert.ok(selected?.type === "selected");
  assert.equal(selected.element.label.length, 60);
  assert.equal(selected.element.path.length, 300);
  assert.equal(selected.element.styles.color, "red");
  assert.equal("unknown" in selected.element.styles, false);
  assert.equal("extra" in selected.element, false);
  assert.equal(readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, id: "../../x" } }), null, "element IDs are the page script's own");
  assert.equal(readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, tag: "<script>" } }), null);
});

test("changes merge per element and property, return to the start removes them, moves add up, and the list is capped", () => {
  let list = addAdjustment([], heading, "text", "What you owe");
  list = addAdjustment(list, heading, "color", "#1a73e8");
  list = addAdjustment(list, heading, "text", "Amount due");
  assert.equal(list.length, 2);
  assert.deepEqual([list[0]!.prop, list[0]!.prop === "text" && list[0]!.from, list[0]!.to], ["text", "Your balance", "Amount due"], "the original text is kept as 'from'");
  list = addAdjustment(list, heading, "text", "Your balance");
  assert.equal(list.length, 1, "changing it back removes the change");
  assert.deepEqual(addAdjustment(list, heading, "color", "red; background: url(x)"), list, "unsafe style values are refused");
  assert.deepEqual(addAdjustment(list, { ...heading, text: null }, "text", "x"), list, "text only changes on text-only elements");
  list = addAdjustment(list, button, "move", "earlier");
  list = addAdjustment(list, button, "hidden", true);
  assert.deepEqual(list.map(item => item.prop), ["color", "move", "hidden"]);
  assert.deepEqual(addAdjustment(list, heading, "move", "earlier"), list, "nothing to move past");
  assert.deepEqual(replayChanges(list), [{ id: "e1", prop: "color", value: "#1a73e8" }, { id: "e2", prop: "move", value: "earlier" }, { id: "e2", prop: "hidden", value: true }]);
  assert.deepEqual(removeAdjustment(list, 1).map(item => item.prop), ["color", "hidden"]);
  let many = list;
  for (let i = 0; i < 60; i++) many = addAdjustment(many, button, "move", "earlier");
  assert.equal(many.length, MAX_ADJUSTMENTS);
});

test("style values: sizes, colors and keywords people type, nothing else", () => {
  for (const [prop, value] of [["font-size", "18px"], ["font-size", "1.25rem"], ["padding", "8px 16px"], ["margin", "0 auto"], ["width", "50%"], ["width", "auto"], ["height", "fit-content"],
    ["color", "#1a73e8"], ["color", "rgb(26, 115, 232)"], ["background-color", "white"], ["font-weight", "600"], ["text-align", "center"], ["border-radius", "8px"]] as const) {
    assert.equal(validStyleValue(prop, value), true, `${prop}: ${value}`);
  }
  for (const [prop, value] of [["font-size", "big"], ["width", "calc(100% - 2px)"], ["color", "url(x)"], ["color", "red;display:none"], ["padding", "1px 2px 3px 4px 5px"], ["font-weight", "heavy"], ["text-align", "middle"]] as const) {
    assert.equal(validStyleValue(prop, value), false, `${prop}: ${value}`);
  }
  assert.equal(readableColor("rgb(26, 115, 232)"), "#1a73e8");
  assert.equal(readableColor("rgba(0, 0, 0, 0)"), "transparent");
  assert.equal(readableColor("#fff"), "#fff");
});

test("the agent request lists each element's changes in plain words, with where to find it", () => {
  let list = addAdjustment([], heading, "text", "What you owe");
  list = addAdjustment(list, heading, "color", "#1a73e8");
  list = addAdjustment(list, button, "border-radius", "8px");
  list = addAdjustment(list, button, "move", "earlier");
  list = addAdjustment(list, button, "hidden", true);
  assert.deepEqual(adjustmentLines(list), [
    `1. Heading "Your balance" (h1 at main:nth-of-type(1) > h1:nth-of-type(1)): change the text to "What you owe"; text color #333333 → #1a73e8.`,
    `2. Button "Pay now" (button at main:nth-of-type(1) > button:nth-of-type(1)): corner radius 0px → 8px; move it before Heading "Your balance"; hide it.`,
  ]);
  const prompt = adjustmentPrompt({ title: "Balance lookup", page: PAGE, list, note: "Keep the brand blue." });
  assert.match(prompt, /^Please apply these quick adjustments to the prototype "Balance lookup"\. I made them on the live preview \(https:\/\/servant\.example\.test\/p\/proto-0123456789abcdef01\/\); they aren't saved anywhere yet\./);
  assert.match(prompt, /change only what's listed, keep everything else as it is, then republish the preview\./);
  assert.match(prompt, /\nAlso: Keep the brand blue\.$/);
  assert.doesNotMatch(prompt, /validated|approved|tested with participants/i);
});

test("a reviewer's suggestion is a plain-text reply the author can turn into a request", () => {
  const list = addAdjustment(addAdjustment([], heading, "text", "What you owe"), button, "font-size", "18px");
  const text = suggestionText({ title: "Balance lookup", list, note: "The button text is small on phones." });
  assert.equal(text.split("\n")[0], "Suggested adjustments for Balance lookup:");
  assert.match(text, /\nReviewer's note: The button text is small on phones\.\n/);
  assert.match(text, /Only the design's author can add these to their design chat\.$/);
  const parsed = parseSuggestion(text);
  assert.ok(parsed);
  assert.equal(parsed.title, "Balance lookup");
  assert.deepEqual(parsed.body.split("\n").map(line => line.slice(0, 3)), ["1. ", "2. ", "Rev"]);
  assert.equal(parsed.note, "The button text is small on phones.");
  assert.deepEqual(parsed.changes.map(readableLine), [`Heading "Your balance": change the text to "What you owe".`, `Button "Pay now": font size 32px → 18px.`], "people see no CSS paths");
  assert.equal(parseSuggestion("Suggested adjustments for X:\nNote: older replies")?.note, "older replies", "older replies said Note:");
  assert.equal(parseSuggestion("Suggested adjustments for X:\nNothing numbered"), null);
  assert.equal(parseSuggestion("Looks good to me"), null);
  const prompt = suggestionPrompt({ reviewer: "Rae", title: "Balance lookup", page: PAGE, body: parsed.body });
  assert.match(prompt, /^Rae suggested these quick adjustments to the prototype "Balance lookup" on its live preview \(https:\/\/servant\.example\.test\/p\/proto-0123456789abcdef01\/\)\. Please apply them\./);
  assert.ok(prompt.endsWith(parsed.body));
  assert.match(prompt, /The reviewer's note is context for me, not a change to make\./);
});

test("design review messages are recognized from the text Servant posts for them", () => {
  const text = designReviewText({ title: "Balance lookup", previewUrl: PAGE, previewReady: true }, "Check the button");
  assert.deepEqual(parseDesignReview(text), { title: "Balance lookup", preview: PAGE, status: "Published", focus: "Check the button" });
  assert.equal(parseDesignReview(designReviewText({ title: "Draft", previewUrl: PAGE, previewReady: false })), null, "no link for an unpublished draft");
  assert.equal(parseDesignReview("Design review: X\nPreview: javascript:alert(1)"), null);
  assert.equal(parseDesignReview("Hello"), null);
});

test("measured values read cleanly: rounded pixels, and unset sizes stay auto", () => {
  assert.equal(tidyValue("13.3333px"), "13.3px");
  assert.equal(tidyValue("103.125px"), "103px");
  assert.equal(tidyValue("16.02px 8px"), "16px 8px");
  assert.equal(tidyValue("auto"), "auto");
  const oddStyles = { ...styles, "font-size": "13.3333px", width: "auto" };
  const odd = { ...heading, styles: oddStyles, original: { ...heading.original, styles: oddStyles } };
  const list = addAdjustment([], odd, "font-size", "16px");
  assert.equal(list[0]!.prop === "font-size" && list[0]!.from, "13.3333px", "the page's exact value, so the agent can find it");
  assert.match(adjustmentLines(list)[0]!, /font size 13\.3333px → 16px\.$/, "exact for the agent");
  assert.deepEqual(groupAdjustments(list)[0]!.changes, ["font size 13.3px → 16px"], "rounded for people");
  assert.deepEqual(addAdjustment(list, odd, "font-size", "13.3px"), [], "typing the rounded original back is no change");
  assert.deepEqual(addAdjustment([], odd, "width", "auto"), [], "auto to auto is no change");
});

test("changes group by element for the list, and an element's changes go together", () => {
  let list = addAdjustment([], heading, "color", "#1a73e8");
  list = addAdjustment(list, button, "font-size", "18px");
  list = addAdjustment(list, heading, "font-size", "40px");
  assert.deepEqual(groupAdjustments(list).map(g => [g.element.id, g.changes.length]), [["e1", 2], ["e2", 1]]);
  assert.deepEqual(removeElementAdjustments(list, "e1").map(item => item.element.id), ["e2"]);
});

test("contrast: WCAG ratios, large text needs less, and the check flags low contrast", () => {
  assert.equal(contrastRatio("#000", "#fff"), 21);
  assert.equal(contrastRatio("rgb(119, 119, 119)", "white"), 4.48);
  assert.equal(contrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff"), 3.98, "see-through text is blended with what's behind it");
  assert.equal(contrastRatio("not a color", "#fff"), null);
  assert.deepEqual(contrastCheck("#777777", "#ffffff", "16px", "400"), { ratio: 4.48, needed: 4.5, ok: false });
  assert.equal(contrastCheck("#777777", "#ffffff", "24px", "400").ok, true, "large text needs 3:1");
  assert.equal(contrastCheck("#777777", "#ffffff", "19px", "700").ok, true, "bold text from 18.66px is large");
  const findings = scanFindings(
    [{ id: null, kind: "Page", label: "", problem: "no-lang" }, { id: "e3", kind: "Image", label: "", problem: "no-alt" }],
    [{ id: "e1", kind: "Heading", label: "Your balance", color: "rgb(51, 51, 51)", backdrop: "rgb(255, 255, 255)", size: "32px", weight: "700" },
      { id: "e2", kind: "Paragraph", label: "Due soon", color: "#aaaaaa", backdrop: "#ffffff", size: "14px", weight: "400" }]);
  assert.deepEqual(findings.map(f => [f.id, f.name, f.problem]), [
    ["e2", `Paragraph "Due soon"`, "Has low text contrast: 2.3:1 (needs 4.5:1)."],
    [null, "Page", "Doesn't say what language it's in, so screen readers may mispronounce it."],
    ["e3", "Image", "Has no alt text."],
  ]);
  assert.equal(ratioText(4.48), "4.4:1", "a failing ratio never rounds up to a passing one");
  assert.equal(findingComment(findings[2]!), "Accessibility check: this has no alt text. Please fix it.");
  assert.equal(findingComment(findings[1]!), "Accessibility check: the page doesn't say what language it's in, so screen readers may mispronounce it. Please fix it.");
});

test("design-kit tokens: offered by kind, accepted as values, and other values flagged", () => {
  const tokens = [{ name: "--brand", value: "#1a73e8" }, { name: "--ink", value: "rgb(51, 51, 51)" }, { name: "--space-2", value: "16px" }, { name: "--font", value: "Inter, sans-serif" }];
  assert.deepEqual(tokensFor("color", tokens).map(t => t.name), ["--brand", "--ink"]);
  assert.deepEqual(tokensFor("padding", tokens).map(t => t.name), ["--space-2"]);
  assert.equal(validStyleValue("color", "var(--brand)"), true);
  assert.equal(validStyleValue("padding", "var(--space-2)"), true);
  assert.equal(validStyleValue("color", "var(--brand); x"), false);
  assert.equal(offSystem("color", "#123456", tokens), true);
  assert.equal(offSystem("color", "rgb(26, 115, 232)", tokens), false, "the same color as a token");
  assert.equal(offSystem("color", "var(--anything)", tokens), false);
  assert.equal(offSystem("color", "#123456", []), false, "no kit, nothing to compare with");
  const list = addAdjustment([], heading, "color", "var(--brand)");
  assert.match(adjustmentLines(list)[0]!, /text color #333333 → var\(--brand\)\.$/);
});

test("a style or hide can be limited to one screen size; text can't", () => {
  let list = addAdjustment([], heading, "font-size", "24px", "phone");
  list = addAdjustment(list, heading, "font-size", "40px");
  list = addAdjustment(list, heading, "hidden", true, "desktop");
  list = addAdjustment(list, heading, "text", "Owed", "phone");
  assert.equal(list.length, 4, "the phone size and all sizes are separate changes");
  assert.deepEqual(replayChanges(list), [
    { id: "e1", prop: "font-size", value: "24px", scope: "phone" }, { id: "e1", prop: "font-size", value: "40px" },
    { id: "e1", prop: "hidden", value: true, scope: "desktop" }, { id: "e1", prop: "text", value: "Owed" },
  ]);
  const line = adjustmentLines(list)[0]!;
  assert.match(line, /font size 32px → 24px \(phone sizes only, under 600px wide\); font size 32px → 40px; hide it \(desktop sizes only, 1024px wide and up\); change the text to "Owed"/);
  assert.match(adjustmentPrompt({ title: "T", page: PAGE, list }), /applies at that size only \(use a media query/);
  assert.doesNotMatch(adjustmentPrompt({ title: "T", page: PAGE, list: list.slice(1, 2) }), /media query/);
});

test("comments are notes on an element: added, changed, removed, never replayed on the page", () => {
  let list = addAdjustment([], button, "comment", "Feels cramped next to the heading");
  list = addAdjustment(list, button, "comment", "Feels cramped on phones");
  assert.equal(list.length, 1);
  assert.deepEqual(replayChanges(list), []);
  assert.match(adjustmentLines(list)[0]!, /: comment: "Feels cramped on phones"\.$/);
  assert.match(adjustmentPrompt({ title: "T", page: PAGE, list }), /Comments are notes, not exact changes/);
  const suggestion = parseSuggestion(suggestionText({ title: "T", list }))!;
  assert.match(suggestionPrompt({ reviewer: "Rae", title: "T", page: PAGE, body: suggestion.body }), /Comments are notes/);
  assert.deepEqual(addAdjustment(list, button, "comment", "  "), [], "an empty comment removes it");
});

test("the page's other messages: tokens, edits on the page, the check and layers, all checked", () => {
  const ready = readAdjustMessage({ source: "servant-adjust", version: 1, type: "ready", title: "x", tokens: [{ name: "--brand", value: "#1a73e8" }, { name: "bad name", value: "x" }, "junk"] });
  assert.deepEqual(ready, { type: "ready", title: "x", tokens: [{ name: "--brand", value: "#1a73e8" }] });
  const edited = readAdjustMessage({ source: "servant-adjust", version: 1, type: "edited", element: heading, text: "New\u0000 words" });
  assert.deepEqual(edited?.type === "edited" && edited.text, "New words");
  assert.equal(readAdjustMessage({ source: "servant-adjust", version: 1, type: "edited", element: { ...heading, text: null }, text: "x" }), null, "only text-only elements");
  const scanned = readAdjustMessage({ source: "servant-adjust", version: 1, type: "scanned", issues: [{ id: "e1", kind: "Image", label: "", problem: "no-alt" }, { id: "e2", problem: "made-up" }, { id: "../x", problem: "no-alt" }], texts: [] });
  assert.deepEqual(scanned?.type === "scanned" && scanned.issues.map(i => i.id), ["e1"]);
  const layers = readAdjustMessage({ source: "servant-adjust", version: 1, type: "layers", items: [{ id: "e1", kind: "Main area", label: "", depth: 99 }, { id: "x" }] });
  assert.deepEqual(layers?.type === "layers" && layers.items, [{ id: "e1", kind: "Main area", label: "", depth: 6, hidden: false }]);
  const selected = readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, tokens: { color: "--brand", padding: "not a token" }, backdrop: "rgb(0, 0, 0)" } });
  assert.deepEqual(selected?.type === "selected" && [selected.element.tokens, selected.element.backdrop], [{ color: "--brand" }, "rgb(0, 0, 0)"]);
});

test("a new design reads as an untitled design until it has a name", () => {
  assert.equal(designTitle({ title: "New chat" }), "Untitled design");
  assert.equal(designTitle({ title: "  " }), "Untitled design");
  assert.equal(designTitle({ title: "Checkout" }), "Checkout");
  assert.equal(designHeading("New chat", true), "Untitled design");
  assert.equal(designHeading("New chat", false), "New chat");
});

test("kept versions open only from this server's version links", () => {
  assert.equal(prototypeVersionUrl(`${ORIGIN}/p/proto-0123456789abcdef01.v3/`, ORIGIN), `${ORIGIN}/p/proto-0123456789abcdef01.v3/`);
  for (const bad of [`${ORIGIN}/p/proto-0123456789abcdef01/`, `${ORIGIN}/p/proto-0123456789abcdef01.v0/`, `${ORIGIN}/p/proto-0123456789abcdef01.v3/x.html`,
    `https://evil.example/p/proto-0123456789abcdef01.v3/`, `${ORIGIN}/p/proto-0123456789abcdef01.v3/?x=1`, undefined]) {
    assert.equal(prototypeVersionUrl(bad, ORIGIN), null, String(bad));
  }
});

test("the design library: search, mine, shared and archived lists, and a duplicate's name", () => {
  const at = { createdAt: 1, updatedAt: 1, mode: "vibe" as const };
  const designs = [
    { id: "a", title: "Refund status", ...at },
    { id: "b", title: "Checkout", archived: true, ...at },
    { id: "c", title: "Pricing", author: { id: "u2", name: "Rae Reviewer" }, ...at },
  ];
  const mine = new Set(["a", "b"]);
  const ids = (options: Parameters<typeof filterDesigns>[1]) => filterDesigns(designs, options).map(d => d.id);
  assert.deepEqual(ids({ mine }), ["a", "c"], "archived designs are out of the main list");
  assert.deepEqual(ids({ mine, filter: "mine" }), ["a"]);
  assert.deepEqual(ids({ mine, filter: "shared" }), ["c"]);
  assert.deepEqual(ids({ mine, filter: "archived" }), ["b"]);
  assert.deepEqual(ids({ mine, query: "rae" }), ["c"], "search covers the author");
  assert.deepEqual(ids({ mine, query: "refund STATUS" }), ["a"]);
  assert.equal(duplicateTitle({ title: "Refund status" }), "Copy of Refund status");
  assert.equal(duplicateTitle({ title: "x".repeat(90) }).length, 80);
});

test("changes are measured from how the element first looked, even if the page reports it again mid-change", () => {
  // The page reports the heading after its text changed; a second, late "set it back" must not invent a change.
  let list = addAdjustment([], heading, "text", "What you owe");
  const reported = { ...heading, text: "What you owe" };
  list = addAdjustment(list, reported, "text", "Your balance");
  assert.deepEqual(list, [], "back to how it started");
  assert.deepEqual(addAdjustment(list, reported, "text", "Your balance"), [], "a repeat with the stale report is still no change");
  const restyled = { ...heading, styles: { ...styles, color: "#ff0000" } };
  assert.deepEqual(addAdjustment([], restyled, "color", styles.color), [], "a style set back to the original isn't a change");
  const parsed = readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, text: "What you owe", original: { text: "Your balance", styles: { ...styles, color: "red" }, hidden: true } } });
  assert.deepEqual(parsed?.type === "selected" && parsed.element.original, { text: "Your balance", styles: { ...styles, color: "red" }, hidden: true });
  const older = readAdjustMessage({ source: "servant-adjust", version: 1, type: "selected", element: { ...heading, original: undefined } });
  assert.deepEqual(older?.type === "selected" && older.element.original.text, "Your balance", "without one, the current look is the original");
});
