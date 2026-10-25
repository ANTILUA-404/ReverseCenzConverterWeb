@echo off
title CENZ STUDIO
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)

echo.
echo   CENZ STUDIO
echo   http://localhost:3000
echo.
echo   Press Ctrl+C to stop.
echo.

node server.js
pause
