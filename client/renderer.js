// Gestion des écrans (navigation) + logique existante
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
  // back button visibility
  const back = document.getElementById('btnBack');
  if (id === 'screen-welcome') back.classList.add('hidden');
  else back.classList.remove('hidden');

  // callback hook
  if (options.focus) {
    const input = document.querySelector(`#${id} input`);
    if (input) input.focus();
  }
}

// --- Elements ---
const btnBack = document.getElementById('btnBack');

// Welcome
const btnGetStarted = document.getElementById('btnGetStarted');
const btnHaveAccount = document.getElementById('btnHaveAccount');

// Register
const btnRegister = document.getElementById('btnRegister');
const btnToWelcomeFromRegister = document.getElementById('btnToWelcomeFromRegister');
const reg_msg = document.getElementById('reg_msg');

// Login
const btnLogin = document.getElementById('btnLogin');
const btnToWelcomeFromLogin = document.getElementById('btnToWelcomeFromLogin');
const msg = document.getElementById('msg');

// 2FA
const btnVerify2FA = document.getElementById('btnVerify2FA');
const btnCancel2FA = document.getElementById('btnCancel2FA');
const twofa_msg = document.getElementById('twofa_msg');
const twofa_instr = document.getElementById('twofa_instr');

// Main
const btnConfirm = document.getElementById('btnConfirm');
const btnLogout = document.getElementById('btnLogout');
const welcome = document.getElementById('welcome');
const status = document.getElementById('status');

// Setup 2FA
const btnSetupTOTP = document.getElementById('btnSetupTOTP');
const btnSetupDiscord = document.getElementById('btnSetupDiscord');
const qr_block = document.getElementById('qr_block');
const qr_div = document.getElementById('qr');
const totp_code_input = document.getElementById('totp_code_input');
const btnConfirmSetup = document.getElementById('btnConfirmSetup');
const btnCancelSetup = document.getElementById('btnCancelSetup');
const setup_msg = document.getElementById('setup_msg');

let tempTokenGlobal = null;
let lastLoginMethod = null;

// --- Navigation handlers ---
btnBack.addEventListener('click', () => {
  // If on 2FA or login, go back to welcome or login depending
  const active = document.querySelector('.screen.active').id;
  if (active === 'screen-register') showScreen('screen-welcome');
  else if (active === 'screen-login') showScreen('screen-welcome');
  else if (active === 'screen-2fa') showScreen('screen-login');
  else if (active === 'screen-setup') showScreen('screen-main');
  else showScreen('screen-welcome');
});

btnGetStarted.addEventListener('click', () => showScreen('screen-register', { focus: true }));
btnHaveAccount.addEventListener('click', () => showScreen('screen-login', { focus: true }));
btnToWelcomeFromRegister.addEventListener('click', () => showScreen('screen-welcome'));
btnToWelcomeFromLogin.addEventListener('click', () => showScreen('screen-welcome'));

// --- Register ---
btnRegister.addEventListener('click', async () => {
  reg_msg.textContent = '';
  const u = document.getElementById('reg_user').value.trim();
  const p = document.getElementById('reg_pass').value;
  if (!u || !p) { reg_msg.textContent = 'Remplissez tous les champs.'; return; }
  const r = await window.api.register({ username: u, password: p });
  if (r.error) reg_msg.textContent = 'Erreur: ' + r.error;
  else {
    reg_msg.textContent = 'Compte créé. Vous pouvez maintenant vous connecter.';
    setTimeout(() => showScreen('screen-login', { focus: true }), 800);
  }
});

// --- Login ---
btnLogin.addEventListener('click', async () => {
  msg.textContent = '';
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if (!u || !p) { msg.textContent = 'Remplissez tous les champs.'; return; }

  const r = await window.api.login({ username: u, password: p });
  if (r.error) { msg.textContent = 'Erreur: ' + r.error; return; }

  if (r.twofa) {
    tempTokenGlobal = r.tempToken;
    lastLoginMethod = r.method;
    twofa_instr.textContent = `Méthode 2FA: ${r.method}. Vérifiez votre application ou Discord.`;
    showScreen('screen-2fa', { focus: true });
    return;
  }

  // success (no 2FA)
  window.session = { accessToken: r.accessToken, user: r.user };
  welcome.textContent = `Bienvenue, ${r.user.username}`;
  showScreen('screen-main');
});

// --- 2FA verification ---
btnVerify2FA.addEventListener('click', async () => {
  twofa_msg.textContent = '';
  const code = document.getElementById('twofa_code').value.trim();
  if (!code) { twofa_msg.textContent = 'Entrez le code 2FA'; return; }
  const r = await window.api.verify2fa({ tempToken: tempTokenGlobal, code });
  if (r.error) { twofa_msg.textContent = 'Erreur: ' + r.error; return; }
  // success
  window.session = { accessToken: r.accessToken, user: r.user };
  welcome.textContent = `Bienvenue, ${r.user.username}`;
  tempTokenGlobal = null;
  showScreen('screen-main');
});

btnCancel2FA.addEventListener('click', () => { tempTokenGlobal = null; showScreen('screen-login'); });

// --- Main actions ---
btnConfirm.addEventListener('click', async () => {
  status.textContent = '';
  if (!window.session || !window.session.accessToken) {
    const r = await window.api.getAccessToken();
    if (r.error) { status.textContent = 'Erreur d\'auth: ' + r.error; return; }
    if (!r.accessToken) { status.textContent = 'Non authentifié.'; return; }
    window.session = window.session || {};
    window.session.accessToken = r.accessToken;
  }
  const r = await window.api.confirmPresence({ accessToken: window.session.accessToken });
  if (r.error) { status.textContent = 'Erreur: ' + r.error; return; }
  status.textContent = 'Présence confirmée : ' + new Date().toLocaleTimeString();
});

btnLogout.addEventListener('click', async () => {
  await window.api.logout();
  window.session = null;
  showScreen('screen-welcome');
});

// --- Setup 2FA ---
btnSetupTOTP.addEventListener('click', async () => {
  setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  const url = `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${encodeURIComponent(r.otpauth_url)}`;
  qr_div.innerHTML = `<img src="${url}" alt="QR">`;
  qr_block.classList.remove('hidden');
  qr_block.dataset.base32 = r.base32;
  qr_block.dataset.method = 'totp';
  showScreen('screen-setup', { focus: true });
});

btnSetupDiscord.addEventListener('click', async () => {
  setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  const url = `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${encodeURIComponent(r.otpauth_url)}`;
  qr_div.innerHTML = `<img src="${url}" alt="QR">`;
  qr_block.classList.remove('hidden');
  qr_block.dataset.base32 = r.base32;
  qr_block.dataset.method = 'discord';
  showScreen('screen-setup', { focus: true });
});

btnConfirmSetup.addEventListener('click', async () => {
  const code = totp_code_input.value.trim();
  const b32 = qr_block.dataset.base32;
  const method = qr_block.dataset.method || 'totp';
  if (!b32 || !code) { setup_msg.textContent = 'Scannez le QR et entrez le code TOTP.'; return; }
  const r = await window.api.enable2fa({ base32Secret: b32, code, method });
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  setup_msg.textContent = '2FA activée.';
  setTimeout(() => {
    qr_block.classList.add('hidden');
    totp_code_input.value = '';
    setup_msg.textContent = '';
    showScreen('screen-main');
  }, 900);
});

btnCancelSetup.addEventListener('click', () => {
  qr_block.classList.add('hidden');
  qr_div.innerHTML = '';
  totp_code_input.value = '';
  setup_msg.textContent = '';
  showScreen('screen-main');
});

// Initial screen
showScreen('screen-welcome');