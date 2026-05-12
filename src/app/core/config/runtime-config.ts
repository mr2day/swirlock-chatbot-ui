import { InjectionToken } from '@angular/core';

/**
 * Runtime configuration for the Gigi the Robot UI.
 *
 * Single source of truth for everything the app needs to know at runtime
 * about where to talk to the orchestrator and the identity provider.
 * Provided in `app.config.ts` and consumed by services via
 * `inject(RUNTIME_CONFIG)`.
 */
export interface RuntimeConfig {
  /** WebSocket base URL for the orchestrator. */
  wsBaseUrl: string;

  /** Logical caller name surfaced as `requestContext.callerService` and `app.appId`. */
  appId: string;

  /** Optional client display channel surfaced on session creation. */
  clientChannel: string;

  /** Optional client version surfaced on session creation. */
  clientVersion: string;

  /** OpenID Connect issuer URL of the Swirlock IdP. */
  idpIssuer: string;

  /** Client ID this app is registered as in the IdP. */
  oidcClientId: string;

  /** Where the IdP should redirect the browser after authentication. */
  oidcRedirectUri: string;

  /** Where the IdP should redirect after RP-initiated logout. */
  oidcPostLogoutRedirectUri: string;

  /**
   * Resource indicator (audience) bound to access tokens. The orchestrator
   * verifies the JWT's `aud` against this exact string.
   */
  oidcResource: string;
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  wsBaseUrl: 'ws://127.0.0.1:3200',
  appId: 'gigi-the-robot-ui',
  clientChannel: 'web',
  clientVersion: '0.1.0',
  idpIssuer: 'https://idpbase.swirlock.com/oidc',
  oidcClientId: 'swirlock-chatbot-ui',
  oidcRedirectUri: 'http://localhost:4200/auth/callback',
  oidcPostLogoutRedirectUri: 'http://localhost:4200/auth/logout-callback',
  oidcResource: 'http://127.0.0.1:3200',
};
