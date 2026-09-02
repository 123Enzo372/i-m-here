require('dotenv').config();
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const keytar = require('keytar');
const fetch = require('node-fetch');
const https = require('https');
const nodemailer = require('nodemailer');

// Configuration du transporteur SMTP pour l'envoi d'emails
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Envoi de l'email d'inactivité
async function sendInactivityEmail(userEmail) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: userEmail,
      subject: process.env.INACTIVITY_EMAIL_SUBJECT || 'Absence détectée',
      text: process.env.INACTIVITY_EMAIL_MESSAGE || 'Bonjour, vous ne vous êtes pas connecté depuis plusieurs jours.',
    });
    console.log(`Mail d'inactivité envoyé avec succès à ${userEmail}`);
  } catch (error) {
    console.error(`Erreur lors de l'envoi du mail d'inactivité :`, error);
  }
}

// Vérification de l'inactivité globale
async function checkInactivity() {
  const inactivityDays = parseInt(process.env.INACTIVITY_DAYS, 10) || 7;
  const thresholdDate = new Date(Date.now() - inactivityDays * 24 * 60 * 60 * 1000);

  try {
    // Requête vers ton serveur backend pour récupérer et traiter les utilisateurs inactifs
    const resp = await customFetch(`${SERVER_ORIGIN}/api/check-inactivity`, {
      method: 'POST',
      body: JSON.stringify({ thresholdDate, inactivityDays }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (resp.ok) {
      const { inactiveUsers } = await resp.json();
      if (Array.isArray(inactiveUsers)) {
        for (const user of inactiveUsers) {
          if (user.email) {
            await sendInactivityEmail(user.email);
          }
        }
      }
    }
  } catch (err) {
    console.error('Erreur lors de la vérification de l\'inactivité :', err);
  }
}

// Ignorer les erreurs SSL pour node-fetch (certificat auto-signé en local)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const customFetch = (url, options = {}) => fetch(url, { ...options, agent: httpsAgent });

// Ignorer les erreurs SSL pour Chromium/Electron
app.commandLine.appendSwitch('ignore-certificate-errors');

const SERVICE_NAME = 'presence-app';
const REFRESH_TOKEN_KEY = 'refreshToken';
const SERVER_ORIGIN = 'https://localhost:8443';

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

  // Lance la vérification de l'inactivité au démarrage puis toutes les 24h
  checkInactivity();
  setInterval(checkInactivity, 24 * 60 * 60 * 1000);

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
    const resp = await customFetch(`${SERVER_ORIGIN}/api/register`, {
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

ipcMain.handle('start2faSetup', async () => {
  try {
    const refreshToken = await keytar.getPassword(SERVICE_NAME, REFRESH_TOKEN_KEY);
    if (!refreshToken) return { error: 'not_authenticated' };
    const r = await customFetch(`${SERVER_ORIGIN}/api/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const tokenData = await r.json();
    if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
    const accessToken = tokenData.accessToken;

    const resp = await customFetch(`${SERVER_ORIGIN}/api/2fa/setup`, {
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
    const r = await customFetch(`${SERVER_ORIGIN}/api/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const tokenData = await r.json();
    if (!r.ok) return { error: tokenData.error || 'refresh_failed' };
    const accessToken = tokenData.accessToken;

    const resp = await customFetch(`${SERVER_ORIGIN}/api/2fa/enable`, {
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