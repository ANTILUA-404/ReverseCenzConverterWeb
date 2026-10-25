#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi

echo
echo "  CENZ STUDIO"
echo "  http://localhost:3000"
echo
exec node server.js
