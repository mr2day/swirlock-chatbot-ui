import { Injectable, inject, signal } from '@angular/core';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import type {
  CreateSessionResponse,
  DeleteSessionResponse,
  GetSessionResponse,
  PersistedMessage,
} from '../models/chat.model';
import type { ApiMeta } from '../models/api-meta.model';
import type { ChatStreamEvent } from '../models/stream-event.model';
import { AuthService } from './auth.service';

/**
 * ChatStreamService — talks to swirlock-agent-runtime over a single
 * persistent WebSocket at `${wsBaseUrl}/v1/agent`.
 *
 * The new agent's protocol is materially different from the old
 * orchestrator's v5 channel: first-frame `{type: 'auth', token}`
 * instead of `?token=` query; flat envelope `{type, inReplyTo?, ...}`
 * instead of `{type, correlationId, payload}`; turn events carry
 * `turnId` instead of `correlationId`; no persona / no retrieval /
 * no location / no images on the wire.
 *
 * To keep the rest of the UI unchanged we translate at this boundary:
 * the public method surface and the `ChatStreamEvent` union are
 * unchanged; SessionService keeps working against the same shapes.
 * Where the new agent has nothing to say (turn.queued, turn.retrieval,
 * turn.location_required), the corresponding events simply never fire.
 */

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface StreamHandle {
  cancel(): void;
}

/**
 * Backend identifier wire format — must match the agent runtime's
 * BackendId union. Widen here whenever the agent gains a new backend.
 */
export type AgentBackend =
  | 'anthropic'
  | 'mistral-online'
  | 'mistral-local'
  | 'ollama-local';

/**
 * Backend descriptor as it arrives from the agent's backends.list
 * reply. Used verbatim by the UI's model picker — no display strings
 * are hardcoded client-side.
 */
export interface AgentBackendInfo {
  name: AgentBackend;
  displayName: string;
  defaultModelId: string;
  location: 'cloud' | 'local';
}

interface ServerFrame {
  type: string;
  inReplyTo?: string;
  [key: string]: unknown;
}

interface PendingRequest<T> {
  successType: string;
  resolve: (frame: ServerFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  sessionId: string;
  turnId: string;
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
  // Accumulators so we can emit a complete turn.done payload at the
  // end (the new agent's turn.done carries only usage + finishReason,
  // not the assistant text — that text was streamed via text_delta).
  assistantText: string;
  assistantCreatedAt: string;
  // Citation buffer. The new agent has no top-level citations field
  // on turn.done; search_web tool results carry the sources. We
  // collect them across every search_web call in the turn, dedup by
  // URL, and emit as CitationRef[] on the synthesized turn.done.
  citations: Map<string, { title: string; url: string }>;
}

@Injectable({ providedIn: 'root' })
export class ChatStreamService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly auth = inject(AuthService);

  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private authenticated = false;
  /**
   * The reason auth was rejected, captured from the pre-auth error
   * frame. Used by failPending() so callers see "Invalid Compact JWS"
   * or "unexpected aud claim" instead of the generic "WebSocket
   * closed" — which used to happen because the close event fires
   * just after the rejection and overrode the real reason.
   */
  private lastAuthError: string | null = null;

  // Frames queued before the socket is open / authenticated.
  private readonly preauthQueue: unknown[] = [];

  // Outstanding command->reply correlations.
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  // At most one streaming turn at a time. Maps the active turnId so
  // we can route incoming text_delta / tool_use / done frames.
  private activeTurn: ActiveTurn | null = null;

  private readonly _modelId = signal<string | null>(null);
  private readonly _thinkingSupported = signal<boolean | null>(null);
  readonly modelId = this._modelId.asReadonly();
  readonly thinkingSupported = this._thinkingSupported.asReadonly();

  /**
   * Returns the agent's currently-pinned default model + capability
   * flags. Cached after the first resolution; force=true bypasses.
   * `thinkingSupported` is false until the agent gates extended
   * thinking through (no provider exposes it on the wire today).
   */
  async getModelInfo(args?: {
    force?: boolean;
  }): Promise<{ modelId: string; thinkingSupported: boolean }> {
    const force = args?.force === true;
    if (!force) {
      const cached = this._modelId();
      const cachedThink = this._thinkingSupported();
      if (cached !== null && cachedThink !== null) {
        return { modelId: cached, thinkingSupported: cachedThink };
      }
    }
    const { backends, defaultBackend } = await this.listBackends();
    const chosen =
      backends.find((b) => b.name === defaultBackend) ?? backends[0];
    const info = {
      modelId: chosen?.defaultModelId ?? 'unknown',
      thinkingSupported: false,
    };
    this._modelId.set(info.modelId);
    this._thinkingSupported.set(info.thinkingSupported);
    return info;
  }

  async getModelId(): Promise<string> {
    return (await this.getModelInfo()).modelId;
  }

  /**
   * Returns the runtime's available backends, verbatim from the agent's
   * `backends.list` reply. Display strings come from the server.
   */
  async listBackends(): Promise<{
    defaultBackend: AgentBackend;
    backends: AgentBackendInfo[];
  }> {
    const id = uuid();
    const reply = await this.request(id, 'backends.list', 'backends.list', {});
    return {
      defaultBackend: reply['defaultBackend'] as AgentBackend,
      backends: (reply['backends'] as AgentBackendInfo[] | undefined) ?? [],
    };
  }

  /**
   * Asks the agent to pin a different default backend on a session.
   * Resolves with the updated PublicSession (callers should use the
   * returned session as the new source of truth — including
   * defaultBackend, updatedAt). The agent persists the change before
   * replying, so optimistic UI updates are not needed.
   */
  async setSessionBackend(args: {
    sessionId: string;
    backend: AgentBackend;
  }): Promise<{
    sessionId: string;
    defaultBackend: AgentBackend;
    updatedAt: string;
  }> {
    const id = uuid();
    const reply = await this.request(
      id,
      'session.set_backend',
      'session.backend_set',
      { sessionId: args.sessionId, backend: args.backend },
    );
    const session = reply['session'] as {
      id: string;
      defaultBackend: AgentBackend | null;
      updatedAt: string;
    };
    return {
      sessionId: session.id,
      defaultBackend: (session.defaultBackend ?? args.backend) as AgentBackend,
      updatedAt: session.updatedAt,
    };
  }

  createSession(args: {
    userId: string;
    displayName?: string;
    persona: { id: string; name: string; systemPrompt: string };
    correlationId?: string;
  }): Promise<CreateSessionResponse> {
    const id = args.correlationId ?? uuid();
    // No `defaultBackend` sent — the agent uses the user's saved
    // preference (or AGENT_DEFAULT_BACKEND if none) when the client
    // omits it. No `title` sent — the agent auto-derives from the
    // first user message. `clientMetadata.personaId` is persisted
    // server-side so listSessions can scope the sidebar by persona
    // (replaces the client-side localStorage intersection that
    // silently hid all sessions on a fresh device).
    return this.request(id, 'session.create', 'session.created', {
      systemPrompt: args.persona.systemPrompt,
      clientMetadata: { personaId: args.persona.id },
    }).then((reply) => {
      const session = reply['session'] as {
        id: string;
        createdAt: string;
        defaultBackend: AgentBackend | null;
      };
      return {
        meta: this.meta(id),
        data: {
          sessionId: session.id,
          createdAt: session.createdAt,
          status: 'active' as const,
          defaultBackend: session.defaultBackend,
        },
      };
    });
  }

  listSessions(args?: {
    personaId?: string;
    correlationId?: string;
  }): Promise<{
    sessions: {
      sessionId: string;
      personaId: string | null;
      title: string;
      defaultBackend: string | null;
      createdAt: string;
      updatedAt: string;
    }[];
  }> {
    // Persona scoping is server-side now: pass {personaId} as a
    // clientMetadata filter; the agent does JSONB containment on
    // sessions.client_metadata and returns only matching rows.
    // Survives device swaps + localStorage clears (the regression
    // the previous local-cache intersection had).
    const id = uuid();
    const extras: Record<string, unknown> = {};
    if (args?.personaId) {
      extras['clientMetadataFilter'] = { personaId: args.personaId };
    }
    return this.request(id, 'session.list', 'session.list', extras).then(
      (reply) => {
        const list = (reply['sessions'] ?? []) as Array<{
          id: string;
          title: string | null;
          defaultBackend: string | null;
          clientMetadata: { personaId?: string } | null;
          createdAt: string;
          updatedAt: string;
        }>;
        return {
          sessions: list.map((s) => ({
            sessionId: s.id,
            personaId: s.clientMetadata?.personaId ?? null,
            title: s.title ?? 'New chat',
            defaultBackend: s.defaultBackend,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          })),
        };
      },
    );
  }

  getSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<GetSessionResponse> {
    return this.request(correlationId, 'session.get', 'session.detail', {
      sessionId,
    }).then((reply) => {
      const session = reply['session'] as {
        id: string;
        title: string | null;
        defaultBackend: AgentBackend | null;
        clientMetadata: { personaId?: string } | null;
        createdAt: string;
        updatedAt: string;
        status: string;
      };
      const messages = (reply['messages'] ?? []) as Array<{
        id: string;
        turnId: string;
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: unknown;
        text: string;
        seq: number;
        createdAt: string;
        metadata: { backend?: string; modelId?: string } | null;
      }>;
      const persisted: PersistedMessage[] = messages
        // Hide pure tool-call / tool-result messages from the UI —
        // they're internal agent-loop accounting, not turns the user
        // typed or the assistant said. The final assistant text
        // message at the end of the turn carries the visible content.
        .filter((m) => m.role !== 'tool' && m.text.length > 0)
        .map((m) => ({
          messageId: m.id,
          turnId: m.turnId,
          role: m.role === 'system' ? 'assistant' : (m.role as 'user' | 'assistant'),
          content: m.text,
          createdAt: m.createdAt,
          ...(m.metadata?.backend && m.metadata?.modelId
            ? {
                attribution: {
                  backend: m.metadata.backend,
                  modelId: m.metadata.modelId,
                },
              }
            : {}),
        }));
      return {
        meta: this.meta(correlationId),
        data: {
          sessionId: session.id,
          // personaId now flows back from the server-side metadata
          // bag — set when the chatbot UI created the session, null
          // for sessions from other clients. The chat-page uses this
          // to sync the active persona when a session is opened by
          // URL on a different device.
          personaId: session.clientMetadata?.personaId ?? null,
          personaName: null,
          defaultBackend: session.defaultBackend,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          status: session.status,
          messages: persisted,
        },
      };
    });
  }

  deleteSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<DeleteSessionResponse> {
    // The agent has no destructive delete — it archives. From the UI's
    // perspective this is identical: the session no longer appears in
    // the active list. We surface the success as the old "deleted"
    // response shape so SessionService doesn't need to learn the new
    // verb.
    return this.request(
      correlationId,
      'session.archive',
      'session.archived',
      { sessionId },
    ).then(() => ({
      meta: this.meta(correlationId),
      data: { sessionId, deleted: true },
    }));
  }

  openTurn(args: {
    sessionId: string;
    text: string;
    correlationId?: string;
    thinking?: boolean;
    forceThinking?: boolean;
    includeDiagnostics?: boolean;
    images?: { dataUrl: string; mimeType: string }[];
    userLocation?: import('../models/chat.model').UserLocation;
    onEvent: (event: ChatStreamEvent) => void;
    onClose?: (info: {
      clean: boolean;
      code?: number;
      reason?: string;
    }) => void;
  }): StreamHandle {
    const turnId = args.correlationId ?? uuid();

    if (this.activeTurn) {
      args.onEvent(this.localError(turnId, 'A turn is already active'));
      return { cancel: () => undefined };
    }

    if (args.images && args.images.length > 0) {
      // The new agent doesn't accept images yet — drop them and warn.
      // SessionService will still show the inline preview in the user
      // bubble; the model just won't see them. Add when the agent
      // gains multimodal support.
      console.warn(
        '[chat] image attachments dropped — swirlock-agent-runtime has no multimodal input yet',
      );
    }

    const active: ActiveTurn = {
      sessionId: args.sessionId,
      turnId,
      onEvent: args.onEvent,
      onClose: args.onClose,
      assistantText: '',
      assistantCreatedAt: new Date().toISOString(),
      citations: new Map(),
    };
    this.activeTurn = active;

    // No per-turn backend override on the wire — model selection
    // lives on session.default_backend (set via session.set_backend).
    // The agent reads that on every turn.
    this.sendOrQueue({
      type: 'turn.submit',
      id: turnId,
      sessionId: args.sessionId,
      message: args.text,
      turnId,
    });

    return {
      cancel: () => {
        if (this.activeTurn !== active) return;
        // Tell the agent to abort the in-flight provider call. Fire
        // and forget: the matching `turn.error` will arrive shortly
        // and the loop in handleFrame will tear the turn down.
        this.sendOrQueue({ type: 'turn.cancel', turnId: active.turnId });
        active.onClose?.({ clean: false, reason: 'cancelled' });
      },
    };
  }

  closeSession(_sessionId: string): void {
    // Single app-level socket; nothing to close per session.
  }

  sendLocationResponse(
    _correlationId: string,
    _response:
      | {
          available: true;
          location: import('../models/chat.model').UserLocation;
        }
      | { available: false; reason: 'denied' | 'unavailable' },
  ): void {
    // The new agent never emits turn.location_required; SessionService
    // therefore never invokes this. Kept as a no-op stub so the
    // SessionService surface compiles without conditional code paths.
  }

  // ====================================================================
  // Internals
  // ====================================================================

  private async request(
    id: string,
    type: string,
    successType: string,
    extras: Record<string, unknown>,
  ): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, 30000);
      this.pending.set(id, {
        successType,
        resolve,
        reject,
        timer,
      });
      this.sendOrQueue({ type, id, ...extras });
    });
  }

  private socket(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      return Promise.resolve(this.ws);
    }
    if (this.connecting) return this.connecting;

    const url = `${this.cfg.wsBaseUrl.replace(/\/$/, '')}/v1/agent`;
    const connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);

      ws.addEventListener('open', () => {
        // First frame on the wire MUST be auth — the gateway rejects
        // every other frame type until verification completes.
        ws.send(
          JSON.stringify({
            type: 'auth',
            id: '__auth__',
            token: this.auth.token(),
          }),
        );
      });

      ws.addEventListener('message', (msg) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(msg.data)) as ServerFrame;
        } catch {
          return;
        }
        if (!this.authenticated) {
          if (frame.type === 'ready') {
            this.authenticated = true;
            this.ws = ws;
            for (const queued of this.preauthQueue.splice(0)) {
              ws.send(JSON.stringify(queued));
            }
            resolve(ws);
            return;
          }
          if (frame.type === 'error') {
            const message =
              (frame['message'] as string | undefined) ?? 'auth failed';
            // Stash the reason so the close-event handler (which
            // fires right after) reports it to pending requests
            // instead of the generic "WebSocket closed". Without
            // this, JWT verification failures (audience mismatch,
            // expired token, missing claim) reach the UI as the
            // useless "WebSocket closed" string.
            this.lastAuthError = message;
            reject(new Error(message));
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          // Pre-auth frames other than ready/error are ignored.
          return;
        }
        this.handleFrame(frame);
      });

      ws.addEventListener('close', (ev) => {
        if (this.ws === ws) this.ws = null;
        this.authenticated = false;
        const reason = this.lastAuthError ?? 'WebSocket closed';
        this.lastAuthError = null;
        this.failPending(new Error(reason));
        const active = this.activeTurn;
        this.activeTurn = null;
        active?.onClose?.({
          clean: ev.wasClean,
          code: ev.code,
          reason: ev.reason || reason,
        });
      });

      ws.addEventListener('error', () => {
        const active = this.activeTurn;
        active?.onEvent(this.localError(active.turnId));
        reject(new Error('WebSocket transport error'));
      });
    }).finally(() => {
      this.connecting = null;
    });

    this.connecting = connecting;
    return connecting;
  }

  private handleFrame(frame: ServerFrame): void {
    // Command replies: matched by inReplyTo against the request id.
    const replyTo = frame.inReplyTo;
    if (replyTo) {
      const pending = this.pending.get(replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(replyTo);
        if (frame.type === 'error') {
          pending.reject(
            new Error(
              (frame['message'] as string | undefined) ?? 'Request failed',
            ),
          );
        } else if (frame.type === pending.successType) {
          pending.resolve(frame);
        } else {
          pending.reject(
            new Error(
              `expected ${pending.successType}, got ${frame.type}`,
            ),
          );
        }
        // Turn frames also carry inReplyTo (the turn.submit's id) —
        // turn.accepted's inReplyTo matches the submit's id. We
        // resolved the request above, but the turn stream is also
        // about to begin, so fall through to route it.
        if (!frame.type.startsWith('turn.')) return;
      }
    }

    const active = this.activeTurn;
    if (!active) return;
    const turnId = frame['turnId'];
    if (typeof turnId === 'string' && turnId !== active.turnId) return;

    const event = this.toChatStreamEvent(frame, active);
    if (event) active.onEvent(event);

    if (frame.type === 'turn.done' || frame.type === 'turn.error') {
      this.activeTurn = null;
    }
  }

  private toChatStreamEvent(
    frame: ServerFrame,
    active: ActiveTurn,
  ): ChatStreamEvent | null {
    const turnId = active.turnId;
    switch (frame.type) {
      case 'turn.accepted': {
        // Forward backend + model so the UI can stamp the assistant
        // placeholder with attribution immediately, before any text
        // streams in. SessionService picks these up and writes them
        // into ChatMessage.attribution.
        const backend = frame['backend'];
        const model = frame['model'];
        return {
          type: 'turn.started',
          correlationId: turnId,
          payload: {
            ...(typeof backend === 'string' ? { backend } : {}),
            ...(typeof model === 'string' ? { modelId: model } : {}),
          },
        };
      }

      case 'turn.text_delta': {
        const delta = (frame['delta'] as string | undefined) ?? '';
        active.assistantText += delta;
        return {
          type: 'turn.chunk',
          correlationId: turnId,
          payload: { text: delta },
        };
      }

      case 'turn.thinking_delta': {
        const delta = (frame['delta'] as string | undefined) ?? '';
        return {
          type: 'turn.thinking',
          correlationId: turnId,
          payload: { text: delta },
        };
      }

      case 'turn.tool_use_started': {
        const name = (frame['toolName'] as string | undefined) ?? 'tool';
        return {
          type: 'turn.agent',
          correlationId: turnId,
          payload: {
            phase: 'command_started',
            command: name,
            summary: this.toolStartedSummary(name, frame['input']),
          },
        };
      }

      case 'turn.tool_use_completed': {
        const toolName =
          (frame['toolName'] as string | undefined) ?? 'tool';
        if (toolName === 'search_web') {
          const output = frame['output'] as
            | { results?: Array<{ title?: string; url?: string }> }
            | undefined;
          for (const r of output?.results ?? []) {
            if (typeof r.url !== 'string' || r.url.length === 0) continue;
            if (active.citations.has(r.url)) continue;
            active.citations.set(r.url, {
              title: typeof r.title === 'string' ? r.title : r.url,
              url: r.url,
            });
          }
        }
        return {
          type: 'turn.agent',
          correlationId: turnId,
          payload: {
            phase: 'command_completed',
            command: toolName,
            summary: 'Tool finished',
          },
        };
      }

      case 'turn.tool_use_failed':
        return {
          type: 'turn.agent',
          correlationId: turnId,
          payload: {
            phase: 'command_completed',
            command: (frame['toolName'] as string | undefined) ?? 'tool',
            summary: `Tool failed: ${(frame['error'] as string | undefined) ?? 'unknown'}`,
          },
        };

      case 'turn.done': {
        const finish =
          (frame['finishReason'] as string | undefined) ?? 'stop';
        const citations = Array.from(active.citations.values()).map((c) => ({
          // Reuse the URL as the evidenceId. The UI uses evidenceId
          // for keying only; it doesn't need to match a server-side
          // entity (the new agent doesn't have an evidence table).
          evidenceId: c.url,
          sourceTitle: c.title,
          sourceUrl: c.url,
        }));
        return {
          type: 'turn.done',
          correlationId: turnId,
          payload: {
            sessionId: active.sessionId,
            turnId,
            assistantMessage: {
              messageId: turnId,
              content: active.assistantText,
              createdAt: active.assistantCreatedAt,
            },
            finishReason: (finish === 'length'
              ? 'length'
              : finish === 'error'
                ? 'error'
                : 'stop') as 'stop' | 'length' | 'error',
            ...(citations.length > 0 ? { citations } : {}),
          },
        };
      }

      case 'turn.error':
        return {
          type: 'error',
          correlationId: turnId,
          error: {
            code: 'turn_error',
            message:
              (frame['error'] as string | undefined) ?? 'Turn failed',
            retryable: false,
          },
        };

      default:
        return null;
    }
  }

  private toolStartedSummary(name: string, input: unknown): string {
    if (name === 'search_web' && input && typeof input === 'object') {
      const q = (input as { query?: unknown }).query;
      if (typeof q === 'string') return `Searching: "${q}"`;
    }
    if (name === 'get_current_time') return 'Checking the time';
    if (name === 'add_numbers') return 'Computing';
    return `Calling tool: ${name}`;
  }

  private sendOrQueue(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    this.preauthQueue.push(frame);
    void this.socket();
  }

  private localError(turnId: string, message = 'WebSocket transport error'): ChatStreamEvent {
    return {
      type: 'error',
      correlationId: turnId,
      error: {
        code: 'transport_error',
        message,
        retryable: true,
      },
    };
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private meta(correlationId: string): ApiMeta {
    return {
      requestId: uuid(),
      correlationId,
      apiVersion: 'v1',
      servedAt: new Date().toISOString(),
    };
  }
}
