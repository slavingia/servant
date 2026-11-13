import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isBannerHidden } from "./banner.ts";

test("hiding the banner hides only that message", () => {
  assert.equal(isBannerHidden("Okay for limited, accepted use", null), false);
  assert.equal(isBannerHidden("Okay for limited, accepted use", "Okay for limited, accepted use"), true);
  assert.equal(isBannerHidden("Down for maintenance at 5", "Okay for limited, accepted use"), false);
});

test("the banner has a close button that hides it", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../components/ServerBanner.tsx"), "utf8");
  assert.match(source, /<IconButton icon="close" label="Hide this message"[^>]*onPress=\{\(\) => hideBanner\(message\)\}/);
  assert.match(source, /isBannerHidden\(message, hidden\)/);
});
