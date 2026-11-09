#!/usr/bin/env bash
# Reproducible local CI for machines without GitHub Actions.
# Usage: ./ci.sh            (installs deps when node_modules is missing)
#        SKIP_INSTALL=1 ./ci.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ] && [ "${SKIP_INSTALL:-0}" != "1" ]; then
  npm ci
fi

npm run typecheck
npm test
npm run package
npm run package:vsix

echo "ci: OK — bundle out/extension.js, tests, typecheck and VSIX packaging passed"
