const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (creds) => ipcRenderer.invoke('login', creds),
  getAccessToken: () => ipcRenderer.invoke('getAccessToken'),
  confirmPresence: (args) => ipcRenderer.invoke('confirmPresence', args),
  logout: () => ipcRenderer.invoke('logout'),
  register: (creds) => ipcRenderer.invoke('register', creds),
  verify2fa: (args) => ipcRenderer.invoke('verify2fa', args),
  start2faSetup: () => ipcRenderer.invoke('start2faSetup'),
  enable2fa: (args) => ipcRenderer.invoke('enable2fa', args)
});