// A small, deliberately literal Markdown subset for agent messages. No HTML and
// no remote images: an image becomes a plain link, and only web and mail links
// are tappable. Attachments keep their authenticated media path.
export type Inline = { text: string; strong?: boolean; em?: boolean; code?: boolean; strike?: boolean; url?: string };
export type Block =
  | { kind: 'paragraph' | 'quote'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; text: string; marker: string; depth: number; checked?: boolean }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'table'; header: string[]; rows: string[][]; align: ('left' | 'center' | 'right')[] }
  | { kind: 'rule' };

type Style = Omit<Inline, 'text'>;

// In-app links the server writes (an agent chat opened for a @s request) are allowed too.
const SAFE_URL = /^(https?:\/\/|mailto:|\/chat\/cht_[\w-]+$)[^\s<>"]*$/i;
export function safeUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/^<(.*)>$/, '$1');
  return SAFE_URL.test(trimmed) ? trimmed : undefined;
}

const unescape = (text: string) => text.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');

// Order matters: code wins over everything, links over emphasis.
const INLINE = new RegExp([
  /(`+)([^`\n]+?)\1/.source,                                   // 1,2 code
  /!?\[((?:[^\][\n]|\[[^\][\n]*\])+)\]\s{0,3}\(\s*<?([^()\s<>]+(?:\([^()\s]*\)[^()\s<>]*)*)>?(?:\s+"[^"\n]*")?\s*\)/.source, // 3,4 link or image
  /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~])/.source,      // 5 bare url
  /\*\*(?=\S)([^\n]*?\S)\*\*/.source,                          // 6 strong
  /(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/.source,           // 7 strong
  /~~(?=\S)([^~\n]*?\S)~~/.source,                             // 8 strike
  /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/.source,  // 9 em
  /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/.source,    // 10 em
].join('|'), 'g');

function parse(text: string, style: Style, out: Inline[]) {
  let start = 0;
  const plain = (s: string) => { if (s) out.push({ ...style, text: unescape(s) }); };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    // A backslash-escaped marker stays literal.
    if (at > 0 && text[at - 1] === '\\' && !m[2]) continue;
    if (m[3] !== undefined) {
      const url = safeUrl(m[4]!);
      if (!url) continue; // javascript: and friends stay as typed
      // Models sometimes write "[title] (/chat/cht_x)"; forgive the space for in-app links only.
      if (/\]\s+\(/.test(m[0]) && !url.startsWith('/chat/')) continue;
      plain(text.slice(start, at));
      parse(m[3], { ...style, url }, out);
    } else {
      plain(text.slice(start, at));
      if (m[2] !== undefined) out.push({ ...style, code: true, text: m[2] });
      else if (m[5] !== undefined) out.push({ ...style, url: style.url ?? m[5], text: m[5] });
      else if (m[6] !== undefined || m[7] !== undefined) parse(m[6] ?? m[7]!, { ...style, strong: true }, out);
      else if (m[8] !== undefined) parse(m[8], { ...style, strike: true }, out);
      else parse(m[9] ?? m[10]!, { ...style, em: true }, out);
    }
    start = at + m[0].length;
  }
  plain(text.slice(start));
}

export function inlineMessage(text: string): Inline[] {
  const out: Inline[] = [];
  parse(text, {}, out);
  // Merge neighbours with identical styling so screen readers get whole phrases.
  return out.reduce<Inline[]>((acc, part) => {
    const prev = acc[acc.length - 1];
    if (prev && !part.code && !prev.code && sameStyle(prev, part)) prev.text += part.text;
    else acc.push({ ...part });
    return acc;
  }, []);
}

const sameStyle = (a: Inline, b: Inline) => !!a.strong === !!b.strong && !!a.em === !!b.em && !!a.strike === !!b.strike && a.url === b.url;

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

export function messageBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let listIndents: number[] = [];
  const flush = () => { if (paragraph.length) { blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})([^\s`]*)[^`]*$/.exec(line);
    if (fence) {
      flush(); listIndents = [];
      const code: string[] = [];
      const indent = /^\s*/.exec(line)![0].length;
      const close = new RegExp(`^\\s*${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i]!)) code.push(lines[i]!.slice(Math.min(indent, /^\s*/.exec(lines[i]!)![0].length)));
      blocks.push({ kind: 'code', text: code.join('\n'), language: fence[2] ?? '' });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = cells(line);
      const align = cells(lines[i + 1]!).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' as const : c.endsWith(':') ? 'right' as const : 'left' as const);
      if (align.length === header.length || lines[i + 1]!.includes('|')) {
        flush(); listIndents = [];
        const rows: string[][] = [];
        i += 1;
        while (i + 1 < lines.length && lines[i + 1]!.includes('|') && lines[i + 1]!.trim()) rows.push(cells(lines[++i]!));
        const width = Math.max(header.length, ...rows.map(r => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')].slice(0, width);
        blocks.push({ kind: 'table', header: pad(header), rows: rows.map(pad), align: pad(align as string[]).map(a => (a || 'left') as 'left') });
        continue;
      }
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); listIndents = []; blocks.push({ kind: 'rule' }); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    const list = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (heading) { flush(); listIndents = []; blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! }); continue; }
    if (list && list[3]!.trim()) {
      flush();
      const indent = list[1]!.replace(/\t/g, '    ').length;
      while (listIndents.length && listIndents[listIndents.length - 1]! > indent) listIndents.pop();
      if (!listIndents.length || listIndents[listIndents.length - 1]! < indent) listIndents.push(indent);
      const depth = Math.min(listIndents.length - 1, 3);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(list[3]!);
      const ordered = /^\d/.test(list[2]!);
      blocks.push({
        kind: 'list', depth, text: task ? task[2]! : list[3]!,
        marker: ordered ? list[2]!.replace(')', '.') : ['•', '◦', '▪', '▪'][depth]!,
        ...(task ? { checked: task[1] !== ' ' } : {}),
      });
      continue;
    }
    if (quote) {
      flush(); listIndents = [];
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'quote' && i > 0 && /^\s{0,3}>/.test(lines[i - 1]!)) prev.text += '\n' + quote[1]!;
      else blocks.push({ kind: 'quote', text: quote[1]! });
      continue;
    }
    // An indented line right under a list item continues that item.
    const prev = blocks[blocks.length - 1];
    if (!paragraph.length && prev?.kind === 'list' && /^\s{2,}\S/.test(line) && i > 0 && lines[i - 1]!.trim()) { prev.text += '\n' + line.trim(); continue; }
    listIndents = [];
    paragraph.push(line);
  }
  flush();
  return blocks;
}
