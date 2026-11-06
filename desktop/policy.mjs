import path from 'node:path';

export const APP_NAME = 'Servant UX';
export const USER_DATA_NAME = 'Servant UX';
export const INTERNAL_SCHEME = 'servant-ux-app';
export const INVITE_SCHEME = 'servant-ux';
export const APP_URL = `${INTERNAL_SCHEME}://app`;
// A UX-team release feed must be configured before binary updates are enabled.
// Never point this separately signed app at the upstream Servant feed.
export const DOWNLOAD_PAGE = null;
export function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === `${INTERNAL_SCHEME}:` && url.host === 'app' && !url.username && !url.password; }
  catch { return false; }
}
export function externalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
// The UX scheme opens this app directly. Ordinary servant:// links are also
// accepted when pasted or explicitly sent to the process.
export function inviteLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { const url = new URL(value); return ['servant:', `${INVITE_SCHEME}:`].includes(url.protocol) && url.host === 'pair' && url.searchParams.get('code') ? value : null; }
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
