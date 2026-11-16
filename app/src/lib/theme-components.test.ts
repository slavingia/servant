import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Calls keep dark canvases, but their action colors
// still belong to the active server. A literal brand color bypasses its theme.
test("call accents do not hardcode the default blue palette", () => {
  for (const name of ["CallControls", "CallPulse", "IncomingCall", "GuestInvite", "NoiseToggle"]) {
    const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /#(?:1E265D|4E61D6|4252B6|27327A|DEEF51|F3FD8C|EBEFFC|004C97|0071BC|205493|80C7FF|A6D6FF|E8F2FC|19344D|DCEBFA)\b/i, name);
  }
});
