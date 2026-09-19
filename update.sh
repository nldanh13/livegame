#!/bin/bash
# Lấy code mới nhất từ GitHub trong lúc server vẫn đang chạy live.
# Không cần dừng "npm start" - xem README mục "Cập nhật code khi đang live".
set -e
cd "$(dirname "$0")"

echo "🔎 Kiểm tra thay đổi cục bộ..."
STASHED=0
if ! git diff --quiet -- config.json 2>/dev/null; then
  echo "⚠️  config.json đang có thay đổi chưa lưu (có thể do bạn chỉnh cân bằng qua trang admin)."
  echo "    Tạm cất lại để không bị mất khi cập nhật..."
  git stash push -m "update.sh: tạm cất config.json" -- config.json
  STASHED=1
fi

echo "📥 Đang tải code mới nhất..."
if ! git pull; then
  echo "❌ Tải code thất bại (có thể do xung đột). Xem thông báo git ở trên để xử lý."
  if [ "$STASHED" = "1" ]; then
    echo "    (Thay đổi config.json của bạn vẫn còn trong 'git stash list', chưa mất.)"
  fi
  exit 1
fi

if [ "$STASHED" = "1" ]; then
  echo "♻️  Khôi phục lại chỉnh sửa config.json của bạn..."
  if ! git stash pop; then
    echo "⚠️  config.json của bạn xung đột với bản mới tải về."
    echo "    Mở file lên xem dòng có dấu <<<<<<< / ======= / >>>>>>> và tự chọn giữ bên nào,"
    echo "    rồi chạy: git add config.json && git stash drop"
    exit 1
  fi
fi

echo ""
echo "✅ Xong! Server đang chạy sẽ tự áp dụng:"
echo "   - config.json          : gần như ngay lập tức"
echo "   - game.js (luật chơi)  : khi ván hiện tại kết thúc"
echo "   - public/index.html    : trình duyệt tự tải lại khi ván mới bắt đầu"
echo "   - server.js            : cần bạn tự dừng (Ctrl+C) rồi chạy lại 'npm start'"
