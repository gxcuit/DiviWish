@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  exit /b 1
)
call npm ci
if errorlevel 1 exit /b 1
echo Setup complete. Run run.cmd for the standalone app.
