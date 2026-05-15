#!/usr/bin/env node
/**
 * Capacitor Live Updates publisher.
 *
 * Reads the freshly-built Angular bundle from
 * `dist/swirlock-chatbot-ui/browser`, zips it, computes a sha256,
 * writes a manifest.json that points the @capgo/capacitor-updater
 * plugin at the new bundle, and copies both into the chat
 * orchestrator's `data/updates/` directory so api.gigi-the-robot.com
 * serves them.
 *
 * Assumes `ng build` has already run. `deploy.sh` calls this script
 * after its `npm run build` step.
 *
 * Bundle version is the monotonically-increasing git commit count on
 * the current branch, prefixed `0.0.` so the resulting string is a
 * valid semver that the plugin can compare against the previous
 * value with a plain string comparison.
 *
 * Cleans up older bundles in the destination so the directory does
 * not grow forever: keeps the most recent N bundles (default 10),
 * deletes the rest.
 */

import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const distDir = path.join(uiRoot, 'dist', 'swirlock-chatbot-ui', 'browser');
const orchestratorRoot = path.resolve(uiRoot, '..', 'swirlock-chat-orchestrator');
const updatesDir = path.join(orchestratorRoot, 'data', 'updates');

const PUBLIC_BASE_URL = 'https://api.gigi-the-robot.com/updates';
const KEEP_LAST_N_BUNDLES = 10;

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: uiRoot, encoding: 'utf8', ...opts }).trim();
}

function main() {
  if (!fs.existsSync(distDir)) {
    console.error(`[publish-update] no build at ${distDir}; run \`npm run build\` first.`);
    process.exit(1);
  }

  fs.mkdirSync(updatesDir, { recursive: true });

  const commitCount = sh('git rev-list --count HEAD');
  const version = `0.0.${commitCount}`;
  const bundleName = `bundle-${version}.zip`;
  const bundlePath = path.join(updatesDir, bundleName);

  if (fs.existsSync(bundlePath)) {
    console.log(`[publish-update] ${bundleName} already exists — overwriting.`);
    fs.unlinkSync(bundlePath);
  }

  console.log(`[publish-update] zipping ${distDir} → ${bundleName}`);
  const zip = new AdmZip();
  zip.addLocalFolder(distDir);
  zip.writeZip(bundlePath);

  const zipBytes = fs.readFileSync(bundlePath);
  const checksum = crypto.createHash('sha256').update(zipBytes).digest('hex');

  const manifest = {
    version,
    url: `${PUBLIC_BASE_URL}/${bundleName}`,
    checksum,
  };
  const manifestPath = path.join(updatesDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[publish-update] manifest written:`, manifest);

  pruneOldBundles(updatesDir, bundleName);
  purgeManifestFromCloudflare();

  console.log(`[publish-update] done. Friends' apps will pick up ${version} on next launch.`);
}

function pruneOldBundles(dir, currentName) {
  const bundles = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('bundle-') && f.endsWith('.zip'))
    .sort();
  if (bundles.length <= KEEP_LAST_N_BUNDLES) return;
  const toDelete = bundles.slice(0, bundles.length - KEEP_LAST_N_BUNDLES);
  for (const name of toDelete) {
    if (name === currentName) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      console.log(`[publish-update] pruned old bundle ${name}`);
    } catch {
      /* best effort */
    }
  }
}

function purgeManifestFromCloudflare() {
  const email = process.env.CLOUDFLARE_API_EMAIL;
  const key = process.env.CLOUDFLARE_API_KEY;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!email || !key || !zoneId) {
    console.log(
      '[publish-update] Cloudflare env vars unset (CLOUDFLARE_API_EMAIL/KEY/ZONE_ID); skipping cache purge.',
    );
    return;
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
  const body = JSON.stringify({ files: [`${PUBLIC_BASE_URL}/manifest.json`] });
  try {
    const res = sh(
      `curl -fsS -X POST "${url}" -H "X-Auth-Email: ${email}" -H "X-Auth-Key: ${key}" -H "Content-Type: application/json" --data '${body}'`,
    );
    console.log('[publish-update] Cloudflare cache purged.');
    console.log('  response:', res.slice(0, 200));
  } catch (err) {
    console.warn(
      '[publish-update] Cloudflare purge failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

main();
