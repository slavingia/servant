// Quoting a message: its words go into the reply field as a quote ("> " lines, which messages show as a quote),
// ahead of whatever was already typed, ready for the answer underneath.

const MAX = 500;

/** A message's words as quote lines. Long messages are cut; a quote inside the message is not quoted again. */
export function quoteOf(text: string) {
  const own = text.split("\n").filter(line => !/^\s*>/.test(line)).join("\n").trim();
  const cut = own.length > MAX ? own.slice(0, MAX - 1).trimEnd() + "…" : own;
  return cut ? cut.split("\n").map(line => (line ? `> ${line}` : ">")).join("\n") : "";
}

/** The reply field's text after quoting: the quote, a blank line, then what was there. */
export function withQuote(draft: string, text: string) {
  const quote = quoteOf(text);
  return quote ? `${quote}\n\n${draft.replace(/^\s+/, "")}` : draft;
}
