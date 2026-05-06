# Swirlock Chatbot UI

Angular browser client for the Swirlock Chat Orchestrator.

The UI opens one persistent WebSocket to:

```text
WS /v4/chat
```

Session creation, session loading, session deletion, and streamed turns all use
that socket. The UI does not use REST APIs.

## Development

```powershell
npm install
npm run start
```

Runtime connection settings live in
`src/app/core/config/runtime-config.ts`.
