#!/usr/bin/env node
// Build file cài đặt bằng một lệnh.
//
//   node scripts/build.js                  build cho hệ điều hành đang chạy
//   node scripts/build.js linux            chỉ Linux (.deb)
//   node scripts/build.js win              chỉ Windows (.exe cài đặt + .exe portable)
//   node scripts/build.js all              cả hai (build Windows trên Linux cần wine32)
//   node scripts/build.js --version 1.2.0  đổi version trong package.json trước khi build
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG = path.join(ROOT, 'package.json');

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const green = c('32');
const red = c('31');
const dim = c('2');

const step = (msg) => console.log(`\n${bold('▸')} ${msg}`);
const fail = (msg) => {
  console.error(`\n${red('✗')} ${msg}`);
  process.exit(1);
};

function parseArgs(argv) {
  const opts = { targets: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') opts.version = argv[++i];
    else if (['linux', 'win', 'all'].includes(a)) opts.targets = a;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/build.js [linux|win|all] [--version x.y.z]');
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  if (!opts.targets) opts.targets = process.platform === 'win32' ? 'win' : 'linux';
  if (opts.version && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(opts.version)) fail(`Invalid version: ${opts.version}`);
  return opts;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) fail(`Command failed: ${cmd} ${args.join(' ')}`);
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) fail(`Node.js 18+ is required (current: ${process.versions.node})`);

  // Terminal của VSCode đặt biến này → Electron chạy như Node thuần.
  delete process.env.ELECTRON_RUN_AS_NODE;

  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron-builder'))) {
    step('Installing dependencies (npm install)…');
    run('npm', ['install']);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (opts.version && opts.version !== pkg.version) {
    step(`Setting version ${pkg.version} → ${opts.version}`);
    pkg.version = opts.version;
    fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  step('Cleaning dist/');
  fs.rmSync(DIST, { recursive: true, force: true });

  const builder = require('electron-builder');
  // Linux: thư mục cài /opt/<productName> không được có dấu cách — chrome-sandbox (SUID) cắt
  // đường dẫn tại dấu cách khi khởi chạy tiến trình con → crash "failed to execvp: /opt/Git".
  // Tên hiển thị trong menu vẫn là "Git Sync" nhờ desktop.Name. Windows giữ productName gốc.
  const linuxConfig = {
    ...pkg.build,
    productName: pkg.name,
    linux: { ...pkg.build.linux, desktop: { Name: pkg.build.productName } },
  };
  const platforms = [];
  if (opts.targets === 'linux' || opts.targets === 'all') platforms.push(['Linux', builder.Platform.LINUX, linuxConfig]);
  if (opts.targets === 'win' || opts.targets === 'all') platforms.push(['Windows', builder.Platform.WINDOWS, undefined]);

  const artifacts = [];
  for (const [name, platform, config] of platforms) {
    step(`Building ${name} v${pkg.version}…`);
    try {
      const files = await builder.build({ targets: platform.createTarget(), projectDir: ROOT, config });
      artifacts.push(...files.filter((f) => /\.(deb|exe)$/.test(f)));
    } catch (e) {
      const msg = String(e.message || e);
      if (platform === builder.Platform.WINDOWS && process.platform !== 'win32') {
        fail(
          `Windows build failed:\n${msg}\n\n` +
          'Building for Windows on Linux needs 32-bit Wine. Install it with:\n' +
          '    sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine64 wine32:i386\n' +
          '  or run this script on a Windows machine.',
        );
      }
      fail(`${name} build failed:\n${msg}`);
    }
  }

  console.log(`\n${green('✓')} ${bold('Done!')} Installers in ${path.relative(process.cwd(), DIST) || 'dist'}/:\n`);
  for (const f of artifacts) {
    console.log(`  ${path.basename(f).padEnd(36)} ${dim(formatSize(fs.statSync(f).size))}`);
  }
  console.log();
}

main().catch((e) => fail(e.stack || e.message));
