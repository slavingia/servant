import { app, dialog } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import updater from 'electron-updater';
import { DISPLAY_NAME, DOWNLOAD_PAGE, teamIdentifier, updateMode } from './policy.mjs';

const { autoUpdater } = updater;
const run = promisify(execFile);
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Updates come from the GitHub release feed configured in package.json.
// Squirrel.Mac installs an update only when it carries the running app's
// Developer ID signature, so ad-hoc preview builds offer the download page.
export function createUpdates({ getWindow, openExternal, enabled = true }) {
  let mode = null;
  let offered = null;
  let downloading = false;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Mac releases are published as GitHub pre-releases.
  autoUpdater.allowPrerelease = true;
  // Keep failures to one line; HTTP errors otherwise include every response header.
  autoUpdater.logger = { info: console.log, warn: console.warn, debug() {}, error: error => console.warn('Updater:', String(error?.message ?? error).split('\n')[0]) };

  const show = options => {
    const window = getWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  if (!enabled) return {
    start() {},
    check: async ({ manual = false } = {}) => {
      if (manual) await show({
        type: 'info',
        message: `${DISPLAY_NAME} updates are not configured yet`,
        detail: 'Install a new UX-team build manually until a dedicated signed release feed is available.',
      });
    },
  };

  const resolveMode = async () => {
    if (mode) return mode;
    const bundle = path.resolve(path.dirname(process.execPath), '../..');
    try {
      const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
      mode = updateMode(teamIdentifier(stderr));
    } catch {
      mode = 'notify';
    }
    return mode;
  };

  autoUpdater.on('update-downloaded', async info => {
    downloading = false;
    const { response } = await show({
      type: 'info', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
      message: `${DISPLAY_NAME} ${info.version} is ready`, detail: 'Restart to finish updating. Otherwise it installs the next time you quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  const check = async ({ manual = false } = {}) => {
    if (!app.isPackaged) {
      if (manual) await show({ type: 'info', message: 'Updates are checked in the installed app', detail: `This copy of ${DISPLAY_NAME} is running from source.` });
      return;
    }
    if (downloading) {
      if (manual) await show({ type: 'info', message: 'An update is downloading', detail: `${DISPLAY_NAME} will tell you when it is ready.` });
      return;
    }
    let result;
    try {
      result = await autoUpdater.checkForUpdates();
    } catch (error) {
      if (!manual) { console.warn('Update check failed', error?.message); return; }
      const { response } = await show({
        type: 'warning', buttons: ['Open Download Page', 'OK'], defaultId: 1, cancelId: 1,
        message: "Couldn't check for updates", detail: `Check your connection, or download the latest ${DISPLAY_NAME} from the website.`,
      });
      if (response === 0) openExternal(DOWNLOAD_PAGE);
      return;
    }
    if (!result?.isUpdateAvailable) {
      if (manual) await show({ type: 'info', message: "You're up to date", detail: `${DISPLAY_NAME} ${app.getVersion()} is the latest version.` });
      return;
    }
    const version = result.updateInfo.version;
    // Background checks offer each version once per launch.
    if (!manual && offered === version) return;
    offered = version;
    if (await resolveMode() === 'install') {
      downloading = true;
      autoUpdater.downloadUpdate().catch(error => {
        downloading = false;
        console.warn('Update download failed', error?.message);
        if (manual) void show({ type: 'warning', message: "Couldn't download the update", detail: error?.message ?? 'Try again later.' });
      });
      if (manual) await show({ type: 'info', message: `Downloading ${DISPLAY_NAME} ${version}`, detail: `${DISPLAY_NAME} will tell you when it is ready to install.` });
      return;
    }
    const { response } = await show({
      type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      message: `${DISPLAY_NAME} ${version} is available`, detail: `You have ${app.getVersion()}. Download the new version and replace the old one in Applications.`,
    });
    if (response === 0) openExternal(DOWNLOAD_PAGE);
  };

  const start = () => {
    if (!app.isPackaged) return;
    setTimeout(() => void check(), 10_000);
    setInterval(() => void check(), CHECK_INTERVAL_MS);
  };

  return { check, start };
}
