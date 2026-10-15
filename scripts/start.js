// Chạy Electron ở chế độ dev.
// - Bỏ ELECTRON_RUN_AS_NODE: terminal của VSCode đặt biến này khiến Electron chạy như Node thuần.
// - Linux: Ubuntu 24.04+ chặn user namespace nên Chromium cần chrome-sandbox có SUID root.
//   Bản trong node_modules không có quyền đó → tự thêm --no-sandbox (chỉ khi dev).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['.', ...process.argv.slice(2)];

if (process.platform === 'linux') {
  const sandbox = path.join(path.dirname(electron), 'chrome-sandbox');
  let suidOk = false;
  try {
    const st = fs.statSync(sandbox);
    suidOk = st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {}
  if (!suidOk && !args.includes('--no-sandbox')) {
    console.warn(
      '[dev] chrome-sandbox is not SUID root → running with --no-sandbox.\n' +
      `      To enable the sandbox: sudo chown root:root "${sandbox}" && sudo chmod 4755 "${sandbox}"`,
    );
    args.push('--no-sandbox');
  }
}

const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
