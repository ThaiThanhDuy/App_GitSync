const {
  app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Tray, Menu, nativeImage, Notification,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const auth = require('./auth');
const git = require('./git');
const pkg = require('../../package.json');

let win = null;
let tray = null;
let quitting = false;
let trayState = { needSync: 0, total: 0 };
let deviceFlow = null; // { flow, clientId, abort }

const ASSETS = path.join(__dirname, '..', 'assets');
const startHidden = process.argv.includes('--hidden');

// Chỉ cho chạy một bản; mở lần hai → hiện cửa sổ đang chạy.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    // Chỉ hiện khi đã vẽ xong trang → không nháy khung trống lúc mở.
    show: false,
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: 'Git Sync',
    autoHideMenuBar: true,
    backgroundColor: themeBackground(),
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Tự kiểm tra theo chu kỳ phải chạy cả khi cửa sổ đang ẩn trong khay.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (show) win.once('ready-to-show', () => win.show());

  // Đóng cửa sổ → ẩn xuống khay (nếu bật), app vẫn chạy và tự kiểm tra.
  win.on('close', (e) => {
    if (quitting || !trayEnabled()) return;
    e.preventDefault();
    win.hide();
    if (!store.get('trayHintShown') && Notification.isSupported()) {
      store.set('trayHintShown', true);
      new Notification({
        title: 'Git Sync is still running',
        body: 'It keeps checking your repositories in the background. Quit from the tray icon.',
        icon: path.join(ASSETS, 'icon.png'),
      }).show();
    }
  });
  win.on('closed', () => { win = null; });

  // Link ngoài luôn mở bằng trình duyệt mặc định.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const THEMES = ['system', 'light', 'dark'];
// Khoảng thời gian tự kiểm tra (phút): tối thiểu 1, mặc định 5.
const CHECK_MIN = 1;
const CHECK_MAX = 1440;
const CHECK_DEFAULT = 5;
const checkInterval = () => {
  const n = Number(store.get('checkInterval', CHECK_DEFAULT));
  return Number.isInteger(n) && n >= CHECK_MIN && n <= CHECK_MAX ? n : CHECK_DEFAULT;
};
const trayEnabled = () => store.get('tray', true) !== false;

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Tray ----------
function trayImage() {
  return nativeImage.createFromPath(path.join(ASSETS, trayState.needSync ? 'tray-alert.png' : 'tray.png'));
}

function updateTray() {
  if (!tray) return;
  const { needSync, total } = trayState;
  tray.setImage(trayImage());
  tray.setToolTip(needSync ? `Git Sync — ${needSync}/${total} need sync` : `Git Sync — ${total} repos up to date`);
  const send = (cmd) => () => win?.webContents.send('tray:command', cmd);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Git Sync', click: showWindow },
    { type: 'separator' },
    { label: 'Check all now', click: send('checkAll') },
    { label: needSync ? `Sync all (${needSync})` : 'Sync all', enabled: needSync > 0, click: send('syncAll') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function setupTray() {
  if (!trayEnabled()) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(trayImage());
    tray.on('click', showWindow); // Windows; trên Linux (AppIndicator) click mở menu.
  }
  updateTray();
}

// ---------- Tự khởi động cùng hệ thống ----------
const autostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'git-sync-desktop.desktop');

function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(autostartFile());
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setAutostart(on) {
  if (process.platform === 'linux') {
    const file = autostartFile();
    if (!on) return fs.rmSync(file, { force: true });
    const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
    const exec = app.isPackaged ? q(process.execPath) : `${q(process.execPath)} ${q(app.getAppPath())}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Git Sync',
      `Exec=${exec} --hidden`,
      'Icon=git-sync-desktop',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } else {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  }
}

const themeBackground = () => (nativeTheme.shouldUseDarkColors ? '#0c0c0e' : '#fafafa');

function clientId() {
  return store.get('clientId') || auth.DEFAULT_CLIENT_ID;
}

async function finishLogin(token) {
  const user = await auth.fetchUser(token);
  store.setToken(token);
  store.set('user', user);
  return user;
}

// ---------- Auth ----------
// Thông tin đăng nhập đã lưu (không gọi mạng) để vào app ngay; kiểm tra token chạy ở nền.
ipcMain.handle('auth:cached', () => (store.getToken() && store.get('user') ? { user: store.get('user') } : null));

ipcMain.handle('auth:session', async () => {
  const token = store.getToken();
  if (!token) return null;
  try {
    const user = await auth.fetchUser(token);
    store.set('user', user);
    return { user };
  } catch (e) {
    // Mất mạng: vẫn cho vào app bằng thông tin đã lưu.
    if (e.offline && store.get('user')) return { user: store.get('user'), offline: true };
    store.setToken(null);
    return null;
  }
});

ipcMain.handle('auth:config', () => ({ clientId: clientId(), scopes: auth.SCOPES }));
ipcMain.handle('auth:setClientId', (_e, id) => store.set('clientId', String(id || '').trim()));

ipcMain.handle('auth:deviceStart', async () => {
  deviceFlow?.abort.abort();
  const id = clientId();
  const flow = await auth.startDeviceFlow(id);
  deviceFlow = { flow, clientId: id, abort: new AbortController() };
  clipboard.writeText(flow.user_code);
  shell.openExternal(flow.verification_uri);
  return { userCode: flow.user_code, verificationUri: flow.verification_uri, expiresIn: flow.expires_in };
});

ipcMain.handle('auth:deviceWait', async () => {
  if (!deviceFlow) throw new Error('Login has not been started');
  const current = deviceFlow;
  try {
    const token = await auth.pollDeviceFlow(current.clientId, current.flow, current.abort.signal);
    return await finishLogin(token);
  } finally {
    if (deviceFlow === current) deviceFlow = null;
  }
});

ipcMain.handle('auth:deviceCancel', () => {
  deviceFlow?.abort.abort();
  deviceFlow = null;
});

ipcMain.handle('auth:token', async (_e, token) => {
  token = String(token || '').trim();
  if (!token) throw new Error('Please enter a token');
  return finishLogin(token);
});

ipcMain.handle('auth:gh', async () => finishLogin(await auth.tokenFromGhCli()));

ipcMain.handle('auth:logout', () => {
  store.setToken(null);
  store.set('user', null);
});

// ---------- Repos ----------
// Mỗi repo lưu dạng { path, addedAt }. Bản cũ lưu chuỗi path → tự chuyển đổi (addedAt = null).
const repoList = () => store.get('repos', []).map((r) => (typeof r === 'string' ? { path: r, addedAt: null } : r));

ipcMain.handle('repos:list', () => repoList());

ipcMain.handle('repos:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a git folder',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (res.canceled) return { added: [], errors: [] };

  const repos = repoList();
  const added = [];
  const errors = [];
  for (const folder of res.filePaths) {
    try {
      const root = path.normalize(await git.resolveRepo(folder));
      if (repos.some((r) => r.path === root)) {
        errors.push(`${folder}: already in the list`);
        continue;
      }
      const repo = { path: root, addedAt: Date.now() };
      repos.push(repo);
      added.push(repo);
    } catch (e) {
      errors.push(`${folder}: ${e.message}`);
    }
  }
  store.set('repos', repos);
  return { added, errors };
});

ipcMain.handle('repos:remove', (_e, repoPath) => {
  store.set('repos', repoList().filter((r) => r.path !== repoPath));
});

ipcMain.handle('repos:status', (_e, repoPath, doFetch) =>
  git.getStatus(repoPath, { fetch: !!doFetch, token: store.getToken() }));

ipcMain.handle('repos:pull', (_e, repoPath, opts) => git.pull(repoPath, store.getToken(), { rebase: !!opts?.rebase }));
ipcMain.handle('repos:branches', (_e, repoPath) => git.branches(repoPath));
ipcMain.handle('repos:switch', (_e, repoPath, name, opts) => git.switchBranch(repoPath, String(name), { remote: !!opts?.remote }));
ipcMain.handle('repos:fileDiff', (_e, repoPath, hash, file, from) => git.fileDiff(repoPath, hash, file, from));
ipcMain.handle('repos:push', (_e, repoPath) => git.push(repoPath, store.getToken()));
ipcMain.handle('repos:changes', (_e, repoPath) => git.changes(repoPath));
ipcMain.handle('repos:log', (_e, repoPath, opts) => git.log(repoPath, opts));
ipcMain.handle('repos:commitDetail', (_e, repoPath, hash) => git.commitDetail(repoPath, hash));
ipcMain.handle('repos:commit', (_e, repoPath, message) => git.commitAll(repoPath, message));

ipcMain.handle('shell:openFolder', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openUrl', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
});

// ---------- Settings ----------
ipcMain.handle('settings:get', () => ({
  theme: nativeTheme.themeSource,
  version: pkg.version,
  checkInterval: checkInterval(),
  tray: trayEnabled(),
  autostart: getAutostart(),
  electron: process.versions.electron,
  platform: `${process.platform} ${process.arch}`,
}));

ipcMain.handle('settings:setTheme', (_e, theme) => {
  if (!THEMES.includes(theme)) return;
  // themeSource đổi luôn prefers-color-scheme của renderer và màu các hộp thoại hệ thống.
  nativeTheme.themeSource = theme;
  store.set('theme', theme);
});

ipcMain.handle('settings:setCheckInterval', (_e, minutes) => {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n)) return checkInterval();
  store.set('checkInterval', Math.min(CHECK_MAX, Math.max(CHECK_MIN, n)));
  return checkInterval();
});

ipcMain.handle('settings:setTray', (_e, on) => {
  store.set('tray', !!on);
  setupTray();
  return trayEnabled();
});

ipcMain.handle('settings:setAutostart', (_e, on) => {
  setAutostart(!!on);
  return getAutostart();
});

// Renderer báo số repo cần sync để cập nhật icon/menu khay.
ipcMain.on('tray:update', (_e, state) => {
  trayState = { needSync: Number(state?.needSync) || 0, total: Number(state?.total) || 0 };
  updateTray();
});

nativeTheme.on('updated', () => win?.setBackgroundColor(themeBackground()));

app.whenReady().then(() => {
  if (!primaryInstance) return;
  const theme = store.get('theme', 'system');
  nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'system';
  setupTray();
  // Khởi động cùng hệ thống (--hidden) → chạy ngầm trong khay, không bật cửa sổ.
  createWindow({ show: !(startHidden && tray) });
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
