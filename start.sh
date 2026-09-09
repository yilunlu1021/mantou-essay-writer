#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22 or 24 LTS from https://nodejs.org/en/download, reopen your terminal, then retry.' >&2
  exit 1
fi
exec node bin/essay.mjs doctor
