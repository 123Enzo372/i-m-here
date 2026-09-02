const fs = require('fs');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const dotenv = require('dotenv');
const argon2 = require('argon2');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { init } = require('./db');
const path = require('path');
const crypto = require('crypto');
const speakeasy = require('speakeasy');

dotenv.config();

const PORT = process.env.PORT || 8443;
const DB_PATH = process.env.DB_PATH || './presence.db';
const SSL_CERT = process.env.SSL_CERT || './certs/cert.pem';
const SSL_KEY = process.env.SSL_KEY || './certs/key.pem';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DISCORD_2FA_WEBHOOK = process.env.DISCORD_2FA_WEBHOOK;
const ABSENCE_MINUTES = parseInt(process.env.ABSENCE_MINUTES || '10', 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10);
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret';
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY || null;

if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length !== 64) {
  console.error('ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Generate with: openssl rand -hex 32');
  process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');

if (!WEBHOOK_URL) {
  console.warn('WARNING: WEBHOOK_URL is not set. No Discord absence notifications will be sent.');
}
if (!DISCORD_2FA_WEBHOOK) {
  console.warn('WARNING: DISCORD_2FA_WEBHOOK is not set. 2FA via Discord will not work.');
}

const db = init(DB_PATH);

// Prepare statements
const insertUser = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const updateLastSeen = db.prepare('UPDATE users SET last_seen = ?, last_notified = 0 WHERE id = ?');
const updateFailedAttempts = db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?');
const insertToken = db.prepare('INSERT INTO refresh_tokens (user_id, jti_digest, device_info, ip, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)');
const getTokenByDigest = db.prepare('SELECT * FROM refresh_tokens WHERE jti_digest = ? AND revoked = 0');
const revokeTokenByDigest = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE jti_digest = ?');
const insertOtp = db.prepare('INSERT INTO otp_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)');
const getValidOtpForUser = db.prepare('SELECT * FROM otp_codes WHERE user_id = ? AND used = 0 AND expires_at > ?');
const markOtpUsed = db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?');
const setTwoFaForUser = db.prepare('UPDATE users SET twofa_enabled = ?, twofa_method = ?, twofa_secret_enc = ?, twofa_secret_iv = ? WHERE id = ?');
const getAbsentUsers = db.prepare('SELECT * FROM users WHERE (last_seen IS NULL OR last_seen < ?) AND (last_notified IS NULL OR last_notified < ?)');
const setLastNotified = db.prepare('UPDATE users SET last_notified = ? WHERE id = ?');

const app = express();

// Security middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'","data:"]
    }
  }
}));
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true
}));
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Helpers
function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([encrypted, tag]).toString('base64'), iv: iv.toString('base64') };
}

function decryptSecret(encBase64, ivBase64) {
  const iv = Buffer.from(ivBase64, 'base64');
  const data = Buffer.from(encBase64, 'base64');
  const tag = data.slice(data.length - 16);
  const encrypted = data.slice(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return dec.toString('utf8');
}

// Token creation / verification: refresh tokens are JWTs with jti. Store jti_digest = sha256(jti)
function createTokens(userId, deviceInfo = null, ip = null) {
  const access = jwt.sign({ sub: userId }, JWT_ACCESS_SECRET, { expiresIn: '5m' });
  const jti = uuidv4();
  const refresh = jwt.sign({ sub: userId, jti }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  const jtiDigest = sha256hex(jti);
  const now = Date.now();
  const expiresAt = now + 7 * 24 * 3600 * 1000;
  insertToken.run(userId, jtiDigest, deviceInfo, ip, now, expiresAt);
  return { accessToken: access, refreshToken: refresh };
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_ACCESS_SECRET);
  } catch (err) {
    return null;
  }
}
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (err) {
    return null;
  }
}

// Routes

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 8) {
    return res.status(400).json({ error: 'Nom d\'utilisateur ou mot de passe invalide (min 8 caractères).' });
  }
  const existing = getUserByUsername.get(username);
  if (existing) return res.status(409).json({ error: 'Utilisateur existe déjà' });

  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const id = uuidv4();
    const ts = Date.now();
    insertUser.run(id, username, hash, ts);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Login initial (password) -> if 2FA enabled respond requiring 2FA, else return tokens
app.post('/api/login', async (req, res) => {
  const { username, password, deviceInfo } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid_request' });

  const user = getUserByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    return res.status(403).json({ error: 'account_locked' });
  }

  try {
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) {
      const failed = (user.failed_attempts || 0) + 1;
      let lockedUntil = 0;
      if (failed >= 5) {
        lockedUntil = now + 15 * 60 * 1000;
      }
      updateFailedAttempts.run(failed, lockedUntil, user.id);
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // success -> reset failed attempts
    updateFailedAttempts.run(0, 0, user.id);

    // If 2FA is enabled for this user, start 2FA flow
    if (user.twofa_enabled) {
      // create a short-lived temp token to allow 2FA verification
      const tempToken = jwt.sign({ sub: user.id, t2: true }, JWT_ACCESS_SECRET, { expiresIn: '5m' });

      // If method = 'discord', generate numeric OTP, store hash, send to DISCORD_2FA_WEBHOOK
      if (user.twofa_method === 'discord') {
        if (!DISCORD_2FA_WEBHOOK) {
          return res.status(500).json({ error: '2fa_unavailable' });
        }
        // generate 6-digit code
        const code = (Math.floor(100000 + Math.random() * 900000)).toString();
        const codeHash = await argon2.hash(code, { type: argon2.argon2id });
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min
        insertOtp.run(user.id, codeHash, expiresAt, Date.now());

        // send to discord webhook (do NOT include secrets in logs)
        const payload = {
          username: 'Presence-2FA',
          embeds: [{
            title: 'Code 2FA',
            description: `Code pour l'utilisateur **${user.username}** : \`${code}\` (valable 5 minutes)`,
            timestamp: new Date().toISOString()
          }]
        };
        try {
          await fetch(DISCORD_2FA_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } catch (err) {
          console.error('Failed to send 2FA webhook', err);
          return res.status(500).json({ error: '2fa_send_failed' });
        }
      }

      return res.json({ twofa: true, tempToken, method: user.twofa_method });
    }

    // No 2FA -> issue tokens
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const tokens = createTokens(user.id, deviceInfo || null, ip);
    res.json({ ...tokens, user: { id: user.id, username: user.username } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// 2FA verify: exchange tempToken + code -> final access + refresh tokens
app.post('/api/2fa/verify', async (req, res) => {
  const { tempToken, code, deviceInfo } = req.body || {};
  if (!tempToken || !code) return res.status(400).json({ error: 'invalid_request' });

  try {
    const payload = jwt.verify(tempToken, JWT_ACCESS_SECRET);
    if (!payload || !payload.sub || !payload.t2) return res.status(401).json({ error: 'invalid_temp' });
    const user = getUserById.get(payload.sub);
    if (!user) return res.status(401).json({ error: 'no_user' });

    if (user.twofa_method === 'totp') {
      // decrypt secret
      if (!user.twofa_secret_enc || !user.twofa_secret_iv) return res.status(500).json({ error: '2fa_not_setup' });
      const secret = decryptSecret(user.twofa_secret_enc, user.twofa_secret_iv);
      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 1
      });
      if (!verified) return res.status(401).json({ error: 'invalid_2fa' });
    } else if (user.twofa_method === 'discord') {
      // find valid OTP entries and verify argon2 against the most recent
      const rows = getValidOtpForUser.all(user.id, Date.now());
      if (!rows || rows.length === 0) return res.status(401).json({ error: 'no_otp' });
      let matched = null;
      for (const r of rows) {
        try {
          if (await argon2.verify(r.code_hash, code)) { matched = r; break; }
        } catch (err) {
          // continue
        }
      }
      if (!matched) return res.status(401).json({ error: 'invalid_otp' });
      markOtpUsed.run(matched.id);
    } else {
      return res.status(400).json({ error: 'unsupported_2fa' });
    }

    // OK -> issue tokens
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const tokens = createTokens(user.id, deviceInfo || null, ip);
    res.json({ ...tokens, user: { id: user.id, username: user.username } });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'temp_expired' });
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Refresh endpoint (uses refresh JWT with jti)
app.post('/api/refresh', (req, res) => {
  const { refreshToken, deviceInfo } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'missing_refresh' });

  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return res.status(401).json({ error: 'invalid_refresh' });

  const jti = payload.jti;
  if (!jti) return res.status(401).json({ error: 'invalid_refresh' });
  const jtiDigest = sha256hex(jti);
  const tokenRow = getTokenByDigest.get(jtiDigest);
  if (!tokenRow) return res.status(401).json({ error: 'invalid_refresh' });
  if (tokenRow.revoked) return res.status(401).json({ error: 'revoked' });
  if (tokenRow.expires_at < Date.now()) return res.status(401).json({ error: 'expired' });

  // OK -> issue new access token (do not rotate refresh in this minimal example)
  const accessToken = jwt.sign({ sub: payload.sub }, JWT_ACCESS_SECRET, { expiresIn: '5m' });
  res.json({ accessToken });
});

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'no_token' });
  const token = auth.split(' ')[1];
  const payload = verifyAccessToken(token);
  if (!payload) return res.status(401).json({ error: 'invalid_token' });
  const user = getUserById.get(payload.sub);
  if (!user) return res.status(401).json({ error: 'no_user' });
  req.user = user;
  next();
}

// Confirm presence
app.post('/api/presence', authMiddleware, (req, res) => {
  const now = Date.now();
  updateLastSeen.run(now, req.user.id);
  res.json({ ok: true, last_seen: now });
});

// Get self info
app.get('/api/me', authMiddleware, (req, res) => {
  const u = getUserById.get(req.user.id);
  res.json({
    id: u.id, username: u.username, last_seen: u.last_seen,
    twofa_enabled: !!u.twofa_enabled, twofa_method: u.twofa_method || null
  });
});

// 2FA setup: generate secret + otpauth_url (auth required)
app.post('/api/2fa/setup', authMiddleware, (req, res) => {
  // generate secret
  const secret = speakeasy.generateSecret({ length: 20, name: `PresenceApp (${req.user.username})` });
  // return otpauth_url for QR (client shows QR)
  res.json({ otpauth_url: secret.otpauth_url, base32: secret.base32 });
});

// 2FA enable: verify code and persist encrypted secret + method
app.post('/api/2fa/enable', authMiddleware, async (req, res) => {
  const { base32Secret, code, method } = req.body || {};
  if (!base32Secret || !code || !method) return res.status(400).json({ error: 'invalid_request' });
  if (!['totp','discord'].includes(method)) return res.status(400).json({ error: 'invalid_method' });

  // verify TOTP code
  const verified = speakeasy.totp.verify({
    secret: base32Secret,
    encoding: 'base32',
    token: code,
    window: 1
  });
  if (!verified) return res.status(400).json({ error: 'invalid_2fa_code' });

  // encrypt secret and save user settings
  const { enc, iv } = encryptSecret(base32Secret);
  setTwoFaForUser.run(1, method, enc, iv, req.user.id);
  res.json({ ok: true });
});

// Background job: check absences and notify webhook
async function checkAbsences() {
  const cutoff = Date.now() - ABSENCE_MINUTES * 60 * 1000;
  const notifyCutoff = Date.now() - ABSENCE_MINUTES * 60 * 1000;
  const rows = getAbsentUsers.all(cutoff, notifyCutoff);
  for (const u of rows) {
    if (!WEBHOOK_URL) continue;
    const payload = {
      username: 'PresenceBot',
      embeds: [{
        title: 'Utilisateur absent',
        description: `L'utilisateur **${u.username}** n'a pas confirmé sa présence depuis plus de ${ABSENCE_MINUTES} minutes.`,
        timestamp: new Date().toISOString()
      }]
    };
    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setLastNotified.run(Date.now(), u.id);
      console.log(`Notified absence for ${u.username}`);
    } catch (err) {
      console.error('Failed to send webhook', err);
    }
  }
}

// Start HTTPS server (dev) or exit: in production use reverse-proxy TLS
function start() {
  if (!fs.existsSync(SSL_CERT) || !fs.existsSync(SSL_KEY)) {
    console.error('SSL cert or key not found. Create them or set correct SSL_CERT / SSL_KEY in .env');
    process.exit(1);
  }
  const options = {
    cert: fs.readFileSync(SSL_CERT),
    key: fs.readFileSync(SSL_KEY)
  };
  const server = https.createServer(options, app);
  server.listen(PORT, () => {
    console.log(`Server listening on https://localhost:${PORT}`);
  });

  setInterval(checkAbsences, CHECK_INTERVAL_SECONDS * 1000);
}

start();