# Gigi the Robot — App Manifest

## Identity

- **Visible name:** Gigi the Robot
- **Repository name:** `swirlock-chatbot-ui`
- **Role in the Swirlock ecosystem:** the **Client** of the Chat
  Orchestrator (per `INTERACTION_MODEL.md`). It owns user-facing chat
  UX. It does not own session storage, retrieval, memory, or model
  hosting.

The visible name is *always* the active persona's name. Today there is
one persona, **Gigi the Robot**, so the name is fixed. When more
personas are added, the same UI re-skins to **Gigina Robotina**, **The
English Teacher**, **The Italian Actor**, and so on.

## Stack

- Angular 21 (signals, standalone components, zoneless change detection,
  control flow syntax `@if`/`@for`).
- Separate `.ts`, `.html`, `.scss` files. No unit tests in v0.1.
- TypeScript `strict`.
- `marked` + `DOMPurify` for safe Markdown rendering of assistant
  messages.
- Mobile-first dark UI. Designed to be wrapped with Capacitor for
  Android/iOS without changing the chat surface.

## Connection to the orchestrator

| Operation                      | Path                                              | Transport |
| ------------------------------ | ------------------------------------------------- | --------- |
| Create session                 | `POST   /v2/chat/sessions`                        | HTTP      |
| Open session (history)         | `GET    /v2/chat/sessions/:sessionId`             | HTTP      |
| Delete session                 | `DELETE /v2/chat/sessions/:sessionId`             | HTTP      |
| Stream a turn                  | `WS     /v2/chat/sessions/:sessionId/turns/stream`| WebSocket |
| Health                         | `GET    /v2/health`                               | HTTP      |

Auth on every endpoint is the bearer token from `RuntimeConfig`. On HTTP
the `Authorization: Bearer <token>` header is used. The browser cannot
set custom headers on `new WebSocket()`, so the streaming endpoint
receives the token as `?token=<...>` (one of the three transports
allowed by `API_CONVENTIONS.md#websocket-authentication`). The
orchestrator currently expects the same dev token shipped in
`swirlock-chat-orchestrator/service.config.cjs`.

The chat stream emits these events; the UI consumes all of them:

- `accepted` — orchestrator received the request.
- `queued` — Model Host queue position info.
- `started` — Model Host started inference.
- `retrieval` — RAG progress (forwarded from RAG Engine SSE). The UI
  renders a friendly inline label like *"Searching the web…"*.
- `thinking` — Model Host thinking text. Collapsed by default; one tap
  to expand.
- `chunk` — assistant text token(s). Streamed character-by-character into
  the bubble.
- `done` — terminal success. Carries the persisted `turnId`,
  `assistantMessage.messageId`, optional `citations`, optional
  `diagnostics`. The UI shows the **Sources** disclosure when citations
  are present.
- `error` — terminal failure. Surfaced both inline on the bubble and as
  a banner above the composer.

## Personas

A persona is **both** a UI skin and an LLM personality (the orchestrator
receives `app.personaId` on session creation, ready to be used for
persona-specific prompt construction in a future iteration).

A persona ships in two parts:

1. A **TypeScript file** under
   [`src/app/core/personas/`](src/app/core/personas/) implementing the
   `Persona` interface (id, name, description, logo path, greeting,
   theme).
2. An **image asset** under [`public/personas/<id>/logo.png`](public/personas/).

The UI applies the active persona's `theme` as `--persona-*` CSS custom
properties on `:root`. Switching personas is a single set of writes;
every component re-skins instantly because every component reads
`--persona-*`, never raw colors.

The persona's name flows through to:

- the browser tab title (set by an `effect()` in the root component),
- the topbar header,
- the sidebar brand,
- the empty-state hero,
- the composer placeholder ("Message Gigi the Robot…"),
- the meta tags `apple-mobile-web-app-title` and `description` in
  `index.html` (these are static today; the visible names are the
  default persona's name).

To add a new persona later:

1. Drop a new logo at `public/personas/<id>/logo.png`.
2. Add `<id>.persona.ts` next to `gigi-the-robot.persona.ts`.
3. Append it to `personas.registry.ts`.

That's it — no other code changes needed. A persona switcher in the
topbar is on the roadmap; for now the registry is read-only.

## Roadmap

- Persona switcher UI in the topbar.
- Multiple personas: Gigina Robotina, The English Teacher, The Italian
  Actor.
- Settings panel (override bearer token at runtime, switch orchestrator
  base URL).
- File / image attachments (when the orchestrator wires `imageId`
  resolution).
- Edit/regenerate user message (ChatGPT-style).
- Capacitor wrapper for iOS and Android.
- Voice input/output.
- Conversation search.

## Layout

```
src/
  app/
    core/
      config/runtime-config.ts        InjectionToken with API base URLs and bearer token
      markdown/markdown.ts            marked + DOMPurify wrapper
      models/                         TypeScript types for the v3 contract
      personas/                       Persona interface, GIGI_THE_ROBOT, registry
      services/
        auth.service.ts               bearer token storage
        chat-api.service.ts           REST client (sessions: create, get, delete)
        chat-stream.service.ts        WebSocket client for /turns/stream
        layout.service.ts             sidebar open/close + isMobile signal
        persona.service.ts            active persona signal + theme application
        session.service.ts            sessions list, current session, streaming reducer
    layouts/
      main-layout/                    sidebar + main shell, mobile drawer behavior
      sidebar/                        new chat button, sessions list, brand block
      topbar/                         hamburger + persona name
    features/
      chat/
        chat-page.ts/.html/.scss      message list + composer + empty state
        components/
          composer/                   textarea + send/stop, Enter-to-send
          empty-state/                hero + suggestions
          message-bubble/             user/assistant bubble, thinking, retrieval, citations
    app.config.ts                     providers (HttpClient, zoneless, RUNTIME_CONFIG)
    app.routes.ts                     `/` and `/c/:sessionId`
    app.ts/.html/.scss                root, sets browser title from active persona
public/
  personas/gigi-the-robot/            persona-scoped image assets
service.config.cjs                    (not present here; lives in the orchestrator)
```

## Run locally

```powershell
npm install
npm start
```

The app serves at <http://localhost:4200/>. Make sure the orchestrator
is running on `127.0.0.1:3200` with the dev bearer token
`dev-token-change-me` (default in
`swirlock-chat-orchestrator/service.config.cjs`). To change either, edit
`DEFAULT_RUNTIME_CONFIG` in
[`src/app/core/config/runtime-config.ts`](src/app/core/config/runtime-config.ts).
