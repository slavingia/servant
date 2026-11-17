// A conversation opens in one step: its recycling list is held undrawn, at its end, until its first screen has
// settled, then shown once; and never held for long.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OPENING_CAP_MS, SETTLE_LIMIT_MS, WATCH_MS, fromEnd, openingStep, rowsInViewMeasured, startOpening, type ListFrame, type Opening, type RowLayout } from "./list-opening.ts";

// A window 600 points tall. `height` is the content's; `from` is how far the list is from its end.
const frame = (height: number, from = 0, measured = true): ListFrame => ({ scrollTop: Math.max(0, height - 600 - from), scrollHeight: height, clientHeight: 600, measured });
// Runs frames `every` ms apart from `start`, returning what each one asked for.
function run(frames: (ListFrame | null)[], start = 1000, every = 16, state: Opening = startOpening()) {
  const steps = frames.map((f, i) => { const step = openingStep(state, f, start + i * every); state = step.state; return step; });
  return { steps, state, shownOn: steps.findIndex(s => s.show), pins: steps.map(s => s.pin) };
}

test("how far a list is from its end", () => {
  assert.equal(fromEnd(frame(3000)), 0);
  assert.equal(fromEnd(frame(3000, 250)), 250);
  assert.equal(fromEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 }), 0, "a conversation shorter than the window is at its end");
});

test("the list is shown in the first frame it is at its end with every row in view measured", () => {
  // The list's own passes, as they were measured: the last row alone with the rest guessed, rows drawn at
  // guessed heights with the list far from its end, measured but not yet at the end, then settled.
  const { steps, shownOn, state } = run([frame(2600, 0, false), frame(4950, 2326, false), frame(5183, 233, true), frame(5183), frame(5183)]);
  assert.equal(shownOn, 3);
  assert.deepEqual(steps.map(s => s.show), [false, false, false, true, false], "shown once");
  assert.deepEqual(steps.map(s => s.pin), [false, true, true, false, false], "put at its end whenever it is not there");
  assert.equal(state.shownAt, 1000 + 3 * 16);
  // Rows in view still guessed: not shown, however still it stands. Not at its end: not shown, and put there.
  assert.equal(run([frame(5000, 0, false), frame(5000, 0, false), frame(5000, 0, false)]).shownOn, -1);
  const away = run([frame(5000, 40), frame(5000, 40), frame(5000, 40)]);
  assert.equal(away.shownOn, -1);
  assert.deepEqual(away.pins, [true, true, true]);
});

test("a list is never held for longer than the limit: it is shown as it is, and still kept at its end", () => {
  // It never settles (a row keeps changing size). Frames 50 ms apart.
  const frames = Array.from({ length: 12 }, (_, i) => frame(5000 + i * 10, 30, false));
  const { steps, shownOn } = run(frames, 1000, 50);
  assert.equal(shownOn, Math.ceil(OPENING_CAP_MS / 50), "the first frame at or past the limit");
  assert.equal(steps.filter(s => s.show).length, 1);
  assert.ok(steps.slice(shownOn).every(s => s.pin), "it goes on being put at its end after it is shown");
  // And after long enough it is left alone altogether.
  const long = run(Array.from({ length: 60 }, (_, i) => frame(5000 + i * 10, 30, false)), 1000, 50);
  const last = long.steps.findIndex(s => s.state.done);
  assert.equal(last, SETTLE_LIMIT_MS / 50);
  assert.ok(long.steps.slice(last).every(s => !s.pin && !s.show));
});

test("shown after the limit, it is finished once it does settle", () => {
  const frames = [...Array.from({ length: 8 }, () => frame(5000, 30, false)), ...Array.from({ length: 10 }, () => frame(5183))];
  const { steps, shownOn } = run(frames, 1000, 50);
  assert.equal(shownOn, 6);
  // Settled from the ninth frame; finished on the first settled frame a full watch after it was shown.
  const done = steps.findIndex(s => s.state.done);
  assert.equal(done, 6 + WATCH_MS / 50);
  assert.ok(steps.slice(6, 8).every(s => s.pin) && steps.slice(8).every(s => !s.pin), "put at its end until it is there");
});

test("once shown it is watched a moment longer, and put back if it leaves its end", () => {
  // Settled and shown on the first frame; the list's own first scroll then lands above the end.
  const { steps } = run([frame(5183), frame(5183, 400), frame(5183), frame(5183)]);
  assert.equal(steps[0]!.show, true);
  assert.equal(steps[1]!.pin, true, "put back at the end");
  assert.equal(steps[1]!.show, false, "and not shown a second time");
  // Left alone once the moment has passed with the list settled.
  const later = run(Array.from({ length: 22 }, () => frame(5183)));
  const done = later.steps.findIndex(s => s.state.done);
  assert.ok(done * 16 >= WATCH_MS && (done - 1) * 16 < WATCH_MS, `watched for ${WATCH_MS} ms after it was shown`);
  assert.deepEqual(openingStep(later.state, frame(5183, 900), 99999), { state: later.state, pin: false, show: false }, "after that a list that is scrolled is the person's");
});

test("a list with no size yet is not judged, and its time does not run", () => {
  // Under another screen the list has no size. Nothing is shown or moved, however long it lasts.
  let state = startOpening();
  for (const at of [0, 500, 5000]) {
    const step = openingStep(state, { scrollTop: 0, scrollHeight: 0, clientHeight: 0, measured: true }, at);
    assert.deepEqual(step, { state, pin: false, show: false });
    assert.deepEqual(openingStep(state, null, at), { state, pin: false, show: false });
    state = step.state;
  }
  // Then it gets its size: the limit counts from here.
  const { steps, shownOn } = run([frame(5000, 30, false), frame(5000, 30, false), frame(5183)], 9000, 16, state);
  assert.equal(shownOn, 2);
  assert.equal(steps[0]!.state.startedAt, 9000);
});

test("a short conversation and an empty one are shown at once", () => {
  assert.equal(run([{ scrollTop: 0, scrollHeight: 240, clientHeight: 600, measured: true }]).shownOn, 0);
  assert.equal(run([{ scrollTop: 0, scrollHeight: 600, clientHeight: 600, measured: true }]).shownOn, 0);
});

test("every row in view has been measured: looked at from the last row up", () => {
  // Ten rows of 100 points after a 24-point header, 1024 points in all; the window is 320 tall.
  const rows = (measuredFrom: number): RowLayout[] => Array.from({ length: 10 }, (_, i) => ({ y: i * 100, height: 100, isHeightMeasured: i >= measuredFrom }));
  const at = (list: RowLayout[]) => (index: number) => list[index];
  // At the end (scrolled to 704): rows 7, 8 and 9 are in the window, and the last 20 points of row 6 above them.
  assert.equal(rowsInViewMeasured(at(rows(6)), 10, 24, 704, 320), true);
  assert.equal(rowsInViewMeasured(at(rows(7)), 10, 24, 704, 320), false, "row 6 is in view and still a guess");
  assert.equal(rowsInViewMeasured(at(rows(9)), 10, 24, 704, 320), false, "only the last row has been drawn: the first pass");
  // Rows above the window do not matter, measured or not: a window of 300 starts where row 6 ends.
  assert.equal(rowsInViewMeasured(at(rows(7)), 10, 24, 724, 300), true);
  // Nothing to show, and a list that does not know a row yet.
  assert.equal(rowsInViewMeasured(() => undefined, 0, 24, 0, 300), true);
  assert.equal(rowsInViewMeasured(() => undefined, 3, 24, 0, 300), false);
  // A conversation shorter than the window: all of it is in view.
  assert.equal(rowsInViewMeasured(at(rows(0).slice(0, 2)), 2, 24, 0, 300), true);
  assert.equal(rowsInViewMeasured(at(rows(1).slice(0, 2)), 2, 24, 0, 300), false);
});

test("the conversation screen holds its recycling list while it opens, and a phone's list is not touched", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const screen = read("app/c/[id].tsx");
  assert.match(screen, /const opening = useListOpening\(list, RECYCLING_CONVERSATION_LIST && posts !== null, focused\);/);
  assert.match(screen, /<FlashList\n\s+ref=\{list\}\n\s+style=\{opening\}\n\s+\{\.\.\.readTracking\}/);
  assert.equal(screen.match(/style=\{opening\}/g)?.length, 1, "only the recycling list");
  const hook = read("lib/use-list-opening.ts");
  // Only where the page's scroller can be read; anywhere else the list is drawn from its first frame.
  assert.match(hook, /const HOLDS = Platform\.OS === "web";/);
  assert.match(hook, /const \[shown, setShown\] = useState\(!HOLDS\);/);
  assert.match(hook, /const HELD: ViewStyle = \{ opacity: 0 \};/, "laid out, not drawn");
  assert.match(hook, /if \(step\.pin && node\) node\.scrollTop = node\.scrollHeight;/);
  assert.match(hook, /if \(step\.show\) \{ drawNow\(node\); setShown\(true\); \}/, "shown in the frame that decides it");
  // It opens once for each time the list is put on the page: coming back from a thread does not start it again,
  // so the place a person was reading at is kept.
  assert.match(hook, /if \(!HOLDS \|\| !mounted \|\| !inFront \|\| opening\.current\.done\) return;/);
  assert.match(hook, /useEffect\(\(\) => \{ if \(!mounted\) opening\.current = startOpening\(\); \}, \[mounted\]\);/);
  // A person who scrolls a list that is already shown has it to themselves.
  assert.match(hook, /const letGo = \(\) => \{ if \(opening\.current\.shownAt !== null\) opening\.current = \{ \.\.\.opening\.current, done: true \}; \};/);
});
