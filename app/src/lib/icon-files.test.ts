// The icon files the stores and devices are strict about. icon.png is the source; the rest are cut from it by
// scripts/make-icons.py. An iPhone refuses an icon with transparency; Android's adaptive foreground, themed icon
// and status-bar icon are shapes on a clear canvas, so they must have it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { APP_ICON_COLOR } from "./theme-colors.ts";

const app = path.join(import.meta.dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(app, "app.json"), "utf8")).expo;

/** Width, height and whether the file carries transparency, from the PNG header. */
function header(file: string) {
  const bytes = fs.readFileSync(path.join(app, file));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is a PNG`);
  const colorType = bytes[25]!;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

test("the app icon is 1024 square with no transparency", () => {
  assert.deepEqual(header(config.icon), { width: 1024, height: 1024, alpha: false });
});

test("Android's adaptive icon is a clear foreground and themed shape over an opaque field in the icon's navy", () => {
  const icon = config.android.adaptiveIcon;
  assert.deepEqual(header(icon.foregroundImage), { width: 1024, height: 1024, alpha: true });
  assert.deepEqual(header(icon.monochromeImage), { width: 1024, height: 1024, alpha: true });
  assert.deepEqual(header(icon.backgroundImage), { width: 1024, height: 1024, alpha: false });
  assert.equal(icon.backgroundColor, APP_ICON_COLOR, "the color shown before the picture loads is the icon's navy");
});

test("the status-bar icon is a clear shape and the favicon is square", () => {
  const notifications = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-notifications")[1];
  assert.deepEqual(header(notifications.icon), { width: 96, height: 96, alpha: true });
  const favicon = header(config.web.favicon);
  assert.equal(favicon.width, favicon.height);
});
