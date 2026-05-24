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
  const apkName = `gigi-${bundle}.apk`;
  const apkPath = path.join(DRIVE_DEST, apkName);
  const notesPath = path.join(DRIVE_DEST, 'gigi-notes.txt');

  // Wipe every existing gigi-*.apk in the destination. Previous
  // builds (especially branch-experiments with non-monotonic version
  // numbers) created a graveyard of files that confused the human
  // looking for "the latest" one. Now the folder always holds
  // exactly one APK at any moment.
  const wiped = [];
  for (const entry of fs.readdirSync(DRIVE_DEST)) {
    if (/^gigi-.*\.apk$/.test(entry)) {
      try {
        fs.unlinkSync(path.join(DRIVE_DEST, entry));
        wiped.push(entry);
      } catch {
        /* harmless */
      }
    }
  }
  // Also remove the old dual-named notes file from the previous
  // scheme so it doesn't linger as a confusing artefact.
  const oldNotes = path.join(DRIVE_DEST, 'gigi-latest-notes.txt');
  if (fs.existsSync(oldNotes)) {
    try { fs.unlinkSync(oldNotes); } catch { /* */ }
  }

  fs.copyFileSync(APK_SRC, apkPath);

  const notes =
    `Gigi the Robot — Android APK\n` +
    `===========================\n\n` +
    `Version:       ${display}\n` +
    `Bundle id:     ${bundle}\n` +
    `Built:         ${buildDate}\n` +
    `Git commit:    ${commitHash}\n` +
    `APK size:      ${apkMb} MB\n` +
    `APK file:      ${apkName}\n` +
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

  if (wiped.length > 0) {
    console.log(`[publish-to-drive] wiped ${wiped.length} old APK(s): ${wiped.join(', ')}`);
  }
  console.log(`[publish-to-drive] wrote APK -> ${apkPath}`);
  console.log(`[publish-to-drive] wrote notes -> ${notesPath}`);
}

main();
