// A small, deliberately literal Markdown subset for messages. No HTML, remote
// images or executable links: attachments keep their authenticated media path.
export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };
export type Block = { kind: 'paragraph' | 'heading' | 'quote' | 'list'; text: string; marker?: string }
  | { kind: 'code'; text: string; language: string };

export function inlineMessage(text: string): Inline[] {
  const result: Inline[] = [];
  const pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?!\*)|(?<![\w_])_([^_\n]+)_(?!\w)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > start) result.push({ kind: 'text', text: text.slice(start, match.index) });
    result.push({ kind: match[2] ? 'code' : match[3] || match[4] ? 'strong' : 'em', text: match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6]! });
    start = match.index! + match[0].length;
  }
  if (start < text.length) result.push({ kind: 'text', text: text.slice(start) });
  return result;
}

export function messageBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})([^\s`]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      const close = new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i]!)) code.push(lines[i]!);
      blocks.push({ kind: 'code', text: code.join('\n'), language: fence[2] ?? '' });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    const list = /^\s{0,12}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (heading || list || quote) {
      flush();
      if (heading) blocks.push({ kind: 'heading', text: heading[1]! });
      else if (list) blocks.push({ kind: 'list', marker: /^\d/.test(list[1]!) ? list[1]! : '•', text: list[2]! });
      else blocks.push({ kind: 'quote', text: quote![1]! });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}
