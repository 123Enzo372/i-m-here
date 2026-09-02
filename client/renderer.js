// UI handling (FR), simplified for clarity
const registerDiv = document.getElementById('register');
const loginDiv = document.getElementById('login');
const twofaDiv = document.getElementById('twofa_section');
const mainDiv = document.getElementById('main');

const btnShowLogin = document.getElementById('btnShowLogin');
const btnShowRegister = document.getElementById('btnShowRegister');
const btnRegister = document.getElementById('btnRegister');
const btnLogin = document.getElementById('btnLogin');
const btnConfirm = document.getElementById('btnConfirm');
const btnLogout = document.getElementById('btnLogout');

const reg_msg = document.getElementById('reg_msg');
const msg = document.getElementById('msg');
const status = document.getElementById('status');
const welcome = document.getElementById('welcome');

const twofa_code = document.getElementById('twofa_code');
const btnVerify2FA = document.getElementById('btnVerify2FA');
const btnCancel2FA = document.getElementById('btnCancel2FA');
const twofa_msg = document.getElementById('twofa_msg');

const btnSetupTOTP = document.getElementById('btnSetupTOTP');
const btnSetupDiscord = document.getElementById('btnSetupDiscord');
const qr_block = document.getElementById('qr_block');
const qr_div = document.getElementById('qr');
const totp_code_input = document.getElementById('totp_code_input');
const btnConfirmSetup = document.getElementById('btnConfirmSetup');
const btnCancelSetup = document.getElementById('btnCancelSetup');
const setup_msg = document.getElementById('setup_msg');

let tempTokenGlobal = null;

// Page toggles
btnShowLogin.addEventListener('click', () => {
  registerDiv.classList.add('hidden');
  loginDiv.classList.remove('hidden');
});
btnShowRegister.addEventListener('click', () => {
  loginDiv.classList.add('hidden');
  registerDiv.classList.remove('hidden');
});

// Register
btnRegister.addEventListener('click', async () => {
  reg_msg.textContent = '';
  const u = document.getElementById('reg_user').value;
  const p = document.getElementById('reg_pass').value;
  const r = await window.api.register({ username: u, password: p });
  if (r.error) reg_msg.textContent = 'Erreur: ' + r.error;
  else reg_msg.textContent = 'Compte créé. Connectez-vous.';
});

// Login
btnLogin.addEventListener('click', async () => {
  msg.textContent = '';
  const u = document.getElementById('username').value;
  const p = document.getElementById('password').value;
  const r = await window.api.login({ username: u, password: p });
  if (r.error) { msg.textContent = 'Erreur: ' + r.error; return; }

  if (r.twofa) {
    // show 2FA screen
    tempTokenGlobal = r.tempToken;
    loginDiv.classList.add('hidden');
    twofaDiv.classList.remove('hidden');
    twofa_msg.textContent = `Méthode 2FA: ${r.method}. Vérifiez votre application ou Discord.`;
    return;
  }

  // success
  window.session = { accessToken: r.accessToken, user: r.user };
  welcome.textContent = `Bienvenue, ${r.user.username}`;
  loginDiv.classList.add('hidden');
  mainDiv.classList.remove('hidden');
});

// 2FA verify
btnVerify2FA.addEventListener('click', async () => {
  twofa_msg.textContent = '';
  const code = twofa_code.value.trim();
  if (!code) { twofa_msg.textContent = 'Entrez le code 2FA'; return; }
  const r = await window.api.verify2fa({ tempToken: tempTokenGlobal, code });
  if (r.error) { twofa_msg.textContent = 'Erreur: ' + r.error; return; }

  window.session = { accessToken: r.accessToken, user: r.user };
  welcome.textContent = `Bienvenue, ${r.user.username}`;
  twofaDiv.classList.add('hidden');
  mainDiv.classList.remove('hidden');
});

// Cancel 2FA
btnCancel2FA.addEventListener('click', () => {
  twofaDiv.classList.add('hidden');
  loginDiv.classList.remove('hidden');
});

// Confirm presence
btnConfirm.addEventListener('click', async () => {
  status.textContent = '';
  if (!window.session || !window.session.accessToken) {
    const r = await window.api.getAccessToken();
    if (r.error) { status.textContent = 'Erreur d\'auth: ' + r.error; return; }
    window.session = window.session || {};
    window.session.accessToken = r.accessToken;
  }
  const r = await window.api.confirmPresence({ accessToken: window.session.accessToken });
  if (r.error) { status.textContent = 'Erreur: ' + r.error; return; }
  status.textContent = 'Présence confirmée : ' + new Date().toLocaleTimeString();
});

// Logout
btnLogout.addEventListener('click', async () => {
  await window.api.logout();
  window.session = null;
  mainDiv.classList.add('hidden');
  loginDiv.classList.remove('hidden');
});

// 2FA setup (TOTP)
btnSetupTOTP.addEventListener('click', async () => {
  setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  // Render QR using Google Charts API (or any QR library)
  const url = `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${encodeURIComponent(r.otpauth_url)}`;
  qr_div.innerHTML = `<img src="${url}" alt="QR">`;
  qr_block.classList.remove('hidden');
  // store base32 in data attr for confirm
  qr_block.dataset.base32 = r.base32;
});

// 2FA setup via Discord => same flow: generate TOTP secret, confirm it,
// but method will be set to 'discord' so that subsequent login triggers webhook codes.
btnSetupDiscord.addEventListener('click', async () => {
  setup_msg.textContent = '';
  const r = await window.api.start2faSetup();
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  const url = `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${encodeURIComponent(r.otpauth_url)}`;
  qr_div.innerHTML = `<img src="${url}" alt="QR">`;
  qr_block.classList.remove('hidden');
  qr_block.dataset.base32 = r.base32;
  // we will pass method='discord' when confirming
  qr_block.dataset.method = 'discord';
});

// Confirm activation after scanning
btnConfirmSetup.addEventListener('click', async () => {
  const code = totp_code_input.value.trim();
  const b32 = qr_block.dataset.base32;
  const method = qr_block.dataset.method || 'totp';
  if (!b32 || !code) { setup_msg.textContent = 'Scannez le QR et entrez le code TOTP.'; return; }
  const r = await window.api.enable2fa({ base32Secret: b32, code, method });
  if (r.error) { setup_msg.textContent = 'Erreur: ' + r.error; return; }
  setup_msg.textContent = '2FA activée.';
  setTimeout(() => { qr_block.classList.add('hidden'); }, 1000);
});

// Cancel setup
btnCancelSetup.addEventListener('click', () => {
  qr_block.classList.add('hidden');
  qr_div.innerHTML = '';
  totp_code_input.value = '';
  setup_msg.textContent = '';
});