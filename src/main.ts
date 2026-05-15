import { bootstrapApplication } from '@angular/platform-browser';
import { createAppConfig } from './app/app.config';
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from './app/core/config/runtime-config';
import { App } from './app/app';

/**
 * Fetches /config.json (served by the production runtime via serve.js)
 * and merges it over the dev defaults. On localhost / `ng serve`,
 * /config.json doesn't exist; the fetch is treated as "use defaults".
 *
 * Only string-valued, non-empty overrides are applied — so a partial
 * config.json doesn't accidentally wipe a default with an empty string.
 */
async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_RUNTIME_CONFIG;
    const fetched = (await res.json()) as Partial<
      Record<keyof RuntimeConfig, unknown>
    >;
    const merged: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
    for (const [k, v] of Object.entries(fetched)) {
      if (typeof v === 'string' && v.length > 0) {
        (merged as unknown as Record<string, string>)[k] = v;
      }
    }
    return merged;
  } catch {
    return DEFAULT_RUNTIME_CONFIG;
  }
}

void loadRuntimeConfig().then((cfg) => {
  bootstrapApplication(App, createAppConfig(cfg))
    .then(notifyLiveUpdateReady)
    .catch((err) => console.error(err));
});

/**
 * On native (Capacitor) the @capgo/capacitor-updater plugin is
 * watching for this acknowledgement. If we don't call it within
 * `appReadyTimeout` (default 10s) after a freshly downloaded web
 * bundle starts, the plugin assumes the new bundle crashed and rolls
 * back to the previous one on next launch. Calling it right after
 * Angular bootstraps is the equivalent of "this version actually
 * rendered, keep it." A no-op on web.
 */
async function notifyLiveUpdateReady(): Promise<void> {
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.notifyAppReady();
  } catch {
    /* native plugin not present (web build) — ignore */
  }
}
