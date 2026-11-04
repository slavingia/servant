// Slack-style commands typed in the message box: "/invite @maya", "/rename refund-desk".
// The list shows while you type a "/" at the very start; Send runs the command instead of posting it.

export type SlashCommand = { name: string; args: string; hint: string; description: string; channelOnly?: boolean };

export const SLASH_COMMANDS: Omit<SlashCommand, "args">[] = [
  { name: "invite", hint: "@person …", description: "Add people to this channel", channelOnly: true },
  { name: "rename", hint: "new-name", description: "Rename this channel", channelOnly: true },
  { name: "leave", hint: "", description: "Leave this channel", channelOnly: true },
  { name: "call", hint: "", description: "Start a call here (or join the one running)" },
  { name: "agent", hint: "question", description: "Ask the agent about this conversation" },
  { name: "dm", hint: "@person message", description: "Send someone a direct message" },
  { name: "files", hint: "", description: "Everything shared here" },
  { name: "shrug", hint: "message", description: "Add ¯\\_(ツ)_/¯ to your message" },
  { name: "me", hint: "action", description: "Post in italics, like \"is out today\"" },
];

/** The commands that match what's typed so far ("/" alone lists them all), or null when not typing one. */
export function slashMatches(text: string, isChannel: boolean) {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return null;
  const q = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter(c => (isChannel || !c.channelOnly) && c.name.startsWith(q));
}

/** A full command ready to run, or null for ordinary text (including "/path/like/this" and "//"). */
export function parseSlash(text: string, isChannel: boolean): SlashCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const def = SLASH_COMMANDS.find(c => c.name === m[1]!.toLowerCase());
  if (!def || (def.channelOnly && !isChannel)) return null;
  return { ...def, args: (m[2] ?? "").trim() };
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
