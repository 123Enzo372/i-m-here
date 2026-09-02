// Gestion des écrans (navigation)
const SCREENS = [
  'screen-welcome',
  'screen-register',
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

// Fonction utilitaire sécurisée pour attacher les clics
function addClick(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
}

let tempTokenGlobal = null;
let lastLoginMethod = null;

// --- Navigation handlers ---
addClick('btnBack', () => {
  const activeEl = document.querySelector('.screen.active');
  const active = activeEl ? activeEl.id : 'screen-welcome';
  if (active === 'screen-register' || active === 'screen-login') showScreen('screen-welcome');
  else if (active === 'screen-2fa') showScreen('screen-login');
  else if (active === 'screen-setup') showScreen('screen-main');
  else showScreen('screen-welcome');
});

addClick('btnGetStarted', () => showScreen('screen-register', { focus: true }));
addClick('btnHaveAccount', () => showScreen('screen-login', { focus: true }));
addClick('btnToWelcomeFromRegister', () => showScreen('screen-welcome'));
addClick('btnToWelcomeFromLogin', () => showScreen('screen-welcome'));

// --- Register ---
addClick('btnRegister', async () => {
  const reg_msg = document.getElementById('reg_msg');
  if (reg_msg) reg_msg.textContent = '';
  const u = document.getElementById('reg_user').value.trim();
  const p = document.getElementById('reg_pass').value;
  if (!u || !p) { if (reg_msg) reg_msg.textContent = 'Remplissez tous les champs.'; return; }
  const r = await window.api.register({ username: u, password: p });
  if (r.error) { if (reg_msg) reg_msg.textContent = 'Erreur: ' + r.error; }
  else {
    if (reg_msg) reg_msg.textContent = 'Compte créé. Vous pouvez maintenant vous connecter.';
    setTimeout(() => showScreen('screen-login', { focus: true }), 800);
  }
});

// --- Login ---
addClick('btnLogin', async () => {
  const msg = document.getElementById('msg');
  if (msg) msg.textContent = '';
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if (!u || !p) { if (msg) msg.textContent = 'Remplissez tous les champs.'; return; }

  const r = await window.api.login({ username: u, password: p });
  if (r.error) { if (msg) msg.textContent = 'Erreur: ' + r.error; return; }

  if (r.twofa) {
    tempTokenGlobal = r.tempToken;
    lastLoginMethod = r.method;
    const twofa_instr = document.getElementById('twofa_instr');
    if (twofa_instr) twofa_instr.textContent = `Méthode 2FA: ${r.method}. Vérifiez votre application ou Discord.`;
    showScreen('screen-2fa', { focus: true });
    return;
  }

  window.session = { accessToken: r.accessToken, user: r.user };
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.textContent = `Bienvenue, ${r.user.username}`;
  showScreen('screen-main');
});

// --- 2FA verification ---
addClick('btnVerify2FA', async () => {
  const twofa_msg = document.getElementById('twofa_msg');
  if (twofa_msg) twofa_msg.textContent = '';
  const code = document.getElementById('twofa_code').value.trim();
  if (!code) { if (twofa_msg) twofa_msg.textContent = 'Entrez le code 2FA'; return; }
  const r = await window.api.verify2fa({ tempToken: tempTokenGlobal, code });
  if (r.error) { if (twofa_msg) twofa_msg.textContent = 'Erreur: ' + r.error; return; }
  
  window.session = { accessToken: r.accessToken, user: r.user };
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.textContent = `Bienvenue, ${r.user.username}`;
  tempTokenGlobal = null;
  showScreen('screen-main');
});

addClick('btnCancel2FA', () => { tempTokenGlobal = null; showScreen('screen-login'); });

// --- Main actions ---
addClick('btnConfirm', async () => {
  const status = document.getElementById('status');
  if (status) status.textContent = '';
  if (!window.session || !window.session.accessToken) {
    const r = await window.api.getAccessToken();
    if (r.error) { if (status) status.textContent = 'Erreur d\'auth: ' + r.error; return; }
    if (!r.accessToken) { if (status) status.textContent = 'Non authentifié.'; return; }
    window.session = window.session || {};
    window.session.accessToken = r.accessToken;
  }
  const r = await window.api.confirmPresence({ accessToken: window.session.accessToken });
  if (r.error) { if (status) status.textContent = 'Erreur: ' + r.error; return; }
  if (status) status.textContent = 'Présence confirmée : ' + new Date().toLocaleTimeString();
});

addClick('btnLogout', async () => {
  await window.api.logout();
  window.session = null;
  showScreen('screen-welcome');
});

// --- Setup 2FA ---
async function renderQrAndFallback(otpauth_url) {
  // Remplacement de l'API Google par api.qrserver.com
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

addClick('btnSetupTOTP', async () => {
  const setup_msg = document.getElementById('setup_msg');
  if (setup_msg) setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { if (setup_msg) setup_msg.textContent = 'Erreur: ' + r.error; return; }
  await renderQrAndFallback(r.otpauth_url);
  const qr_block = document.getElementById('qr_block');
  if (qr_block) {
    qr_block.dataset.base32 = r.base32;
    qr_block.dataset.method = 'totp';
  }
  showScreen('screen-setup', { focus: true });
});

addClick('btnSetupDiscord', async () => {
  const setup_msg = document.getElementById('setup_msg');
  if (setup_msg) setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { if (setup_msg) setup_msg.textContent = 'Erreur: ' + r.error; return; }
  await renderQrAndFallback(r.otpauth_url);
  const qr_block = document.getElementById('qr_block');
  if (qr_block) {
    qr_block.dataset.base32 = r.base32;
    qr_block.dataset.method = 'discord';
  }
  showScreen('screen-setup', { focus: true });
});

addClick('btnConfirmSetup', async () => {
  const setup_msg = document.getElementById('setup_msg');
  const totp_code_input = document.getElementById('totp_code_input');
  const qr_block = document.getElementById('qr_block');
  const code = totp_code_input ? totp_code_input.value.trim() : '';
  const b32 = qr_block ? qr_block.dataset.base32 : null;
  const method = qr_block ? (qr_block.dataset.method || 'totp') : 'totp';

  if (!b32 || !code) { if (setup_msg) setup_msg.textContent = 'Scannez le QR et entrez le code TOTP.'; return; }
  const r = await window.api.enable2fa({ base32Secret: b32, code, method });
  if (r.error) { if (setup_msg) setup_msg.textContent = 'Erreur: ' + r.error; return; }
  if (setup_msg) setup_msg.textContent = '2FA activée.';
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

// Écran initial
showScreen('screen-welcome');