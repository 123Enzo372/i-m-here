const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const keytar = require('keytar');
const fetch = require('node-fetch');

const SERVICE_NAME = 'presence-app';
const REFRESH_TOKEN_KEY = 'refreshToken';
const SERVER_ORIGIN = 'https://localhost:8443'; // adapt if using reverse proxy

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC endpoints

ipcMain.handle('register', async (event, { username, password }) => {
  try {
    const resp = await fetch(`${SERVER_ORIGIN}/api/register`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'register_failed' };
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('login', async (event, { username, password }) => {
  try {
    const resp = await fetch(`${SERVER_ORIGIN}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ username, password, deviceInfo: `${process.platform} desktop` }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'login_failed' };

    if (data.twofa) {
      // 2FA required: return tempToken for verification
      return { twofa: true, tempToken: data.tempToken, method: data.method };
    }

    if (data.refreshToken) {
      await keytar.setPassword(SERVICE_NAME, REFRESH_TOKEN_KEY, data.refreshToken);
    }
    return { accessToken: data.accessToken, user: data.user };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('verify2fa', async (event, { tempToken, code }) => {
  try {
    const resp = await fetch(`${SERVER_ORIGIN}/api/2fa/verify`, {
      method: 'POST',
      body: JSON.stringify({ tempToken, code, deviceInfo: `${process.platform} desktop` }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'verify_failed' };
    if (data.refreshToken) {
      await keytar.setPassword(SERVICE_NAME, REFRESH_TOKEN_KEY, data.refreshToken);
    }
    return { accessToken: data.accessToken, user: data.user, refreshToken: data.refreshToken };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('getAccessToken', async () => {
  try {
    const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
    if (!refreshToken) return { error: 'no_refresh' };
    const resp = await fetch(`${SERVER_ORIGIN}/api/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'refresh_failed' };
    return { accessToken: data.accessToken };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('confirmPresence', async (event, { accessToken }) => {
  try {
    const resp = await fetch(`${SERVER_ORIGIN}/api/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'presence_failed' };
    return { ok: true, last_seen: data.last_seen };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('logout', async () => {
  try {
    await keytar.deletePassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { error: 'logout_failed' };
  }
});

// 2FA setup: request otpauth_url from server
ipcMain.handle('start2faSetup', async () => {
  try {
    // require authentication: for simplicity we use stored refresh token to get access token,
    // then call the protected endpoint. In a robust client you'd keep accessToken in memory.
    const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
    if (!refreshToken) return { error: 'not_authenticated' };
    const r = await fetch(`${SERVER_ORIGIN}/api/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const tokenData = await r.json();
    if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
    const accessToken = tokenData.accessToken;

    const resp = await fetch(`${SERVER_ORIGIN}/api/2fa/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'start2fa_failed' };
    return { otpauth_url: data.otpauth_url, base32: data.base32 };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('enable2fa', async (event, { base32Secret, code, method }) => {
  try {
    const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
    if (!refreshToken) return { error: 'not_authenticated' };
    const r = await fetch(`${SERVER_ORIGIN}/api/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const tokenData = await r.json();
    if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
    const accessToken = tokenData.accessToken;

    const resp = await fetch(`${SERVER_ORIGIN}/api/2fa/enable`, {
      method: 'POST',
      body: JSON.stringify({ base32Secret, code, method }),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'enable_failed' };
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});