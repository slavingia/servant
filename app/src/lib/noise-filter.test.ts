import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE, WASM, wasmFile } from "./noise-filter.ts";

test("the SIMD build is used where SIMD runs, the plain one elsewhere, both served with the app", () => {
  assert.equal(wasmFile(true), WASM.simd);
  assert.equal(wasmFile(false), WASM.plain);
  for (const f of [WASM.simd, WASM.plain]) assert.match(f, /^\/noise\/rnnoise(_simd)?\.wasm$/);
  assert.equal(RATE, 48000);
});
