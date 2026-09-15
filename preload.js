const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playground', {
  checkResources: () => ipcRenderer.invoke('cli:check'),
  toolHelp: id => ipcRenderer.invoke('cli:help', id),
  installTool: id => ipcRenderer.invoke('cli:install', id),
  launchCli: value => ipcRenderer.invoke('cli:launch', value),
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  unlockVault: password => ipcRenderer.invoke('vault:unlock', password),
  onVaultSaveError: callback => { ipcRenderer.on('vault:save-error', () => callback()); },
  readNotebook: () => ipcRenderer.invoke('storage:read'),
  saveNotebook: value => ipcRenderer.invoke('storage:save', value),
  openDataFolder: () => ipcRenderer.invoke('storage:folder'),
  requestExit: () => ipcRenderer.invoke('storage:request-exit'),
  finishExit: () => ipcRenderer.invoke('storage:finish-exit'),
  cancelExit: () => ipcRenderer.invoke('storage:cancel-exit'),
  onPrepareExit: callback => { ipcRenderer.on('storage:prepare-exit', () => callback()); },
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: profile => ipcRenderer.invoke('profiles:add', profile),
  deleteProfile: id => ipcRenderer.invoke('profiles:delete', id),
  openTask: task => ipcRenderer.invoke('task:open', task),
  exportNotes: notes => ipcRenderer.invoke('file:export', notes),
  importNotes: () => ipcRenderer.invoke('file:import')
});
