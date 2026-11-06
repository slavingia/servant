const { contextBridge, ipcRenderer } = require('electron');
const config = ipcRenderer.sendSync('servant:config');
contextBridge.exposeInMainWorld('servantDesktop', {
  platform: 'macos',
  workspace: config.workspace,
  // Servant pair links opened while the app runs, or the one that launched it.
  takeInvite: () => ipcRenderer.sendSync('servant:pending-invite'),
  onInvite: callback => {
    const listener = () => { const link = ipcRenderer.sendSync('servant:pending-invite'); if (link) callback(link); };
    ipcRenderer.on('servant:invite', listener);
    return () => ipcRenderer.removeListener('servant:invite', listener);
  },
  storage: {
    getItem: key => ipcRenderer.invoke('servant:storage', 'get', key),
    setItem: (key, value) => ipcRenderer.invoke('servant:storage', 'set', key, value),
    removeItem: key => ipcRenderer.invoke('servant:storage', 'remove', key),
  },
});
