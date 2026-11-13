// Wide Home's three starting points (Ask the agent, New message, Browse channels) each took at least 180 points,
// so on an iPad held upright two sat side by side and the third stretched across a row of its own.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

test("wide Home's starting points share one row equally at every width", () => {
  const home = read("components/DesktopHome.tsx");
  assert.match(home, /\n  actions: \{ flexDirection: "row", gap: space\.sm, marginTop: space\.lg \},/, "one row that does not wrap");
  assert.match(home, /\n  action: \{ flex: 1, minWidth: 0, /, "equal shares; a long title wraps inside its card");
  assert.doesNotMatch(home, /paddingTop: 72/, "spacing from the scale");
});
