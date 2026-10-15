// Gọi lệnh `git` của hệ thống. Token GitHub được đưa vào qua một credential helper
// chỉ áp dụng cho https://github.com (giống `gh auth setup-git`), đọc token từ biến
// môi trường nên không lộ trên dòng lệnh.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GIT_SYNC_TOKEN"; }; f';

// SSH không được hỏi gì (passphrase, xác nhận host key): app không có terminal để trả lời,
// nếu không lệnh sẽ treo tới hết timeout. Chỉ áp dụng khi người dùng chưa tự cấu hình
// GIT_SSH_COMMAND / core.sshCommand (biến môi trường sẽ đè cấu hình của họ).
const BATCH_SSH = 'ssh -o BatchMode=yes -o ConnectTimeout=15';
const sshConfigCache = new Map();

async function sshCommandFor(cwd) {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return null;
  if (!sshConfigCache.has(cwd)) {
    sshConfigCache.set(cwd, (await tryGit(cwd, ['config', '--get', 'core.sshCommand'])) ? null : BATCH_SSH);
  }
  return sshConfigCache.get(cwd);
}

function git(cwd, args, { token, timeout = 120000, raw = false, sshCommand = null } = {}) {
  // Thư mục bị xoá/di chuyển: execFile cũng trả ENOENT như khi thiếu git → báo rõ ràng.
  if (!fs.existsSync(cwd)) return Promise.reject(new Error(`Folder not found: ${cwd}`));
  const pre = [];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (token) {
    pre.push('-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${CRED_HELPER}`);
    env.GIT_SYNC_TOKEN = token;
  }
  if (sshCommand) env.GIT_SSH_COMMAND = sshCommand;
  return new Promise((resolve, reject) => {
    execFile('git', [...pre, ...args], { cwd, env, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('git not found. Please install Git and add it to PATH'));
        if (err.killed) return reject(new Error('git command timed out'));
        return reject(new Error((stderr || stdout || err.message).trim()));
      }
      resolve(raw ? stdout : stdout.trim());
    });
  });
}

async function tryGit(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

// Lệnh có kết nối mạng (fetch/pull/push): thêm token + SSH không tương tác.
async function netGit(cwd, args, token, timeout) {
  return git(cwd, args, { token, timeout, sshCommand: await sshCommandFor(cwd) });
}

// Trả về thư mục gốc của repo, hoặc ném lỗi nếu thư mục chưa `git init`.
async function resolveRepo(folder) {
  try {
    return await git(folder, ['rev-parse', '--show-toplevel']);
  } catch (e) {
    if (/not a git repository/i.test(e.message)) {
      throw new Error('Folder is not a git repository (run git init first)');
    }
    throw e;
  }
}

async function getStatus(cwd, { fetch = false, token } = {}) {
  const status = { path: cwd, checkedAt: Date.now() };
  if (!fs.existsSync(cwd)) return { ...status, state: 'error', error: `Folder not found: ${cwd}` };

  const ct = await tryGit(cwd, ['log', '-1', '--format=%ct']);
  status.lastCommitAt = ct ? Number(ct) * 1000 : null;
  status.branch = await tryGit(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (!status.branch) {
    const sha = await tryGit(cwd, ['rev-parse', '--short', 'HEAD']);
    if (sha === null && (await tryGit(cwd, ['rev-parse', '--git-dir'])) === null) {
      return { ...status, state: 'error', error: 'Folder is no longer a git repository' };
    }
    return { ...status, state: 'detached', branch: sha ? `(detached ${sha})` : '(detached)' };
  }

  status.remoteUrl = await tryGit(cwd, ['remote', 'get-url', 'origin']);

  if (fetch) {
    try {
      await netGit(cwd, ['fetch', '--prune', '--quiet'], token, 60000);
    } catch (e) {
      status.fetchError = e.message;
    }
  }

  status.upstream = await tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const porcelain = await tryGit(cwd, ['status', '--porcelain']);
  status.dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;

  if (!status.upstream) {
    return { ...status, state: 'no-upstream' };
  }

  const counts = await tryGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const [ahead, behind] = (counts || '0\t0').split(/\s+/).map(Number);
  status.ahead = ahead;
  status.behind = behind;

  if (status.fetchError) status.state = 'error';
  else if (behind > 0 && ahead > 0) status.state = 'diverged';
  else status.state = behind > 0 ? 'behind' : 'uptodate';
  return status;
}

async function isRebasing(cwd) {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = await tryGit(cwd, ['rev-parse', '--git-path', dir]);
    if (p && fs.existsSync(path.resolve(cwd, p))) return true;
  }
  return false;
}

// Mặc định --ff-only: không tự tạo merge commit. rebase = true dùng khi nhánh đã diverged:
// đặt commit local lên trên upstream; nếu xung đột thì huỷ rebase để repo trở lại như cũ.
async function pull(cwd, token, { rebase = false } = {}) {
  let output;
  try {
    output = await netGit(cwd, ['pull', rebase ? '--rebase' : '--ff-only'], token, 300000);
  } catch (e) {
    if (rebase && (await isRebasing(cwd))) {
      await tryGit(cwd, ['rebase', '--abort']);
      throw new Error(`Rebase hit conflicts and was aborted — nothing was changed. Resolve it manually in a terminal.\n${e.message}`);
    }
    throw e;
  }
  return { output, status: await getStatus(cwd) };
}

// Push nhánh hiện tại. Chưa có upstream thì publish lên origin và đặt upstream (-u).
async function push(cwd, token) {
  const upstream = await tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let args = ['push'];
  if (!upstream) {
    if (!(await tryGit(cwd, ['remote', 'get-url', 'origin']))) throw new Error('No remote "origin" configured');
    args = ['push', '-u', 'origin', 'HEAD'];
  }
  const output = await netGit(cwd, args, token, 300000);
  return { output, published: !upstream, status: await getStatus(cwd) };
}

// Danh sách file thay đổi: [{ code: 'M'|'A'|'D'|'R'|'?'…, path }]
async function changes(cwd) {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall'], { raw: true });
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    // Rename/copy: mục tiếp theo là đường dẫn cũ.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const code = xy === '??' ? '?' : (xy[0] !== ' ' ? xy[0] : xy[1]);
    files.push({ code, path: file });
  }
  return files;
}

async function commitAll(cwd, message) {
  message = String(message || '').trim();
  if (!message) throw new Error('Commit message cannot be empty');
  await git(cwd, ['add', '.']);
  const staged = await tryGit(cwd, ['diff', '--cached', '--name-only']);
  if (!staged) throw new Error('Nothing to commit');
  const output = await git(cwd, ['commit', '-m', message]);
  return { output, files: staged.split('\n').length, status: await getStatus(cwd) };
}

const FS = '\x1f';
const RS = '\x1e';

// Phân loại ref từ %D: "HEAD -> main, origin/main, tag: v1.0"
function parseRefs(decoration, remotes) {
  const refs = [];
  for (let name of decoration.split(', ').filter(Boolean)) {
    let head = false;
    if (name.startsWith('HEAD -> ')) {
      head = true;
      name = name.slice(8);
    } else if (name === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' });
      continue;
    }
    if (name.startsWith('tag: ')) refs.push({ type: 'tag', name: name.slice(5) });
    else if (remotes.some((r) => name.startsWith(r + '/'))) {
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name });
    } else refs.push({ type: 'branch', name, head });
  }
  return refs;
}

// Lịch sử commit (mới → cũ). all = mọi nhánh local/remote/tag, ngược lại chỉ HEAD.
async function log(cwd, { skip = 0, limit = 300, all = true } = {}) {
  const remotes = ((await tryGit(cwd, ['remote'])) || '').split('\n').filter(Boolean);
  const args = [
    'log', '--date-order', `--max-count=${limit}`, `--skip=${skip}`,
    `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s${RS}`,
  ];
  if (all) args.push('--branches', '--remotes', '--tags');
  args.push('HEAD', '--');
  let out;
  try {
    out = await git(cwd, args, { raw: true });
  } catch (e) {
    if (/does not have any commits|unknown revision|bad (default )?revision/i.test(e.message)) return [];
    throw e;
  }
  return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, author, email, at, refs, subject] = r.split(FS);
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(at) * 1000,
      refs: parseRefs(refs, remotes),
      subject,
    };
  });
}

async function commitDetail(cwd, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash');
  const meta = await git(cwd, ['show', '-s', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ct${FS}%B`, hash], { raw: true });
  const [full, parents, author, email, at, committer, ct, body] = meta.split(FS);

  // Merge commit: so với parent đầu tiên.
  const diffArgs = ['show', '--format=', '--diff-merges=first-parent', '-M', hash];
  const [nameStatus, numstat] = await Promise.all([
    git(cwd, [...diffArgs, '--name-status', '-z'], { raw: true }),
    git(cwd, [...diffArgs, '--numstat', '-z'], { raw: true }),
  ]);

  const files = [];
  const ns = nameStatus.split('\0').filter((x) => x !== '');
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i].replace(/^\n/, '')[0];
    if (code === 'R' || code === 'C') {
      files.push({ code, from: ns[i + 1], path: ns[i + 2] });
      i += 2;
    } else {
      files.push({ code, path: ns[i + 1] });
      i += 1;
    }
  }

  // numstat -z: "add\tdel\tpath\0" hoặc khi rename: "add\tdel\t\0from\0to\0"
  const stats = new Map();
  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; i++) {
    const m = nm[i].replace(/^\n/, '').match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      file = nm[i + 2];
      i += 2;
    }
    stats.set(file, { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
  }
  for (const f of files) Object.assign(f, stats.get(f.path) || {});

  return {
    hash: full,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    date: Number(at) * 1000,
    committer,
    commitDate: Number(ct) * 1000,
    message: body.trim(),
    files,
  };
}

// Nhánh local + nhánh remote chưa có bản local tương ứng.
async function branches(cwd) {
  const out = await git(cwd, [
    'for-each-ref', '--sort=-committerdate',
    `--format=%(refname)${FS}%(refname:short)${FS}%(upstream:short)${FS}%(committerdate:unix)`,
    'refs/heads', 'refs/remotes',
  ]);
  const current = await tryGit(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const local = [];
  const remote = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, name, upstream, at] = line.split(FS);
    const date = Number(at) * 1000;
    if (ref.startsWith('refs/heads/')) local.push({ name, upstream, date, current: name === current });
    else if (!ref.endsWith('/HEAD')) remote.push({ name, date });
  }
  const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
  const localNames = new Set(local.map((b) => b.name));
  return {
    current,
    local,
    remote: remote.filter((r) => !tracked.has(r.name) && !localNames.has(r.name.slice(r.name.indexOf('/') + 1))),
  };
}

// Chuyển nhánh. remote = true: tạo nhánh local theo dõi nhánh remote (git switch --track).
async function switchBranch(cwd, name, { remote = false } = {}) {
  if (!name || name.startsWith('-')) throw new Error('Invalid branch name');
  await git(cwd, remote ? ['switch', '--track', name] : ['switch', name]);
  return getStatus(cwd);
}

const DIFF_LIMIT = 512 * 1024;

// Diff của một file trong commit (merge commit: so với parent đầu tiên).
async function fileDiff(cwd, hash, file, from) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash');
  const paths = from ? [from, file] : [file];
  let diff = await git(cwd, [
    'show', '--format=', '--diff-merges=first-parent', '-M', '--no-color', '--no-ext-diff', hash, '--', ...paths,
  ], { raw: true });
  const truncated = diff.length > DIFF_LIMIT;
  if (truncated) diff = diff.slice(0, DIFF_LIMIT);
  return { diff, truncated, binary: /^Binary files .* differ$/m.test(diff) };
}

module.exports = {
  resolveRepo, getStatus, pull, push, changes, commitAll, log, commitDetail, branches, switchBranch, fileDiff,
};
