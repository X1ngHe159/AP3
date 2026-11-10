@echo off
chcp 65001 >nul
title AP3 · 光照与纹理场景
echo ============================================================
echo  AP3 · 光照与纹理场景
echo   1) 本窗口会启动一个零依赖静态服务器（node tools\serve.mjs）
echo   2) 然后用浏览器打开： http://127.0.0.1:8134/
echo   3) 关闭本窗口即停止服务器
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node。请先安装 Node.js 18+，或改用：
  echo        python -m http.server 8134
  echo.
  pause
  exit /b 1
)
node tools\serve.mjs
pause
