import path from 'node:path';

export const APP_URL = 'servant-app://app';
export function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === 'servant-app:' && url.host === 'app' && !url.username && !url.password; }
  catch { return false; }
}
export function externalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
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
