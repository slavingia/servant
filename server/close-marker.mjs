// Conversations are no longer closed automatically: only the person archives one. Older agent
// sessions may still end a reply with the hidden "done" line they were once told to add, so it is
// stripped and never shown.
export const CLOSE_OPEN = '<servant-done>';

// Whole text without the marker.
export function stripCloseMarker(text) {
  if (typeof text !== 'string') return text;
  const at = text.indexOf(CLOSE_OPEN);
  return at < 0 ? text : text.slice(0, at).replace(/\s+$/, '');
}

// Streaming: holds back anything that could be the start of the marker and
// drops everything from the marker on. filter.reason() reports what it saw.
export function createCloseMarkerFilter() {
  let pending = '', captured = false;
  const filter = (chunk = '', final = false) => {
    if (captured) return '';
    pending += chunk;
    const at = pending.indexOf(CLOSE_OPEN);
    if (at >= 0) {
      captured = true;
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
  return filter;
}
