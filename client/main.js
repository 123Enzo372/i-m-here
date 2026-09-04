const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const keytar = require('keytar');
const fetch = require('node-fetch');

const SERVER_ENV_PATH = process.env.PRESENCE_SERVER_ENV ||
  (app.isPackaged
    ? path.join(path.dirname(process.execPath), 'server.env')
    : path.join(__dirname, '..', 'server', '.env'));
process.env.PRESENCE_SERVER_ENV = SERVER_ENV_PATH;

function loadServerEnv(envPath) {
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadServerEnv(SERVER_ENV_PATH);

const SERVICE_NAME = 'presence-app';
const REFRESH_TOKEN_KEY = 'refreshToken';
const SERVER_PORT = process.env.PORT || 3000;
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;

const customFetch = (url, options = {}) => fetch(url, options);

app.commandLine.appendSwitch('ignore-certificate-errors');

function getServerEntryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'server.js');
  }

  return path.join(__dirname, '..', 'server', 'server.js');
}

function startInternalServer() {
  try {
    const serverEntry = getServerEntryPath();
    const serverModule = require(serverEntry);

    if (!serverModule || typeof serverModule.startServer !== 'function') {
      throw new Error('Le serveur interne n’exporte pas startServer().');
    }

    serverModule.startServer(SERVER_PORT);
    console.log('Serveur backend démarré en arrière-plan.');
  } catch (err) {
    console.error('Erreur lors du démarrage du serveur interne:', err);
  }
}

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
  startInternalServer();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Endpoints ---

ipcMain.handle('register', async (event, { username, password }) => {
  try {
    const resp = await customFetch(`${SERVER_ORIGIN}/api/register`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'register_failed' };

    if (data.refreshToken) {
      await keytar.setPassword(SERVICE_NAME, REFRESH_TOKEN_KEY, data.refreshToken);
    }

    return { ok: true, accessToken: data.accessToken, user: data.user };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('saveEmail', async (event, { email, accessToken }) => {
  try {
    const resp = await customFetch(`${SERVER_ORIGIN}/api/user/email`, {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'save_email_failed' };
    return { ok: true, user: data.user };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('saveDiscordWebhook', async (event, { webhookUrl, accessToken }) => {
  try {
    const resp = await customFetch(`${SERVER_ORIGIN}/api/user/discord-webhook`, {
      method: 'POST',
      body: JSON.stringify({ webhookUrl }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'save_webhook_failed' };
    return { ok: true, user: data.user };
  } catch (err) {
    console.error(err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('login', async (event, { username, password }) => {
  try {
    const resp = await customFetch(`${SERVER_ORIGIN}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ username, password, deviceInfo: `${process.platform} desktop` }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'login_failed' };

    if (data.twofa) {
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
    const resp = await customFetch(`${SERVER_ORIGIN}/api/2fa/verify`, {
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
    if (!refreshToken) return { error: null };
    const resp = await customFetch(`${SERVER_ORIGIN}/api/refresh`, {
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
    const resp = await customFetch(`${SERVER_ORIGIN}/api/presence`, {
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

ipcMain.handle('start2faSetup', async (event, { accessToken } = {}) => {
  try {
    let token = accessToken;

    if (!token) {
      const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
      if (!refreshToken) return { error: 'not_authenticated' };

      const r = await customFetch(`${SERVER_ORIGIN}/api/refresh`, {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        headers: { 'Content-Type': 'application/json' }
      });
      const tokenData = await r.json();
      if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
      token = tokenData.accessToken;
    }

    const resp = await customFetch(`${SERVER_ORIGIN}/api/2fa/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'start2fa_failed' };

    return { otpauth_url: data.otpauth_url, base32: data.base32 };
  } catch (err) {
    console.error('Erreur start2faSetup IPC:', err);
    return { error: 'network_error' };
  }
});

ipcMain.handle('enable2fa', async (event, { base32Secret, code, method, accessToken }) => {
  try {
    let token = accessToken;

    if (!token) {
      const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
      if (!refreshToken) return { error: 'not_authenticated' };

      const r = await customFetch(`${SERVER_ORIGIN}/api/refresh`, {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        headers: { 'Content-Type': 'application/json' }
      });
      const tokenData = await r.json();
      if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
      token = tokenData.accessToken;
    }

    const resp = await customFetch(`${SERVER_ORIGIN}/api/2fa/enable`, {
      method: 'POST',
      body: JSON.stringify({ base32Secret, code, method }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await resp.json();
    if (!resp.ok) return { error: data.error || 'enable_failed' };
    return { ok: true, user: data.user };
  } catch (err) {
    console.error('Erreur enable2fa IPC:', err);
    return { error: 'network_error' };
  }
});
