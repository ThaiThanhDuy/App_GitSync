// Lưu cấu hình vào <userData>/settings.json. Token được mã hoá bằng safeStorage
// (Keychain/DPAPI/libsecret) nếu hệ điều hành hỗ trợ.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function get(key, fallback) {
  const v = load()[key];
  return v === undefined ? fallback : v;
}

function set(key, value) {
  load()[key] = value;
  save();
}

function setToken(token) {
  if (!token) return set('token', null);
  if (safeStorage.isEncryptionAvailable()) {
    set('token', { enc: true, data: safeStorage.encryptString(token).toString('base64') });
  } else {
    set('token', { enc: false, data: token });
  }
}

function getToken() {
  const t = get('token');
  if (!t) return null;
  try {
    return t.enc ? safeStorage.decryptString(Buffer.from(t.data, 'base64')) : t.data;
  } catch {
    return null;
  }
}

module.exports = { get, set, getToken, setToken };
