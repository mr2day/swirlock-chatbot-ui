#!/usr/bin/env bash
# Build the UI and restart the PM2 process serving it.
# Run after committing UI code changes — `./deploy.sh` or `npm run deploy`.

set -euo pipefail

cd "$(dirname "$0")"

echo "[deploy] Building Angular bundle..."
npm run build --silent

echo "[deploy] Reloading PM2 process from ecosystem file..."
# startOrReload re-reads ecosystem.config.cjs so env-var edits land,
# unlike plain `pm2 restart`, which only re-reads PM2's saved dump.
pm2 startOrReload ecosystem.config.cjs --update-env --silent
pm2 save --silent

echo "[deploy] Done. https://gigi-the-robot.com/ now serves the new build."
