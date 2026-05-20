#!/usr/bin/env bash
# Build the UI and restart the PM2 process serving it.
# Run after committing UI code changes — `./deploy.sh` or `npm run deploy`.

set -euo pipefail

cd "$(dirname "$0")"

echo "[deploy] Stamping version into src/app/core/version.ts..."
node scripts/write-version.mjs

echo "[deploy] Building Angular bundle..."
npm run build --silent

echo "[deploy] Publishing Capacitor Live Update bundle..."
node scripts/publish-update.mjs

echo "[deploy] Reloading PM2 process from ecosystem file..."
# startOrReload re-reads ecosystem.config.cjs so env-var edits land,
# unlike plain `pm2 restart`, which only re-reads PM2's saved dump.
pm2 startOrReload ecosystem.config.cjs --update-env --silent
pm2 save --silent

# Build the Android APK so the file in Google Drive always matches
# what's running on the web. Without this step deploy.sh would mirror
# whatever APK was last built (potentially several versions stale).
# `cap sync` copies the freshly-built web bundle into the Android
# assets/public; `./gradlew assembleDebug` compiles the APK.
echo "[deploy] Syncing Android assets + building debug APK..."
npx cap sync android
( cd android && ./gradlew assembleDebug )

# Publish the APK + notes to the user's Google Drive Claude folder.
# Best-effort: warns and continues if Drive is offline.
echo "[deploy] Publishing APK + notes to Google Drive..."
node scripts/publish-to-drive.mjs

echo "[deploy] Done."
echo "[deploy]   https://gigi-the-robot.com/        serves the new web build."
echo "[deploy]   https://api.gigi-the-robot.com/updates/  exposes the new bundle to APK installs."
echo "[deploy]   G:\\My Drive\\Claude\\                       holds the latest APK + notes."
