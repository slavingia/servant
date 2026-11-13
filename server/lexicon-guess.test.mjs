import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGuesses, guessAbbreviations, cleanGuessRequest } from "./lexicon-guess.mjs";

test("parseGuesses keeps usable guesses and drops the rest", () => {
  const reply = 'Sure: {"omw": "on my way", "ETA": "", "TPS": 5, "XYZ": "xyz", "bad": "x\\u0001y"}';
  assert.deepEqual(parseGuesses(reply, ["OMW", "ETA", "TPS", "XYZ", "BAD", "NONE"]), { OMW: "on my way" });
  assert.deepEqual(parseGuesses("no json", ["OMW"]), {});
  assert.deepEqual(parseGuesses("[1]", ["OMW"]), {});
});

test("guessAbbreviations sends the message and falls back to no guesses on failure", async () => {
  let seen;
  const ok = await guessAbbreviations({ terms: ["PTO"], text: "Taking PTO Friday" }, async (system, user) => { seen = user; return '{"PTO":"paid time off"}'; });
  assert.deepEqual(ok, { PTO: "paid time off" });
  assert.match(seen, /Taking PTO Friday/);
  assert.deepEqual(await guessAbbreviations({ terms: ["PTO"], text: "x" }, async () => { throw new Error("down"); }), {});
  assert.deepEqual(await guessAbbreviations({ terms: ["PTO"], text: "x" }, null), {});
});

test("cleanGuessRequest validates", () => {
  assert.deepEqual(cleanGuessRequest({ terms: [" A ", "A", "B"], text: "hi" }), { terms: ["A", "B"], text: "hi" });
  for (const bad of [null, {}, { terms: [], text: "" }, { terms: [1], text: "" }, { terms: ["A"], text: 3 }, { terms: Array(9).fill("A"), text: "" }])
    assert.throws(() => cleanGuessRequest(bad), { status: 400 });
});
