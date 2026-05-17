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
  plugins: {
    // Capacitor Live Updates over a self-hosted manifest served by
    // the chat orchestrator at api.gigi-the-robot.com/updates. On
    // launch the plugin POSTs the device's current version to
    // `updateUrl`, the orchestrator returns the latest manifest, and
    // if the bundle version is newer the plugin downloads it in the
    // background and applies it on next launch. `notifyAppReady()`
    // (called from main.ts after Angular bootstraps) confirms the
    // bundle rendered successfully; if it doesn't fire within
    // `appReadyTimeout` the plugin rolls back to the previous bundle.
    //
    // statsUrl/channelUrl are blanked so the plugin doesn't phone
    // home to capgo.app — this deployment is fully self-hosted.
    CapacitorUpdater: {
      // autoUpdate=false: the plugin will NOT check, download, or
      // apply bundles on its own. We drive everything manually from
      // LiveUpdateService so the user is in full control — no silent
      // first-launch swap. notifyAppReady() in main.ts still applies
      // (commits whichever bundle is active so the plugin doesn't
      // roll back the next time the app launches).
      autoUpdate: false,
      appReadyTimeout: 30000,
      updateUrl: 'https://api.gigi-the-robot.com/updates',
      statsUrl: '',
      channelUrl: '',
      autoDeleteFailed: true,
      autoDeletePrevious: true,
    },
  },
};

export default config;
