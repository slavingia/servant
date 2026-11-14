// Opening an agent chat used to wait twice: a blank screen while the app asked the server whose chat it was,
// then a loading screen while it asked for the messages. From your own list the app already knows whose chat it
// is; anywhere else it asks, and asks for the messages in the same moment. A chat that was open before shows
// what it showed then while the fresh copy loads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const screen = read("app/chat/[id].tsx");
const cache = read("lib/chat-cache.ts");

test("a chat's screen is not held back by asking whose chat it is", () => {
  const opener = screen.slice(screen.indexOf("export default function ChatScreen()"), screen.indexOf("function SharedChatView()"));
  // The row says, or the last visit does; only then is the server asked.
  assert.match(opener, /const theirs = readOnly === "1" \? true : mine === "1" \? false : remembered \? !!remembered\.readOnly : answer\?\.key === key \? answer\.theirs : null;/);
  assert.match(opener, /if \(theirs !== null \|\| !account \|\| !id\) return;/, "nothing is asked when it is known");
  // When it must ask, the messages are asked for at the same time, not after the answer.
  assert.match(opener, /chatLoad\(account, String\(id\)\)\.info\.then\(/);
  assert.doesNotMatch(opener, /api\.chat\(/);
  // And the wait shows the chat's own loading rows, not an empty screen.
  assert.doesNotMatch(opener, /if \(theirs === null\) return null;/);
  assert.match(opener, /if \(theirs === null\) return <View style=\{styles\.root\}><SkeletonRows label="Loading messages"/);
});

test("everything a chat needs is asked for at once, and the screen's first load takes those requests", () => {
  assert.match(cache, /const load = \{ info: api\.chat\(account, id\), messages: api\.messages\(account, id\), turns: readOnly \? Promise\.resolve\(\[\]\) : chatTurns\(account, id\) \};/);
  const conversation = screen.slice(screen.indexOf("function ChatConversation("));
  assert.match(conversation, /const first = takeChatLoad\(account, id\);\n\s+return Promise\.all\(\[first\?\.messages \?\? api\.messages\(account, id\), first\?\.turns \?\? chatTurns\(account, id\)\]\)/);
  assert.match(conversation, /\(peekChatLoad\(account, id\)\?\.info \?\? api\.chat\(account, id\)\)\.then\(/, "the chat's settings come from the same request");
  const shared = screen.slice(screen.indexOf("function SharedChatView()"), screen.indexOf("function ChatConversation("));
  assert.match(shared, /const first = takeChatLoad\(account, id\);/);
});

test("your own list opens a chat as yours and starts its requests at the press", () => {
  const tab = read("app/(tabs)/agent.tsx");
  const open = tab.slice(tab.indexOf("const openChat = "), tab.indexOf("const act = async"));
  assert.ok(open.indexOf("openingChat(account, chat.id, chat.readOnly === true);") < open.indexOf("router.push("), "the requests leave before navigating");
  // Yours unless the list itself says it is someone else's.
  assert.match(open, /\.\.\.\(chat\.readOnly \? \{ readOnly: "1", author: chat\.author\?\.name \?\? "" \} : \{ mine: "1" \}\)/);
  // Someone else's chat is opened read-only, without asking for turns it has no right to.
  assert.match(tab, /openingChat\(account, item\.id, true\);\n\s+router\.push\(\{ pathname: "\/chat\/\[id\]", params: \{ id: item\.id, title: item\.title, readOnly: "1"/);
});

test("a chat that was open before starts from what it showed, never from a reply still being written", () => {
  const conversation = screen.slice(screen.indexOf("function ChatConversation("));
  assert.match(conversation, /const \[kept\] = useState\(\(\) => keptChat\(account, String\(id\)\)\);/);
  assert.match(conversation, /useState<Row\[\] \| null>\(kept\?\.messages \?\? null\)/);
  assert.match(conversation, /useState<Map<string, AgentTurn>>\(\(\) => workByMessage\(kept\?\.turns \?\? \[\]\)\)/, "finished replies keep their Worked-for line");
  // The reply in progress and the waiting messages come from the server, not from memory.
  assert.match(conversation, /const \[turn, setTurn\] = useState<AgentTurn \| null>\(null\);/);
  assert.match(conversation, /const \[waiting, setWaiting\] = useState<AgentTurn\[\]>\(\[\]\);/);
  // Only what the server has confirmed is kept.
  assert.match(conversation, /if \(messages === null \|\| loadError \|\| !hasShown\.current \|\| messages\.some\(row => row\.localId \|\| row\.pending\)\) return;/);
  // A chat deleted because it was never used is not kept either.
  assert.match(conversation, /forgetChat\(a, String\(id\)\); void api\.deleteChat\(a, String\(id\)\)/);
  // A refresh that fails leaves the kept messages up instead of the error page, and says why above the message box.
  assert.match(conversation, /if \(hasShown\.current\) \{ setSendError\(e instanceof ServerError \? e\.message : "Check your connection and try again\."\); return; \}\n\s+setMessages\(\[\]\);/);
});

test("kept chats live in memory only", () => {
  assert.doesNotMatch(cache, /setItem|SecureStore|localStorage|AsyncStorage/);
  assert.match(cache, /createScreenCache<ChatSnapshot>\(30\)/);
});
