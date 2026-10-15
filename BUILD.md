# Build file cài đặt Git Sync

Chỉ cần một lệnh là có file cài. Script tự cài thư viện nếu thiếu, xoá thư mục `dist/` cũ, build, rồi in ra danh sách file đã tạo.

| Hệ điều hành | File tạo ra (trong `dist/`) | Cách dùng |
|---|---|---|
| Linux | `Git Sync-<version>.AppImage` | Một file duy nhất, không cần cài |
| Windows | `Git Sync Setup <version>.exe` | Bộ cài: chọn thư mục cài, tạo shortcut, gỡ được trong Settings |
| Windows | `Git Sync <version>.exe` | Bản portable: chạy luôn, không cần cài |

Máy build cần có [Node.js 18+](https://nodejs.org). Máy chạy app cần có [Git](https://git-scm.com).

## Linux

```bash
./build.sh
```

Kết quả: `dist/Git Sync-<version>.AppImage`

## Windows

Bấm đúp vào **`build.bat`**, hoặc chạy trong PowerShell/CMD:

```bat
build.bat
```

Kết quả: `dist\Git Sync Setup <version>.exe` và `dist\Git Sync <version>.exe`

## Tuỳ chọn

```bash
./build.sh --version 1.2.0   # đổi version trong package.json rồi build
./build.sh win               # build bản Windows từ Linux (cần wine32, xem bên dưới)
./build.sh all               # build cả Linux và Windows
```

Trên Windows: `build.bat --version 1.2.0`

Dùng npm cũng được, chạy được trên mọi hệ điều hành:

```bash
npm run build         # build cho hệ điều hành đang dùng
npm run build:linux
npm run build:win
npm run build:all
npm run build -- --version 1.2.0
```

## Cài và chạy

**Linux (AppImage):**

```bash
chmod +x "Git Sync-1.0.0.AppImage"
./"Git Sync-1.0.0.AppImage"
```

Sau khi cấp quyền chạy, có thể bấm đúp vào file để mở.

- **Ubuntu 24.04 trở lên:** hệ điều hành chặn sandbox của Chromium. App tự phát hiện việc này và chạy với `--no-sandbox`, bạn không cần làm gì thêm. Phần xử lý nằm ở `build/after-pack.js`.
- **Báo lỗi `libfuse.so.2`:** cài FUSE bằng `sudo apt install libfuse2t64` (Ubuntu 24.04+) hoặc `sudo apt install libfuse2` (Ubuntu 22.04).

**Windows:** chạy `Git Sync Setup <version>.exe` rồi làm theo các bước cài đặt.

File `.exe` chưa được ký số (code signing), nên lần đầu chạy Windows sẽ hiện cảnh báo “Windows protected your PC”. Bấm **More info** rồi **Run anyway** để tiếp tục.

## Build bản Windows từ Linux

electron-builder cần Wine 32-bit. Nếu thiếu, script sẽ báo lỗi kèm lệnh cài sau:

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install wine64 wine32:i386
```

Cài xong thì chạy `./build.sh win` hoặc `./build.sh all`. Nếu không muốn cài Wine, chạy `build.bat` trên một máy Windows.

## Lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `Electron failed to install correctly` | Xoá `node_modules` rồi chạy lại script |
| `Node.js 18+ is required` | Cài Node.js bản mới hơn |
| Windows build failed + `32-bit Wine` | Cài wine32 (mục trên) hoặc build trên máy Windows |
| AppImage báo lỗi `libfuse.so.2` | `sudo apt install libfuse2t64` |
