#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer with npm is required: https://nodejs.org/" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/scripts/launch.mjs" --prepare "$@"
