// Hook afterPack của electron-builder (chỉ Linux).
// Khi bấm đúp file AppImage, AppRun chạy app không kèm --no-sandbox. Trên Ubuntu 24.04+
// (AppArmor chặn user namespace) Chromium cần chrome-sandbox có SUID root — điều AppImage
// không làm được — nên app crash ngay. Ta đổi tên file chạy thật thành *.bin và đặt một
// script bọc ngoài: chỉ thêm --no-sandbox khi hệ thống không cho dùng user namespace.
const fs = require('fs');
const path = require('path');

const wrapper = (bin) => `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
ARGS=()
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \\
   || ! unshare --user true 2>/dev/null; then
  ARGS+=(--no-sandbox)
fi
exec "$HERE/${bin}" "\${ARGS[@]}" "$@"
`;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const exe = path.join(context.appOutDir, name);
  fs.renameSync(exe, `${exe}.bin`);
  fs.writeFileSync(exe, wrapper(`${name}.bin`), { mode: 0o755 });
};
