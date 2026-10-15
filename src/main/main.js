const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const path = require('path');
const store = require('./store');
const auth = require('./auth');
const git = require('./git');
const pkg = require('../../package.json');

let win = null;
let deviceFlow = null; // { flow, clientId, abort }

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: 'Git Sync',
    autoHideMenuBar: true,
    backgroundColor: themeBackground(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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

ipcMain.handle('repos:pull', (_e, repoPath) => git.pull(repoPath, store.getToken()));
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

nativeTheme.on('updated', () => win?.setBackgroundColor(themeBackground()));

app.whenReady().then(() => {
  const theme = store.get('theme', 'system');
  nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'system';
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
