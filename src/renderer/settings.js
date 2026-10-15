// ======================= Cài đặt =======================
// Dùng chung: $, api (renderer.js), switchView (history.js). Đăng xuất dùng lại nút #btn-logout.

function setThemeActive(theme) {
  for (const opt of document.querySelectorAll('.theme-opt')) {
    const active = opt.dataset.theme === theme;
    opt.classList.toggle('active', active);
    opt.setAttribute('aria-checked', active);
  }
}

async function openSettings() {
  const u = currentUser || {};
  $('#s-avatar').src = u.avatarUrl || '';
  $('#s-avatar').classList.toggle('hidden', !u.avatarUrl);
  $('#s-name').textContent = u.name || u.login || '';
  $('#s-login').textContent = u.login ? `@${u.login}` : '';

  const info = await api.settings.get();
  setThemeActive(info.theme);
  setIntervalInput(info.checkInterval);
  $('#s-tray').checked = info.tray;
  $('#s-autostart').checked = info.autostart;
  $('#s-version').textContent = `v${info.version}`;
  $('#s-runtime').textContent = `Electron ${info.electron} · ${info.platform}`;

  switchView('#main-view', '#settings-view', 'slide-in');
}

function closeSettings() {
  switchView('#settings-view', '#main-view', 'slide-back');
}

let themeTimer = null;
async function setTheme(theme) {
  setThemeActive(theme);
  // Bật transition màu tạm thời để đổi theme mượt, rồi tắt để không ảnh hưởng hover.
  document.documentElement.classList.add('theme-transition');
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => document.documentElement.classList.remove('theme-transition'), 400);
  await api.settings.setTheme(theme);
}

// ----- Thời gian tự kiểm tra -----
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 1440;
let intervalTimer = null;

function setIntervalInput(minutes) {
  $('#s-interval').value = minutes;
  $('#s-int-dec').disabled = minutes <= INTERVAL_MIN;
  $('#s-int-inc').disabled = minutes >= INTERVAL_MAX;
}

function readIntervalInput() {
  const n = Math.round(Number($('#s-interval').value));
  if (!Number.isFinite(n)) return checkMinutes;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, n));
}

// Lưu sau khi ngừng bấm/gõ một chút để không ghi file liên tục.
function saveInterval(delay = 400) {
  clearTimeout(intervalTimer);
  intervalTimer = setTimeout(async () => {
    const minutes = await api.settings.setCheckInterval(readIntervalInput());
    setIntervalInput(minutes);
    if (minutes === checkMinutes) return;
    scheduleAutoCheck(minutes);
    const box = $('.stepper');
    box.classList.remove('saved');
    void box.offsetWidth;
    box.classList.add('saved');
  }, delay);
}

function stepInterval(delta) {
  setIntervalInput(Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, readIntervalInput() + delta)));
  saveInterval();
}

$('#s-int-dec').addEventListener('click', () => stepInterval(-1));
$('#s-int-inc').addEventListener('click', () => stepInterval(1));
$('#s-interval').addEventListener('input', () => saveInterval(800));
$('#s-interval').addEventListener('change', () => {
  setIntervalInput(readIntervalInput());
  saveInterval(0);
});
$('#s-interval').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});

// ----- Chạy nền -----
$('#s-tray').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setTray(e.target.checked);
});
$('#s-autostart').addEventListener('change', async (e) => {
  try {
    e.target.checked = await api.settings.setAutostart(e.target.checked);
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(errMsg(err), 'bad');
  }
});

$('#btn-settings').addEventListener('click', openSettings);
$('#s-back').addEventListener('click', closeSettings);
$('#s-logout').addEventListener('click', () => $('#btn-logout').click());
for (const opt of document.querySelectorAll('.theme-opt')) {
  opt.addEventListener('click', () => setTheme(opt.dataset.theme));
}

document.addEventListener('keydown', (e) => {
  if ($('#settings-view').classList.contains('hidden') || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeSettings();
});
