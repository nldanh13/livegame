# Công thành chiến – Săn 3 sao

Game overlay cho **TikTok LIVE**: khán giả tặng quà, thả tim, chat để triệu hồi lính đánh căn cứ. Hiển thị bằng **Browser Source của OBS** (nền trong suốt), có chế độ **Solo** (cả phòng đánh một căn cứ) và chế độ **Đội** (Xanh đấu Đỏ).

> Đây là dự án cá nhân, không liên quan tới TikTok hay bất kỳ hãng game nào. Toàn bộ hình vẽ do mã tự tạo (Canvas 2D).

## Tính năng chính
- Quà TikTok → lính hoặc phép (gán ngay trong trang admin), thả tim / theo dõi / chia sẻ / chat cũng gọi lính.
- Chế độ Đội: chat `!xanh` / `!do` để chọn phe, chat lại lệnh để hô hào; giao tranh rồi công thành.
- Rồng canh kho báu giữa sân, quỹ đội mở Máy phá thành và Tướng, truy nã người tặng nhiều nhất, giờ vàng và hiệp phụ.
- Quà phá hoại: Thiên thạch, Độc, Khiên; combo, cuồng nộ, đóng băng, hồi máu.
- Khung dọc 9:16 (live điện thoại) và khung ngang; chế độ giảm nháy `?calm=1`.
- Chế độ trình diễn khi phòng vắng, lọc tên nhạy cảm, nhật ký trận, đại gia của mùa.
- Trang admin (chỉ mở từ máy chạy server): gán quà, chỉnh cân bằng bằng thanh kéo, gọi sự kiện thử, thống kê, sao lưu.

## Cài đặt
Cần [Node.js](https://nodejs.org) 18 trở lên.

```bash
git clone <địa-chỉ-repo-của-bạn>
cd <tên-thư-mục>
npm install
```

## Chạy
```bash
# Windows (PowerShell)
$env:TIKTOK_USER="ten_kenh_cua_ban"; npm start

# macOS / Linux
TIKTOK_USER=ten_kenh_cua_ban npm start
```
Không đặt `TIKTOK_USER` thì chạy ở **chế độ thử** (không kết nối TikTok), dùng admin hoặc phím tắt để gọi lính.

| Đường dẫn | Dùng để |
|---|---|
| `http://localhost:3000/` | Overlay (dán vào OBS Browser Source) |
| `http://localhost:3000/admin` | Bảng điều khiển (chỉ truy cập từ máy chạy server) |
| `http://localhost:3000/?bg=1` | Xem thử trên trình duyệt với nền tối |

### OBS
1. Thêm **Browser Source**, URL `http://localhost:3000/`, kích thước 1080×1920 (dọc) hoặc 1920×1080 (ngang).
2. Bỏ CSS mặc định của OBS nếu có. Tick "Control audio via OBS" nếu muốn có tiếng.
3. Tham số URL hữu ích: `?safeTop=9&safeBottom=16` (tránh giao diện TikTok), `?calm=1` (giảm nháy), `?mute=1`, `?music=1`, `?assets=0` (tắt sprite), `?ground=0` (bỏ nền).

## Cập nhật code khi đang live
Không cần dừng server để lấy code mới. Mở terminal khác (đừng đóng cửa sổ đang chạy `npm start`), vào thư mục dự án rồi chạy:
```bash
# Windows: bấm đúp update.bat, hoặc
update.bat

# macOS / Linux
./update.sh
```
Script tự `git pull`, và nếu bạn có chỉnh cân bằng qua trang admin (ghi thẳng vào `config.json`) thì tự tạm cất lại trước khi tải, tránh mất khi có xung đột.

Server đang chạy tự áp dụng thay đổi:
- `config.json` → gần như ngay lập tức.
- `game.js` (luật chơi) → khi ván hiện tại kết thúc, không ảnh hưởng ván đang chơi.
- `public/index.html` (giao diện) → trình duyệt OBS tự tải lại đúng lúc ván mới bắt đầu.
- `server.js` → cần tự dừng (`Ctrl+C`) rồi `npm start` lại, vì đang giữ kết nối TikTok Live.

## Cấu hình
Mọi thông số nằm trong [`config.json`](config.json): lính, phép, công trình, quà, cân bằng, lọc tên, trình diễn. Sửa file rồi lưu, game tự nạp lại. Bảng gán quà và thanh kéo cân bằng nằm trong trang admin.
Tên quà TikTok khác nhau theo khu vực, hãy dùng bảng "Gán quà" trong admin để chọn theo tên thật.

## Thêm hình ảnh (tùy chọn)
Thả sprite và chất liệu vào `public/assets/`, xem hướng dẫn ở [`public/assets/README.md`](public/assets/README.md). Thiếu file nào thì game tự vẽ tay file đó.
> **Chỉ dùng hình bạn có quyền sử dụng thương mại** (tự làm, CC0, hoặc đã mua). Không dùng hình của Clash of Clans hay game có bản quyền khác: live có quà là hoạt động kiếm tiền.

## Cấu trúc
```
server.js        Express + Socket.io + kết nối TikTok Live
game.js          Toàn bộ luật chơi (thuần logic, có thể test)
config.json      Dữ liệu cân bằng, quà, lính, phép
admin.html       Trang điều khiển
public/          Overlay (index.html) và tài nguyên (assets/)
tools/           Công cụ tạo chất liệu nền
data/            Thống kê và nhật ký trận (tự tạo, không đưa lên git)
```

## Lưu ý
- Thư viện `tiktok-live-connector` dùng API không chính thức của TikTok, có thể thay đổi hoặc gián đoạn.
- Đọc điều khoản của TikTok về quà tặng và nội dung khi live.
- Số cân bằng được ước lượng từ mô phỏng, hãy chỉnh theo phòng live thật.
