import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_URL, assetPath, externalUrl, isAppUrl, workspaceConfig } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, 'web');
app.setName('Servant');
// QA always uses a distinct profile and a separately configured test workspace.
if (!app.isPackaged && process.env.SERVANT_DESKTOP_TEST_PROFILE) {
  app.setName('Servant Test');
  app.setPath('userData', path.resolve(process.env.SERVANT_DESKTOP_TEST_PROFILE));
}
protocol.registerSchemesAsPrivileged([{ scheme: 'servant-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const rawWorkspace = JSON.parse(fs.readFileSync(path.join(here, 'workspace.json'), 'utf8'));
const workspace = rawWorkspace ? workspaceConfig(rawWorkspace, { allowLoopback: !app.isPackaged && !!process.env.SERVANT_DESKTOP_TEST_PROFILE }) : undefined;
let window;
const validSender = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url);
const openExternal = value => { const url = externalUrl(value); if (url) void shell.openExternal(url); };

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
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
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'");
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(result.body, { status: result.status, headers });
    });
    // Copy actions may write plain text; no clipboard reading or device access.
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && isAppUrl(origin) && permission === 'clipboard-sanitized-write');
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && isAppUrl(details.requestingUrl) && permission === 'clipboard-sanitized-write'));
    ipcMain.on('servant:config', event => { event.returnValue = validSender(event) ? { workspace } : {}; });
    // Serialize storage writes to preserve sign-out and account changes in order.
    let storageQueue = Promise.resolve();
    ipcMain.handle('servant:storage', (event, operation, key, value) => {
      if (!validSender(event) || key !== 'servant.account' || !['get', 'set', 'remove'].includes(operation)) throw new Error('Invalid storage request');
      if (operation === 'set' && (typeof value !== 'string' || value.length > 65536)) throw new Error('Invalid account');
      const run = async () => {
        const file = path.join(app.getPath('userData'), 'account.enc');
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Download the latest Servant', click: () => openExternal('https://servant-desktop.web.app') }] },
    ]));
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); else window?.show(); });
  }).catch(error => { dialog.showErrorBox('Servant could not start', error.message); app.quit(); });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1200, height: 820, minWidth: 760, minHeight: 560, title: 'Servant', show: false,
    // The sidebar draws under the inset traffic lights, like Slack and ChatGPT.
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161C' : '#FFFFFF',
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); openExternal(url); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  void window.loadURL(APP_URL + '/');
}
