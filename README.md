# Swirlock Chatbot UI

Angular browser client for the Swirlock Chat Orchestrator.

The UI opens one persistent WebSocket to:

```text
WS /v5/chat
```

Session creation, session loading, session deletion, and streamed turns all use
that socket. The UI does not use REST APIs. Implements the client side of
[Swirlock Chatbot Contracts v5](../swirlock-chatbot-contracts/docs/versions/v5/apps/chat-orchestrator.md).

## Development

```powershell
npm install
npm run start
```

Runtime connection settings live in
`src/app/core/config/runtime-config.ts`.
