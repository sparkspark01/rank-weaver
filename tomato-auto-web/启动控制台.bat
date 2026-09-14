@echo off
setlocal
chcp 65001 >nul
title Tomato Auto Console
cd /d "%~dp0"
echo ==========================================
echo    Tomato Auto Console  (番茄自动化控制台)
echo    Browser:  http://127.0.0.1:3210
echo    Close this window to stop the server.
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  echo         Install Node.js 18+ or fix PATH, then retry.
  echo.
  pause
  exit /b 1
)
echo Starting server ...
start "" http://127.0.0.1:3210
node server.mjs
echo.
echo [Server stopped] exit code: %ERRORLEVEL%
echo.
pause
