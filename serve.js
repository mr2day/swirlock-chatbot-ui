/* eslint-disable */
// Production serve script for the Angular SPA. Used by Google Cloud
// Buildpacks (via Procfile) on Cloud Run. Does three things:
//
//   1. Serve /config.json from Cloud Run env vars so the SPA can hydrate
//      its RuntimeConfig at runtime without rebuilding per environment.
//   2. Serve the built static assets from dist/swirlock-chatbot-ui/browser.
//   3. Fall back to index.html for SPA client-side routes.
//
// Local dev still uses `ng serve` and never touches this file.

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const port = parseInt(process.env.PORT, 10) || 8080;
const dist = path.join(__dirname, 'dist', 'swirlock-chatbot-ui', 'browser');

const runtimeConfig = {
  wsBaseUrl: process.env.WS_BASE_URL,
  appId: process.env.APP_ID,
  clientChannel: process.env.CLIENT_CHANNEL,
  clientVersion: process.env.CLIENT_VERSION,
  idpIssuer: process.env.IDP_ISSUER,
  oidcClientId: process.env.OIDC_CLIENT_ID,
  oidcRedirectUri: process.env.OIDC_REDIRECT_URI,
  oidcPostLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI,
  oidcResource: process.env.OIDC_RESOURCE,
};

app.get('/config.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(runtimeConfig);
});

// Hashed asset filenames (main-XYZ.js etc.) can cache aggressively;
// index.html cannot, because it's the document that pins which hashes
// the browser fetches next. If index.html is cached, a redeploy keeps
// serving the old bundle to existing tabs.
app.use(
  express.static(dist, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
      }
    },
  }),
);

app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(dist, 'index.html'));
});

app.listen(port, () => {
  console.log(`[serve] listening on :${port}, serving ${dist}`);
  console.log(`[serve] runtime config:`, runtimeConfig);
  if (!fs.existsSync(dist)) {
    console.warn(`[serve] WARN: dist directory does not exist yet`);
  }
});
