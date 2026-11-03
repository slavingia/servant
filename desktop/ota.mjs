// Over-the-air updates for the Mac app's interface, from the owner's server.
//
// The Mac app is a native shell (Electron) around the Servant web app. The shell
// changes rarely and needs a new download; the web app changes often and
// updates here, signed by the same key as the phone apps. Each file is checked
// against its signed hash. A new bundle gets two trial launches: if it fails
// to load, the app goes back to the bundled version by itself.
//
// "Shell API" below is the contract between this shell and the web app (the
// preload bridge, the app:// protocol, storage). Bump it whenever that
// contract changes, so older shells stop receiving bundles that expect more.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SHELL_API = 1;
export const RUNTIME = `mac-shell-${SHELL_API}`;
const MAX_FILE_BYTES = 120 * 1024 * 1024;
const MAX_FILES = 5000;
const SAFE_PATH = /^[A-Za-z0-9_\-\[][A-Za-z0-9_\-. @+()%\[\]]*(\/[A-Za-z0-9_\-\[][A-Za-z0-9_\-. @+()%\[\]]*)*$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('base64url');

export const updateAddress = server => {
  try {
    const url = new URL(server);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return null;
    return `${url.origin}/ota/web/manifest?runtime=${encodeURIComponent(RUNTIME)}`;
  } catch { return null; }
};

/** Parse and verify a signed manifest. Throws a sentence a person can act on. */
export function verifyManifest(text, signature, certificatePem) {
  if (!signature) throw new Error('The server sent an update without a signature');
  let key;
  try { key = crypto.createPublicKey(certificatePem); } catch { throw new Error('This app has no valid update certificate'); }
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(text), key, Buffer.from(signature, 'base64')); } catch { ok = false; }
  if (!ok) throw new Error("This update isn't signed by your server");
  const manifest = JSON.parse(text);
  if (manifest.runtimeVersion !== RUNTIME) throw new Error('The server answered for a different app version');
  return manifest;
}

export function checkFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('The update has no files');
  const seen = new Set();
  for (const f of files) {
    if (typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || f.path.split('/').includes('..')) throw new Error(`The update has an unsafe file name: ${String(f.path).slice(0, 60)}`);
    if (!HASH.test(f.hash) || !Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new Error('The update lists a file wrongly');
    if (seen.has(f.path)) throw new Error('The update lists a file twice');
    seen.add(f.path);
  }
  if (!seen.has('index.html')) throw new Error('The update has no index.html');
}

export function createWebUpdates({ dir, certificate, serverUrl, fetchImpl = fetch, log = console, now = Date.now }) {
  const stateFile = path.join(dir, 'current.json');
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
  const writeState = state => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!state) { fs.rmSync(stateFile, { force: true }); return; }
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };
  const bundleDir = id => path.join(dir, 'bundles', id);

  /**
   * Which folder to serve at launch: a downloaded bundle, or null for the
   * bundled one. Counts trial launches and gives up on a bundle that never
   * proved itself.
   */
  function chooseRoot() {
    const state = readState();
    if (!state) return null;
    const root = bundleDir(state.id);
    if (!fs.existsSync(path.join(root, 'index.html'))) { writeState(null); return null; }
    if (state.trial) {
      if ((state.attempts || 0) >= 2) { log.warn?.('Update', state.id, 'never finished loading; going back to the built-in version'); discard(state.id); return null; }
      writeState({ ...state, attempts: (state.attempts || 0) + 1 });
    }
    return { id: state.id, root };
  }

  const markGood = () => { const s = readState(); if (s?.trial) writeState({ ...s, trial: false, attempts: 0 }); };
  function discard(id) { writeState(null); if (id) fs.rmSync(bundleDir(id), { recursive: true, force: true }); }
  const current = () => readState()?.id || null;

  function prune(keep) {
    try {
      for (const id of fs.readdirSync(path.join(dir, 'bundles'))) if (!keep.has(id)) fs.rmSync(bundleDir(id), { recursive: true, force: true });
    } catch { /* none yet */ }
  }

  /**
   * Ask the server and install what it offers.
   * Returns { status: 'current' | 'ready' | 'rolledBack' | 'unavailable', id?, error? }.
   */
  async function check() {
    const server = typeof serverUrl === 'function' ? serverUrl() : serverUrl;
    const address = server && updateAddress(server);
    if (!address) return { status: 'unavailable', error: 'Sign in to a server first' };
    let res;
    try { res = await fetchImpl(address, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); }
    catch { return { status: 'unavailable', error: "Can't reach your server" }; }
    if (res.status === 404) return { status: 'unavailable', error: "Your server doesn't offer app updates yet" };
    if (!res.ok) return { status: 'unavailable', error: res.status === 503 ? 'Your server has no update signing key' : `Your server answered ${res.status}` };
    let manifest;
    try { manifest = verifyManifest(await res.text(), res.headers.get('x-servant-signature'), certificate); }
    catch (error) { return { status: 'unavailable', error: error.message }; }

    if (manifest.type === 'none') return { status: 'current' };
    if (manifest.type === 'rollback') {
      const state = readState();
      if (!state) return { status: 'current' };
      discard(state.id);
      return { status: 'rolledBack' };
    }
    if (manifest.type !== 'update') return { status: 'unavailable', error: 'The server sent something this app does not understand' };
    if (current() === manifest.id) return { status: 'current' };
    try { checkFiles(manifest.files); } catch (error) { return { status: 'unavailable', error: error.message }; }

    const target = bundleDir(manifest.id);
    const staging = `${target}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      const base = new URL(address).origin;
      // Reuse files the current bundle already has, by hash.
      const have = new Map();
      const state = readState();
      if (state) for (const f of state.files || []) have.set(f.hash, path.join(bundleDir(state.id), f.path));
      for (const f of manifest.files) {
        const out = path.join(staging, ...f.path.split('/'));
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
        const cached = have.get(f.hash);
        let buf = null;
        if (cached && fs.existsSync(cached)) { buf = fs.readFileSync(cached); if (sha256(buf) !== f.hash) buf = null; }
        if (!buf) {
          const file = await fetchImpl(`${base}/ota/assets/${f.hash}`, { signal: AbortSignal.timeout(120000) });
          if (!file.ok) throw new Error(`The server couldn't send ${f.path} (${file.status})`);
          buf = Buffer.from(await file.arrayBuffer());
          if (sha256(buf) !== f.hash || buf.length !== f.size) throw new Error(`${f.path} didn't match its signed checksum`);
        }
        fs.writeFileSync(out, buf, { mode: 0o600 });
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { status: 'unavailable', error: error.message };
    }
    writeState({ id: manifest.id, trial: true, attempts: 0, installedAt: now(), files: manifest.files.map(({ path: p, hash }) => ({ path: p, hash })) });
    prune(new Set([manifest.id]));
    return { status: 'ready', id: manifest.id };
  }

  return { chooseRoot, markGood, discard, current, check };
}
