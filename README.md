# Git Sync

App desktop (Windows và Linux) để theo dõi nhiều thư mục git và đồng bộ (`git pull`) chúng với GitHub.

- Thêm thư mục: bắt buộc phải là thư mục đã `git init`. Nếu chọn một thư mục con, app tự lấy thư mục gốc của repo.
- Hiện nhánh hiện tại. App chạy `git fetch` để kiểm tra repo đã ở phiên bản mới nhất chưa:
  - ✓ xanh: đã là phiên bản mới nhất
  - ✗ đỏ: chưa mới nhất, đang thiếu N commit
  - ! vàng: chưa có upstream, đang ở detached HEAD, hoặc fetch bị lỗi
- Nút **Sync** chạy `git pull --ff-only`. Nút **Sync tất cả** pull mọi repo đang có dấu ✗.
- App tự kiểm tra lại mỗi 5 phút.
- Phải đăng nhập GitHub mới vào được app. Có 3 cách, giống `gh auth login`:
  1. **Trình duyệt** (OAuth Device Flow): app hiện mã 8 ký tự, bạn nhập mã đó trên github.com/login/device
  2. **Personal Access Token**: cần quyền `repo`
  3. **GitHub CLI**: lấy token từ `gh auth token`

## Yêu cầu

- Đã cài Git và lệnh `git` có trong PATH. Trên Windows, dùng Git for Windows.
- Node.js 18 trở lên (chỉ cần khi chạy từ mã nguồn hoặc khi build)

## Chạy thử

```bash
npm install
npm start
```

## Cấu hình đăng nhập bằng trình duyệt

Device Flow cần Client ID của một GitHub OAuth App:

1. Vào <https://github.com/settings/developers> → **New OAuth App**
2. Homepage URL và Callback URL: điền gì cũng được, ví dụ `http://localhost`
3. Sau khi tạo, tick **Enable Device Flow** rồi lưu
4. Copy **Client ID** (không cần Client Secret) rồi đưa vào app theo một trong ba cách:
   - nhập trong mục **Nâng cao** ở màn hình đăng nhập
   - đặt biến môi trường `GITHUB_CLIENT_ID`
   - điền sẵn vào `DEFAULT_CLIENT_ID` trong `src/main/auth.js` trước khi build

## Build bộ cài

Xem chi tiết trong [BUILD.md](BUILD.md).

```bash
./build.sh           # Linux: dist/Git Sync-<version>.AppImage
build.bat            # Windows: bộ cài .exe và bản portable .exe trong dist\
```

## Bảo mật

- Token được lưu trong `settings.json` ở thư mục dữ liệu của app và được mã hoá bằng `safeStorage` của Electron: DPAPI trên Windows, libsecret/kwallet trên Linux.
- Khi fetch hoặc pull, token được đưa cho git qua một credential helper. Helper này chỉ áp dụng cho `https://github.com` và nhận token qua biến môi trường, nên token không xuất hiện trên dòng lệnh. Remote dùng SSH vẫn dùng SSH key của máy như bình thường.
