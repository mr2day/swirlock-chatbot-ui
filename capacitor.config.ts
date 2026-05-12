import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wrap of the Angular SPA. The `webDir` points at the
 * production build output that `npm run build` produces; `npx cap
 * sync android` copies it into the Android project's `assets/public`.
 *
 * `appId` is the Android package id and also feeds the OIDC client's
 * custom-scheme redirect URI (`gigi://auth/callback`) registered with
 * the IdP — see swirlock-idp-base's client store.
 */
const config: CapacitorConfig = {
  appId: 'com.swirlock.gigi',
  appName: 'Gigi the Robot',
  webDir: 'dist/swirlock-chatbot-ui/browser',
};

export default config;
