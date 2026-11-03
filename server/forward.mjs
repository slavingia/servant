// "Ask the agent" about a channel or DM message. The server, not the client,
// writes the "Forwarded message from …" header from the stored message, so the
// author and place can't be faked in a chat others may read. The app parses the
// same header back into a card (app/src/lib/forward.ts).
import { MAX_FILE, MAX_UPLOAD_TOTAL, MAX_VIDEO } from "./media.mjs";

const MAX_FILES = 4;
const isMedia = mime => /^(image|video)\//.test(mime);

export function forwardHeader({ author, where, at }, timeZone) {
  const when = new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  // Names can contain anything; keep the parenthesized place/time unambiguous.
  return `Forwarded message from ${String(author).replace(/[\r\n]+/g, " ")} (${where} · ${when}):`;
}

// Combines the person's own message with the forwarded one. Their own files
// come first; forwarded photos and videos follow while they fit the agent's
// limits. Anything left out is named in the quote so the agent knows.
export function composeForward({ text, attachments }, source, { timeZone } = {}) {
  const files = [...attachments];
  const skipped = [];
  let total = files.reduce((sum, a) => sum + a.data.length, 0);
  for (const f of source.files || []) {
    const size = f.data.length;
    const fits = isMedia(f.mime) && files.length < MAX_FILES && size <= (f.mime.startsWith("image/") ? MAX_FILE : MAX_VIDEO) && total + size <= MAX_UPLOAD_TOTAL;
    if (fits) { files.push({ name: f.name, mime: f.mime, data: Buffer.from(f.data) }); total += size; }
    else skipped.push(f.name);
  }
  const lines = String(source.text || "").split("\n").map(line => `> ${line}`);
  if (!source.text) lines.length = 0;
  for (const name of skipped) lines.push(`> [Attachment not sent to the agent: ${name}]`);
  if (!lines.length) lines.push("> [No text]");
  const quote = `${forwardHeader(source, timeZone)}\n${lines.join("\n")}`;
  return { text: text ? `${quote}\n\n${text}` : quote, attachments: files };
}
