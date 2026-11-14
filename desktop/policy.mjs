import path from 'node:path';
import { createHash } from 'node:crypto';

export const APP_URL = 'servant-app://app';
export const DOWNLOAD_PAGE = 'https://servant-desktop.web.app';
export function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === 'servant-app:' && url.host === 'app' && !url.username && !url.password; }
  catch { return false; }
}
export function externalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
// servant://pair invite links opened from Terminal, Mail or a browser. The app
// treats them exactly like a pasted invite.
export function inviteLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { const url = new URL(value); return url.protocol === 'servant:' && url.host === 'pair' && url.searchParams.get('code') ? value : null; }
  catch { return null; }
}
export function assetPath(root, value) {
  if (!isAppUrl(value)) return null;
  try {
    const name = decodeURIComponent(new URL(value).pathname);
    if (name.includes('\0') || name.includes('\\')) return null;
    const resolved = path.resolve(root, '.' + name);
    return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
  } catch { return null; }
}
export function workspaceConfig(value, { allowLoopback = false } = {}) {
  if (!value || typeof value !== 'object' || !/^(02|03)[0-9a-f]{64}$/.test(value.serverKey)) throw new Error('Workspace needs a trusted public encryption key');
  const checkedUrl = value => {
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Workspace URLs must use HTTPS');
    return url.href.replace(/\/$/, '');
  };
  return { server: checkedUrl(value.server), serverKey: value.serverKey, ...(value.discovery ? { discovery: checkedUrl(value.discovery) } : {}) };
}
// Extra sites the app window may show in a frame (for example the GitHub Pages site where a
// project's older prototype previews live). Set at build time with SERVANT_DESKTOP_FRAME_ORIGINS,
// a space- or comma-separated list of https origins. Anything that isn't a bare https origin is refused.
export function frameOrigins(value) {
  return [...new Set(String(value ?? '').split(/[\s,]+/).filter(Boolean).map(item => {
    let url;
    try { url = new URL(item); } catch { throw new Error(`Frame origin is not a URL: ${item}`); }
    if (url.protocol !== 'https:' || !/^[a-z0-9.-]+(:\d+)?$/.test(url.host) || url.username || url.password || url.origin + '/' !== url.href.replace(/\/?$/, '/')) throw new Error(`Frame origins must be bare https origins like https://example-org.github.io: ${item}`);
    return url.origin;
  }))];
}
// The app window's Content Security Policy. Tweets embed from platform.twitter.com.
// The app's page as the Mac app serves it: marked, so the skeleton it shows before its script loads
// (app/public/index.html) leaves room for the window controls, as the sidebar that replaces it does.
export function desktopPage(html) {
  return String(html).replace(/<html(?=[\s>])/, '<html data-servant-desktop');
}
export function contentSecurityPolicy(origins = []) {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; frame-src ${[...origins, 'https://platform.twitter.com'].join(' ')}; base-uri 'self'; form-action 'none'`;
}
// `codesign -dv` prints the signing team; ad-hoc and unsigned builds have none.
export function teamIdentifier(codesignOutput) {
  const match = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(codesignOutput ?? ''));
  return match ? match[1] : null;
}
// Squirrel.Mac rejects updates for apps without a Developer ID team.
export function updateMode(team) {
  return team ? 'install' : 'notify';
}

// The app window may write copied text and, for meetings, use the camera and
// microphone and share a screen the person picks. Clipboard reads and everything else stay off.
export function allowedPermission(permission, details = {}) {
  if (permission === 'clipboard-sanitized-write') return true;
  // Only reached when the person chooses "Share screen" in a call; they then pick what to share.
  if (permission === 'display-capture') return true;
  if (permission !== 'media') return false;
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  return types.length > 0 && types.every(type => type === 'audio' || type === 'video');
}

// Credential keys are an allowlist, never filesystem paths. Hashed filenames
// keep long server identifiers within the filesystem's component limit.
export function accountFileName(key) {
  if (key === 'servant.account') return 'account.enc';
  if (key === 'servant.accounts') return 'accounts.enc';
  if (typeof key !== 'string' || key.length > 16384 || !/^servant\.account\.(?:[0-9a-f]{6})+$/.test(key)) return null;
  return 'account-' + createHash('sha256').update(key).digest('hex') + '.enc';
}
export function activeAccountKey(manifest) {
  const id = manifest?.activeId;
  if (manifest?.version !== 1 || typeof id !== 'string' || id.length > 2048 || !Array.isArray(manifest.ids) || !manifest.ids.includes(id)) return null;
  return 'servant.account.' + [...id].map(char => char.codePointAt(0).toString(16).padStart(6, '0')).join('');
}
// OS notification targets contain local account identifiers and opaque ids only.
export function desktopNotification(value) {
  if (!value || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 2048) return null;
  const data = value.data;
  if (!data || typeof data.userId !== 'string' || typeof data.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.userId) || !/^[A-Za-z0-9_-]{1,128}$/.test(data.deviceId)) return null;
  const target = typeof data.chatId === 'string' && /^cht_[A-Za-z0-9_-]{1,80}$/.test(data.chatId) ? { chatId: data.chatId }
    : typeof data.conversationId === 'string' && /^(ch|dm)_[A-Za-z0-9_-]{1,80}$/.test(data.conversationId) ? { conversationId: data.conversationId } : null;
  if (!target) return null;
  return { accountId: value.accountId, title: typeof value.title === 'string' ? value.title.slice(0, 80) : 'Servant',
    body: typeof value.body === 'string' ? value.body.slice(0, 240) : 'You have a new message',
    data: { userId: data.userId, deviceId: data.deviceId, ...target,
      ...(typeof data.threadRoot === 'string' && /^\d{1,16}$/.test(data.threadRoot) ? { threadRoot: data.threadRoot } : {}),
      ...(typeof data.messageId === 'string' && /^\d{1,16}$/.test(data.messageId) ? { messageId: data.messageId } : {}),
    } };
}
