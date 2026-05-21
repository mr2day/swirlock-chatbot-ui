#!/usr/bin/env node
/**
 * Copies the freshly-built debug APK into Google Drive Desktop's
 * mounted "My Drive" alongside a notes.txt that summarises what's
 * in the APK (version, build date, last commits).
 *
 * Wired into deploy.sh as the last step, after the APK has been
 * assembled by gradle. If the destination Drive folder isn't
 * present (Drive Desktop not running, or running under a different
 * user), the script logs a warning and exits 0 — never breaks a
 * deploy.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');

const DRIVE_DEST = 'G:\\My Drive\\Claude';
const APK_SRC = path.join(
  uiRoot,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);

function sh(cmd) {
  return execSync(cmd, { cwd: uiRoot, encoding: 'utf8' }).trim();
}

function safeSh(cmd) {
  try {
    return sh(cmd);
  } catch {
    return '';
  }
}

function main() {
  if (!fs.existsSync(DRIVE_DEST)) {
    console.warn(`[publish-to-drive] ${DRIVE_DEST} not found — Drive Desktop offline or mount changed; skipping.`);
    return;
  }
  if (!fs.existsSync(APK_SRC)) {
    console.warn(`[publish-to-drive] ${APK_SRC} not found — APK not built yet; skipping.`);
    return;
  }

  const versionPath = path.join(uiRoot, 'src', 'app', 'core', 'version.ts');
  const versionSrc = fs.readFileSync(versionPath, 'utf8');
  const display = versionSrc.match(/display:\s*'([^']+)'/)?.[1] ?? 'unknown';
  const bundle = versionSrc.match(/bundle:\s*'([^']+)'/)?.[1] ?? 'unknown';
  const commitHash = versionSrc.match(/commitHash:\s*'([^']+)'/)?.[1] ?? 'unknown';
  const buildDate = versionSrc.match(/buildDate:\s*'([^']+)'/)?.[1] ?? new Date().toISOString();

  // Latest UI commits — useful at-a-glance summary of what's in this APK.
  const uiLog = safeSh('git log -n 8 --pretty=format:%h%x09%ad%x09%s --date=short');
  const orchestratorRoot = path.resolve(uiRoot, '..', 'swirlock-chat-orchestrator');
  let orchestratorLog = '';
  if (fs.existsSync(path.join(orchestratorRoot, '.git'))) {
    try {
      orchestratorLog = execSync(
        'git log -n 5 --pretty=format:%h%x09%ad%x09%s --date=short',
        { cwd: orchestratorRoot, encoding: 'utf8' },
      ).trim();
    } catch {
      /* skip */
    }
  }

  const apkBytes = fs.statSync(APK_SRC).size;
  const apkMb = (apkBytes / 1024 / 1024).toFixed(1);
  const stampedApkName = `gigi-${bundle}.apk`;
  const stampedApkPath = path.join(DRIVE_DEST, stampedApkName);
  const latestApkPath = path.join(DRIVE_DEST, 'gigi-latest.apk');
  const notesPath = path.join(DRIVE_DEST, 'gigi-latest-notes.txt');

  fs.copyFileSync(APK_SRC, stampedApkPath);
  fs.copyFileSync(APK_SRC, latestApkPath);

  const notes =
    `Gigi the Robot — Android APK\n` +
    `===========================\n\n` +
    `Version:       ${display}\n` +
    `Bundle id:     ${bundle}\n` +
    `Built:         ${buildDate}\n` +
    `Git commit:    ${commitHash}\n` +
    `APK size:      ${apkMb} MB\n` +
    `\n` +
    `Files in this folder:\n` +
    `  - gigi-latest.apk     (always the freshest build; overwritten each deploy)\n` +
    `  - ${stampedApkName.padEnd(20)} (this specific build, kept by version)\n` +
    `  - gigi-latest-notes.txt (this file)\n` +
    `\n` +
    `Latest UI commits (newest first):\n` +
    `${uiLog || '  (no git history available)'}\n`;
  const notesWithOrch = orchestratorLog
    ? notes +
      `\n` +
      `Latest orchestrator commits (newest first):\n` +
      `${orchestratorLog}\n`
    : notes;

  fs.writeFileSync(notesPath, notesWithOrch);

  console.log(`[publish-to-drive] copied APK -> ${stampedApkPath}`);
  console.log(`[publish-to-drive] copied APK -> ${latestApkPath}`);
  console.log(`[publish-to-drive] wrote notes -> ${notesPath}`);
}

main();
