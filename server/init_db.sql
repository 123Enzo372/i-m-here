-- initialisation SQLite pour presence.db
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  failed_attempts INTEGER DEFAULT 0,
  locked_until INTEGER DEFAULT 0,
  twofa_enabled INTEGER DEFAULT 0,
  twofa_method TEXT DEFAULT NULL, -- 'totp' or 'discord'
  twofa_secret_enc BLOB DEFAULT NULL, -- encrypted TOTP secret (AES-GCM)
  twofa_secret_iv BLOB DEFAULT NULL,
  last_notified INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

-- Refresh tokens / sessions: store digest of jti, device and ip, expirations, revocation flag
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  jti_digest TEXT NOT NULL,
  device_info TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tokens_jti ON refresh_tokens(jti_digest);

-- OTP codes used for Discord-delivered codes (one-time codes)
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_codes(user_id);