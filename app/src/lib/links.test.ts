// Links are always underlined in a browser and the Mac app (docs/design-system.md, "Links"). The rule lives in the
// theme (`linkUnderline`) and every blue word that can be pressed spreads it. Before this, only links inside
// messages were underlined: "Add a photo", "Refresh", "Back", "3 replies" and thirty more were plain blue words.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".tsx")).map(file => file.split(path.sep).join("/"));

// Blue words that are not links, and why. Anything else blue is a link.
const NOT_LINKS: Record<string, string> = {
  "app/leaderboard.tsx:rankTop": "the first place's number",
  "components/ApproveFromPhone.tsx:bulletText": "step numbers",
  "components/ServerSwitcher.tsx:current": 'the word "Current" beside the open server',
  "components/Messaging.tsx:mention": "a name in a message",
  "components/Messaging.tsx:menuActionText": "a row in a menu",
  "app/chat/[id].tsx:menuActionText": "a row in a menu",
  "app/(tabs)/agent.tsx:turnLiveText": "what the agent is doing now",
  "app/(tabs)/agent.tsx:turnLabel": "what the agent is doing now",
  "app/(tabs)/agent.tsx:unreadWhen": "the time on an unread row",
  "app/(tabs)/_layout.tsx:selected": "the chosen tab's label",
  "app/c/[id].tsx:labelStyle": "a native header button",
  "components/MessageText.tsx:mention": "a name in a message",
};

test("the rule is one line in the theme, and the shared Button's link uses it", () => {
  assert.match(read("lib/theme.tsx"), /export const linkUnderline: TextStyle = Platform\.OS === "web" \? \{ textDecorationLine: "underline" \} : \{\};/);
  assert.match(read("components/Button.tsx"), /linkLabel: \{ color: colors\.blue, \.\.\.linkUnderline \},/);
});

test("every blue word that can be pressed is underlined on the web", () => {
  const plain: string[] = [];
  let found = 0;
  for (const file of files) {
    for (const [, name, body] of read(file).matchAll(/(\w+): \{([^{}]*\bcolor: colors\.blue\b[^{}]*)\}/g)) {
      found++;
      if (`${file}:${name}` in NOT_LINKS) continue;
      if (!/\.\.\.linkUnderline\b/.test(body!) && !/textDecorationLine: ["']underline["']/.test(body!)) plain.push(`${file}:${name}`);
    }
  }
  assert.ok(found >= 30, "found the blue text styles");
  assert.deepEqual(plain, []);
  for (const key of Object.keys(NOT_LINKS)) { const [file, name] = key.split(":"); assert.match(read(file!), new RegExp(`\\b${name}: \\{[^{}]*color: colors\\.blue`), `${key} is still there`); }
});
