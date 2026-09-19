@echo off
REM Lay code moi nhat tu GitHub trong luc server van dang chay live.
REM Khong can dung "npm start" - xem README muc "Cap nhat code khi dang live".
cd /d "%~dp0"

set STASHED=0
git diff --quiet -- config.json
if errorlevel 1 (
  echo [!] config.json dang co thay doi chua luu ^(co the do ban chinh can bang qua trang admin^).
  echo     Tam cat lai de khong bi mat khi cap nhat...
  git stash push -m "update.bat: tam cat config.json" -- config.json
  set STASHED=1
)

echo.
echo Dang tai code moi nhat...
git pull
if errorlevel 1 (
  echo.
  echo [X] Tai code that bai ^(co the do xung dot^). Xem thong bao git o tren de xu ly.
  if "%STASHED%"=="1" echo     ^(Thay doi config.json cua ban van con trong 'git stash list', chua mat.^)
  pause
  exit /b 1
)

if "%STASHED%"=="1" (
  echo.
  echo Khoi phuc lai chinh sua config.json cua ban...
  git stash pop
  if errorlevel 1 (
    echo [!] config.json cua ban xung dot voi ban moi tai ve.
    echo     Mo file len xem dong co dau ^<^<^<^<^<^<^< / ======= / ^>^>^>^>^>^>^> va tu chon giu ben nao,
    echo     roi chay: git add config.json ^&^& git stash drop
    pause
    exit /b 1
  )
)

echo.
echo Xong! Server dang chay se tu ap dung:
echo    - config.json          : gan nhu ngay lap tuc
echo    - game.js (luat choi)  : khi van hien tai ket thuc
echo    - public/index.html    : trinh duyet tu tai lai khi van moi bat dau
echo    - server.js            : can ban tu dung (Ctrl+C) roi chay lai "npm start"
pause
