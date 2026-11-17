import crypto from 'node:crypto';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The page follows docs/design-system.md, like the other public pages: the app's palette (theme-colors.ts) in light
// and dark, system type in its roles (28/34 title, 18/24 heading, 15/22 body, 13/18 labels and hints), 6-pixel
// buttons and 10-pixel fields at 48 points, underlined links and no decoration. Text fields use 16 pixels so iOS
// does not zoom the page on focus. A conversation reads top to bottom as author, time and words, as it does in the app.
const PAGE_STYLE = `:root{color-scheme:light dark;--background:#FFFFFF;--surface:#F7F8FA;--ink:#1D1C1D;--muted:#5B616B;--line:#E6E7EB;--borderStrong:#8B929B;--blue:#0071BC;--blueSoft:#E8F2FC;--primary:#0071BC;--onPrimary:#FFFFFF;--red:#D11242;--redSoft:#FDECEF}
@media (prefers-color-scheme:dark){:root{--background:#12161C;--surface:#1B222C;--ink:#F0F3F7;--muted:#ADB8C7;--line:#303945;--borderStrong:#748397;--blue:#80C7FF;--blueSoft:#19344D;--red:#FF8FA5;--redSoft:#3D202B}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{font:15px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--background);-webkit-text-size-adjust:100%}
body{margin:0}
main{max-width:712px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:28px;line-height:34px;letter-spacing:-.5px;margin:0 0 8px;overflow-wrap:anywhere}
h2{font-size:18px;line-height:24px;letter-spacing:-.15px;margin:0;overflow-wrap:anywhere}
p{margin:0 0 16px}
.lead{color:var(--muted);margin:0 0 24px}
button,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.field{margin:0 0 16px}
label{display:block;font-size:13px;line-height:18px;font-weight:600;margin:0 0 4px}
.hint{font-size:13px;line-height:18px;color:var(--muted);margin:4px 0 0}
.small{font-size:13px;line-height:18px;color:var(--muted);margin:0}
input,textarea{display:block;width:100%;min-height:48px;padding:12px 16px;border:1px solid var(--borderStrong);border-radius:10px;background:var(--background);font-size:16px;line-height:24px}
textarea{resize:vertical;min-height:120px;overflow-wrap:anywhere}
input[type=file]{padding:10px 12px;font-size:15px;line-height:26px}
::placeholder{color:var(--muted);opacity:1}
button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 16px;border:1px solid transparent;border-radius:6px;background:var(--primary);color:var(--onPrimary);font-size:15px;line-height:22px;font-weight:600;text-align:center;cursor:pointer}
button:disabled{background:var(--line);color:var(--muted);cursor:default}
.secondary{background:var(--background);border-color:var(--borderStrong);color:var(--ink)}
.danger{background:var(--background);border-color:var(--red);color:var(--red)}
.secondary:disabled,.danger:disabled,.download:disabled{background:var(--background);opacity:.5}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 16px}
.alert{border-radius:10px;padding:12px 16px;margin:0 0 16px;background:var(--redSoft);color:var(--red)}
.notice{border-radius:10px;padding:12px 16px;margin:0 0 16px;background:var(--blueSoft)}
.notice .small{color:var(--ink);margin:4px 0 12px}
.notice .actions{margin:0}
.notice .field{margin:0 0 12px}
.notice strong{display:block}
.code{max-width:200px}
.link{padding:12px 0;background:none;color:var(--blue);text-decoration:underline;text-underline-offset:3px}
.link:disabled{background:none;color:var(--blue);opacity:.5}
.links{gap:0 24px}
.return{margin-top:24px}
.thread-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px;margin:0 0 4px}
.status{font-size:13px;line-height:18px;font-weight:600;background:var(--blueSoft);border-radius:999px;padding:4px 12px;white-space:nowrap}
.messages{max-height:55vh;min-height:120px;overflow:auto;margin:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.message{padding:12px 0}
.message+.message{border-top:1px solid var(--line)}
.by{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0 0 4px}
.by strong{font-weight:600}
.by time{font-size:12px;line-height:16px;color:var(--muted)}
.body{white-space:pre-wrap;overflow-wrap:anywhere}
.download{margin-top:8px;max-width:100%;background:var(--background);border-color:var(--line);color:var(--blue);text-decoration:underline;text-underline-offset:3px;text-align:left;overflow-wrap:anywhere}
footer{margin-top:32px;font-size:13px;line-height:18px;color:var(--muted)}
@media (min-width:640px){.form-grid{display:grid;grid-template-columns:1fr 1fr;column-gap:16px}.wide{grid-column:1/-1}}`;

// Public visitors trust this owner-hosted HTTPS page on first use, then pin its key.
// This is separate from (and does not change) the invited app's trust bootstrap.
// `notices`: the server can send email, so the page offers a reply email. Without it the page says so and
// offers only the return link.
export function secureInboxPage({ name = 'Servant', publicKey, notices = false }) {
  const point = crypto.ECDH.convertKey(publicKey, 'prime256v1', 'hex', 'hex', 'uncompressed');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Message ${escape(name)}</title>
<style>
${PAGE_STYLE}
</style><script src="/contact/inbox.js" defer></script></head>
<body data-server-key="${escape(publicKey)}" data-server-point="${escape(point)}" data-notices="${notices ? '1' : '0'}"><main>
<div id="error" class="alert" role="alert" hidden></div><div id="notice" class="notice" role="status" hidden></div>
<section id="start"><h1>Message ${escape(name)}</h1><p class="lead">${notices ? 'Send a message and files. Replies appear on this page, and we can email you when one arrives. You do not need an account.' : 'Send a message and files. Replies appear on this page, so come back to it. You do not need an account.'}</p><form id="start-form"><div class="form-grid">
<div class="field"><label for="name">Your name</label><input id="name" name="name" maxlength="80" autocomplete="name" required></div>
<div class="field"><label for="email">Email (optional)</label><input id="email" name="email" type="email" maxlength="254" autocomplete="email"><p class="hint">${notices ? 'To get an email when the team replies. The reply itself stays on this page.' : 'Contact information only. Replies stay in this chat.'}</p></div>
<div class="field wide"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="160" required></div>
<div class="field wide"><label for="message">Message</label><textarea id="message" name="message" maxlength="10000" placeholder="How can we help?"></textarea></div>
<div class="field wide"><label for="start-files">Attach files</label><input id="start-files" type="file" multiple><p class="hint">Up to 4 files. 5 MB each, 10 MB total.</p></div></div>
<div class="actions"><button id="start-button" type="submit">Start conversation</button></div></form></section>
<section id="thread" hidden><h1>Your conversation</h1><p class="lead">Replies appear here automatically while this page is open.</p>
<div id="alerts" class="notice" hidden><strong id="alerts-title"></strong><p id="alerts-text" class="small"></p>
<form id="alerts-email-form" hidden><div class="field"><label for="alerts-email">Email</label><input id="alerts-email" type="email" maxlength="254" autocomplete="email" required></div><div class="actions"><button id="alerts-send" type="submit">Send code</button><button id="alerts-cancel" class="link" type="button" hidden>Cancel</button></div></form>
<form id="alerts-code-form" hidden><div class="field"><label for="alerts-code">6-digit code</label><input id="alerts-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><div class="actions"><button id="alerts-confirm" type="submit">Confirm email</button></div><div class="actions links"><button id="alerts-resend" class="link" type="button">Send a new code</button><button id="alerts-change" class="link" type="button">Use a different email</button></div></form>
<div id="alerts-on" class="actions" hidden><button id="alerts-stop" class="link" type="button">Stop emails</button></div></div><div class="thread-head"><div><h2 id="subject-title"></h2><p id="contact-name" class="small"></p></div><span id="status" class="status"></span></div><p id="connection" class="small" role="status">Connecting…</p>
<button id="older" class="secondary" type="button" hidden>Load more messages</button><div id="messages" class="messages" role="log" aria-label="Conversation messages" aria-live="polite"></div>
<form id="reply-form"><div class="field"><label for="reply">Reply</label><textarea id="reply" maxlength="10000" placeholder="Write a reply…"></textarea></div><div class="field"><label for="reply-files">Attach files</label><input id="reply-files" type="file" multiple><p class="hint">Up to 4 files. 5 MB each, 10 MB total.</p></div><div class="actions"><button id="send" type="submit">Send reply</button></div></form>
<div class="notice return"><strong>Keep your return link private.</strong><p id="return-note" class="small">Anyone with this link can read and reply to this conversation. Save it to return from another device. There are no email notifications.</p><div class="actions"><button id="copy" class="secondary" type="button">Copy return link</button><button id="leave" class="danger" type="button">Leave this device</button></div><input id="return-link" aria-label="Private return link" readonly hidden></div></section>
<footer>Messages and files are encrypted in transit to this server. Our team can read this conversation. Only share files you intend to send to the team.</footer><noscript><p>Enable JavaScript to start an encrypted conversation.</p></noscript></main></body></html>`;
}

// Kept dependency-free: the browser uses Web Crypto and the existing authenticated
// servant-tunnel-v1 wire format. No plaintext API fallback or external resources.
async function inboxBrowser() {
  const $ = id => document.getElementById(id);
  const error = value => { $('error').textContent = value; $('error').hidden = !value; };
  const notice = value => { $('notice').textContent = value; $('notice').hidden = !value; };
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { notice('This browser cannot save your conversation. Copy your return link before leaving.'); } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* Nothing persisted. */ } },
  };
  const SESSION = 'servant.inbox.session.v1';
  const PIN = 'servant.inbox.key.v1';
  // Never leave the bearer capability in history, request URLs or referrers.
  const resume = new URLSearchParams(location.hash.slice(1)).get('resume');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const key = document.body.dataset.serverKey;
  if (!globalThis.isSecureContext || !crypto.subtle || (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
    error('An HTTPS connection is required. Open the secure address provided by the team.');
    $('start-button').disabled = true;
    return;
  }
  if (storage.get(PIN) && storage.get(PIN) !== key) {
    error('This server’s encryption key has changed. Contact the team through a trusted channel before continuing.');
    $('start-button').disabled = true;
    return;
  }
  storage.set(PIN, key);
  let token = resume && /^[A-Za-z0-9_-]{40,128}$/.test(resume) ? resume : storage.get(SESSION);
  if (token) storage.set(SESSION, token);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fromHex = value => Uint8Array.from(value.match(/../g), p => parseInt(p, 16));
  const hex = value => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
  const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
  const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const protocol = 'servant-tunnel-v1';
  const rawPoint = fromHex(document.body.dataset.serverPoint);
  if (rawPoint.length !== 65 || `${rawPoint[64] % 2 ? '03' : '02'}${hex(rawPoint.slice(1, 33))}` !== key) {
    error('The server encryption setup is invalid. Contact the team.'); $('start-button').disabled = true; return;
  }
  const serverKey = await crypto.subtle.importKey('raw', rawPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  async function request(path, method = 'GET', body) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const publicKey = `${raw[64] % 2 ? '03' : '02'}${hex(raw.slice(1, 33))}`;
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const seed = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    shared.fill(0);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${protocol}:${key}:${publicKey}`) }, seed, 512));
    const writeKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt']);
    const readKey = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['decrypt']);
    bits.fill(0);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: encoder.encode(`${protocol}:request`) }, writeKey, encoder.encode(JSON.stringify({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? '' : JSON.stringify(body), at: Date.now() }))));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 45000);
    let reader;
    try {
      const response = await fetch('/v1/secure', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-servant-encrypted' }, body: JSON.stringify({ v: 1, publicKey, salt: base64(salt), data: base64(data) }), signal: abort.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-servant-encrypted') || !response.body) throw new Error('Encrypted connection unavailable. Check your connection and try again.');
      reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      let buffer = '', text = '', sequence = 0, status = null;
      for (;;) {
        const part = await reader.read();
        if (part.done) throw new Error('The encrypted reply was interrupted. Try again.');
        buffer += textDecoder.decode(part.value, { stream: true });
        while (buffer.includes('\n')) {
          const boundary = buffer.indexOf('\n');
          if (boundary > 256 * 1024 || sequence >= 0xffffffff) throw new Error('Invalid encrypted reply.');
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, sequence++);
          const frame = JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${protocol}:response`) }, readKey, unbase64(line))));
          if (status === null) { if (frame.type !== 'headers' || !Number.isInteger(frame.status)) throw new Error('Invalid encrypted reply.'); status = frame.status; }
          else if (frame.type === 'chunk' && typeof frame.data === 'string') { text += frame.data; if (text.length > 24 * 1024 * 1024) throw new Error('Reply is too large.'); }
          else if (frame.type === 'end') { const result = JSON.parse(text); if (status < 200 || status >= 300) throw Object.assign(new Error(result.error?.message || 'Could not complete this step. Try again.'), { status }); return result; }
          else throw new Error('Invalid encrypted reply.');
        }
        if (buffer.length > 256 * 1024) throw new Error('Invalid encrypted reply.');
      }
    } finally { clearTimeout(timeout); await reader?.cancel().catch(() => {}); }
  }
  const draftIds = new Map();
  async function draftId(kind, body) {
    const signature = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(body)))));
    const prior = draftIds.get(kind);
    if (prior?.signature === signature) return prior.id;
    const id = crypto.randomUUID(); draftIds.set(kind, { signature, id }); return id;
  }
  async function files(input) {
    const chosen = Array.from(input.files || []);
    if (chosen.length > 4 || chosen.some(file => file.size > 5 * 1024 * 1024) || chosen.reduce((n, file) => n + file.size, 0) > 10 * 1024 * 1024) throw new Error('Choose up to 4 files, no more than 5 MB each and 10 MB total.');
    return Promise.all(chosen.map(async file => ({ name: file.name, data: base64(new Uint8Array(await file.arrayBuffer())) })));
  }
  let last = 0, polling = false, timer, active = true, sending = false;
  const seen = new Set();
  function showThread(conversation) {
    $('start').hidden = true; $('thread').hidden = false;
    $('subject-title').textContent = conversation.subject;
    $('contact-name').textContent = conversation.name;
    $('status').textContent = conversation.status === 'resolved' ? 'Resolved · reply to reopen' : 'Open';
  }
  function append(messages) {
    const list = $('messages'); const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    for (const message of messages) {
      last = Math.max(last, message.sequence);
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const item = document.createElement('article'); item.className = `message ${message.sender === 'visitor' ? 'visitor' : 'staff'}`;
      const by = document.createElement('div'); by.className = 'by';
      const author = document.createElement('strong'); author.textContent = message.sender === 'visitor' ? 'You' : message.senderName;
      const at = document.createElement('time'); at.dateTime = new Date(message.createdAt).toISOString(); at.textContent = new Date(message.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      by.append(author, at); const body = document.createElement('div'); body.className = 'body'; body.textContent = message.text; item.append(by, body);
      for (const attachment of message.attachments) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'download'; button.textContent = `Download ${attachment.name}`;
        button.onclick = async () => { button.disabled = true; error(''); try { const { file } = await request(`/v1/inbox/guest/files/${encodeURIComponent(attachment.id)}`); const url = URL.createObjectURL(new Blob([unbase64(file.data)], { type: 'application/octet-stream' })); const link = document.createElement('a'); link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); } catch (e) { error(e.message); } finally { button.disabled = false; } };
        item.append(button);
      }
      list.append(item);
    }
    if (nearEnd) list.scrollTop = list.scrollHeight;
  }
  // Reply emails, offered only when the server can send mail. The box is redrawn only when its state changes,
  // so the timer that fetches replies never wipes what someone is typing.
  const RETURN = 'Anyone with this link can read and reply to this conversation. Save it to return from another device.';
  let lastNotify = null, lastConversation = null, shownAlerts = '', editingEmail = false, alertsBusy = false;
  function showAlerts(notify, conversation) {
    lastNotify = notify || null; lastConversation = conversation || lastConversation;
    if (!notify?.available) { $('alerts').hidden = true; $('return-note').textContent = `${RETURN} There are no email notifications.`; return; }
    const state = editingEmail ? 'edit' : notify.state;
    const signature = `${state}|${notify.email || ''}`;
    if (signature === shownAlerts) return;
    shownAlerts = signature;
    const asking = state === 'none' || state === 'off' || state === 'edit';
    $('alerts').hidden = false; $('alerts-email-form').hidden = !asking; $('alerts-code-form').hidden = state !== 'pending'; $('alerts-on').hidden = state !== 'on'; $('alerts-cancel').hidden = state !== 'edit';
    if (asking && state !== 'edit' && !$('alerts-email').value) $('alerts-email').value = notify.email || lastConversation?.email || '';
    $('alerts-title').textContent = state === 'pending' ? 'Enter the code we emailed you' : state === 'on' ? `We email ${notify.email} when the team replies.` : 'Get an email when the team replies';
    // Once emails are on the box is one line, so a returning visitor reaches the conversation first.
    $('alerts-text').textContent = state === 'pending' ? `We sent a 6-digit code to ${notify.email}. Enter it here to get an email each time the team replies.` : state === 'on' ? '' : 'We send a private link back to this conversation. The reply itself stays on this page.';
    $('alerts-text').hidden = state === 'on';
    $('return-note').textContent = state === 'on' ? RETURN : `${RETURN} Until email is turned on, you will not be told when the team replies.`;
  }
  async function alertsCall(path, body, done) {
    if (alertsBusy) return;
    alertsBusy = true; error('');
    const controls = Array.from($('alerts').querySelectorAll('button,input'));
    for (const control of controls) control.disabled = true;
    try { const result = await request(path, 'POST', body); editingEmail = false; shownAlerts = ''; showAlerts(result.notify, lastConversation); done(); }
    catch (e) { error(e.message); }
    finally { alertsBusy = false; for (const control of controls) control.disabled = false; }
  }
  $('alerts-email-form').onsubmit = event => { event.preventDefault(); void alertsCall('/v1/inbox/guest/notify', { email: $('alerts-email').value.trim() }, () => { $('alerts-code').value = ''; notice('Code sent. Check your email.'); $('alerts-code').focus(); }); };
  $('alerts-code-form').onsubmit = event => { event.preventDefault(); void alertsCall('/v1/inbox/guest/notify/confirm', { code: $('alerts-code').value.trim() }, () => notice('Email confirmed.')); };
  $('alerts-resend').onclick = () => void alertsCall('/v1/inbox/guest/notify', { email: lastNotify.email }, () => { $('alerts-code').value = ''; notice('New code sent. Check your email.'); });
  $('alerts-change').onclick = () => { editingEmail = true; $('alerts-email').value = ''; showAlerts(lastNotify, lastConversation); $('alerts-email').focus(); };
  $('alerts-cancel').onclick = () => { editingEmail = false; showAlerts(lastNotify, lastConversation); };
  $('alerts-stop').onclick = () => void alertsCall('/v1/inbox/guest/notify/stop', undefined, () => notice('Emails stopped.'));
  async function refresh() {
    if (!token || polling || !active) return;
    polling = true;
    try {
      const result = await request(`/v1/inbox/guest/conversation?after=${last}`);
      if (!active) return;
      showThread(result.conversation); append(result.messages); showAlerts(result.notify, result.conversation);
      $('older').hidden = !result.hasMore;
      $('connection').textContent = 'Connected · replies update automatically';
      if (!document.hidden && last) await request('/v1/inbox/guest/read', 'POST', { through: last });
    } catch (e) { $('connection').textContent = 'Connection interrupted · retrying'; if (e.status === 401 || e.status === 404) error(e.message); }
    finally { polling = false; clearTimeout(timer); if (active && token) timer = setTimeout(() => void refresh(), 3000); }
  }
  $('older').onclick = () => void refresh();
  $('start-form').onsubmit = async event => {
    event.preventDefault(); if (sending) return; sending = true; for (const field of $('start-form').elements) field.disabled = true; error('');
    try {
      const body = { name: $('name').value.trim(), email: $('email').value.trim(), subject: $('subject').value.trim(), text: $('message').value.trim(), attachments: await files($('start-files')) };
      if (!body.text && !body.attachments.length) throw new Error('Write a message or attach a file first.');
      const result = await request('/v1/inbox/guest/start', 'POST', { ...body, requestId: await draftId('start', body) });
      token = result.token; storage.set(SESSION, token); showThread(result.conversation); append(result.messages); showAlerts(result.notify, result.conversation);
      notice(result.notify?.state === 'pending' ? 'Message sent.' : 'Message sent. To see the reply, come back to this page in this browser, or save your return link below.'); $('start-form').reset(); await refresh();
    } catch (e) { error(e.message); } finally { sending = false; for (const field of $('start-form').elements) field.disabled = false; }
  };
  $('reply-form').onsubmit = async event => {
    event.preventDefault(); if (sending) return; sending = true; $('send').disabled = true; $('reply').disabled = true; $('reply-files').disabled = true; error('');
    try {
      const body = { text: $('reply').value.trim(), attachments: await files($('reply-files')) };
      if (!body.text && !body.attachments.length) throw new Error('Write a reply or attach a file first.');
      await request('/v1/inbox/guest/messages', 'POST', { ...body, requestId: await draftId('reply', body) });
      $('reply-form').reset(); draftIds.delete('reply'); await refresh();
    } catch (e) { error(e.message); } finally { sending = false; $('send').disabled = false; $('reply').disabled = false; $('reply-files').disabled = false; }
  };
  $('copy').onclick = async () => {
    const link = `${location.origin}/contact#resume=${encodeURIComponent(token)}`;
    try { await navigator.clipboard.writeText(link); notice('Return link copied. Keep it private.'); }
    catch { $('return-link').value = link; $('return-link').hidden = false; $('return-link').focus(); $('return-link').select(); }
  };
  $('leave').onclick = () => {
    if (!confirm('Save your private return link first. Leave this conversation on this device?')) return;
    active = false; token = null; clearTimeout(timer); storage.remove(SESSION); location.replace('/contact');
  };
  window.addEventListener('pagehide', () => { active = false; clearTimeout(timer); });
  window.addEventListener('pageshow', () => { if (!active) { active = true; void refresh(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  if (token) { $('start').hidden = true; $('thread').hidden = false; await refresh(); }
}

export const secureInboxScript = () => `"use strict";\nvoid (${inboxBrowser.toString()})().catch(() => { const box = document.getElementById('error'); box.textContent = 'Could not set up encrypted messaging. Reload this page or contact the team.'; box.hidden = false; document.getElementById('start-button').disabled = true; });\n`;
