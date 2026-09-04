const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const speakeasy = require('speakeasy');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: process.env.PRESENCE_SERVER_ENV || path.join(__dirname, '.env') });

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  const message = 'SUPABASE_URL et SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_ROLE_KEY sont requis dans server/.env.';
  if (require.main === module) {
    console.error(message);
    process.exit(1);
  }
  throw new Error(message);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'secret_key_de_test';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '24h';
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS || '30', 10);
const TEMP_2FA_TTL = process.env.TEMP_2FA_TTL || '10m';
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'Presence';
const DAY_MS = 24 * 60 * 60 * 1000;

function readInactivityDays() {
  const days = parseInt(process.env.INACTIVITY_DAYS, 10);
  return Number.isNaN(days) ? 7 : days;
}

function redactEmail(email) {
  return email ? email.replace(/(^.).*(@.*$)/, '$1***$2') : null;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getInactiveDays(lastSeen) {
  return Math.floor((Date.now() - Number(lastSeen)) / DAY_MS);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || null,
    has_discord_webhook: Boolean(user.discord_webhook_url),
    twofa_enabled: Boolean(user.twofa_enabled),
    twofa_method: user.twofa_enabled ? 'totp' : null,
    last_seen: user.last_seen || null
  };
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, scope: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getEncryptionKey() {
  const raw = process.env.TWOFA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || JWT_SECRET;
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    encrypted: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    iv: iv.toString('base64')
  };
}

function decryptSecret(secretEnc, iv) {
  if (!secretEnc || !iv) return null;
  const raw = Buffer.from(secretEnc, 'base64');
  const authTag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function getUserByUsername(username) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateUserById(id, values) {
  const { data, error } = await supabase
    .from('users')
    .update(values)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function createRefreshToken(userId, deviceInfo, ip) {
  const jti = uuidv4();
  const now = Date.now();
  const expiresAt = now + REFRESH_TOKEN_DAYS * DAY_MS;
  const refreshToken = jwt.sign(
    { id: userId, jti, scope: 'refresh' },
    JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_DAYS}d` }
  );

  const { error } = await supabase.from('refresh_tokens').insert({
    user_id: userId,
    jti_digest: sha256(jti),
    device_info: deviceInfo || null,
    ip: ip || null,
    created_at: now,
    expires_at: expiresAt,
    revoked: false
  });

  if (error) throw error;
  return refreshToken;
}

async function issueSession(user, deviceInfo, ip) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: await createRefreshToken(user.id, deviceInfo, ip),
    user: publicUser(user)
  };
}

function verifyTotp(secret, code) {
  const token = String(code || '').trim();
  if (!/^\d{6}$/.test(token)) return false;

  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    step: 30,
    window: 0,
    time: Math.floor(Date.now() / 1000)
  });
}

function isValidDiscordWebhookUrl(value) {
  if (!value || typeof value !== 'string') return false;

  try {
    const url = new URL(value.trim());
    const isDiscordHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
    return url.protocol === 'https:' &&
      isDiscordHost &&
      /^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname);
  } catch (err) {
    return false;
  }
}

async function backfillDefaultWebhookForExistingUsers() {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!isValidDiscordWebhookUrl(webhookUrl)) return;

  const { error } = await supabase
    .from('users')
    .update({ discord_webhook_url: webhookUrl.trim() })
    .is('discord_webhook_url', null);

  if (error) {
    console.warn('[DISCORD] Impossible d’appliquer le webhook par défaut aux comptes existants:', error.message);
  }
}

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendDiscordInactivityMessage(user, inactiveDays) {
  const webhookUrl = user.discord_webhook_url || process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(`[DISCORD] Webhook absent pour ${user.username}, message d’inactivité non envoyé.`);
    return false;
  }

  const dayLabel = inactiveDays > 1 ? 'jours' : 'jour';
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'PresenceBot',
      embeds: [{
        title: 'Inactivité détectée',
        description: `${user.username} est inactif depuis ${inactiveDays} ${dayLabel}.`,
        fields: [
          { name: 'Utilisateur', value: user.username, inline: true },
          { name: 'Inactivité', value: `${inactiveDays} ${dayLabel}`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook HTTP ${response.status}`);
  }

  return true;
}

async function sendDiscordWebhookSetupMessage(webhookUrl, username) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'PresenceBot',
      embeds: [{
        title: 'Webhook configuré',
        description: `Les rappels d'inactivité de ${username} seront envoyés ici.`,
        timestamp: new Date().toISOString()
      }]
    })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook HTTP ${response.status}`);
  }
}

async function sendInactivityEmail(user) {
  if (!user.email) return false;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`[CRON] SMTP non configuré, mail J+${readInactivityDays()} non envoyé à ${redactEmail(user.email)}.`);
    return false;
  }

  await mailer.sendMail({
    from: `"Presence App" <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: process.env.INACTIVITY_EMAIL_SUBJECT || 'Absence détectée',
    text: process.env.INACTIVITY_EMAIL_MESSAGE || 'Bonjour, vous ne vous êtes pas connecté depuis plusieurs jours.'
  });

  return true;
}

async function processInactiveUsers() {
  const maxInactivityDays = readInactivityDays();
  const todayStart = startOfToday();
  const { data: users, error } = await supabase
    .from('users')
    .select('id, username, email, discord_webhook_url, last_seen, last_notified')
    .not('last_seen', 'is', null)
    .eq('notifications_disabled', false);

  if (error) throw error;

  for (const user of users || []) {
    const inactiveDays = getInactiveDays(user.last_seen);

    if (inactiveDays > maxInactivityDays) {
      await updateUserById(user.id, { notifications_disabled: true });
      continue;
    }

    if (inactiveDays < 1 || inactiveDays > maxInactivityDays) {
      continue;
    }

    if ((Number(user.last_notified) || 0) < todayStart) {
      try {
        if (await sendDiscordInactivityMessage(user, inactiveDays)) {
          await updateUserById(user.id, { last_notified: Date.now() });
        }
      } catch (err) {
        console.error(`[DISCORD] Erreur message inactivité (${user.username}):`, err.message);
      }
    }

    if (inactiveDays >= maxInactivityDays) {
      try {
        await sendInactivityEmail(user);
        await updateUserById(user.id, {
          notifications_disabled: true,
          last_email_sent: Date.now()
        });
      } catch (err) {
        console.error(`[CRON] Erreur mail (${redactEmail(user.email)}):`, err.message);
      }
    }
  }
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Accès non autorisé' });

  try {
    const tokenPayload = jwt.verify(token, JWT_SECRET);
    if (tokenPayload.scope !== 'access') {
      return res.status(403).json({ error: 'Token invalide ou expiré' });
    }

    const user = await getUserById(tokenPayload.id);
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });

    req.user = await updateUserById(tokenPayload.id, {
      last_seen: Date.now(),
      notifications_disabled: false
    });
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token invalide ou expiré' });
  }
}

app.post('/api/register', async (req, res) => {
  const { username, password, deviceInfo } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }

  try {
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Ce nom d\'utilisateur est déjà pris' });
    }

    const now = Date.now();
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        id: uuidv4(),
        username,
        password_hash: await argon2.hash(password),
        created_at: now,
        last_seen: now
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ message: 'Compte créé avec succès', ...(await issueSession(user, deviceInfo, req.ip)) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, deviceInfo } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  }

  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(400).json({ error: 'Identifiants incorrects' });
    }

    const validPassword = await argon2.verify(user.password_hash, password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Identifiants incorrects' });
    }

    const updatedUser = await updateUserById(user.id, {
      last_seen: Date.now(),
      notifications_disabled: false
    });

    if (updatedUser.twofa_enabled) {
      const tempToken = jwt.sign(
        { id: updatedUser.id, username: updatedUser.username, scope: '2fa' },
        JWT_SECRET,
        { expiresIn: TEMP_2FA_TTL }
      );
      return res.json({ twofa: true, tempToken, method: 'totp' });
    }

    return res.json({ message: 'Connexion réussie', ...(await issueSession(updatedUser, deviceInfo, req.ip)) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

app.post('/api/user/email', verifyToken, async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse e-mail invalide' });
  }

  try {
    const user = await updateUserById(req.user.id, { email, email_verified: true });
    return res.json({ message: 'Adresse email enregistrée avec succès', user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

app.post('/api/user/discord-webhook', verifyToken, async (req, res) => {
  const { webhookUrl } = req.body;

  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    return res.status(400).json({ error: 'Webhook Discord invalide' });
  }

  try {
    const normalizedWebhookUrl = webhookUrl.trim();
    await sendDiscordWebhookSetupMessage(normalizedWebhookUrl, req.user.username);

    const user = await updateUserById(req.user.id, { discord_webhook_url: normalizedWebhookUrl });
    return res.json({ message: 'Webhook Discord enregistré avec succès', user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: 'Impossible d’envoyer un message sur ce webhook' });
  }
});

cron.schedule('0 0 * * *', () => {
  console.log('[CRON] Vérification des comptes inactifs...');
  processInactiveUsers().catch(err => {
    console.error('[CRON] Erreur lors de la vérification d’inactivité:', err.message);
  });
});

app.post('/api/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token requis' });

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.scope !== 'refresh' || !payload.jti) {
      return res.status(403).json({ error: 'Refresh token invalide' });
    }

    const { data: tokenRow, error } = await supabase
      .from('refresh_tokens')
      .select('*')
      .eq('user_id', payload.id)
      .eq('jti_digest', sha256(payload.jti))
      .eq('revoked', false)
      .gt('expires_at', Date.now())
      .maybeSingle();

    if (error) throw error;
    if (!tokenRow) return res.status(403).json({ error: 'Session expirée' });

    const user = await getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });

    return res.json({ accessToken: signAccessToken(user), user: publicUser(user) });
  } catch (err) {
    return res.status(403).json({ error: 'Refresh token invalide' });
  }
});

app.post('/api/presence', verifyToken, async (req, res) => {
  try {
    const lastSeen = Date.now();
    await updateUserById(req.user.id, {
      last_seen: lastSeen,
      notifications_disabled: false
    });

    return res.json({ ok: true, last_seen: lastSeen });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de la confirmation de présence' });
  }
});

app.post('/api/2fa/setup', verifyToken, (req, res) => {
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${TOTP_ISSUER} (${req.user.username})`,
    issuer: TOTP_ISSUER
  });

  return res.json({
    base32: secret.base32,
    otpauth_url: secret.otpauth_url
  });
});

app.post('/api/2fa/enable', verifyToken, async (req, res) => {
  const { base32Secret, code } = req.body;

  if (!base32Secret || !code) {
    return res.status(400).json({ error: 'Secret et code requis' });
  }

  if (!verifyTotp(base32Secret, code)) {
    return res.status(400).json({ error: 'Code TOTP invalide' });
  }

  try {
    const { encrypted, iv } = encryptSecret(base32Secret);
    const user = await updateUserById(req.user.id, {
      twofa_enabled: true,
      twofa_method: 'totp',
      twofa_secret_enc: encrypted,
      twofa_secret_iv: iv
    });

    return res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de l’activation 2FA' });
  }
});

app.post('/api/2fa/verify', async (req, res) => {
  const { tempToken, code, deviceInfo } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'Token temporaire et code requis' });

  try {
    const payload = jwt.verify(tempToken, JWT_SECRET);
    if (payload.scope !== '2fa') return res.status(403).json({ error: 'Token 2FA invalide' });

    const user = await getUserById(payload.id);
    if (!user || !user.twofa_enabled) return res.status(403).json({ error: '2FA non activée' });

    const secret = decryptSecret(user.twofa_secret_enc, user.twofa_secret_iv);
    if (!secret || !verifyTotp(secret, code)) {
      return res.status(400).json({ error: 'Code 2FA invalide' });
    }

    const freshUser = await updateUserById(user.id, {
      last_seen: Date.now(),
      notifications_disabled: false
    });

    return res.json(await issueSession(freshUser, deviceInfo, req.ip));
  } catch (err) {
    console.error(err);
    return res.status(403).json({ error: 'Token 2FA invalide ou expiré' });
  }
});

app.post('/api/check-inactivity', async (req, res) => {
  const { thresholdDate, inactivityDays } = req.body;
  const parsedThreshold = thresholdDate ? new Date(thresholdDate).getTime() : NaN;
  const parsedDays = parseInt(inactivityDays, 10);
  const fallbackDays = Number.isNaN(parsedDays) ? readInactivityDays() : parsedDays;
  const threshold = Number.isFinite(parsedThreshold)
    ? parsedThreshold
    : Date.now() - fallbackDays * DAY_MS;

  try {
    const { data: inactiveUsers, error } = await supabase
      .from('users')
      .select('id, username, email, last_seen')
      .not('last_seen', 'is', null)
      .lt('last_seen', threshold)
      .eq('notifications_disabled', false);

    if (error) throw error;
    return res.json({ inactiveUsers: inactiveUsers || [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur lors de la vérification de l’inactivité' });
  }
});

const PORT = process.env.PORT || 3000;
let serverInstance = null;
let startupJobsStarted = false;

function runStartupJobs() {
  if (startupJobsStarted) return;
  startupJobsStarted = true;

  backfillDefaultWebhookForExistingUsers().catch(err => {
    console.error('[DISCORD] Erreur lors de l’application du webhook par défaut:', err.message);
  });
  processInactiveUsers().catch(err => {
    console.error('[CRON] Erreur lors de la vérification d’inactivité au démarrage:', err.message);
  });
}

function startServer(port = PORT) {
  if (serverInstance) return serverInstance;

  serverInstance = app.listen(port, () => {
    console.log(`Serveur démarré sur le port ${port}`);
    runStartupJobs();
  });

  serverInstance.on('error', err => {
    serverInstance = null;
    console.error(`[SERVER] Impossible de démarrer sur le port ${port}:`, err.message);
  });

  return serverInstance;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  processInactiveUsers
};
