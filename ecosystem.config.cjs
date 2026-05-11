// PM2 process definition for serving the production-built UI locally.
// The same `serve.js` runs in Cloud Run too — only the env vars
// differ. For local-tunnel hosting these point at the
// Cloudflare-tunneled orchestrator/IdP URLs.

module.exports = {
  apps: [
    {
      name: 'swirlock-chatbot-ui-frontend',
      script: 'serve.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        WS_BASE_URL: 'wss://api.gigi-the-robot.com',
        APP_ID: 'gigi-the-robot-ui',
        CLIENT_CHANNEL: 'web',
        CLIENT_VERSION: '0.1.0',
        IDP_ISSUER: 'https://idpbase.swirlock.com/oidc',
        OIDC_CLIENT_ID: 'swirlock-chatbot-ui',
        OIDC_REDIRECT_URI: 'https://gigi-the-robot.com/auth/callback',
        OIDC_POST_LOGOUT_REDIRECT_URI: 'https://gigi-the-robot.com/',
        OIDC_RESOURCE: 'http://127.0.0.1:3200',
      },
    },
  ],
};
