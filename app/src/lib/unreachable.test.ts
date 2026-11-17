import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isUnreachable, UNREACHABLE_MESSAGE } from "./unreachable.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
class ServerError extends Error {
  status: number; code: string;
  constructor(message: string, status = 0, code = "network") { super(message); this.status = status; this.code = code; }
}

test("only a request that never reached the server counts as unreachable", () => {
  assert.equal(isUnreachable(new ServerError("The server isn't reachable right now")), true);
  assert.equal(isUnreachable(new ServerError("The server isn't reachable right now", 502, "unreachable")), true);
  assert.equal(isUnreachable(new TypeError("Failed to fetch")), true);
  assert.equal(isUnreachable(new TypeError("Network request failed")), true);
  assert.equal(isUnreachable(new ServerError("Request cancelled")), false);
  assert.equal(isUnreachable(new ServerError("No live updates")), false);
  assert.equal(isUnreachable(new TypeError("undefined is not a function")), false);
  assert.equal(isUnreachable(new ServerError("Not allowed", 403, "forbidden")), false);
  assert.equal(isUnreachable(new Error("boom")), false);
  assert.equal(isUnreachable("unreachable"), false);
});

test("the unreachable server is a red bar at the very top that colors the status bar", () => {
  const banner = read("components/OfflineBanner.tsx");
  assert.match(banner, /backgroundColor: colors\.danger/);
  assert.match(banner, /paddingTop: space\.sm \+ topInset/);
  assert.match(banner, /<StatusBar style="light" \/>/);
  const chrome = read("components/AppChrome.tsx");
  assert.ok(chrome.indexOf("<OfflineBanner") < chrome.indexOf("<ServerBanner"), "above the server banner");
});

test("lib/server.ts still says it in the same words", () => {
  assert.match(read("lib/server.ts"), new RegExp(`new ServerError\\("${UNREACHABLE_MESSAGE}"\\)`));
});

test("screens do not repeat the unreachable line under the bar", () => {
  for (const file of ["components/ChannelList.tsx", "app/(tabs)/messages.tsx"]) assert.match(read(file), /error && !unreachable && conversations/, file);
});
