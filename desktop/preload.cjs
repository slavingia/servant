const { contextBridge, ipcRenderer } = require('electron');
const config = ipcRenderer.sendSync('servant:config');
contextBridge.exposeInMainWorld('servantDesktop', {
  platform: 'macos',
  workspace: config.workspace,
  storage: {
    getItem: key => ipcRenderer.invoke('servant:storage', 'get', key),
    setItem: (key, value) => ipcRenderer.invoke('servant:storage', 'set', key, value),
    removeItem: key => ipcRenderer.invoke('servant:storage', 'remove', key),
  },
});
