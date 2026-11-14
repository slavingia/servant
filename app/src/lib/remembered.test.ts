import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { remembered } from "./remembered.ts";

test("a costly question is asked once and its answer remembered", () => {
  let asked = 0;
  const available = remembered(() => { asked++; return true; });
  assert.equal(asked, 0, "not asked until someone needs it");
  assert.equal(available.get(), true);
  assert.equal(available.get(), true);
  assert.equal(available.get(), true);
  assert.equal(asked, 1);
});

test("an answer of no is remembered too, and a forgotten one is asked again", () => {
  let asked = 0, answer = false;
  const available = remembered(() => { asked++; return answer; });
  assert.equal(available.get(), false);
  assert.equal(available.get(), false);
  assert.equal(asked, 1, "false is an answer, not a reason to ask again");
  // The person turns dictation on in Settings and comes back to the app.
  answer = true;
  available.forget();
  assert.equal(available.get(), true);
  assert.equal(asked, 2);
});

test("a composer asks the system whether it can take dictation once, not on every screen", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "dictation.ts"), "utf8");
  // The call into the system is made through the remembered answer, never straight from a component's first render.
  assert.match(source, /const recognitionAvailable = remembered\(\(\) => \{\n\s+try \{ return ExpoSpeechRecognitionModule\.isRecognitionAvailable\(\); \} catch \{ return false; \}\n\}\);/);
  assert.match(source, /const \[available\] = useState\(recognitionAvailable\.get\);/);
  assert.equal(source.match(/isRecognitionAvailable\(\)/g)?.length, 1);
  // Coming back to the app asks again, in case a setting changed.
  assert.match(source, /AppState\.addEventListener\("change", state => \{ if \(state === "active"\) recognitionAvailable\.forget\(\); \}\);/);
});
