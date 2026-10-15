// Đăng nhập GitHub theo các cách giống `gh auth login`:
//  1. Trình duyệt (OAuth Device Flow — nhập mã 8 ký tự trên github.com/login/device)
//  2. Dán Personal Access Token
//  3. Lấy token từ GitHub CLI (`gh auth token`) đã đăng nhập sẵn
const { execFile } = require('child_process');

// Client ID của GitHub OAuth App (bật "Enable Device Flow"). Có thể điền sẵn ở đây
// trước khi build, đặt biến môi trường GITHUB_CLIENT_ID, hoặc nhập trong màn hình đăng nhập.
const DEFAULT_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const SCOPES = 'repo read:org';
const UA = 'GitSyncDesktop';

async function fetchUser(token) {
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    });
  } catch (e) {
    const err = new Error('Could not connect to GitHub: ' + e.message);
    err.offline = true;
    throw err;
  }
  if (res.status === 401) throw new Error('Token is invalid or expired');
  if (!res.ok) throw new Error(`GitHub API returned error ${res.status}`);
  const u = await res.json();
  return { login: u.login, name: u.name, avatarUrl: u.avatar_url };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) throw new Error(`HTTP ${res.status}`);
  return json;
}

async function startDeviceFlow(clientId) {
  if (!clientId) throw new Error('OAuth Client ID is not configured (see "OAuth Client ID settings")');
  const j = await postJson('https://github.com/login/device/code', { client_id: clientId, scope: SCOPES });
  if (j.error) {
    if (j.error === 'device_flow_disabled') throw new Error('The OAuth App does not have "Enable Device Flow" turned on');
    throw new Error(j.error_description || j.error);
  }
  return j; // { device_code, user_code, verification_uri, expires_in, interval }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Login cancelled'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Login cancelled'));
    }, { once: true });
  });
}

async function pollDeviceFlow(clientId, flow, signal) {
  let interval = flow.interval || 5;
  const deadline = Date.now() + flow.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal);
    const j = await postJson('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: flow.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (j.access_token) return j.access_token;
    switch (j.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval = j.interval || interval + 5;
        break;
      case 'expired_token':
        throw new Error('The code has expired, please try again');
      case 'access_denied':
        throw new Error('Authorization was denied');
      default:
        throw new Error(j.error_description || j.error || 'Unknown error');
    }
  }
  throw new Error('The code has expired, please try again');
}

function tokenFromGhCli() {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('GitHub CLI (gh) not found in PATH'));
        return reject(new Error((stderr || err.message).trim() || 'gh is not logged in'));
      }
      const token = stdout.trim();
      if (!token) return reject(new Error('gh is not logged in (run: gh auth login)'));
      resolve(token);
    });
  });
}

module.exports = { DEFAULT_CLIENT_ID, SCOPES, fetchUser, startDeviceFlow, pollDeviceFlow, tokenFromGhCli };
