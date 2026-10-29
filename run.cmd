@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0.conda\python.exe" (
  echo Conda environment is missing. Run: conda env create --prefix .\.conda -f environment.yml
  exit /b 1
)
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
set "PATH=%~dp0.conda;%~dp0.conda\Library\bin;%~dp0.conda\Scripts;%PATH%"
"%~dp0.conda\python.exe" "%~dp0scripts\export_sheet_pic.py"
exit /b %errorlevel%
