// While the agent replies there is one control: the composer. A message sent then joins the reply (or waits,
// when it can't), a held Send or "/queue" waits on purpose, and with nothing typed the Send button is Stop.
// There was a red Stop button beside the live line and a Steer pill under every waiting message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const chat = read("app/chat/[id].tsx"), composer = read("components/Messaging.tsx"), steps = read("components/AgentSteps.tsx"), live = read("components/LiveStatus.tsx");

test("the chat draws no Stop or Steer button of its own", () => {
  assert.doesNotMatch(chat, /label="Stop"/);
  assert.doesNotMatch(chat, /label="Steer"|Steer:/);
  assert.doesNotMatch(chat, /api\.steerAgent\([^)]*\)[^\n]*onPress/, "steering is never a tap");
  // The composer is told when a reply is running and how to stop it; /stop still works for a keyboard.
  assert.match(chat, /holdToQueue=\{busy \|\| activeAgentTurn\(turn\)\}/);
  assert.match(chat, /onStop=\{stoppable \? \(\) => \{ void stop\(\); \} : undefined\}/);
  assert.match(chat, /case "stop":/);
});

test("a message sent mid-reply joins it when it can, and otherwise waits with a way to take it back", () => {
  assert.match(chat, /const join = !later && joinsReply\(turn, body, /);
  assert.match(chat, /if \(taken\.turn && join\) void joinReply\(taken\.turn, sure\);/);
  // A refusal is not an error to show: the message keeps its place.
  const joinReply = chat.slice(chat.indexOf("const joinReply = async"), chat.indexOf("const queue = async"));
  assert.doesNotMatch(joinReply, /setActionError|setSendError/);
  assert.match(chat, /queued\.steerRequested \? "Adding this to the current reply…" : "Sends after the current reply"/);
  assert.match(chat, /\{!queued\.steerRequested \? <IconButton icon="close" label="Remove waiting message"/, "only a message that is still waiting can be taken back");
});

test("Send says what holding it does, and becomes Stop when there is nothing to send", () => {
  assert.match(composer, /holdHint \? "Hold to queue" : /);
  assert.match(composer, /onLongPress=\{holdToQueue \? sendOnLongPress : undefined\}/, "a hold only means something while a reply is running");
  assert.match(composer, /void send\("queue"\);/);
  assert.match(composer, /canStop \? "Stop the agent"/);
  assert.match(composer, /const canStop = !!onStop && empty && !busy && !picking;/);
  // A screen reader gets the hold as an action, since it can't touch and hold.
  assert.match(composer, /accessibilityActions=\{holdHint \? \[\{ name: "longpress", label: "Send after the current reply" \}\] : undefined\}/);
  // "/queue …" is a message: it goes through the same send, abbreviations and all, marked to wait.
  assert.match(composer, /const later = commands\?\.agent && !onCancel \? queuedMessage\(body\) : null;/);
});

test("the working line is calm: plain steps, no clock, and it stands still for Reduce Motion", () => {
  assert.doesNotMatch(steps, /elapsed\(|tabular-nums/, "no stopwatch beside the steps");
  assert.match(steps, /const steps = readableSteps\(turn\?\.steps \?\? \[\]\);/);
  assert.match(steps, /aria-expanded=\{open\}/);
  assert.match(live, /if \(still \|\| !width\) return;/, "no moving light when motion is reduced");
  assert.match(live, /\{!still && width \? \(/);
  assert.match(live, /aria-live="polite" accessibilityLiveRegion="polite"/);
  assert.match(live, /AccessibilityInfo\.announceForAccessibility\(line\)/, "VoiceOver has no live regions, so the line is spoken");
});

test("one tap on Send is enough in an agent chat, as in a person's chat", () => {
  // The conversation list must not spend the first tap on closing the keyboard.
  const list = chat.slice(chat.indexOf("<FlatList"), chat.indexOf("renderItem={renderItem}"));
  assert.match(list, /keyboardShouldPersistTaps="handled"/);
  assert.match(list, /keyboardDismissMode="interactive"/);
  // Send's own box is the hit area: at least 44pt (the app avoids hitSlop).
  assert.match(composer, /send: \{ minHeight: 44, minWidth: 44,/);
});

test('a message the server holds as up next frees the composer, so the next one can be sent', () => {
  assert.match(chat, /else if \(e\.turn\.status === 'queued'\) onAccepted\(\);/);
});

// "About 17 min left" beside the line and a thin bar under it, in the chat and on the Agent tab's rows, when the
// server has an estimate (docs/agent-turns.md, "How long is left"). The rules for the numbers are tested in
// agent-turns.test.ts; these are the rules for how they are drawn.
test("how long is left is words and a bar with no number on it: a slow tick, still for Reduce Motion, silent as a percentage", () => {
  const bar = read("components/ReplyBar.tsx"), tab = read("app/(tabs)/agent.tsx"), clock = read("lib/use-now.ts");
  // The chat and the Agent tab ask the same function, so the two can't say different things.
  assert.match(steps, /const time = replyTime\(turn, now\);/);
  assert.match(tab, /return children\(estimated \? replyTime\(turn, now\) : null\);/);
  // The bar is there only while an estimate has time left on it: never before, and never sitting full afterwards.
  assert.match(steps, /const bar = time\.progress === null \? null : <ReplyBar progress=\{time\.progress\} paused=\{time\.paused\}/);
  assert.match(tab, /\{time && time\.progress !== null \? <ReplyBar progress=\{time\.progress\} paused=\{time\.paused\}/);
  // Nobody measured a percentage, so none is drawn or read out: a screen reader hears the words.
  assert.match(bar, /aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/);
  assert.doesNotMatch(bar, /progressbar|accessibilityValue|accessibilityLabel|<Text/);
  assert.match(steps, /\{time\.text \? <Text accessibilityLabel=\{time\.spoken\} style=\{styles\.since\}>· \{time\.text\}<\/Text> : null\}/);
  assert.match(steps, /accessibilityLabel=\{`\$\{line\}\$\{time\.spoken \? `, \$\{time\.spoken\}` : ""\}`\}/);
  assert.match(tab, /\$\{activeAgentTurn\(item\.latestTurn\) \? `\. \$\{turnLine\(item\.latestTurn!\)\}\$\{time\?\.spoken \? `, \$\{time\.spoken\}` : ""\}` : ""\}/, "the row's button says what its reply is doing and how long is left");
  // Still calm: the time is looked at every few seconds, only by a row that has an estimate, and nothing counts seconds.
  assert.match(steps, /const now = useNow\(5_000\);/);
  assert.match(tab, /const estimated = activeAgentTurn\(turn\) && typeof turn\?\.usualMs === "number";\n\s+const now = useNow\(estimated \? 5_000 : null\);/);
  assert.match(clock, /if \(!every\) return;/, "a row with nothing to estimate never ticks");
  assert.doesNotMatch(bar + clock, /tabular-nums|setInterval\([^)]*, 1_?000\)/);
  // Reduce Motion gets the same bar, placed without the glide. The glide runs natively on a phone.
  assert.match(bar, /const still = useReduceMotion\(\);/);
  assert.match(bar, /if \(still\) \{ at\.setValue\(progress\); return; \}/);
  assert.match(bar, /const native = Platform\.OS !== "web";/);
  assert.match(bar, /Animated\.timing\(at, \{ toValue: progress, duration: 600, easing: Easing\.out\(Easing\.quad\), useNativeDriver: native \}\)/);
});
