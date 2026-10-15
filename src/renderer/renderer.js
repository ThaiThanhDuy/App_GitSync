const $ = (sel, root = document) => root.querySelector(sel);

const CONCURRENCY = 4;

// Electron bọc lỗi IPC thành "Error invoking remote method 'x': Error: ..." — bỏ phần đầu.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function setIcon(container, name) {
  container.innerHTML = `<svg class="i"><use href="#i-${name}"/></svg>`;
}

// ======================= Toast =======================
function toast(msg, kind = 'ok', ms = 4000) {
  if (!msg) return;
  const icon = { ok: 'check', bad: 'x', warn: 'alert' }[kind] || 'dot';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  setIcon(el, icon);
  el.append(msg);
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

// ======================= Dialog xác nhận =======================
function confirmDialog(title, text, okText = 'Remove') {
  const dlg = $('#confirm');
  $('#confirm-ok').textContent = okText;
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// ======================= Đăng nhập =======================
function showPane(name) {
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('hidden', pane.dataset.pane !== name);
  }
  showLoginError('');
  const input = $(`.pane[data-pane="${name}"] input`);
  if (input) setTimeout(() => input.focus(), 50);
}

function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
  // Chạy lại animation rung khi có lỗi mới.
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

function setLoginBusy(busy) {
  for (const el of document.querySelectorAll('#login-view button, #login-view input')) {
    if (!el.closest('[data-pane="device"]')) el.disabled = busy;
  }
}

async function showLogin() {
  for (const v of ['#main-view', '#history-view', '#settings-view']) $(v).classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  showPane('choose');
  const cfg = await api.auth.config();
  $('#input-client-id').value = cfg.clientId || '';
}

async function loginWith(fn, { onErrorPane } = {}) {
  showLoginError('');
  setLoginBusy(true);
  try {
    const user = await fn();
    enterApp(user);
  } catch (e) {
    if (onErrorPane) showPane(onErrorPane);
    if (errMsg(e) !== 'Login cancelled') showLoginError(errMsg(e));
  } finally {
    setLoginBusy(false);
  }
}

for (const btn of document.querySelectorAll('[data-back]')) {
  btn.addEventListener('click', () => showPane('choose'));
}
$('#btn-show-token').addEventListener('click', () => showPane('token'));
$('#btn-show-advanced').addEventListener('click', () => showPane('advanced'));

$('#btn-device').addEventListener('click', () => loginWith(async () => {
  const flow = await api.auth.deviceStart();
  $('#device-code').textContent = flow.userCode;
  $('#device-code').onclick = () => {
    navigator.clipboard.writeText(flow.userCode);
    toast('Code copied', 'ok', 1500);
  };
  $('#btn-device-open').onclick = () => api.openUrl(flow.verificationUri);
  showPane('device');
  setLoginBusy(true);
  return api.auth.deviceWait();
}, { onErrorPane: 'choose' }));

$('#btn-device-cancel').addEventListener('click', () => api.auth.deviceCancel());

$('#btn-token').addEventListener('click', () => loginWith(async () => {
  const user = await api.auth.token($('#input-token').value);
  $('#input-token').value = '';
  return user;
}));
$('#input-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-token').click(); });

$('#btn-gh').addEventListener('click', () => loginWith(() => api.auth.gh()));

$('#link-new-token').addEventListener('click', () => {
  api.openUrl('https://github.com/settings/tokens/new?scopes=repo,read:org&description=Git%20Sync%20Desktop');
});

$('#btn-client-id').addEventListener('click', async () => {
  await api.auth.setClientId($('#input-client-id').value);
  showPane('choose');
  toast('Client ID saved', 'ok', 2000);
});
$('#input-client-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-client-id').click(); });

$('#btn-logout').addEventListener('click', async () => {
  if (!(await confirmDialog('Sign out?', 'You will need to sign in again to keep using the app.', 'Sign out'))) return;
  await api.auth.logout();
  clearInterval(autoTimer);
  showLogin();
});

// ======================= Màn hình chính =======================
const repos = new Map(); // path -> { path, addedAt, order, status, busy, busyText, error }
const rows = new Map();  // path -> <li>
let autoTimer = null;
let checkMinutes = 5;

// (Re)đặt bộ hẹn giờ tự kiểm tra; gọi lại khi đổi thông số trong Settings.
function scheduleAutoCheck(minutes) {
  checkMinutes = minutes;
  clearInterval(autoTimer);
  autoTimer = setInterval(() => checkAll(), minutes * 60 * 1000);
  $('#auto-check-label').textContent = `Auto-checks every ${plural(minutes, 'minute')}`;
}
let currentUser = null;
let nextOrder = 0;

// ----- Tìm kiếm & sắp xếp -----
const SORTS = {
  status: { label: 'Status', dir: ['Needs sync first', 'Up to date first'] },
  commit: { label: 'Latest commit', dir: ['Newest first', 'Oldest first'] },
  added: { label: 'Date added', dir: ['Recently added first', 'Earliest added first'] },
  name: { label: 'Name', dir: ['A → Z', 'Z → A'] },
};
const STATUS_RANK = { bad: 0, warn: 1, idle: 2, ok: 3 };
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const prefs = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  },
};

const view = {
  q: '',
  sort: SORTS[prefs.get('sort')] ? prefs.get('sort') : 'status',
  reversed: prefs.get('sortReversed') === '1',
};

// Bỏ dấu, chữ thường, coi - _ . như dấu cách: "dong bo" khớp "Đồng-Bộ_cũ".
const fold = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[-_.\s]+/g, ' ').trim();

function matches(entry) {
  if (!view.q) return true;
  const name = fold(baseName(entry.path));
  return fold(view.q).split(' ').every((word) => name.includes(word));
}

function statusRank(entry) {
  return STATUS_RANK[describe({ ...entry, busy: false }).state] ?? 2;
}

function compare(a, b) {
  let r = 0;
  switch (view.sort) {
    case 'status': r = statusRank(a) - statusRank(b); break;
    case 'commit': r = (b.status?.lastCommitAt || 0) - (a.status?.lastCommitAt || 0); break;
    // Repo cũ (chưa có addedAt) coi như thêm sớm nhất, giữ thứ tự ban đầu.
    case 'added': r = (b.addedAt ?? b.order) - (a.addedAt ?? a.order); break;
    default: break;
  }
  if (!r) r = collator.compare(baseName(a.path), baseName(b.path));
  return view.reversed ? -r : r;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relTime(ms) {
  const sec = Math.round((ms - Date.now()) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  }
  return 'just now';
}

function enterApp(user, offline) {
  $('#login-view').classList.add('hidden');
  $('#main-view').classList.remove('hidden');
  currentUser = user;
  $('#user-login').textContent = user.login;
  $('.user').title = `Settings — ${user.name ? `${user.name} (@${user.login})` : `@${user.login}`}`;
  $('#user-avatar').src = user.avatarUrl || '';
  $('#user-avatar').classList.toggle('hidden', !user.avatarUrl);
  if (offline) toast('Could not reach GitHub — using saved sign-in info.', 'warn', 6000);
  loadRepos();
  api.settings.get().then((info) => scheduleAutoCheck(info.checkInterval));
}

async function loadRepos() {
  const list = await api.repos.list();
  repos.clear();
  for (const li of rows.values()) li.remove();
  rows.clear();
  for (const r of list) addEntry(r);
  render();
  checkAll();
}

function addEntry(r) {
  repos.set(r.path, { path: r.path, addedAt: r.addedAt, order: nextOrder++, status: null, busy: false });
}

function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

// Trả về { state: ok|bad|warn|busy|idle, icon, text }
function describe(entry) {
  const s = entry.status;
  if (entry.busy) return { state: 'busy', icon: null, text: entry.busyText || 'Checking…' };
  if (entry.error) return { state: 'warn', icon: 'alert', text: entry.error };
  if (!s) return { state: 'idle', icon: 'dot', text: 'Not checked yet' };

  switch (s.state) {
    case 'uptodate':
      return { state: 'ok', icon: 'check', text: `Up to date with ${s.upstream}` };
    case 'behind':
      return { state: 'bad', icon: 'x', text: `Behind ${s.upstream} by ${plural(s.behind, 'commit')}` };
    case 'no-upstream':
      return { state: 'warn', icon: 'alert', text: 'Branch has no upstream' };
    case 'detached':
      return { state: 'warn', icon: 'alert', text: 'Detached HEAD' };
    default:
      return { state: 'warn', icon: 'alert', text: s.fetchError || s.error || 'Unknown error' };
  }
}

function createRow(p) {
  const li = $('#repo-tpl').content.firstElementChild.cloneNode(true);
  // Các hàng xuất hiện lần lượt khi mở app.
  li.addEventListener('animationend', (e) => {
    if (e.target === li && e.animationName === 'row-in') li.classList.add('settled');
  });
  $('.name', li).textContent = baseName(p);
  $('.path', li).textContent = p;
  $('.path', li).title = p;
  $('.act-sync', li).onclick = () => syncRepo(p);
  $('.act-commit', li).onclick = () => openCommit(p);
  $('.act-push', li).onclick = () => pushRepo(p);
  $('.act-refresh', li).onclick = () => checkRepo(p);
  $('.act-open', li).onclick = () => api.openFolder(p);
  $('.act-remove', li).onclick = () => removeRepo(p);
  // Bấm vào hàng (không phải nút) → mở lịch sử git.
  li.addEventListener('click', (e) => {
    if (!e.target.closest('button')) openHistory(p);
  });
  return li;
}

function updateRow(li, entry) {
  const d = describe(entry);
  const s = entry.status;

  if (li.dataset.state !== d.state) {
    li.dataset.state = d.state;
    const box = $('.state', li);
    if (d.state === 'busy') {
      box.innerHTML = '<span class="ring"></span>';
    } else {
      setIcon(box, d.icon);
      box.classList.remove('pop');
      void box.offsetWidth;
      box.classList.add('pop');
    }
  }

  const time = $('.time', li);
  time.classList.toggle('hidden', !s?.lastCommitAt);
  if (s?.lastCommitAt) {
    $('span', time).textContent = relTime(s.lastCommitAt);
    time.title = `Latest commit: ${new Date(s.lastCommitAt).toLocaleString('en-US')}`;
  }

  const detail = $('.detail', li);
  detail.textContent = d.text;
  detail.title = d.text;

  const branch = $('.branch', li);
  branch.classList.toggle('hidden', !s?.branch);
  $('span', branch).textContent = s?.branch || '';

  const ahead = $('.ahead', li);
  ahead.classList.toggle('hidden', !s?.ahead);
  ahead.title = `${plural(s?.ahead || 0, 'commit')} not pushed`;
  $('span', ahead).textContent = s?.ahead || '';

  const dirty = $('.dirty', li);
  dirty.classList.toggle('hidden', !s?.dirty);
  dirty.title = `${plural(s?.dirty || 0, 'changed file')}`;
  $('span', dirty).textContent = s?.dirty || '';

  updatePushButton($('.act-push', li), entry);

  const commitBtn = $('.act-commit', li);
  commitBtn.classList.toggle('hidden', !s?.dirty);
  commitBtn.disabled = entry.busy;
  commitBtn.title = `git add . && git commit (${plural(s?.dirty || 0, 'file')})`;

  $('.act-sync', li).disabled = entry.busy || !s?.upstream;
  $('.act-refresh', li).disabled = entry.busy;
  $('.act-remove', li).disabled = entry.busy;
}

function render() {
  for (const [p, entry] of repos) {
    let li = rows.get(p);
    if (!li) {
      li = createRow(p);
      rows.set(p, li);
    }
    updateRow(li, entry);
  }
  const visible = [...repos.values()].filter(matches).sort(compare).map((e) => rows.get(e.path));
  reorder($('#repo-list'), visible);

  $('#empty').classList.toggle('hidden', repos.size > 0);
  $('#list-tools').classList.toggle('hidden', repos.size === 0);
  $('#no-match').classList.toggle('hidden', !(repos.size && view.q && !visible.length));
  $('#no-match-q').textContent = view.q;
  renderSummary();
  renderHistoryHeader();
}

// Sắp lại các hàng trong list; hàng đổi chỗ thì trượt mượt tới vị trí mới (kỹ thuật FLIP).
function reorder(ul, items) {
  const current = [...ul.children].filter((li) => !li.classList.contains('leaving'));
  if (current.length === items.length && current.every((li, i) => li === items[i])) return;

  const before = new Map(current.map((li) => [li, li.getBoundingClientRect().top]));
  for (const li of ul.querySelectorAll('.leaving')) li.remove();

  let enterIndex = 0;
  for (const li of current) if (!items.includes(li)) li.remove();
  for (const li of items) {
    if (!li.isConnected) {
      li.classList.remove('settled');
      li.style.animationDelay = `${Math.min(enterIndex++, 10) * 35}ms`;
    }
    ul.appendChild(li);
  }

  const moved = [];
  for (const li of items) {
    const top = before.get(li);
    if (top === undefined) continue;
    const dy = top - li.getBoundingClientRect().top;
    if (!dy) continue;
    li.style.transition = 'none';
    li.style.transform = `translateY(${dy}px)`;
    moved.push(li);
  }
  if (!moved.length) return;
  void ul.offsetHeight;
  for (const li of moved) {
    li.style.transition = 'transform .4s var(--ease), background .15s';
    li.style.transform = '';
    setTimeout(() => { li.style.transition = ''; }, 450);
  }
}

function renderSortControls() {
  const sort = SORTS[view.sort];
  $('#sort-label').textContent = sort.label;
  for (const item of document.querySelectorAll('.menu-item')) {
    const active = item.dataset.sort === view.sort;
    item.classList.toggle('active', active);
    item.setAttribute('aria-checked', active);
  }
  const dirBtn = $('#sort-dir');
  setIcon(dirBtn, view.reversed ? 'sort-asc' : 'sort-desc');
  $('.i', dirBtn).classList.add('pop-in');
  dirBtn.title = sort.dir[view.reversed ? 1 : 0];
}

function setSearch(q) {
  view.q = q;
  const input = $('#search');
  if (input.value !== q) input.value = q;
  $('.search').classList.toggle('has-value', !!q);
  $('#search-clear').classList.toggle('hidden', !q);
  render();
}

function toggleSortMenu(open) {
  const menu = $('#sort-menu');
  open ??= menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('#sort-btn').setAttribute('aria-expanded', open);
  if (open) $('.menu-item.active', menu)?.focus();
}

$('#search').addEventListener('input', (e) => setSearch(e.target.value));
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setSearch('');
    e.target.blur();
  }
});
$('#search-clear').addEventListener('click', (e) => {
  e.preventDefault();
  setSearch('');
  $('#search').focus();
});

$('#sort-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSortMenu();
});
for (const item of document.querySelectorAll('.menu-item')) {
  item.addEventListener('click', () => {
    view.sort = item.dataset.sort;
    view.reversed = false;
    prefs.set('sort', view.sort);
    prefs.set('sortReversed', '0');
    toggleSortMenu(false);
    renderSortControls();
    render();
  });
}
$('#sort-dir').addEventListener('click', () => {
  view.reversed = !view.reversed;
  prefs.set('sortReversed', view.reversed ? '1' : '0');
  renderSortControls();
  render();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.sort')) toggleSortMenu(false);
});
document.addEventListener('keydown', (e) => {
  if ($('#main-view').classList.contains('hidden') || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') toggleSortMenu(false);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  }
});

renderSortControls();

function renderSummary() {
  const el = $('#summary');
  const all = [...repos.values()];
  const behind = all.filter((e) => !e.busy && e.status?.state === 'behind').length;
  const busy = all.some((e) => e.busy);
  el.className = `summary ${behind ? 'bad' : busy ? '' : 'ok'}`;
  el.classList.toggle('hidden', !all.length);
  el.innerHTML = '<span class="dot"></span>';
  el.append(
    busy ? `${plural(all.length, 'repo')} · checking…`
      : behind ? `${behind}/${all.length} need sync`
        : `${plural(all.length, 'repo')} · all up to date`,
  );
  $('#btn-sync-all').disabled = !behind;
}

async function checkRepo(p) {
  const entry = repos.get(p);
  if (!entry || entry.busy) return;
  Object.assign(entry, { busy: true, busyText: 'Fetching…', error: null });
  render();
  try {
    entry.status = await api.repos.status(p, true);
  } catch (e) {
    entry.error = errMsg(e);
  }
  entry.busy = false;
  if (repos.has(p)) render();
}

async function syncRepo(p, { quiet = false } = {}) {
  const entry = repos.get(p);
  if (!entry || entry.busy) return false;
  Object.assign(entry, { busy: true, busyText: 'Pulling…', error: null });
  render();
  let ok = false;
  try {
    const res = await api.repos.pull(p);
    entry.status = res.status;
    ok = true;
    if (!quiet) toast(`Synced ${baseName(p)}`, 'ok', 2500);
  } catch (e) {
    entry.error = `Sync failed: ${errMsg(e)}`;
    if (!quiet) toast(`${baseName(p)}: ${errMsg(e)}`, 'bad', 6000);
  }
  entry.busy = false;
  render();
  return ok;
}

// Hiện khi có commit chưa push, hoặc nhánh chưa có upstream nhưng có remote → publish.
function updatePushButton(btn, entry) {
  const s = entry.status;
  const publish = !!s && !s.upstream && !!s.remoteUrl && s.state === 'no-upstream';
  const show = !!s?.ahead || publish;
  btn.classList.toggle('hidden', !show);
  btn.disabled = entry.busy;
  $('span', btn).textContent = publish ? 'Publish' : `Push ${s?.ahead || ''}`.trim();
  btn.title = publish
    ? `git push -u origin ${s.branch}`
    : `git push (${plural(s?.ahead || 0, 'commit')} to ${s?.upstream})`;
}

async function pushRepo(p) {
  const entry = repos.get(p);
  if (!entry || entry.busy) return false;
  Object.assign(entry, { busy: true, busyText: 'Pushing…', error: null });
  render();
  let ok = false;
  try {
    const res = await api.repos.push(p);
    entry.status = res.status;
    ok = true;
    toast(res.published ? `Published ${baseName(p)} to ${res.status.upstream}` : `Pushed ${baseName(p)}`, 'ok', 2500);
  } catch (e) {
    entry.error = `Push failed: ${errMsg(e)}`;
    toast(`${baseName(p)}: ${errMsg(e)}`, 'bad', 6000);
  }
  entry.busy = false;
  render();
  return ok;
}

async function runPool(items, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function checkAll() {
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.classList.add('spinning');
  await runPool([...repos.keys()], checkRepo);
  btn.disabled = false;
  btn.classList.remove('spinning');
  $('#last-check').textContent = `Last checked at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

async function syncAll() {
  const targets = [...repos].filter(([, e]) => e.status?.state === 'behind').map(([p]) => p);
  if (!targets.length) return toast('All repositories are up to date', 'ok');
  const btn = $('#btn-sync-all');
  btn.disabled = true;
  let failed = 0;
  await runPool(targets, async (p) => { if (!(await syncRepo(p, { quiet: true }))) failed++; });
  renderSummary();
  if (failed) toast(`Synced ${targets.length - failed}/${targets.length} repos — ${failed} failed`, 'bad', 6000);
  else toast(`Synced ${plural(targets.length, 'repo')}`, 'ok');
}

async function removeRepo(p) {
  if (!(await confirmDialog(`Remove “${baseName(p)}”?`, 'This only removes it from the list. No files on disk are deleted.'))) return;
  await api.repos.remove(p);
  repos.delete(p);
  const li = rows.get(p);
  rows.delete(p);
  li.classList.add('leaving');
  const done = (e) => {
    if (e.target !== li) return;
    li.removeEventListener('animationend', done);
    li.remove();
    render();
  };
  li.addEventListener('animationend', done);
}

async function addRepos() {
  const { added, errors } = await api.repos.add();
  for (const r of added) addEntry(r);
  // Xoá ô tìm kiếm để repo vừa thêm chắc chắn hiện ra.
  if (added.length && view.q) setSearch('');
  render();
  if (errors.length) toast(`Could not add:\n${errors.join('\n')}`, 'bad', 7000);
  added.forEach((r) => checkRepo(r.path));
}

// ======================= Commit =======================
const FILE_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked' };
let commitTarget = null;
let committing = false;

function showCommitError(msg) {
  const el = $('#commit-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

function updateCommitBtn() {
  $('#commit-ok').disabled = committing || !$('#commit-msg').value.trim();
}

async function openCommit(p) {
  const entry = repos.get(p);
  if (!entry || entry.busy) return;
  commitTarget = p;
  $('#commit-repo').textContent = baseName(p);
  $('#commit-branch').textContent = entry.status?.branch || '';
  $('#commit-msg').value = '';
  $('#commit-count').textContent = '';
  showCommitError('');
  const ul = $('#commit-files');
  ul.innerHTML = '<li class="loading">Loading changed files…</li>';
  updateCommitBtn();
  $('#commit-dlg').showModal();
  $('#commit-msg').focus();

  try {
    const files = await api.repos.changes(p);
    if (commitTarget !== p) return;
    ul.innerHTML = '';
    files.forEach((f, i) => {
      const code = f.code === '?' ? 'U' : f.code;
      const li = document.createElement('li');
      li.style.animationDelay = `${Math.min(i, 20) * 15}ms`;
      const c = document.createElement('span');
      c.className = `fcode ${code}`;
      c.textContent = code;
      c.title = FILE_LABELS[code] || code;
      const name = document.createElement('span');
      name.textContent = f.path;
      name.title = f.path;
      li.append(c, name);
      ul.appendChild(li);
    });
    $('#commit-count').textContent = files.length ? plural(files.length, 'changed file') : 'No changes';
  } catch (e) {
    ul.innerHTML = '';
    showCommitError(errMsg(e));
  }
}

async function doCommit() {
  const p = commitTarget;
  const entry = repos.get(p);
  const msg = $('#commit-msg').value;
  if (committing || !entry || !msg.trim()) return;

  committing = true;
  const btn = $('#commit-ok');
  btn.classList.add('loading');
  updateCommitBtn();
  showCommitError('');
  Object.assign(entry, { busy: true, busyText: 'Committing…', error: null });
  render();

  try {
    const res = await api.repos.commit(p, msg);
    entry.status = res.status;
    $('#commit-dlg').close();
    toast(`Committed ${plural(res.files, 'file')} to ${baseName(p)}`, 'ok');
  } catch (e) {
    showCommitError(errMsg(e));
  } finally {
    committing = false;
    btn.classList.remove('loading');
    updateCommitBtn();
    entry.busy = false;
    if (repos.has(p)) render();
  }
}

$('#commit-form').addEventListener('submit', (e) => {
  if (e.submitter?.id !== 'commit-ok') return;
  e.preventDefault();
  doCommit();
});
$('#commit-msg').addEventListener('input', updateCommitBtn);
$('#commit-msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doCommit();
  }
});
// Không cho đóng hộp thoại (Esc) khi đang commit.
$('#commit-dlg').addEventListener('cancel', (e) => { if (committing) e.preventDefault(); });

$('#btn-add').addEventListener('click', addRepos);
$('#btn-add-empty').addEventListener('click', addRepos);
$('#btn-check-all').addEventListener('click', checkAll);
$('#btn-sync-all').addEventListener('click', syncAll);

// ======================= Khởi động =======================
(async () => {
  const session = await api.auth.session();
  if (session) enterApp(session.user, session.offline);
  else showLogin();
})();
