// Sending a message with an abbreviation nobody had defined used to stop and ask "What is PTO?". The owner asked
// for no question: Agent's guess is added on its own, a person can correct it later, and it shows up as a to-do.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { confirmedEntries, expandAbbreviations, findUnknownAbbreviations, type GlossaryEntry } from "./abbreviations.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const entry = (abbreviation: string, fullName: string, guessed = false): GlossaryEntry =>
  ({ id: `lex_${abbreviation}`, abbreviation, fullName, createdAt: 1, updatedAt: 1, ...(guessed ? { guessed: true } : {}) });
const entries = [entry("API", "Application programming interface"), entry("PTO", "Paid time off", true)];

test("a guess is known, so nobody is asked about it again, but it rewrites no one's message", () => {
  assert.deepEqual(findUnknownAbbreviations("PTO via the API, see XYZ", entries), ["XYZ"]);
  assert.deepEqual(confirmedEntries(entries).map(item => item.abbreviation), ["API"]);
  assert.equal(expandAbbreviations("PTO via the API", confirmedEntries(entries)), "PTO via the Application programming interface");
  // Once a person keeps it, it is an entry like any other.
  const kept = entries.map(item => ({ ...item, guessed: undefined }));
  assert.equal(expandAbbreviations("PTO via the API", confirmedEntries(kept)), "Paid time off via the Application programming interface");
});

test("sending never stops to ask: the message goes as written and the server is told afterwards", () => {
  const composer = read("components/Messaging.tsx");
  assert.doesNotMatch(composer, /LearnAbbreviations|useAbbreviationDefinitions|definitions\.(define|dialog)/, "no dialog in the way of Send");
  assert.equal(fs.existsSync(path.join(import.meta.dirname, "../components/LearnAbbreviations.tsx")), false);
  assert.match(composer, /void lexiconApi\.learn\(account, unknown\.slice\(0, MAX_LEARNED_TERMS\), body\)\.then\(result => result\.entries\.forEach\(remember\)\)\.catch\(\(\) => \{\}\);/, "not awaited, and a failure never stops the send");
  const server = fs.readFileSync(path.join(import.meta.dirname, "../../../server/lexicon-guess.mjs"), "utf8");
  assert.equal(Number(/const MAX_LEARNED_TERMS = (\d+);/.exec(composer)![1]), Number(/MAX_GUESS_TERMS = (\d+)/.exec(server)![1]), "no more than the server takes");
  assert.match(read("lib/lexicon-api.ts"), /learn: \(account: Account, terms: string\[\], text: string/);
});

test("the Abbreviations page marks a guess and lets anyone keep it", () => {
  const page = read("components/WikiAbbreviations.tsx");
  assert.match(page, /\{entry\.guessed \? <Text testID=\{`lexicon-guess-\$\{entry\.id\}`\} style=\{styles\.guess\}>Agent&apos;s guess\. It is not underlined in messages until someone keeps or edits it\.<\/Text> : null\}/);
  assert.match(page, /\{entry\.guessed \? <Button label="Keep" accessibilityLabel=\{`Keep Agent's guess for \$\{entry\.abbreviation\}`\} kind="secondary"/);
  assert.match(page, /saved\(await lexiconApi\.update\(account, entry\.id, \{ fullName: entry\.fullName \}\)\)/, "keeping saves the same words under a person's name");
});
