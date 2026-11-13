// Cases follow the app's design system (docs/design-system.md) instead of a look of their own. The list said
// "Cases" twice and put a card about the public link, a search label and two rows of look-alike pills above the
// first case, so a phone showed barely one. A case stacked its details, tabs, a visitor strip and an audience banner
// above the conversation in a wide window, and on a phone showed the reference twice and never the subject. Messages
// were left and right bubbles in an app whose conversations are a left-aligned author stream, and the follow-ups tab
// was called Tasks and kept its whole form above the list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESTINATIONS } from "./destinations.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const style = (source: string, name: string) => source.match(new RegExp(`\\b${name}: \\{([^{}]*)\\}`))?.[1] ?? "";
const list = read("app/inbox.tsx"), screen = read("app/inbox/[id].tsx"), panel = read("components/CaseMessagePanel.tsx");
const tasks = read("components/CaseTasks.tsx"), picker = read("components/CaseOwnerPicker.tsx");

test("the list starts with what to do, then the cases: no second title, no card, no look-alike filter rows", () => {
  assert.doesNotMatch(list, />Cases<\/Text>/, "the screen's header already says Cases");
  assert.doesNotMatch(list, /Let people reach your team/);
  assert.match(list, /<ButtonGroup>\s*<Button label="New case" compact /, "New case and Copy public link sit together");
  // Status divides the list like the tabs on Saved; which cases to show is one choice of four, so those are radios.
  assert.match(style(list, "tabs"), /backgroundColor: colors\.surface, borderRadius: radius\.md, padding: 3/);
  assert.match(list, /accessibilityRole="radiogroup" accessibilityLabel="Cases to show"/);
  assert.match(list, /accessibilityRole="radio" accessibilityLabel=\{item\.label\} accessibilityState=\{\{ checked: scope === item\.id \}\} aria-checked=\{scope === item\.id\}/);
  assert.match(style(list, "chip"), /minHeight: 44/);
  assert.match(style(list, "chips"), /flexWrap: "wrap"/, "all four are in view on a phone; none runs off the edge");
});

test("a case row is the person, the subject, the latest words, then where it stands", () => {
  assert.match(list, /<Avatar name=\{item\.name\} size=\{40\} \/>/, "the shared avatar, not one initial in a circle");
  assert.match(list, /\{item\.reference\} · \{item\.assigneeName \|\| "Unassigned"\}\{followUps\}/);
  assert.match(list, /item\.openTaskCount \? /, 'no "0 open follow-ups" on every row');
  assert.match(list, /inboxOverdue\(item\.nextAction\.dueDate\) && styles\.overdue/);
});

test("a wide window puts the case's details beside the conversation; a narrower one keeps the subject in view", () => {
  assert.match(screen, /const COLUMNS_MIN_WIDTH = 1100;/);
  assert.match(screen, /const columns = !mobile && width >= COLUMNS_MIN_WIDTH;/);
  assert.match(style(screen, "side"), /flexBasis: 320, width: 320, borderLeftWidth/, "the same panel a channel's Details uses");
  assert.match(screen, /\{columns \? <ScrollView style=\{styles\.side\}/);
  assert.match(screen, /styles\.compactSubject\}>\{conversation\.subject\}/, "the subject, not the reference a second time");
  assert.match(screen, /<Button label="Done" accessibilityLabel="Close case details" kind="secondary"/);
  assert.match(style(screen, "dialogTitle"), /paddingHorizontal: space\.side/, "the dialog's title lines up with what is under it");
});

test("the tabs are the app's segmented tabs, and the third is named for what it holds", () => {
  assert.match(screen, /\{ id: "tasks", label: "Follow-ups" \}/);
  assert.doesNotMatch(screen, /label: "Tasks"/);
  assert.match(style(screen, "tabs"), /backgroundColor: colors\.surface, borderRadius: radius\.md, padding: 3/);
  assert.doesNotMatch(screen, /borderBottomWidth: 2/, "not an underline of their own");
  assert.match(screen, /` · \$\{workspace\.openTaskCount\}`/, "a count is written like Chats · 1");
});

test("a case's conversation is the app's left-aligned author stream", () => {
  assert.match(panel, /<Avatar name=\{message\.senderName\} size=\{34\} \/>/);
  assert.match(panel, /\{staff \? "Team" : "Visitor"\}/, "who is speaking is said in words");
  assert.doesNotMatch(panel, /alignSelf: "flex-end"/, "no bubbles pushed to the right");
  assert.doesNotMatch(panel, /staffMessage|visitorMessage/);
});

test("follow-ups show the list first: adding one is a single line until you start", () => {
  assert.match(tasks, /const whole = !!task \|\| started \|\| !!text \|\| !!owner \|\| !!dueDate;/);
  assert.match(tasks, /onFocus=\{\(\) => setStarted\(true\)\}/);
  assert.match(tasks, /\{whole \? <>/);
  assert.match(style(tasks, "task"), /flexDirection: "row", flexWrap: "wrap"/, "Complete and Edit sit on the follow-up's line when there is room");
  assert.match(tasks, /!done && inboxOverdue\(task\.dueDate\) \? styles\.overdue/);
  assert.doesNotMatch(tasks, /Dates use UTC/, "said once, under the date");
});

test("choosing an owner is a field that opens a list, with a tick on the chosen one", () => {
  assert.match(picker, /<AppIcon name="chevronDown"/);
  assert.match(picker, /aria-expanded=\{open\}/);
  assert.match(picker, /\{value === person\.id \? <AppIcon name="check"/);
  assert.doesNotMatch(picker, /· Selected/);
  assert.match(picker, /people\.length > SEARCH_FROM \? <TextInput/, "a short list needs no search");
});

test("Cases is one place in the one list: the sidebar, You on a phone and search all read it", () => {
  const cases = DESTINATIONS.find(place => place.id === "inbox")!;
  assert.deepEqual({ label: cases.label, path: cases.path, group: cases.group, needs: cases.needs, sidebar: cases.sidebar, you: cases.you },
    { label: "Cases", path: "/inbox", group: "talk", needs: "secureInbox", sidebar: true, you: true });
  assert.match(read("app/(tabs)/you.tsx"), /destinationGroups\("you"/, "a phone has no sidebar, so You lists the places");
});

test("a case's details say whether the visitor is emailed, and call an address confirmed only when it is", () => {
  assert.match(screen, /\{inboxReplyEmailLine\(workspace\.notify\)\}/);
  assert.match(screen, /inboxContactConfirmed\(conversation\.email, workspace\.notify\) \? "Confirmed" : "Unverified"/);
});
