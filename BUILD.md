# Build file cài đặt Git Sync

Chỉ cần một lệnh là có file cài. Script tự cài thư viện nếu thiếu, xoá thư mục `dist/` cũ, build, rồi in ra danh sách file đã tạo.

| Hệ điều hành | File tạo ra (trong `dist/`) | Cách dùng |
|---|---|---|
| Linux | `git-sync-desktop_<version>_amd64.deb` | Cài bằng `dpkg -i`, có shortcut trong menu ứng dụng |
| Windows | `Git Sync Setup <version>.exe` | Bộ cài: chọn thư mục cài, tạo shortcut, gỡ được trong Settings |
| Windows | `Git Sync <version>.exe` | Bản portable: chạy luôn, không cần cài |

Máy build cần có [Node.js 18+](https://nodejs.org). Máy chạy app cần có [Git](https://git-scm.com).

## Linux

```bash
./build.sh
```

Kết quả: `dist/git-sync-desktop_<version>_amd64.deb`

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

**Linux (.deb):**

```bash
sudo dpkg -i dist/git-sync-desktop_1.0.0_amd64.deb
```

Nếu `dpkg` báo thiếu gói phụ thuộc (ví dụ `git`, `libnss3`), chạy thêm lệnh sau để tự cài các gói còn thiếu và hoàn tất cài đặt:

```bash
sudo apt -f install
```

Cũng có thể cài bằng `sudo apt install ./dist/git-sync-desktop_1.0.0_amd64.deb`, lệnh này tự cài luôn gói phụ thuộc.

Sau khi cài:

- Mở app từ menu ứng dụng (tìm “Git Sync”) hoặc chạy lệnh `git-sync-desktop`.
- Cập nhật bản mới: build lại rồi chạy lại `sudo dpkg -i` với file mới.
- Gỡ app: `sudo dpkg -r git-sync-desktop`. Dữ liệu của app (danh sách repo, token, cài đặt) nằm ở `~/.config/git-sync-desktop/`, xoá thư mục này nếu muốn xoá sạch.
- Ubuntu 24.04 trở lên: script cài đặt (`build/linux-after-install.sh`) cấp quyền SUID cho `chrome-sandbox`, nên app chạy với sandbox đầy đủ mà không cần `--no-sandbox`.

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
| `dpkg: dependency problems` khi cài | `sudo apt -f install` |
