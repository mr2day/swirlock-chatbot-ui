import { InjectionToken } from '@angular/core';

/**
 * Runtime configuration for the Gigi the Robot UI.
 *
 * Single source of truth for everything the app needs to know at runtime
 * about where to talk to the orchestrator and how to authenticate.
 * Provided in `app.config.ts` and consumed by services via
 * `inject(RUNTIME_CONFIG)`.
 *
 * In a real deployment this would come from an environment file, a backend
 * local file, or a Capacitor preference. For local development we supply the
 * same hardcoded dev token the orchestrator's `service.config.cjs` ships with.
 */
export interface RuntimeConfig {
  /** WebSocket base URL for the orchestrator. */
  wsBaseUrl: string;

  /**
   * Bearer token sent on the WebSocket upgrade. Browser `WebSocket` cannot
   * set custom headers, so the client appends it as `?token=`.
   */
  bearerToken: string;

  /**
   * Logical caller name surfaced as `requestContext.callerService` and
   * `app.appId` to the orchestrator.
   */
  appId: string;

  /** Optional client display channel surfaced on session creation. */
  clientChannel: string;

  /** Optional client version surfaced on session creation. */
  clientVersion: string;
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  wsBaseUrl: 'ws://127.0.0.1:3200',
  bearerToken: 'dev-token-change-me',
  appId: 'gigi-the-robot-ui',
  clientChannel: 'web',
  clientVersion: '0.1.0',
};
