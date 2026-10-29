#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

# This project uses a Windows conda environment and Windows Node runtime.
# Delegate to the Windows launcher so its paths and DLL search path stay valid.
if ! command -v wslpath >/dev/null 2>&1; then
  echo 'This launcher requires WSL to use the existing Windows environment.' >&2
  exit 1
fi

cmd_exe="$(command -v cmd.exe || true)"
if [[ -z "$cmd_exe" && -f /mnt/c/Windows/System32/cmd.exe ]]; then
  cmd_exe=/mnt/c/Windows/System32/cmd.exe
fi
if [[ -z "$cmd_exe" ]]; then
  echo 'Windows cmd.exe was not found. Enable Windows interoperability in WSL.' >&2
  exit 1
fi

# WSL passes this Windows-backed working directory to cmd.exe. Using the
# relative filename avoids an extra layer of Windows command-line quoting.
exec "$cmd_exe" /d /c run.cmd
