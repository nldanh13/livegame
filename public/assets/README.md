# Thêm hình ảnh (sprite, chất liệu, khung HUD) cho game

Game **tự dùng** ảnh nếu bạn thả đúng tên file vào thư mục này. **Thiếu file nào thì tự vẽ tay cái đó**, nên bạn thay dần từng thứ được.
Tắt hẳn ảnh (để so sánh) bằng cách thêm `?assets=0` vào URL. Sau khi thay file, tải lại trang (Ctrl+F5, hoặc "Refresh cache of current page" trong OBS).

## 1. Chất liệu nền (đã có sẵn, tạo bằng thuật toán)
`tex/grass.png` (cỏ), `tex/cobble.png` (đá lát sân), `tex/dirt.png` (đất đường đi). Ảnh vuông, **lát liền mạch**.
- Muốn đẹp hơn: thay bằng ảnh chất liệu thật từ **Poly Haven** hoặc **ambientCG** (CC0, dùng thương mại được). Chọn ảnh "diffuse/albedo" vuông, giữ đúng tên file.
- `tile` trong `manifest.json` = 1 ô ảnh phủ bao nhiêu đơn vị sân (số lớn = họa tiết to hơn).
- Tạo lại chất liệu mặc định: `python3 tools/make_textures.py`.

## 2. Sprite công trình: `buildings/<loại>.png`
`townHall, cannon, archerTower, mortar, airDefense, wizardTower, infernoTower, goldMine, elixirCollector, storage`
- PNG **nền trong suốt**, nhìn từ trên xuống chếch (kiểu 2.5D), đặt thẳng đứng, chân công trình sát đáy ảnh.
- Kích thước gợi ý: 256-512 px cạnh dài. `w` (manifest) = bề rộng hiển thị theo đơn vị sân, `ay` = vị trí chân trên ảnh (0 đỉnh, 1 đáy).
- `"plinth": false` = không vẽ bệ đá bên dưới (mặc định vì sprite đã có nền). Đổi thành `true` nếu muốn giữ bệ.
- Tùy chọn `"ruin": "buildings/ruin.png"` = ảnh đống đổ nát khi bị phá.

## 3. Sprite lính: `units/<tên>.png`
`barbarian, archer, giant, wizard, minion, hogRider, balloon, electroDragon` và NPC `guardian` (Rồng canh), `siegeMachine`, `hero`.
- PNG nền trong suốt, nhân vật **quay sang phải** (game tự lật khi đi sang trái; nếu ảnh quay trái thì thêm `"faces": "left"`).
- **Ảnh đơn:** game tự thêm nhún nhảy khi đi và co giãn khi đánh.
- **Sprite sheet (hoạt ảnh thật):** xếp các khung thành lưới đều nhau, rồi khai báo trong `manifest.json`:
  ```json
  "barbarian": { "file": "units/barbarian.png", "w": 4,
    "frames": { "cols": 6, "rows": 2,
      "walk":   { "row": 0, "n": 6, "fps": 10 },
      "attack": { "row": 1, "n": 4, "fps": 10 } } }
  ```
  (`cols` x `rows` là số ô của cả tấm ảnh; mỗi hàng là một hành động.)
- Vòng màu đội, thanh máu, tên chủ lính vẫn do game vẽ chồng lên nên không cần đưa vào ảnh.

## 4. Cây và đá: `decor/tree1.png ... tree3.png`, `decor/rock1.png, rock2.png`
Có bao nhiêu file dùng bấy nhiêu (chọn ngẫu nhiên). Chân cây/đá sát đáy ảnh.

## 5. Khung HUD do bạn tự thiết kế
Sửa `theme.css` (cùng thư mục). Đã có ví dụ dùng ảnh khung 9-slice và đổi màu, font. Bạn có thể thiết kế khung, huy hiệu, banner trên Canva rồi xuất PNG.

## Nguồn tài nguyên và giấy phép (kiểm tra kỹ trước khi kiếm tiền)
- **Kenney.nl**, **Quaternius**, **OpenGameArt** (chọn CC0/CC-BY), **itch.io** (đọc từng gói), Craftpix (trả phí).
- Nếu là CC-BY thì phải ghi công tác giả. Trả phí thì kiểm tra có cho dùng thương mại và livestream không.
- **Không dùng hình ảnh của Clash of Clans hay game có bản quyền khác.**
- Tránh ảnh do AI tạo mà không rõ điều khoản thương mại của công cụ.
