// What a person types into search, taken apart: the words to find and the filters that narrow where.
//   in:#general      only that channel (the name, with or without #, or a conversation's id)
//   from:@Jo-Park    only what that person wrote (their @name, first name, id, or "me")
//   has:link         only messages with a link        has:file   only messages with something attached
//   is:thread        only replies in threads and the messages they answer
// Everything else is words: a message must have all of them, the last one may be the start of a word, and
// "words in quotes" must appear together. Words are matched whole and by their stem (renewal finds renewals),
// through SQLite's own full-text index, so the server stays without dependencies.

const FILTER = /^(in|from|has|is):(.+)$/i;

export function parseSearch(input) {
  const filters = { in: null, from: null, link: false, file: false, thread: false };
  const terms = [];
  // Keep quoted phrases whole; split the rest on spaces.
  for (const match of String(input ?? "").normalize("NFKC").matchAll(/"([^"]*)"|(\S+)/g)) {
    if (match[1] !== undefined) { if (match[1].trim()) terms.push({ text: match[1].trim(), phrase: true }); continue; }
    const filter = FILTER.exec(match[2]);
    const value = filter?.[2].toLowerCase();
    if (filter && filter[1].toLowerCase() === "in") filters.in = filter[2].replace(/^#/, "");
    else if (filter && filter[1].toLowerCase() === "from") filters.from = filter[2].replace(/^@/, "");
    else if (filter && filter[1].toLowerCase() === "has" && ["link", "links"].includes(value)) filters.link = true;
    else if (filter && filter[1].toLowerCase() === "has" && ["file", "files", "attachment", "attachments"].includes(value)) filters.file = true;
    else if (filter && filter[1].toLowerCase() === "is" && ["thread", "threads"].includes(value)) filters.thread = true;
    else terms.push({ text: match[2], phrase: false });
  }
  return { filters, terms, words: terms.map(term => term.text).join(" ").trim(), filtered: !!(filters.in || filters.from || filters.link || filters.file || filters.thread) };
}

// The words as a full-text query. Each becomes a quoted string, so nothing a person types is read as an
// operator; what the index does not treat as a word (punctuation alone) is dropped.
export function ftsQuery(terms) {
  const parts = [];
  terms.forEach((term, index) => {
    const tokens = term.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
    if (!tokens) return;
    const last = index === terms.length - 1 && !term.phrase;
    if (term.phrase) parts.push(`"${tokens.join(" ")}"`);
    else tokens.forEach((token, i) => parts.push(`"${token}"${last && i === tokens.length - 1 ? "*" : ""}`));
  });
  return parts.length ? parts.join(" ") : null;
}

// The index: every message's text, kept in step by the database itself. Triggers run inside whatever
// transaction changes a message, so an edit or a delete can never leave the index showing the old words.
export const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_search USING fts5(text, content='messages', content_rowid='seq', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_search(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_search(messages_search, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_search(messages_search, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO messages_search(rowid, text) VALUES (new.seq, new.text);
END;
`;
