// Nothing a person needs to read is cut off with an ellipsis (docs/design-system.md, "Type"): names, titles, labels,
// values, statuses and options wrap. A line limit is only for a preview whose full text is one press away, a file
// name on a tile, and the call and media screens, and each place that has one is listed here with its reason.
// Before this there were 94 limits: people's names, project and channel names, recording titles, to-do tags, the
// reason an approval is needed and an owner's work email were all cut to one line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => /\.tsx$/.test(file)).map(file => file.split(path.sep).join("/"));

// file: [how many line limits it may have, why they are previews and not content]
const PREVIEWS: Record<string, [number, string]> = {
  "components/Messaging.tsx": [4, "a conversation row's last message, the message being acted on in a sheet, the dictation line, and the first message a reply shown in the conversation answers (the thread has all of it)"],
  "app/(tabs)/agent.tsx": [2, "an agent chat row's last line; the chat opens in full"],
  "app/inbox.tsx": [2, "a case row's last message and next action; each opens its full conversation or task"],
  "app/inbox/[id].tsx": [1, "the next follow-up preview; View follow-ups opens the full task"],
  "components/Omnibar.tsx": [1, "a search result's snippet; the result opens in full"],
  "app/saved.tsx": [2, "the source message and recording summary under a work log entry; Open message and Open note show them in full"],
  "components/SavedTaskRow.tsx": [1, "a saved message, with a control to show all of it"],
  "components/ForwardSheet.tsx": [1, "the message being forwarded"],
  "components/AgentSteps.tsx": [1, "a step's output; the chat has it in full"],
  "app/chat/[id].tsx": [2, "the header title, which opens to show all of it, and a forwarded quote"],
  "components/ProjectReleases.tsx": [1, "a status chip in the release table; the cell opens in full"],
  "app/files.tsx": [2, "file names on tiles; the viewer shows the whole name"],
  "components/Attachments.tsx": [3, "file names on tiles and cards; the viewer shows the whole name"],
  "components/VideoMedia.tsx": [1, "a file name on a video tile"],
  "app/share.tsx": [2, "a shared link and file names on tiles"],
  "components/MediaGallery.tsx": [4, "the media viewer's dark canvas"],
  "components/WebTabBar.tsx": [1, "tab labels are one short word"],
  "lib/typing.tsx": [1, "the line that says who is typing"],
};

test("a line limit is only for a listed preview", () => {
  const over: string[] = [];
  for (const file of files) {
    const count = (fs.readFileSync(path.join(root, file), "utf8").match(/\bnumberOfLines=/g) ?? []).length;
    const allowed = PREVIEWS[file]?.[0] ?? 0;
    if (count > allowed) over.push(`${file}: ${count} line limits, ${allowed} allowed. Let the text wrap, or list the preview here with its reason.`);
  }
  assert.deepEqual(over, []);
});

test("the list has no stale entries", () => {
  for (const [file, [allowed]] of Object.entries(PREVIEWS)) {
    assert.ok(files.includes(file), `${file} exists`);
    const count = (fs.readFileSync(path.join(root, file), "utf8").match(/\bnumberOfLines=/g) ?? []).length;
    assert.equal(count, allowed, `${file} has ${count} line limits; the list says ${allowed}. Lower the number when one is removed.`);
  }
});
