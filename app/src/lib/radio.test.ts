import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const PressResponder = require("react-native-web/dist/cjs/modules/usePressEvents/PressResponder");
const source = readFileSync(new URL("../components/Radio.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function radio(platform: string, onPress: () => void, disabled = false) {
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports,
    require: (id: string) => id === "react-native" ? { Platform: { OS: platform }, Pressable: "Pressable" } : require(id),
  });
  return exports.Radio({ onPress, disabled, "aria-checked": false, accessibilityLabel: "Project" }).props;
}

// Use the installed web PressResponder: Enter is supplied by the framework, Space is not.
// Pressable calls its responder first, then its custom key handler, and handles keyup on document.
function pressKeys(props: Record<string, any>, key: string, repeat = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const listeners = new Map<string, (event: unknown) => void>();
  let prevented = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } });
  const responder = new PressResponder({ onPress: props.onPress, disabled: props.disabled });
  const target = { tagName: "DIV", getAttribute: (name: string) => name === "role" ? props.accessibilityRole : null };
  const event = { key, repeat, target, currentTarget: target, nativeEvent: { type: "keydown" }, persist() {}, stopPropagation() {}, preventDefault() { prevented++; } };
  try {
    responder.getEventHandlers().onKeyDown(event);
    props.onKeyDown?.(event);
    listeners.get("keyup")?.(event);
    return prevented;
  } finally {
    responder.reset();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("changing a web Pressable from button to radio loses Space without the shared handler", () => {
  let calls = 0;
  pressKeys({ accessibilityRole: "button", onPress: () => calls++ }, " ");
  assert.equal(calls, 1);
  pressKeys({ accessibilityRole: "radio", onPress: () => calls++ }, " ");
  assert.equal(calls, 1, "React Native Web does not implement Space for a radio");
});

test("a web radio handles Space and Enter exactly once and prevents Space from scrolling", () => {
  let calls = 0;
  const props = radio("web", () => calls++);
  assert.equal(props.accessibilityRole, "radio");
  assert.equal(props["aria-checked"], false);
  assert.equal(pressKeys(props, " "), 1);
  assert.equal(calls, 1);
  pressKeys(props, "Enter");
  assert.equal(calls, 2, "Enter is handled only by Pressable");
  pressKeys(props, "Spacebar");
  assert.equal(calls, 3);
  pressKeys(props, "ArrowDown");
  assert.equal(calls, 3);
});

test("disabled radios and held Space never repeat the action", () => {
  let calls = 0;
  const disabled = radio("web", () => calls++, true);
  pressKeys(disabled, " "); pressKeys(disabled, "Enter");
  assert.equal(calls, 0);
  const enabled = radio("web", () => calls++);
  pressKeys(enabled, " ");
  assert.equal(pressKeys(enabled, " ", true), 1, "held Space still cannot scroll");
  assert.equal(calls, 1);
});

test("native radios preserve their press callback and have no web keyboard handler", () => {
  const onPress = () => {};
  for (const platform of ["ios", "android"]) {
    const props = radio(platform, onPress);
    assert.equal(props.onPress, onPress);
    assert.equal(props.onKeyDown, undefined);
    assert.equal(props.accessibilityRole, "radio");
  }
});

test("the converted choices all use the keyboard-capable radio", () => {
  for (const path of ["app/chat/[id].tsx", "app/saved.tsx", "components/ChannelList.tsx", "components/ProjectAbout.tsx", "components/ProjectReleases.tsx", "components/ProjectSheet.tsx"]) {
    const screen = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(screen, /<Radio\b/, path);
    assert.doesNotMatch(screen, /accessibilityRole="radio"/, `${path}: use Radio so Space is not lost`);
  }
});
