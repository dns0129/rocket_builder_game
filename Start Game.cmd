@echo off
setlocal EnableExtensions
rem Switch the console to UTF-8 first; keep everything above this line ASCII-only.
chcp 65001 >nul
rem 火箭工坊：Windows 一键启动。双击运行即可。
title 火箭工坊 · 启动游戏
cd /d "%~dp0"

echo.
echo   ======================================
echo      火箭工坊 · 登月与行星际飞行
echo   ======================================
echo.

rem ---------------------------------------------------------------- 1. Node.js
where node >nul 2>nul
if errorlevel 1 (
  set "NODE_MSG=没有找到 Node.js。运行游戏需要它，只需安装一次。"
  goto :need_node
)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VER=%%v"
rem Vite 需要 Node.js 20.19 以上或 22.12 以上
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)"
if errorlevel 1 (
  set "NODE_MSG=Node.js 版本太旧（当前 v%NODE_VER%），需要 22.12 或更新的 LTS 版本。"
  goto :need_node
)
echo [1/3] Node.js v%NODE_VER%

rem ---------------------------------------------------------------- 2. 依赖
rem 第一次运行，或 package-lock.json 有变化（例如拉取了新版本）时才安装
set "NEED_INSTALL=0"
if not exist "node_modules\vite\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\.rocket-lock" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="0" (
  fc /b "package-lock.json" "node_modules\.rocket-lock" >nul 2>nul
  if errorlevel 1 set "NEED_INSTALL=1"
)
if "%NEED_INSTALL%"=="1" (
  echo [2/3] 正在安装依赖（需要联网，第一次约需 1 分钟）……
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :install_failed
  copy /y "package-lock.json" "node_modules\.rocket-lock" >nul
) else (
  echo [2/3] 依赖已安装
)

rem ---------------------------------------------------------------- 3. 构建并启动
echo [3/3] 正在构建游戏……
call npx vite build --logLevel warn
if errorlevel 1 goto :build_failed

echo.
echo   游戏已启动，浏览器会自动打开。
echo   如果没有自动打开，请在浏览器中访问下面显示的地址（通常是 http://localhost:4173/）。
echo   推荐使用 Chrome 或 Edge。玩完后关闭这个窗口即可退出。
echo.
call npx vite preview --host 127.0.0.1 --port 4173 --open
goto :eof

rem ---------------------------------------------------------------- 出错处理
:need_node
echo %NODE_MSG%
echo.
where winget >nul 2>nul
if errorlevel 1 goto :manual_node
choice /c YN /m "是否现在用 winget 自动安装 Node.js（LTS 版）"
if errorlevel 2 goto :manual_node
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto :manual_node
echo.
echo Node.js 安装完成。请关闭这个窗口，再双击“Start Game.cmd”启动游戏。
pause
exit /b 0

:manual_node
echo 请打开 https://nodejs.org 下载并安装 LTS 版本，装好后再双击“Start Game.cmd”。
start "" "https://nodejs.org/"
pause
exit /b 1

:install_failed
echo.
echo 依赖安装失败。请检查网络连接后重新双击“Start Game.cmd”。
echo 如果在中国大陆网络较慢，可以先在命令行执行：npm config set registry https://registry.npmmirror.com
pause
exit /b 1

:build_failed
echo.
echo 构建失败，请把上面的错误信息发给开发者。
pause
exit /b 1
