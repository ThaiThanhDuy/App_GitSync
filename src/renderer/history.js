// ======================= Lịch sử git (graph) =======================
// Dùng chung các hàm/biến của renderer.js: $, api, repos, describe, relTime, baseName,
// setIcon, toast, errMsg, syncRepo, openCommit.

const LANE_COLORS = ['#3b82f6', '#ec4899', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ef4444', '#84cc16'];
const ROW_H = 34;
const LANE_W = 16;
const GRAPH_PAD = 16;
const PAGE = 300;

const hist = {
  path: null,
  all: true,
  commits: [],
  done: false,
  selected: null,
  token: 0,
  headKey: null,
  query: '',
};

const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];
const X = (col) => GRAPH_PAD + col * LANE_W;
const Y = (row) => row * ROW_H + ROW_H / 2;

// Chia làn cho từng commit. Mỗi làn "chờ" một commit cha; commit nằm ở làn đầu tiên đang chờ nó,
// các làn khác cũng chờ nó sẽ hội tụ về đây (điểm rẽ nhánh), commit cha thứ 2+ mở làn mới (merge).
function layoutGraph(commits) {
  const lanes = [];
  const edges = [];
  let maxLane = 0;
  const takeFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  commits.forEach((c, row) => {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = takeFree();
      lanes[col] = c.hash;
    }
    for (let j = 0; j < lanes.length; j++) {
      if (j !== col && lanes[j] === c.hash) lanes[j] = null;
    }
    c.col = col;

    c.parents.forEach((p, k) => {
      let lane;
      if (k === 0) {
        lane = col;
      } else {
        lane = lanes.indexOf(p);
        if (lane === -1) lane = takeFree();
      }
      lanes[lane] = p;
      edges.push({ row, col, lane, parent: p });
    });
    if (!c.parents.length) lanes[col] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxLane = Math.max(maxLane, col, lanes.length - 1);
  });

  return { edges, maxLane };
}

// Đoạn nối 2 điểm: thẳng nếu cùng cột, ngược lại là đường cong chữ S.
function segment([x1, y1], [x2, y2]) {
  if (x1 === x2) return `L${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

function edgePath(e, commits, rowOf) {
  const target = rowOf.get(e.parent);
  const endRow = target ?? commits.length; // cha chưa tải → kéo xuống đáy
  const endCol = target !== undefined ? commits[target].col : e.lane;

  const pts = [[X(e.col), Y(e.row)]];
  if (e.lane !== e.col && e.row + 1 < endRow) pts.push([X(e.lane), Y(e.row + 1)]);
  if (endRow - 1 > e.row && e.lane !== endCol) pts.push([X(e.lane), Y(endRow - 1)]);
  pts.push([X(endCol), target !== undefined ? Y(endRow) : endRow * ROW_H]);

  const uniq = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  let d = `M${uniq[0][0]} ${uniq[0][1]}`;
  for (let i = 1; i < uniq.length; i++) d += segment(uniq[i - 1], uniq[i]);
  return d;
}

function isHead(c) {
  return c.refs.some((r) => r.head || r.type === 'head');
}

function drawGraph(animate) {
  const commits = hist.commits;
  const { edges, maxLane } = layoutGraph(commits);
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]));
  const width = GRAPH_PAD * 2 + maxLane * LANE_W;
  const height = commits.length * ROW_H;

  // Vẽ đường trước, chấm sau để chấm luôn nằm trên.
  let svg = '';
  for (const e of edges) {
    svg += `<path d="${edgePath(e, commits, rowOf)}" stroke="${laneColor(e.lane)}"/>`;
  }
  commits.forEach((c, row) => {
    const color = laneColor(c.col);
    if (isHead(c)) svg += `<circle class="head-ring" cx="${X(c.col)}" cy="${Y(row)}" r="8" stroke="${color}"/>`;
    svg += `<circle cx="${X(c.col)}" cy="${Y(row)}" r="4.5" fill="${color}"/>`;
    // Commit merge: chấm rỗng ruột.
    if (c.parents.length > 1) svg += `<circle class="hole" cx="${X(c.col)}" cy="${Y(row)}" r="2"/>`;
  });

  const el = $('#h-graph');
  el.setAttribute('width', width);
  el.setAttribute('height', height);
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.innerHTML = svg;
  $('#h-commits').style.setProperty('--gw', `${width + 4}px`);

  if (animate) {
    el.classList.remove('reveal');
    void el.getBoundingClientRect();
    el.classList.add('reveal');
  }
}

// Gộp "main" + "origin/main" cùng commit thành một nhãn.
function displayRefs(c) {
  const branches = c.refs.filter((r) => r.type === 'branch');
  const remotes = c.refs.filter((r) => r.type === 'remote');
  const out = [];
  for (const b of branches) {
    const i = remotes.findIndex((r) => r.name.slice(r.name.indexOf('/') + 1) === b.name);
    out.push({ ...b, synced: i !== -1 });
    if (i !== -1) remotes.splice(i, 1);
  }
  out.sort((a, b) => b.head - a.head);
  if (c.refs.some((r) => r.type === 'head')) out.unshift({ type: 'head', name: 'HEAD', head: true });
  return [...out, ...remotes, ...c.refs.filter((r) => r.type === 'tag')];
}

function refBadge(ref, color) {
  const el = document.createElement('span');
  el.className = `ref ${ref.type}${ref.head ? ' head' : ''}`;
  el.style.setProperty('--lane', color);
  const icon = { tag: 'tag', remote: 'cloud' }[ref.type] || 'branch';
  el.innerHTML = `<svg class="i"><use href="#i-${icon}"/></svg>`;
  el.append(ref.name);
  if (ref.synced) {
    const mark = document.createElement('span');
    mark.className = 'sync-mark';
    mark.innerHTML = '<svg class="i"><use href="#i-cloud"/></svg>';
    mark.title = 'In sync with remote';
    el.append(mark);
  }
  el.title = { branch: 'Local branch', remote: 'Remote branch', tag: 'Tag', head: 'HEAD' }[ref.type] + `: ${ref.name}`;
  return el;
}

function buildRow(c, i, animate) {
  const li = document.createElement('li');
  li.className = 'h-row';
  li.dataset.hash = c.hash;
  if (c.parents.length > 1) li.classList.add('merge');
  if (animate && i < 25) {
    li.classList.add('fresh');
    li.style.animationDelay = `${i * 18}ms`;
  }
  if (c.hash === hist.selected) li.classList.add('selected');

  const msg = document.createElement('div');
  msg.className = 'h-msg';
  const refs = displayRefs(c);
  const color = laneColor(c.col);
  refs.slice(0, 3).forEach((r) => msg.appendChild(refBadge(r, color)));
  if (refs.length > 3) {
    const more = document.createElement('span');
    more.className = 'ref';
    more.textContent = `+${refs.length - 3}`;
    more.title = refs.slice(3).map((r) => r.name).join(', ');
    msg.appendChild(more);
  }
  const subject = document.createElement('span');
  subject.className = 'h-subject';
  subject.textContent = c.subject;
  subject.title = c.subject;
  msg.appendChild(subject);

  const author = document.createElement('span');
  author.className = 'h-author';
  author.textContent = c.author;
  author.title = `${c.author} <${c.email}>`;

  const date = document.createElement('span');
  date.className = 'h-date';
  date.textContent = relTime(c.date);
  date.title = new Date(c.date).toLocaleString('en-US');

  const hash = document.createElement('span');
  hash.className = 'h-hash';
  hash.textContent = c.hash.slice(0, 7);

  li.append(msg, author, date, hash);
  li.addEventListener('click', () => selectCommit(c.hash));
  return li;
}

function renderHistory(start, animate) {
  const ul = $('#h-commits');
  if (start === 0) ul.innerHTML = '';
  drawGraph(animate && start === 0);
  const frag = document.createDocumentFragment();
  // Hàng cũ giữ nguyên; layout có thể đổi cột khi tải thêm nên cập nhật lại màu nhãn ref.
  if (start > 0) {
    for (const li of ul.children) {
      const c = hist.commits[Number(li.dataset.i)];
      for (const r of li.querySelectorAll('.ref')) r.style.setProperty('--lane', laneColor(c.col));
    }
  }
  for (let i = start; i < hist.commits.length; i++) {
    const li = buildRow(hist.commits[i], i - start, animate);
    li.dataset.i = i;
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  $('#h-empty').classList.toggle('hidden', hist.commits.length > 0);
  $('#h-more').classList.toggle('hidden', hist.done);
  applyHistorySearch();
}

// ----- Tìm commit (trong các commit đã tải) theo message, tác giả, hash, tên nhánh/tag -----
function commitMatches(c, q) {
  return !q || fold(c.subject).includes(q) || fold(c.author).includes(q)
    || c.hash.startsWith(q) || c.refs.some((r) => fold(r.name).includes(q));
}

function applyHistorySearch() {
  const q = fold($('#h-search').value);
  hist.query = q;
  // Khi lọc, các hàng không còn liền nhau nên ẩn graph.
  $('#h-canvas').classList.toggle('searching', !!q);
  let n = 0;
  for (const li of $('#h-commits').children) {
    const ok = commitMatches(hist.commits[Number(li.dataset.i)], q);
    li.classList.toggle('hidden', !ok);
    if (ok) n++;
  }
  $('.h-search').classList.toggle('has-value', !!q);
  $('#h-search-count').textContent = q ? `${n}/${hist.commits.length}` : '';
  $('#h-search-empty').classList.toggle('hidden', !(q && !n));
  $('#h-search-q').textContent = $('#h-search').value.trim();
}

const visibleCommits = () => hist.commits.filter((c) => commitMatches(c, hist.query));

async function loadHistory({ reset = true, animate = true } = {}) {
  const token = ++hist.token;
  const p = hist.path;
  if (reset) {
    hist.done = false;
    if (animate) {
      hist.commits = [];
      $('#h-commits').innerHTML = '';
      $('#h-graph').innerHTML = '';
      $('#h-empty').classList.add('hidden');
      $('#h-more').classList.add('hidden');
    }
  }
  $('#h-loading').classList.toggle('hidden', !animate && reset);
  $('#h-more').disabled = true;
  try {
    const skip = reset ? 0 : hist.commits.length;
    const batch = await api.repos.log(p, { skip, limit: PAGE, all: hist.all });
    if (token !== hist.token) return;
    const start = reset ? 0 : hist.commits.length;
    hist.commits = reset ? batch : hist.commits.concat(batch);
    hist.done = batch.length < PAGE;
    renderHistory(start, animate);
    if (reset && hist.selected && !hist.commits.some((c) => c.hash === hist.selected)) closeDetail();
  } catch (e) {
    if (token === hist.token) toast(errMsg(e), 'bad', 6000);
  } finally {
    if (token === hist.token) {
      $('#h-loading').classList.add('hidden');
      $('#h-more').disabled = false;
    }
  }
}

// ----- Chi tiết commit -----
function closeDetail() {
  hist.selected = null;
  for (const li of document.querySelectorAll('.h-row.selected')) li.classList.remove('selected');
  const panel = $('#h-detail');
  if (panel.classList.contains('hidden')) return;
  panel.classList.add('leaving');
  panel.addEventListener('animationend', () => {
    panel.classList.remove('leaving');
    if (!hist.selected) panel.classList.add('hidden');
  }, { once: true });
}

async function selectCommit(hash, { scroll = false } = {}) {
  hist.selected = hash;
  for (const li of document.querySelectorAll('.h-row')) {
    li.classList.toggle('selected', li.dataset.hash === hash);
    if (scroll && li.dataset.hash === hash) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const panel = $('#h-detail');
  panel.classList.remove('hidden', 'leaving');
  const body = $('#h-detail-body');
  body.innerHTML = '<div class="h-loading"><span class="ring"></span></div>';

  try {
    const d = await api.repos.commitDetail(hist.path, hash);
    if (hist.selected !== hash) return;
    renderDetail(d);
  } catch (e) {
    if (hist.selected === hash) body.innerHTML = '';
    toast(errMsg(e), 'bad');
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderDetail(d) {
  const body = $('#h-detail-body');
  body.innerHTML = '';
  const c = hist.commits.find((x) => x.hash === d.hash);

  const head = el('div');
  if (c) {
    const refs = displayRefs(c);
    if (refs.length) {
      const box = el('div', 'd-refs');
      refs.forEach((r) => box.appendChild(refBadge(r, laneColor(c.col))));
      head.appendChild(box);
    }
  }
  const [subject, ...rest] = d.message.split('\n');
  head.appendChild(el('h3', 'd-subject', subject));
  const bodyText = rest.join('\n').trim();
  if (bodyText) head.appendChild(el('p', 'd-body', bodyText));
  body.appendChild(head);

  const meta = el('dl', 'd-meta');
  const row = (label, value) => {
    meta.appendChild(el('dt', '', label));
    const dd = el('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.appendChild(value);
    if (typeof value === 'string') dd.title = value;
    meta.appendChild(dd);
  };
  row('Author', `${d.author} <${d.email}>`);
  row('Date', `${new Date(d.date).toLocaleString('en-US')} · ${relTime(d.date)}`);
  if (d.committer !== d.author) row('Committer', d.committer);

  const hashBtn = el('button', 'd-hash');
  hashBtn.title = 'Copy full commit hash';
  hashBtn.append(d.hash.slice(0, 12));
  hashBtn.insertAdjacentHTML('beforeend', '<svg class="i"><use href="#i-copy"/></svg>');
  hashBtn.onclick = () => {
    navigator.clipboard.writeText(d.hash);
    toast('Commit hash copied', 'ok', 1500);
  };
  row('Commit', hashBtn);

  if (d.parents.length) {
    const box = el('span');
    for (const p of d.parents) {
      const b = el('button', 'd-parent', p.slice(0, 7));
      b.title = 'Go to parent commit';
      b.onclick = () => {
        if (hist.commits.some((x) => x.hash === p)) selectCommit(p, { scroll: true });
        else toast('This commit is not loaded yet — click “Load more commits”', 'warn');
      };
      box.appendChild(b);
    }
    row(d.parents.length > 1 ? 'Parents' : 'Parent', box);
  }
  body.appendChild(meta);

  const files = el('div');
  const adds = d.files.reduce((s, f) => s + (f.add || 0), 0);
  const dels = d.files.reduce((s, f) => s + (f.del || 0), 0);
  const fh = el('div', 'd-files-head');
  fh.appendChild(el('span', '', `${plural(d.files.length, 'changed file')}${d.parents.length > 1 ? ' (vs. first parent)' : ''}`));
  const sum = el('span');
  sum.append(el('span', 'add', `+${adds}`), ' ', el('span', 'del', `−${dels}`));
  fh.appendChild(sum);
  files.appendChild(fh);

  const ul = el('ul', 'd-files');
  if (!d.files.length) ul.appendChild(el('li', 'd-empty', 'No file changes'));
  for (const f of d.files) {
    const li = el('li', 'd-file');
    li.title = 'Show changes';
    li.addEventListener('click', () => toggleFileDiff(li, d.hash, f));
    li.insertAdjacentHTML('beforeend', '<svg class="i d-chevron"><use href="#i-chevron-right"/></svg>');
    li.appendChild(el('span', `fcode ${f.code}`, f.code));
    const name = el('span', 'fname');
    const bdi = el('bdi', '', f.from ? `${f.from} → ${f.path}` : f.path);
    name.appendChild(bdi);
    name.title = bdi.textContent;
    li.appendChild(name);
    if (f.add != null || f.del != null) {
      const st = el('span', 'fstat');
      st.append(el('span', 'add', `+${f.add ?? 0}`), el('span', 'del', `−${f.del ?? 0}`));
      li.appendChild(st);
    }
    ul.appendChild(li);
  }
  files.appendChild(ul);
  body.appendChild(files);
}

// ----- Diff -----
function updateDetailWidth() {
  $('#h-detail').classList.toggle('wide', !!document.querySelector('.d-diff-row'));
}

async function toggleFileDiff(li, hash, f) {
  const next = li.nextElementSibling;
  if (next?.classList.contains('d-diff-row')) {
    next.remove();
    li.classList.remove('open');
    updateDetailWidth();
    return;
  }
  li.classList.add('open');
  const row = el('li', 'd-diff-row');
  row.innerHTML = '<div class="h-loading"><span class="ring"></span></div>';
  li.after(row);
  updateDetailWidth();
  try {
    const res = await api.repos.fileDiff(hist.path, hash, f.path, f.from);
    if (!row.isConnected) return;
    row.innerHTML = '';
    row.appendChild(renderDiff(res));
  } catch (e) {
    row.innerHTML = '';
    row.appendChild(el('div', 'diff-note', errMsg(e)));
  }
}

const DIFF_MAX_LINES = 3000;

function renderDiff({ diff, truncated, binary }) {
  const box = el('div', 'diff');
  if (binary) {
    box.appendChild(el('div', 'diff-note', 'Binary file — no preview'));
    return box;
  }
  const lines = diff.split('\n');
  let i = lines.findIndex((l) => l.startsWith('@@'));
  if (i === -1) {
    box.appendChild(el('div', 'diff-note', 'No text changes (empty file or permission change)'));
    return box;
  }
  const add = (kind, a, b, text) => {
    const row = el('div', `dl ${kind}`);
    row.append(el('span', 'ln', String(a)), el('span', 'ln', String(b)), el('span', 'dl-code', text));
    box.appendChild(row);
  };
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git')) break;
    if (++count > DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
      if (m) [oldNo, newNo] = [Number(m[1]), Number(m[2])];
      add('hunk', '', '', l);
    } else if (l.startsWith('+')) add('add', '', newNo++, l.slice(1));
    else if (l.startsWith('-')) add('del', oldNo++, '', l.slice(1));
    else if (l.startsWith('\\')) add('meta', '', '', l.slice(2));
    else if (l === '' && i === lines.length - 1) break;
    else add('ctx', oldNo++, newNo++, l.slice(1));
  }
  if (truncated) box.appendChild(el('div', 'diff-note', 'Diff is too long — showing the first part only'));
  return box;
}

// ----- Header + điều hướng -----
function renderHistoryHeader() {
  if (!hist.path) return;
  const entry = repos.get(hist.path);
  if (!entry) return closeHistory();
  const d = describe(entry);
  const s = entry.status;
  $('#h-name').textContent = baseName(hist.path);
  $('#h-branch').textContent = s?.branch || '…';
  const st = $('#h-state');
  st.textContent = d.text;
  st.className = `h-state ${d.state}`;

  const sync = $('#h-sync');
  sync.disabled = entry.busy || !s?.upstream;
  sync.classList.toggle('needs', d.state === 'bad');
  updatePushButton($('#h-push'), entry);
  const commit = $('#h-commit');
  commit.classList.toggle('hidden', !s?.dirty);
  commit.disabled = entry.busy;
  $('#h-refresh').disabled = entry.busy;

  // Sau khi fetch / pull / commit làm HEAD hoặc remote thay đổi → tải lại lịch sử (không animation).
  if (!entry.busy && s) {
    const key = [s.branch, s.lastCommitAt, s.ahead, s.behind].join('|');
    if (hist.headKey !== null && key !== hist.headKey) loadHistory({ animate: false });
    hist.headKey = key;
  }
}

function switchView(from, to, cls) {
  $(from).classList.add('hidden');
  const v = $(to);
  v.classList.remove('hidden', 'slide-in', 'slide-back');
  void v.offsetWidth;
  v.classList.add(cls);
}

function openHistory(p) {
  hist.path = p;
  hist.selected = null;
  hist.headKey = null;
  hist.commits = [];
  $('#h-detail').classList.add('hidden');
  $('#h-detail').classList.remove('wide');
  $('#h-scroll').scrollTop = 0;
  $('#h-search').value = '';
  switchView('#main-view', '#history-view', 'slide-in');
  renderHistoryHeader();
  loadHistory();
}

function closeHistory() {
  hist.path = null;
  hist.token++;
  switchView('#history-view', '#main-view', 'slide-back');
}

function setScope(all) {
  if (hist.all === all) return;
  hist.all = all;
  $('#h-scope-all').classList.toggle('active', all);
  $('#h-scope-head').classList.toggle('active', !all);
  closeDetail();
  loadHistory();
}

$('#h-back').addEventListener('click', closeHistory);
$('#h-branch-btn').addEventListener('click', (e) => openBranchMenu(hist.path, e.currentTarget));
$('#h-search').addEventListener('input', applyHistorySearch);
$('#h-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (e.target.value) {
      e.target.value = '';
      applyHistorySearch();
    } else e.target.blur();
  }
});
$('#h-refresh').addEventListener('click', () => {
  const btn = $('#h-refresh');
  btn.classList.add('spinning');
  checkRepo(hist.path).finally(() => btn.classList.remove('spinning'));
  loadHistory();
});
$('#h-open').addEventListener('click', () => api.openFolder(hist.path));
$('#h-sync').addEventListener('click', () => syncRepo(hist.path));
$('#h-commit').addEventListener('click', () => openCommit(hist.path));
$('#h-push').addEventListener('click', () => pushRepo(hist.path));
$('#h-more').addEventListener('click', () => loadHistory({ reset: false, animate: true }));
$('#h-detail-close').addEventListener('click', closeDetail);
$('#h-scope-all').addEventListener('click', () => setScope(true));
$('#h-scope-head').addEventListener('click', () => setScope(false));

document.addEventListener('keydown', (e) => {
  if ($('#history-view').classList.contains('hidden') || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (hist.selected) closeDetail();
    else closeHistory();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#h-search').focus();
    $('#h-search').select();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const list = visibleCommits();
    const i = list.findIndex((c) => c.hash === hist.selected);
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
    if (list[next]) selectCommit(list[next].hash, { scroll: true });
  } else if (e.key === 'Backspace' && !e.target.closest('input, textarea')) {
    closeHistory();
  }
});
