import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import {
  DEFAULT_RUNTIME_CONFIG,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from './core/config/runtime-config';

export function createAppConfig(
  runtimeConfig: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideZonelessChangeDetection(),
      provideRouter(routes, withComponentInputBinding()),
      { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    ],
  };
}

/** Legacy export — kept for any code still importing `appConfig` directly. */
export const appConfig: ApplicationConfig = createAppConfig();
