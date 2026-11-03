@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer with npm is required: https://nodejs.org/
  if not defined CI pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs" %*
set "DIVIWISH_EXIT=%errorlevel%"
if not "%DIVIWISH_EXIT%"=="0" if not defined CI pause
exit /b %DIVIWISH_EXIT%
