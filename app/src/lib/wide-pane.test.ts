// The owner: "Remove the rounded corners on white content distracting and doesn't add much".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("the main pane beside the sidebar has square corners", () => {
  const chrome = fs.readFileSync(path.join(import.meta.dirname, "../components/AppChrome.tsx"), "utf8");
  const pane = /\n  widePane: \{([^\n]*)\},/.exec(chrome)?.[1] ?? "";
  assert.match(pane, /backgroundColor: colors\.background/);
  assert.doesNotMatch(pane, /[Rr]adius/);
  assert.doesNotMatch(chrome, /borderTopLeftRadius|borderBottomLeftRadius/);
});

test("the pane is square before the app is signed in too: on the launch screen and the page before its script", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "../..", file), "utf8");
  const launch = /\n  pane: \{([^\n]*)\},/.exec(read("src/components/LaunchScreen.tsx"))?.[1] ?? "";
  assert.match(launch, /backgroundColor: colors\.background/);
  assert.doesNotMatch(launch, /[Rr]adius/);
  const page = /#launch \.pane \{([^}]*)\}/.exec(read("public/index.html"))?.[1] ?? "";
  assert.match(page, /background: var\(--page\)/);
  assert.doesNotMatch(page, /radius/);
});
