const { contextBridge, ipcRenderer } = require('electron');
const config = ipcRenderer.sendSync('servant:config');
contextBridge.exposeInMainWorld('servantDesktop', {
  platform: 'macos',
  workspace: config.workspace,
  // servant://pair links opened while the app runs, or the one that launched it.
  takeInvite: () => ipcRenderer.sendSync('servant:pending-invite'),
  onInvite: callback => {
    const listener = () => { const link = ipcRenderer.sendSync('servant:pending-invite'); if (link) callback(link); };
    ipcRenderer.on('servant:invite', listener);
    return () => ipcRenderer.removeListener('servant:invite', listener);
  },
  // Bring the window to the front (a code request arrived while Servant was open behind other windows).
  focus: () => ipcRenderer.invoke('servant:focus'),
  notifications: {
    show: value => ipcRenderer.invoke('servant:notify', value),
    setBadge: count => ipcRenderer.invoke('servant:badge', count),
    take: () => ipcRenderer.sendSync('servant:pending-notification'),
    onClick: callback => {
      const listener = () => { const value = ipcRenderer.sendSync('servant:pending-notification'); if (value) callback(value); };
      ipcRenderer.on('servant:notification', listener);
      return () => ipcRenderer.removeListener('servant:notification', listener);
    },
  },
  storage: {
    version: 2,
    getItem: key => ipcRenderer.invoke('servant:storage', 'get', key),
    setItem: (key, value) => ipcRenderer.invoke('servant:storage', 'set', key, value),
    removeItem: key => ipcRenderer.invoke('servant:storage', 'remove', key),
  },
});
