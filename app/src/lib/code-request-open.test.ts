import test from "node:test";
import assert from "node:assert/strict";
import { codeRequestAt, codeRequestToOpen } from "./code-request-open.ts";

const r = (id: string, createdAt: number, more: Partial<{ status: "pending" | "answered" | "cancelled" | "expired" | "claimed"; expiresAt: number }> = {}) =>
  ({ id, createdAt, status: "pending" as const, expiresAt: 10_000, ...more });

test("the newest waiting request opens, once", () => {
  const list = [r("code_aaaaaaaaaaaa", 1), r("code_bbbbbbbbbbbb", 3), r("code_cccccccccccc", 2)];
  assert.equal(codeRequestToOpen(list, new Set(), 5), "code_bbbbbbbbbbbb");
  assert.equal(codeRequestToOpen(list, new Set(["code_bbbbbbbbbbbb"]), 5), "code_cccccccccccc", "one already brought up is not brought up again");
});

test("answered, cancelled, expired or malformed requests never open", () => {
  assert.equal(codeRequestToOpen([r("code_aaaaaaaaaaaa", 1, { status: "answered" }), r("code_bbbbbbbbbbbb", 2, { status: "cancelled" })], new Set(), 5), null);
  assert.equal(codeRequestToOpen([r("code_aaaaaaaaaaaa", 1, { expiresAt: 4 })], new Set(), 5), null);
  assert.equal(codeRequestToOpen([r("code_../../x", 1)], new Set(), 5), null);
  assert.equal(codeRequestToOpen([], new Set(), 5), null);
});

test("the Enter code screen knows which request it shows", () => {
  assert.equal(codeRequestAt("/code/code_abcDEF123_-x"), "code_abcDEF123_-x");
  assert.equal(codeRequestAt("/code/elsewhere"), null);
  assert.equal(codeRequestAt("/chat/cht_123"), null);
});
