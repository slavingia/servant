// Agent chats work like issues: the agent closes one when it has finished and
// nothing waits on the person. It says so with a hidden last line that the
// app never shows. The instruction text is fixed so the prompt cache holds.
export const CLOSE_OPEN = '<servant-done>';
const CLOSE_END = '</servant-done>';

export const CLOSE_INSTRUCTIONS = [
  'Servant chat lifecycle: each conversation works like an issue.',
  `When you have fully finished what the person asked and nothing is waiting on them (no question for them, no decision they owe, no follow-up you promised), end your final reply with one last line exactly like ${CLOSE_OPEN}a short sentence saying what was done${CLOSE_END}.`,
  'The app hides that line and files the conversation as closed. Their next message reopens it.',
  'Never add it when you asked them something, need their input or approval, are still working, or only part of the request is done.',
].join(' ');

const cleanReason = raw => {
  const reason = String(raw || '').split(CLOSE_END)[0].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return reason || 'Done';
};

// Whole text: { text without the marker, reason or null }.
// A chat's own instructions (project, vibe coding) come first; the closing rule
// rides after them. Both are fixed per chat, so the prompt cache still holds.
export function withCloseInstructions(chatText = '') {
  return chatText ? `${chatText}\n\n${CLOSE_INSTRUCTIONS}` : CLOSE_INSTRUCTIONS;
}

export function splitCloseMarker(text) {
  if (typeof text !== 'string') return { text, reason: null };
  const at = text.indexOf(CLOSE_OPEN);
  if (at < 0) return { text, reason: null };
  return { text: text.slice(0, at).replace(/\s+$/, ''), reason: cleanReason(text.slice(at + CLOSE_OPEN.length)) };
}

// Streaming: holds back anything that could be the start of the marker and
// drops everything from the marker on. filter.reason() reports what it saw.
export function createCloseMarkerFilter() {
  let pending = '', captured = null;
  const filter = (chunk = '', final = false) => {
    if (captured !== null) { captured += chunk; return ''; }
    pending += chunk;
    const at = pending.indexOf(CLOSE_OPEN);
    if (at >= 0) {
      captured = pending.slice(at + CLOSE_OPEN.length);
      const out = pending.slice(0, at).replace(/\s+$/, '');
      pending = '';
      return out;
    }
    if (final) { const out = pending; pending = ''; return out; }
    let keep = 0;
    for (let n = Math.min(CLOSE_OPEN.length - 1, pending.length); n > 0; n--) {
      if (CLOSE_OPEN.startsWith(pending.slice(-n))) { keep = n; break; }
    }
    // Trailing whitespace waits too, so a closed reply doesn't stream a blank
    // last line that the saved copy won't have.
    let cut = pending.length - keep;
    while (cut > 0 && /\s/.test(pending[cut - 1])) cut--;
    const out = pending.slice(0, cut);
    pending = pending.slice(cut);
    return out;
  };
  filter.reason = () => captured === null ? null : cleanReason(captured);
  return filter;
}
