# Gigi the Robot

> Repo: `swirlock-chatbot-ui` · App name: **Gigi the Robot**

The user-facing chat UI for the Swirlock chatbot ecosystem. Talks to the
[Chat Orchestrator](../swirlock-chat-orchestrator/) over HTTP for
session management and over WebSocket for streamed turns. Mobile-first,
dark-themed, persona-skinnable, ready to be wrapped with Capacitor for
iOS and Android.

The active chat session keeps one persistent WebSocket open and sends each
turn over that connection. The assistant bubble shows `Classifying...` while
the orchestrator is routing the turn through the Utility LLM.

For a deep dive into the architecture, persona model, and per-folder
layout see [`MANIFEST.md`](MANIFEST.md). For the contract this UI
implements, see
[`swirlock-chatbot-contracts/docs/versions/v3/apps/chatbot-ui.md`](../swirlock-chatbot-contracts/docs/versions/v3/apps/chatbot-ui.md).

## Stack

- Angular 21, signals, standalone components, zoneless change detection,
  control flow syntax (`@if`/`@for`).
- Separate `.ts` / `.html` / `.scss` files. No unit tests.
- `marked` + `DOMPurify` for safe Markdown rendering.

## Run

```powershell
npm install
npm start
```

App serves at <http://localhost:4200/>. The orchestrator must be
running on `127.0.0.1:3200` with the same bearer token configured here
as in
[`swirlock-chat-orchestrator/service.config.cjs`](../swirlock-chat-orchestrator/service.config.cjs)
(default `dev-token-change-me`).

## Configuration

All runtime configuration is in
[`src/app/core/config/runtime-config.ts`](src/app/core/config/runtime-config.ts).
Edit `DEFAULT_RUNTIME_CONFIG` to change the orchestrator base URL, the
bearer token, the app id, or the client channel. There are no
environment files to keep in sync.

## Logo asset

Drop the persona's chibi-robot artwork at
`public/personas/gigi-the-robot/logo.png`. The same file is used as the
favicon, the topbar avatar, the sidebar brand, the empty-state hero, and
the bubble avatar. See
[`public/personas/gigi-the-robot/PLACE-LOGO-HERE.md`](public/personas/gigi-the-robot/PLACE-LOGO-HERE.md)
for details.

## Adding a new persona

1. Add `public/personas/<id>/logo.png`.
2. Add `src/app/core/personas/<id>.persona.ts` (implement `Persona`).
3. Append it to
   [`src/app/core/personas/personas.registry.ts`](src/app/core/personas/personas.registry.ts).

Switching personas re-skins the whole app via `--persona-*` CSS custom
properties on `:root`; no component code changes.

## Build

```powershell
npm run build
```

Outputs to `dist/swirlock-chatbot-ui/`.
