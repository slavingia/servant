import test from "node:test";
import assert from "node:assert/strict";
import { applyReadNotes, noteRead, type ReadNotes } from "./read-cache.ts";

const row = (over: Partial<{ id: string; unread: number; readThrough: string; lastMessage: { id: string } | null }> = {}) =>
  ({ id: "c1", unread: 2, readThrough: "5", lastMessage: { id: "8" }, ...over });

test("a late server list that still says unread loses to what you just read", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000);
  const [out] = applyReadNotes([row()], notes, 2000);
  assert.equal(out.unread, 0);
  assert.equal(out.readThrough, "8");
});

test("once the server says you read that far, the note is dropped and the server wins", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000);
  const [out] = applyReadNotes([row({ unread: 1, readThrough: "8" })], notes, 2000);
  assert.equal(out.unread, 1);
  assert.equal(notes.size, 0);
});

test("a message newer than the note counts as unread", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000);
  const [out] = applyReadNotes([row({ lastMessage: { id: "9" }, unread: 1 })], notes, 2000);
  assert.equal(out.unread, 1);
  assert.equal(notes.has("c1"), false);
});

test("a note expires after two minutes", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000);
  assert.equal(applyReadNotes([row()], notes, 1000 + 120000)[0].unread, 2);
});

test("an older place never replaces a newer one", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000); noteRead(notes, "c1", "6", 1500);
  assert.equal(notes.get("c1")?.through, 8);
});

test("a server with no read place is still overridden by the note", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", 8, 1000);
  assert.equal(applyReadNotes([row({ readThrough: undefined })], notes, 1500)[0].unread, 0);
});

test("rows without notes are returned as they are", () => {
  const list = [row({ id: "other" })];
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", "8", 1000);
  assert.equal(applyReadNotes(list, notes, 1500), list);
});

test("a note that is not a message id is ignored", () => {
  const notes: ReadNotes = new Map(); noteRead(notes, "c1", undefined, 1000); noteRead(notes, "c1", "abc", 1000);
  assert.equal(notes.size, 0);
});
