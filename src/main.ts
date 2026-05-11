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
  bootstrapApplication(App, createAppConfig(cfg)).catch((err) =>
    console.error(err),
  );
});
