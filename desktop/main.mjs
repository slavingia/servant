import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, Notification, nativeTheme, net, protocol, safeStorage, session, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_URL, DOWNLOAD_PAGE, accountFileName, activeAccountKey, desktopNotification, desktopPage, allowedPermission, assetPath, contentSecurityPolicy, externalUrl, frameOrigins, inviteLink, isAppUrl, workspaceConfig } from './policy.mjs';
import { createUpdates } from './updates.mjs';
import { createWebUpdates } from './ota.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledRoot = path.join(here, 'web');
// The interface can be replaced by a signed update from the server (see ota.mjs).
let webRoot = bundledRoot;
app.setName('Servant');
// QA always uses a distinct profile and a separately configured test workspace.
if (!app.isPackaged && process.env.SERVANT_DESKTOP_TEST_PROFILE) {
  app.setName('Servant Test');
  app.setPath('userData', path.resolve(process.env.SERVANT_DESKTOP_TEST_PROFILE));
}
protocol.registerSchemesAsPrivileged([{ scheme: 'servant-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const rawWorkspace = JSON.parse(fs.readFileSync(path.join(here, 'workspace.json'), 'utf8'));
const workspace = rawWorkspace ? workspaceConfig(rawWorkspace, { allowLoopback: !app.isPackaged && !!process.env.SERVANT_DESKTOP_TEST_PROFILE }) : undefined;
// Sites allowed in frames, fixed at build time (build.mjs); none beyond the defaults when absent.
const framesFile = path.join(here, 'frame-origins.json');
const csp = contentSecurityPolicy(fs.existsSync(framesFile) ? frameOrigins(JSON.parse(fs.readFileSync(framesFile, 'utf8')).join(' ')) : []);
let window;
let quitting = false;
app.on('before-quit', () => { quitting = true; });
const validSender = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url);
const openExternal = value => { const url = externalUrl(value); if (url) void shell.openExternal(url); };
const updates = createUpdates({ getWindow: () => window, openExternal });
const certificateFile = path.join(here, 'ota-certificate.pem');
// Interface updates run in the installed app, and in a test profile; never from a source checkout.
const webUpdatesEnabled = fs.existsSync(certificateFile) && (app.isPackaged || !!process.env.SERVANT_DESKTOP_TEST_PROFILE);
let webUpdates = null;
// An invite link opened before the window can take it (for example the one
// deploy/mac/install.sh opens) waits here until the app asks for it.
let pendingInvite = null;
let pendingNotification = null;
const notices = new Map();
const openInvite = value => {
  const link = inviteLink(value);
  if (!link) return;
  // Kept until the page takes it, so a link sent while the page is loading is not lost.
  pendingInvite = link;
  window?.webContents.send('servant:invite');
  if (window?.isMinimized()) window.restore();
  window?.show(); window?.focus();
};
app.on('open-url', (event, url) => { event.preventDefault(); openInvite(url); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (app.isPackaged) app.setAsDefaultProtocolClient('servant');
  app.on('second-instance', (event, argv) => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); argv.forEach(openInvite); });
  app.whenReady().then(async () => {
    protocol.handle('servant-app', async request => {
      let file = assetPath(webRoot, request.url);
      if (!file && new URL(request.url).href === APP_URL + '/') file = path.join(webRoot, 'index.html');
      if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        if (path.extname(file)) return new Response('Not found', { status: 404 });
        file = path.join(webRoot, 'index.html');
      }
      const result = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(result.headers);
      headers.set('Content-Security-Policy', csp);
      headers.set('X-Content-Type-Options', 'nosniff');
      // The page itself is marked as the Mac app's (policy.mjs); every other file is served as it is.
      if (file === path.join(webRoot, 'index.html') && result.ok) {
        headers.delete('Content-Length');
        return new Response(desktopPage(await result.text()), { status: result.status, headers });
      }
      return new Response(result.body, { status: result.status, headers });
    });
    // Copy actions may write plain text, and meetings may use the camera and
    // microphone. No clipboard reading, screen capture or other device access.
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => contents === window?.webContents && isAppUrl(origin) && allowedPermission(permission, details));
    session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!(contents === window?.webContents && isAppUrl(details.requestingUrl) && allowedPermission(permission, details))) return callback(false);
      // macOS keeps its own camera and microphone permission. Without asking it here, a call
      // quietly joins with no video (others hear you but can't see you).
      if (permission === 'media' && process.platform === 'darwin') {
        const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
        for (const type of new Set(types.map(t => (t === 'video' ? 'camera' : 'microphone')))) {
          if (systemPreferences.getMediaAccessStatus(type) !== 'granted' && !(await systemPreferences.askForMediaAccess(type).catch(() => false))) {
            // Audio-only still works; video can be retried after allowing it in System Settings.
            if (type === 'microphone') return callback(false);
          }
        }
      }
      callback(true);
    });
    // "Share screen" in a call: macOS shows its own picker (screens and windows), and nothing is
    // captured until the person chooses. If the system picker isn't available, offer the main screen.
    // Screen share in a call, and "Include meeting audio from this computer" when recording a meeting.
    // On macOS 15+ the system picker handles the request itself (this handler is not called) and
    // decides what audio comes back. Electron's loopback system audio is Windows only, so it is
    // added there; elsewhere the page sees whether an audio track arrived and says so.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (request.frame?.top?.url && !isAppUrl(request.frame.top.url)) return callback({});
      const audio = request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {};
      desktopCapturer.getSources({ types: ['screen'] }).then(sources => callback(sources[0] ? { video: sources[0], ...audio } : {}), () => callback({}));
    }, { useSystemPicker: true });
    ipcMain.on('servant:config', event => { event.returnValue = validSender(event) ? { workspace } : {}; });
    ipcMain.on('servant:pending-invite', event => {
      event.returnValue = validSender(event) ? pendingInvite : null;
      if (validSender(event)) pendingInvite = null;
    });
    // Serialize storage writes to preserve sign-out and account changes in order.
    let storageQueue = Promise.resolve();
    ipcMain.handle('servant:storage', (event, operation, key, value) => {
      if (!validSender(event) || !accountFileName(key) || !['get', 'set', 'remove'].includes(operation)) throw new Error('Invalid storage request');
      if (operation === 'set' && (typeof value !== 'string' || value.length > 65536)) throw new Error('Invalid account');
      const run = async () => {
        const file = path.join(app.getPath('userData'), accountFileName(key));
        if (operation === 'remove') { fs.rmSync(file, { force: true }); return; }
        if (operation === 'get' && !fs.existsSync(file)) return null;
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Unlock your Mac Keychain to use Servant');
        if (operation === 'get') return (await safeStorage.decryptStringAsync(fs.readFileSync(file))).result;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file + '.tmp', await safeStorage.encryptStringAsync(value), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      };
      const result = storageQueue.then(run);
      storageQueue = result.catch(() => {});
      return result;
    });
    ipcMain.handle('servant:badge', (event, count) => {
      if (!validSender(event) || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid badge');
      app.setBadgeCount(Math.min(count, 9999));
    });
    ipcMain.on('servant:pending-notification', event => {
      event.returnValue = validSender(event) ? pendingNotification : null;
      if (validSender(event)) pendingNotification = null;
    });
    ipcMain.handle('servant:notify', (event, value) => {
      const notice = desktopNotification(value);
      if (!validSender(event) || !notice) throw new Error('Invalid notification');
      if (!Notification.isSupported()) return false;
      const id = JSON.stringify([notice.accountId, notice.data.conversationId || notice.data.chatId]);
      notices.get(id)?.close();
      const notification = new Notification({ title: notice.title, body: notice.body });
      notices.set(id, notification);
      notification.on('click', () => {
        pendingNotification = notice;
        if (!window) createWindow();
        else window.webContents.send('servant:notification');
        if (window?.isMinimized()) window.restore();
        window?.show(); window?.focus();
      });
      const remove = () => { if (notices.get(id) === notification) notices.delete(id); };
      notification.on('close', remove);
      notification.on('failed', remove);
      notification.show();
      while (notices.size > 100) { const [oldId, old] = notices.entries().next().value; old.close(); notices.delete(oldId); }
      return true;
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [
        { role: 'about' }, { label: 'Check for Updates…', click: () => void checkEverything() }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Download the latest Servant', click: () => openExternal(DOWNLOAD_PAGE) }] },
    ]));
    if (webUpdatesEnabled) {
      webUpdates = createWebUpdates({
        dir: path.join(app.getPath('userData'), 'ota-web'),
        certificate: fs.readFileSync(certificateFile, 'utf8'),
        serverUrl: signedInServer,
        log: console,
      });
      const chosen = webUpdates.chooseRoot();
      if (chosen) { webRoot = chosen.root; console.log('Running interface update', chosen.id); }
    }
    createWindow();
    updates.start();
    startWebUpdates();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); else window?.show(); });
  }).catch(error => { dialog.showErrorBox('Servant could not start', error.message); app.quit(); });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1200, height: 820, minWidth: 760, minHeight: 560, title: 'Servant', show: false,
    // The sidebar draws under the inset traffic lights, like Slack and ChatGPT.
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161C' : '#FFFFFF',
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); openExternal(url); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  // Keep server notifications alive when the person closes the window. Quit
  // still destroys it, and a notification or Dock click reveals it again.
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = null; });
  void window.loadURL(APP_URL + '/');
}

// The server the person is signed in to, read from the saved account (or the
// workspace built into the app). Only its address is used.
function signedInServer() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return workspace?.server;
    const read = key => {
      const name = accountFileName(key);
      if (!name) return null;
      const file = path.join(app.getPath('userData'), name);
      return fs.existsSync(file) ? JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) : null;
    };
    const manifest = read('servant.accounts');
    const key = manifest ? activeAccountKey(manifest) : 'servant.account';
    const account = key ? read(key) : null;
    if (typeof account?.serverUrl === 'string') return account.serverUrl;
  } catch { /* fall through to the bundled workspace */ }
  return workspace?.server;
}

const askRestart = async () => {
  if (process.env.SERVANT_DESKTOP_TEST_PROFILE) return; // test profiles apply it on the next launch
  const options = { type: 'info', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1, message: 'A Servant update is ready', detail: 'Restart to use it. Otherwise it starts the next time you open Servant.' };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 0) { app.relaunch(); app.quit(); }
};

// Background check: quiet unless an update is ready to use.
function startWebUpdates() {
  if (!webUpdates) return;
  // The bundle proves itself by staying loaded; two failed launches send it back.
  setTimeout(() => webUpdates.markGood(), 20_000);
  const run = async () => {
    const result = await webUpdates.check().catch(error => ({ status: 'unavailable', error: error.message }));
    if (result.status === 'ready' || result.status === 'rolledBack') await askRestart();
    else if (result.error) console.warn('Interface update:', result.error);
  };
  setTimeout(() => void run(), 12_000);
  setInterval(() => void run(), 6 * 60 * 60 * 1000);
}

// Check for Updates…: the interface first (from your server), then the app itself.
async function checkEverything() {
  if (webUpdates) {
    const result = await webUpdates.check().catch(error => ({ status: 'unavailable', error: error.message }));
    if (result.status === 'ready' || result.status === 'rolledBack') { await askRestart(); return; }
    if (result.status === 'unavailable' && result.error && !/Sign in|doesn't offer/.test(result.error)) {
      await dialog.showMessageBox(window ?? undefined, { type: 'warning', message: "Couldn't check your server for updates", detail: result.error });
    }
  }
  await updates.check({ manual: true });
}
