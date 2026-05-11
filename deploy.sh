#!/usr/bin/env bash
# Build the UI and restart the PM2 process serving it.
# Run after committing UI code changes — `./deploy.sh` or `npm run deploy`.

set -euo pipefail

cd "$(dirname "$0")"

echo "[deploy] Building Angular bundle..."
npm run build --silent

echo "[deploy] Restarting PM2 process..."
pm2 restart swirlock-chatbot-ui-frontend --update-env --silent

echo "[deploy] Done. https://gigi-the-robot.com/ now serves the new build."
