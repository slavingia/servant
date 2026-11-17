// Slack-style commands typed in the message box: "/invite @maya", "/rename refund-desk".
// The list shows while you type a "/" at the very start; Send runs the command instead of posting it.

// Where a command works. Each one says so itself, so adding a command never needs another list edited.
//   channel = a channel only, talk = channels and direct messages, agent = a chat with the agent, any = all of them.
import { ALL_FEATURES, type FeatureName, type Features } from "./features.ts";

export type SlashWhere = "channel" | "talk" | "agent" | "any";
// `needs`: a server feature (features.ts) the command is pointless without; the command hides when it's off.
export type SlashCommand = { name: string; args: string; hint: string; description: string; where: SlashWhere; needs?: FeatureName };

export const SLASH_COMMANDS: Omit<SlashCommand, "args">[] = [
  { name: "invite", hint: "@person …", description: "Add people to this channel", where: "channel" },
  { name: "rename", hint: "new-name", description: "Rename this channel", where: "channel" },
  { name: "leave", hint: "", description: "Leave this channel", where: "channel" },
  { name: "mute", hint: "", description: "Mute or unmute this for you. Only @mentions of you notify", where: "talk" },
  { name: "call", hint: "", description: "Start a call here (or join the one running)", where: "talk", needs: "meetings" },
  { name: "agent", hint: "question", description: "Ask the agent about this conversation", where: "talk" },
  { name: "dm", hint: "@person message", description: "Send someone a direct message", where: "talk", needs: "directMessages" },
  { name: "files", hint: "", description: "Everything shared here", where: "talk" },
  { name: "shrug", hint: "message", description: "Add ¯\\_(ツ)_/¯ to your message", where: "talk" },
  { name: "me", hint: "action", description: "Post in italics, like \"is out today\"", where: "talk" },
  // Added with the agent-chat commands (11/6). None of these needs the server to learn anything new.
  { name: "archive", hint: "", description: "Archive this for you. Find it again under Archived", where: "any" },
  { name: "new", hint: "", description: "Start a new message to someone", where: "any", needs: "directMessages" },
  { name: "browse", hint: "", description: "Find channels to join", where: "any", needs: "channels" },
  { name: "people", hint: "", description: "See everyone on the server", where: "any", needs: "people" },
  { name: "stop", hint: "", description: "Stop the agent's current reply", where: "agent" },
  { name: "rename", hint: "new name", description: "Rename this chat. The agent stops naming it for you", where: "agent" },
  // A message sent while the agent replies joins that reply. This one waits for it to finish instead.
  { name: "queue", hint: "message", description: "Send it after the current reply, not into it", where: "agent" },
  // About Servant itself, from wherever you are typing (slash-feedback.ts). Only the words after it are sent.
  { name: "feedback", hint: "what to fix or add", description: "Tell the Servant team what to fix or add", where: "any" },
  { name: "help", hint: "", description: "Show what these commands do", where: "any" },
];

const allowedHere = (c: Omit<SlashCommand, "args">, isChannel: boolean, agent: boolean, features: Features) =>
  (!c.needs || features[c.needs]) && (c.where === "any" || (agent ? c.where === "agent" : c.where === "talk" || (c.where === "channel" && isChannel)));

/** The commands that match what's typed so far ("/" alone lists them all), or null when not typing one. */
export function slashMatches(text: string, isChannel: boolean, agent = false, features: Features = ALL_FEATURES) {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return null;
  const q = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter(c => allowedHere(c, isChannel, agent, features) && c.name.startsWith(q));
}

/** A full command ready to run, or null for ordinary text (including "/path/like/this" and "//"). */
export function parseSlash(text: string, isChannel: boolean, agent = false, features: Features = ALL_FEATURES): SlashCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  // Some names mean different things in different places (/rename a channel, /rename an agent chat).
  const def = SLASH_COMMANDS.find(c => c.name === m[1]!.toLowerCase() && allowedHere(c, isChannel, agent, features));
  if (!def) return null;
  return { ...def, args: (m[2] ?? "").trim() };
}

/** "/queue fix the title" is a message, not something to run: the text to send once the current reply is done.
 *  "" when nothing follows the command, null when the text isn't that command at all. */
export function queuedMessage(text: string): string | null {
  const m = /^\/queue(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

/** The /help answer: one line per command that works in this kind of conversation. */
export function helpText(isChannel: boolean, agent = false, features: Features = ALL_FEATURES): string {
  return SLASH_COMMANDS.filter(c => allowedHere(c, isChannel, agent, features))
    .map(c => `/${c.name}${c.hint ? " " + c.hint : ""} — ${c.description}`).join("\n");
}

/** People named in a command: "@maya-ortiz", "@Maya", "maya". Returns matches and anything unknown. */
export function resolvePeople<P extends { id: string; name: string }>(args: string, people: P[]) {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/[\s_-]+/g, "-");
  const found: P[] = [], unknown: string[] = [];
  for (const raw of args.split(/[\s,]+/).filter(Boolean)) {
    const key = fold(raw.replace(/^@/, ""));
    const exact = people.filter(p => fold(p.name) === key);
    const first = people.filter(p => fold(p.name).split("-")[0] === key);
    const hit = exact.length === 1 ? exact[0] : first.length === 1 ? first[0] : undefined;
    if (hit) { if (!found.includes(hit)) found.push(hit); } else unknown.push(raw);
  }
  return { found, unknown };
}

/** /dm @maya hello → the person part and the message part. */
export function splitDm(args: string) {
  const m = /^(@\S+)\s*([\s\S]*)$/.exec(args.trim());
  return m ? { who: m[1]!, message: m[2]!.trim() } : { who: args.trim(), message: "" };
}
