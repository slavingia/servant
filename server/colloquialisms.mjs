// Everyday shorthand that a workspace can turn on as one group: "expandColloquialisms" in config.json.
//   "expandColloquialisms": true
//   "expandColloquialisms": { "enabled": true, "extra": { "ACME": "Acme Corporation" } }
// Off unless set. When on, GET /v1/lexicon lists these after the shared shortcuts, so the apps expand them as
// people type, exactly like a shortcut someone added. A shared shortcut with the same abbreviation always wins.
// They are built in, not stored: nobody can edit or delete one, and turning the setting off removes them all.
// Matching ignores case, so leave out anything that is also an ordinary word (SAT, US, IT).
export const COLLOQUIALISMS = Object.freeze({
  tmmrw: "tomorrow",
  tmrw: "tomorrow",
  lmk: "let me know",
  imo: "in my opinion",
  btw: "by the way",
  nvm: "never mind",
  wdyt: "what do you think",
  tbh: "to be honest",
  idk: "I don't know",
  asap: "as soon as possible",
  thru: "through",
  tho: "though",
  convo: "conversation",
  pls: "please",
  plz: "please",
  ppl: "people",
  "b/c": "because",
  gonna: "going to",
  wanna: "want to",
  kinda: "kind of",
  PR: "pull request",
  QA: "quality assurance",
  PDF: "Portable Document Format",
  API: "Application Programming Interface",
  UI: "user interface",
  UX: "user experience",
});

// The engineering words above mean nothing to most people even spelled out, so tapping one also says what it is.
export const COLLOQUIALISM_DESCRIPTIONS = Object.freeze({
  PR: "A proposed change to the code. Teammates look it over, and it becomes part of the app once it's approved and merged",
  QA: "Testing the app to find problems before people use it",
  API: "The way one program asks another for information or to do something",
  UI: "What you see and tap on the screen",
  UX: "How easy and clear something is to use",
  PDF: "A document file that looks the same on every device",
});

const MAX_EXTRA = 200;

/** The group's normalized setting: null when off, else the pairs to add (built in plus the workspace's own). */
export function colloquialismPairs(raw) {
  const on = raw === true || (!!raw && typeof raw === "object" && !Array.isArray(raw) && raw.enabled === true);
  if (!on) return null;
  const pairs = { ...COLLOQUIALISMS };
  const extra = raw && typeof raw === "object" && raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra) ? raw.extra : {};
  for (const [key, value] of Object.entries(extra).slice(0, MAX_EXTRA)) {
    const abbreviation = key.trim(), fullName = typeof value === "string" ? value.trim() : "";
    if (abbreviation && fullName && abbreviation.length <= 40 && fullName.length <= 400 && !/\s/.test(abbreviation)) pairs[abbreviation] = fullName;
  }
  return pairs;
}

/** Shared shortcuts plus the built-in group when the workspace turned it on. Stored entries keep their abbreviation. */
export function withColloquialisms(entries, raw) {
  const pairs = colloquialismPairs(raw);
  if (!pairs) return entries;
  const taken = new Set(entries.map(entry => String(entry.abbreviation).trim().toUpperCase()));
  const added = [];
  for (const [abbreviation, fullName] of Object.entries(pairs)) {
    const key = abbreviation.toUpperCase();
    if (taken.has(key)) continue;
    taken.add(key);
    const description = COLLOQUIALISM_DESCRIPTIONS[abbreviation];
    added.push({ id: `colloquial:${key}`, abbreviation, fullName, ...(description ? { description } : {}), createdAt: 0, updatedAt: 0, canEdit: false, builtIn: true });
  }
  return [...entries, ...added];
}
