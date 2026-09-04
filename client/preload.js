const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  register: (data) => ipcRenderer.invoke('register', data),
  login: (data) => ipcRenderer.invoke('login', data),
  saveEmail: (data) => ipcRenderer.invoke('saveEmail', data),
  saveDiscordWebhook: (data) => ipcRenderer.invoke('saveDiscordWebhook', data),
  verify2fa: (data) => ipcRenderer.invoke('verify2fa', data),
  getAccessToken: () => ipcRenderer.invoke('getAccessToken'),
  confirmPresence: (data) => ipcRenderer.invoke('confirmPresence', data),
  logout: () => ipcRenderer.invoke('logout'),
  start2faSetup: (data) => ipcRenderer.invoke('start2faSetup', data),
  enable2fa: (data) => ipcRenderer.invoke('enable2fa', data)
});
