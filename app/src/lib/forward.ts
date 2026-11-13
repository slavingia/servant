// Messages forwarded to an agent chat arrive as text the server wrote:
//
//   Forwarded message from Ann Lee (#general · Nov 2, 2026, 8:02 PM):
//   > quoted line
//   > [Attachment not sent to the agent: notes.pdf]
//
//   the person's own question
//
// The agent reads that plainly; the app turns it back into a card.

export type ForwardCard = { author: string; where: string; when: string; quote: string };
export type ParsedForward = { forward: ForwardCard; rest: string };

const HEADER = /^Forwarded message from (.+) \(([^()·]*) · ([^()·]*)\):$/;

export function parseForward(text: string | null | undefined): ParsedForward | null {
  if (!text) return null;
  const lines = text.split("\n");
  const header = HEADER.exec(lines[0] ?? "");
  if (!header) return null;
  const quoted: string[] = [];
  let i = 1;
  for (; i < lines.length && lines[i]!.startsWith(">"); i++) quoted.push(lines[i]!.replace(/^> ?/, ""));
  if (!quoted.length) return null;
  const quote = quoted.join("\n") === "[No text]" ? "" : quoted.join("\n");
  return { forward: { author: header[1]!, where: header[2]!, when: header[3]!, quote }, rest: lines.slice(i).join("\n").trim() };
}

// Title for a new chat started from a forward, before the server names it.
export function forwardTitle(quote: string) {
  const first = quote.split("\n").find(line => line.trim()) ?? "a message";
  return `About: ${first}`.replace(/\s+/g, " ").slice(0, 60);
}
