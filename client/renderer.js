const SCREENS = [
  'screen-welcome',
  'screen-register',
  'screen-email',
  'screen-webhook',
  'screen-login',
  'screen-2fa',
  'screen-main',
  'screen-setup'
];

function showScreen(id, options = {}) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === id) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  const back = document.getElementById('btnBack');
  if (back) {
    if (id === 'screen-welcome') back.classList.add('hidden');
    else back.classList.remove('hidden');
  }

  if (options.focus) {
    const input = document.querySelector(`#${id} input`);
    if (input) input.focus();
  }

  if (id !== 'screen-setup') {
    const qr_block = document.getElementById('qr_block');
    if (qr_block) {
      qr_block.classList.add('hidden');
      const otpauth_txt = document.getElementById('otpauth_txt');
      if (otpauth_txt) otpauth_txt.classList.add('hidden');
    }
  }
}

function addClick(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
}

let tempTokenGlobal = null;
let webhookReturnScreen = 'screen-main';

function setSession(sessionPatch) {
  window.session = { ...(window.session || {}), ...sessionPatch };
  const welcome = document.getElementById('welcome');
  if (welcome && window.session.user) {
    welcome.textContent = `Bienvenue, ${window.session.user.username}`;
  }
}

function showNextRequiredScreen(user) {
  if (user && !user.email) {
    showScreen('screen-email', { focus: true });
    return;
  }

  showWebhookOrMain(user);
}

function showWebhookOrMain(user) {
  if (user && !user.has_discord_webhook) {
    webhookReturnScreen = 'screen-email';
    showScreen('screen-webhook', { focus: true });
    return;
  }

  showScreen('screen-main');
}

async function getCurrentAccessToken() {
  let token = window.session ? window.session.accessToken : null;
  if (token) return token;

  const r = await window.api.getAccessToken();
  if (r && r.accessToken) {
    window.session = window.session || {};
    window.session.accessToken = r.accessToken;
    return r.accessToken;
  }

  return null;
}

// --- Navigation ---
addClick('btnBack', () => {
  const activeEl = document.querySelector('.screen.active');
  const active = activeEl ? activeEl.id : 'screen-welcome';
  if (active === 'screen-register' || active === 'screen-login') showScreen('screen-welcome');
  else if (active === 'screen-email') showScreen('screen-welcome');
  else if (active === 'screen-webhook') showScreen(webhookReturnScreen, { focus: webhookReturnScreen !== 'screen-main' });
  else if (active === 'screen-2fa') showScreen('screen-login');
  else if (active === 'screen-setup') showScreen('screen-main');
  else showScreen('screen-welcome');
});

addClick('btnGetStarted', () => showScreen('screen-register', { focus: true }));
addClick('btnHaveAccount', () => showScreen('screen-login', { focus: true }));
addClick('btnToWelcomeFromRegister', () => showScreen('screen-welcome'));
addClick('btnToWelcomeFromLogin', () => showScreen('screen-welcome'));

// --- Inscription ---
addClick('btnRegister', async () => {
  const reg_msg = document.getElementById('reg_msg');
  if (reg_msg) reg_msg.textContent = '';
  const u = document.getElementById('reg_user').value.trim();
  const p = document.getElementById('reg_pass').value;

  if (!u || !p) {
    if (reg_msg) reg_msg.textContent = 'Remplissez tous les champs.';
    return;
  }

  try {
    const r = await window.api.register({ username: u, password: p });
    if (r && r.error) {
      if (reg_msg) reg_msg.textContent = 'Erreur: ' + r.error;
    } else {
      if (r && r.accessToken) {
        setSession({ accessToken: r.accessToken, user: r.user });
      }
      if (reg_msg) reg_msg.textContent = 'Compte créé avec succès !';
      setTimeout(() => showNextRequiredScreen(r.user), 800);
    }
  } catch (err) {
    if (reg_msg) reg_msg.textContent = 'Erreur IPC: ' + err.message;
  }
});

// --- Email ---
addClick('btnSaveEmail', async () => {
  const email_msg = document.getElementById('email_msg');
  if (email_msg) email_msg.textContent = '';
  const email = document.getElementById('email_input').value.trim();

  if (!email) {
    if (email_msg) email_msg.textContent = 'Veuillez saisir une adresse email.';
    return;
  }

  const token = await getCurrentAccessToken();
  if (!token) {
    if (email_msg) email_msg.textContent = 'Non authentifié.';
    return;
  }

  try {
    const r = await window.api.saveEmail({ email, accessToken: token });
    if (r && r.error) {
      if (email_msg) email_msg.textContent = 'Erreur: ' + r.error;
    } else {
      if (r && r.user) setSession({ user: r.user });
      if (email_msg) email_msg.textContent = 'Email enregistré avec succès !';
      setTimeout(() => {
        if (email_msg) email_msg.textContent = '';
        showNextRequiredScreen(r.user);
      }, 800);
    }
  } catch (err) {
    if (email_msg) email_msg.textContent = 'Erreur IPC: ' + err.message;
  }
});

addClick('btnSkipEmail', () => {
  const email_msg = document.getElementById('email_msg');
  if (email_msg) email_msg.textContent = '';
  showWebhookOrMain(window.session ? window.session.user : null);
});

// --- Discord Webhook ---
addClick('btnSaveWebhook', async () => {
  const webhook_msg = document.getElementById('webhook_msg');
  if (webhook_msg) webhook_msg.textContent = '';
  const webhookUrl = document.getElementById('webhook_input').value.trim();

  if (!webhookUrl) {
    if (webhook_msg) webhook_msg.textContent = 'Veuillez saisir un webhook Discord.';
    return;
  }

  const token = await getCurrentAccessToken();
  if (!token) {
    if (webhook_msg) webhook_msg.textContent = 'Non authentifié.';
    return;
  }

  try {
    const r = await window.api.saveDiscordWebhook({ webhookUrl, accessToken: token });
    if (r && r.error) {
      if (webhook_msg) webhook_msg.textContent = 'Erreur: ' + r.error;
      return;
    }

    if (r && r.user) setSession({ user: r.user });
    const webhook_input = document.getElementById('webhook_input');
    if (webhook_input) webhook_input.value = '';
    if (webhook_msg) webhook_msg.textContent = 'Webhook Discord enregistré avec succès !';
    setTimeout(() => {
      if (webhook_msg) webhook_msg.textContent = '';
      showScreen('screen-main');
    }, 800);
  } catch (err) {
    if (webhook_msg) webhook_msg.textContent = 'Erreur IPC: ' + err.message;
  }
});

// --- Connexion ---
addClick('btnLogin', async () => {
  const msg = document.getElementById('msg');
  if (msg) msg.textContent = '';
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;

  if (!u || !p) {
    if (msg) msg.textContent = 'Remplissez tous les champs.';
    return;
  }

  try {
    const r = await window.api.login({ username: u, password: p });

    if (!r) {
      if (msg) msg.textContent = 'Aucune réponse du serveur.';
      return;
    }

    if (r.error) {
      if (msg) msg.textContent = 'Erreur: ' + r.error;
      return;
    }

    if (r.twofa) {
      tempTokenGlobal = r.tempToken;
      const twofa_instr = document.getElementById('twofa_instr');
      if (twofa_instr) twofa_instr.textContent = 'Saisissez le code de votre application d\'authentification.';
      showScreen('screen-2fa', { focus: true });
      return;
    }

    setSession({ accessToken: r.accessToken, user: r.user });

    showNextRequiredScreen(r.user);
  } catch (err) {
    if (msg) msg.textContent = 'Erreur lors de la connexion: ' + err.message;
  }
});

// --- 2FA Login ---
addClick('btnVerify2FA', async () => {
  const twofa_msg = document.getElementById('twofa_msg');
  if (twofa_msg) twofa_msg.textContent = '';
  const code = document.getElementById('twofa_code').value.trim();
  if (!code) { if (twofa_msg) twofa_msg.textContent = 'Entrez le code 2FA'; return; }

  try {
    const r = await window.api.verify2fa({ tempToken: tempTokenGlobal, code });
    if (r && r.error) {
      if (twofa_msg) twofa_msg.textContent = 'Erreur: ' + r.error;
      return;
    }

    setSession({ accessToken: r.accessToken, user: r.user });
    tempTokenGlobal = null;

    showNextRequiredScreen(r.user);
  } catch (err) {
    if (twofa_msg) twofa_msg.textContent = 'Erreur IPC: ' + err.message;
  }
});

addClick('btnCancel2FA', () => { tempTokenGlobal = null; showScreen('screen-login'); });

// --- Presence / Logout ---
addClick('btnConfirm', async () => {
  const status = document.getElementById('status');
  if (status) status.textContent = '';
  if (!window.session || !window.session.accessToken) {
    const r = await window.api.getAccessToken();
    if (r && r.error) { if (status) status.textContent = 'Erreur d\'auth: ' + r.error; return; }
    if (!r || !r.accessToken) { if (status) status.textContent = 'Non authentifié.'; return; }
    window.session = window.session || {};
    window.session.accessToken = r.accessToken;
  }
  const r = await window.api.confirmPresence({ accessToken: window.session.accessToken });
  if (r && r.error) { if (status) status.textContent = 'Erreur: ' + r.error; return; }
  if (status) status.textContent = 'Présence confirmée : ' + new Date().toLocaleTimeString();
});

addClick('btnLogout', async () => {
  await window.api.logout();
  window.session = null;
  showScreen('screen-welcome');
});

addClick('btnEditWebhook', () => {
  const webhook_msg = document.getElementById('webhook_msg');
  if (webhook_msg) webhook_msg.textContent = '';
  webhookReturnScreen = 'screen-main';
  showScreen('screen-webhook', { focus: true });
});

// --- 2FA Setup ---
async function renderQrAndFallback(otpauth_url) {
  const imgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauth_url)}`;
  const qr_div = document.getElementById('qr');
  if (qr_div) qr_div.innerHTML = `<img src="${imgUrl}" alt="QR">`;

  const otpauth_txt = document.getElementById('otpauth_txt');
  if (otpauth_txt) {
    otpauth_txt.value = otpauth_url;
    otpauth_txt.classList.remove('hidden');
  }
  const qr_block = document.getElementById('qr_block');
  if (qr_block) qr_block.classList.remove('hidden');
}

async function setup2FA(method) {
  const status = document.getElementById('status');
  if (status) status.textContent = 'Initialisation 2FA...';

  try {
    let accessToken = window.session ? window.session.accessToken : null;

    if (!accessToken) {
      const tokenRes = await window.api.getAccessToken();
      if (tokenRes && tokenRes.accessToken) {
        accessToken = tokenRes.accessToken;
        window.session = window.session || {};
        window.session.accessToken = accessToken;
      }
    }

    const r = await window.api.start2faSetup({ accessToken });

    if (!r || r.error) {
      if (status) status.textContent = 'Erreur 2FA: ' + (r ? r.error : 'Pas de réponse');
      return;
    }

    if (status) status.textContent = '';
    showScreen('screen-setup', { focus: true });
    await renderQrAndFallback(r.otpauth_url);

    const qr_block = document.getElementById('qr_block');
    if (qr_block) {
      qr_block.dataset.base32 = r.base32;
      qr_block.dataset.method = method;
    }
  } catch (err) {
    if (status) status.textContent = 'Erreur IPC: ' + err.message;
  }
}

addClick('btnSetupTOTP', () => setup2FA('totp'));

addClick('btnConfirmSetup', async () => {
  const setup_msg = document.getElementById('setup_msg');
  const totp_code_input = document.getElementById('totp_code_input');
  const qr_block = document.getElementById('qr_block');
  const code = totp_code_input ? totp_code_input.value.trim() : '';
  const b32 = qr_block ? qr_block.dataset.base32 : null;
  const method = qr_block ? (qr_block.dataset.method || 'totp') : 'totp';
  const accessToken = window.session ? window.session.accessToken : null;

  if (!b32 || !code) {
    if (setup_msg) setup_msg.textContent = 'Scannez le QR et entrez le code TOTP.';
    return;
  }

  try {
    const r = await window.api.enable2fa({ base32Secret: b32, code, method, accessToken });
    if (r && r.error) {
      if (setup_msg) setup_msg.textContent = 'Erreur: ' + r.error;
      return;
    }

    if (r && r.user) setSession({ user: r.user });
    if (setup_msg) setup_msg.textContent = '2FA activée avec succès !';
    setTimeout(() => {
      if (qr_block) qr_block.classList.add('hidden');
      const qr_div = document.getElementById('qr');
      if (qr_div) qr_div.innerHTML = '';
      if (totp_code_input) totp_code_input.value = '';
      const otpauth_txt = document.getElementById('otpauth_txt');
      if (otpauth_txt) {
        otpauth_txt.value = '';
        otpauth_txt.classList.add('hidden');
      }
      if (setup_msg) setup_msg.textContent = '';
      showScreen('screen-main');
    }, 900);
  } catch (err) {
    if (setup_msg) setup_msg.textContent = 'Erreur IPC: ' + err.message;
  }
});

addClick('btnCancelSetup', () => {
  const qr_block = document.getElementById('qr_block');
  if (qr_block) qr_block.classList.add('hidden');
  const qr_div = document.getElementById('qr');
  if (qr_div) qr_div.innerHTML = '';
  const otpauth_txt = document.getElementById('otpauth_txt');
  if (otpauth_txt) {
    otpauth_txt.value = '';
    otpauth_txt.classList.add('hidden');
  }
  const totp_code_input = document.getElementById('totp_code_input');
  if (totp_code_input) totp_code_input.value = '';
  const setup_msg = document.getElementById('setup_msg');
  if (setup_msg) setup_msg.textContent = '';
  showScreen('screen-main');
});

showScreen('screen-welcome');
