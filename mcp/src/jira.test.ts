// Reading the CSV Jira exports, to learn which issue each to-do became.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jiraKeysByNumber, parseCsv } from "./jira.ts";

test("CSV cells may be quoted, with commas, doubled quotes and line breaks inside", () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,"two, 2","say ""hi"""\n"line\nbreak",,x\n\n'), [["a", "b", "c"], ["1", "two, 2", 'say "hi"'], ["line\nbreak", "", "x"]]);
  assert.deepEqual(parseCsv("\uFEFFa,b"), [["a", "b"]], "a byte order mark is not part of the first name");
  assert.deepEqual(parseCsv(""), []);
});

test("a Jira export gives the key of every issue labelled servant-<number>", () => {
  const file = "Summary,Issue key,Labels,Labels,Status\r\nOne,APP-7,team,servant-1,Done\r\nTwo,app-8,servant-2 other,,To Do\r\nThree,APP-9,other,,To Do\r\nFour,not a key,servant-4,,To Do\r\n";
  assert.deepEqual([...jiraKeysByNumber(file)], [[1, "APP-7"], [2, "APP-8"]]);
  assert.deepEqual([...jiraKeysByNumber("")], []);
  assert.throws(() => jiraKeysByNumber("Summary,Status\r\nOne,Done\r\n"), /needs an "Issue key" column and a "Labels" column/);
});
