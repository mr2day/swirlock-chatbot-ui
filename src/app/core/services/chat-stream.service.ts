import { Injectable, inject, signal } from '@angular/core';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import type {
  CreateSessionResponse,
  DeleteSessionResponse,
  GetSessionResponse,
  PersistedMessage,
} from '../models/chat.model';
import type { ToolActivityEntry } from '../models/chat-message.model';
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

/**
 * Best-effort read of the browser's IANA timezone. Falls back to
 * 'UTC' on legacy environments where Intl.DateTimeFormat is not
 * resolved (Capacitor on very old Android, etc.). Stable for the
 * lifetime of the page; we read it lazily so SSR / unit-test
 * harnesses without a `window` don't crash on import.
 */
function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Trim a URL down to a host-only form for use in the tool-activity
 * timeline (e.g. `https://www.example.com/some/deep/path?x=1` →
 * `example.com`). Falls back to the raw string if parsing fails.
 */
function shortenUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Wire shape of a single persisted message row as returned by the
 * agent runtime's `session.detail` reply. The runtime exposes the
 * raw multi-part `content` (a JSON array of tool_use / tool_result /
 * text parts as emitted by the AI SDK) alongside a flat `text`
 * projection for display. We need the structured form to rebuild
 * the per-turn tool-activity timeline on session reload.
 */
interface RawPersistedMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  text: string;
  seq: number;
  createdAt: string;
  metadata: { backend?: string; modelId?: string } | null;
}

interface ContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Collapse a flat list of persisted message rows (one per AI-SDK
 * ModelMessage written by the agent loop) into the per-turn shape
 * the UI bubbles render: ONE assistant message per turn whose
 * `content` is the final answer text and whose `toolActivity` is the
 * full timeline of tools the agent invoked during that turn.
 *
 * Why this collapse exists: the agent loop persists every step of
 * its reasoning as a separate row (assistant text + tool_use → tool
 * row with tool_result → next assistant turn, repeated). Rendering
 * each row as its own bubble would show the user the agent's
 * internal scratchpad as separate Romanian "let me check" blurbs
 * between the question and the final answer. Collapsing keeps the
 * conversation visually one-question-one-answer while preserving the
 * tool record in a dedicated timeline above the body.
 */
function collapseTurns(rows: RawPersistedMessage[]): PersistedMessage[] {
  const ordered = rows.slice().sort((a, b) => a.seq - b.seq);

  // Group rows by turnId, preserving first-seen order across turns.
  const turnOrder: string[] = [];
  const turns = new Map<string, RawPersistedMessage[]>();
  for (const row of ordered) {
    if (!turns.has(row.turnId)) {
      turnOrder.push(row.turnId);
      turns.set(row.turnId, []);
    }
    turns.get(row.turnId)!.push(row);
  }

  const result: PersistedMessage[] = [];
  for (const turnId of turnOrder) {
    const rows = turns.get(turnId)!;
    const userRow = rows.find((r) => r.role === 'user');
    if (userRow) {
      result.push({
        messageId: userRow.id,
        turnId,
        role: 'user',
        content: userRow.text,
        createdAt: userRow.createdAt,
      });
    }

    const assistantRows = rows.filter(
      (r) => r.role === 'assistant' || r.role === 'system',
    );
    if (assistantRows.length === 0) continue;

    // Walk every assistant message's structured content and pull
    // out tool_use parts (timeline `running` entries) in seq order.
    const activityById = new Map<string, ToolActivityEntry>();
    const activityOrder: string[] = [];
    for (const row of assistantRows) {
      const parts = Array.isArray(row.content)
        ? (row.content as ContentPart[])
        : [];
      for (const part of parts) {
        if (part.type !== 'tool-call') continue;
        if (!part.toolCallId || !part.toolName) continue;
        if (activityById.has(part.toolCallId)) continue;
        activityOrder.push(part.toolCallId);
        activityById.set(part.toolCallId, {
          id: part.toolCallId,
          name: part.toolName,
          summary: toolStartedSummaryStatic(part.toolName, part.input),
          state: 'running',
        });
      }
    }

    // Match tool_result / tool_error parts (tool-role rows) against
    // the timeline by toolCallId, transitioning to completed / failed.
    const toolRows = rows.filter((r) => r.role === 'tool');
    for (const row of toolRows) {
      const parts = Array.isArray(row.content)
        ? (row.content as ContentPart[])
        : [];
      for (const part of parts) {
        if (!part.toolCallId) continue;
        const entry = activityById.get(part.toolCallId);
        if (!entry) continue;
        if (part.type === 'tool-result') {
          activityById.set(part.toolCallId, { ...entry, state: 'completed' });
        } else if (part.type === 'tool-error') {
          activityById.set(part.toolCallId, {
            ...entry,
            state: 'failed',
          });
        }
      }
    }

    // Visible body: the LAST assistant row's text. The earlier rows
    // are the agent's intermediate "let me check" blurbs around tool
    // calls; the user wants the final answer, not the scratchpad.
    const finalRow = assistantRows[assistantRows.length - 1];
    const visibleText = finalRow.text;
    const attribution =
      finalRow.metadata?.backend && finalRow.metadata?.modelId
        ? {
            backend: finalRow.metadata.backend,
            modelId: finalRow.metadata.modelId,
          }
        : undefined;
    const toolActivity = activityOrder.map((id) => activityById.get(id)!);

    result.push({
      messageId: finalRow.id,
      turnId,
      role: 'assistant',
      content: visibleText,
      createdAt: finalRow.createdAt,
      ...(attribution ? { attribution } : {}),
      ...(toolActivity.length > 0 ? { toolActivity } : {}),
    });
  }
  return result;
}

/**
 * Standalone duplicate of the instance-method `toolStartedSummary`
 * used by `collapseTurns`. Kept separate from the method to avoid
 * needing a `this` reference inside the helper function (which runs
 * outside any class context). The two implementations must stay in
 * sync — when adding a new tool, update both. The drift risk is low
 * because both reference the same tool-name string constants.
 */
function toolStartedSummaryStatic(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (name === 'search_web' && typeof obj['query'] === 'string') {
      return `Searching: "${obj['query']}"`;
    }
    if (name === 'fetch_page' && typeof obj['url'] === 'string') {
      return `Reading: ${shortenUrl(obj['url'] as string)}`;
    }
    if (name === 'browse' && typeof obj['url'] === 'string') {
      return `Browsing: ${shortenUrl(obj['url'] as string)}`;
    }
  }
  if (name === 'get_current_time') return 'Checking the time';
  if (name === 'add_numbers') return 'Computing';
  return `Calling tool: ${name}`;
}

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
 * Backend identifier wire format. Opaque string — the UI never
 * branches on specific values; it just renders whatever
 * `backends.list` returns. Adding/removing a backend in the agent
 * runtime requires NO UI change.
 */
export type AgentBackend = string;

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
    /** Optional pre-selected backend. When omitted, the agent uses
     *  the user's server-side saved preference (or
     *  AGENT_DEFAULT_BACKEND if none). When set, the new session
     *  pins this backend as its defaultBackend. */
    defaultBackend?: AgentBackend | null;
    correlationId?: string;
  }): Promise<CreateSessionResponse> {
    const id = args.correlationId ?? uuid();
    // `clientMetadata` carries:
    //   - personaId: persisted so listSessions can scope by persona
    //   - timezone: the browser's IANA timezone, used by the agent
    //     to substitute ${currentTime} + ${userTimezone} in the
    //     persona's system prompt at each turn. No permission
    //     prompt — Intl is always available.
    // No `title` sent — the agent auto-derives from the first user
    // message.
    const timezone = resolveBrowserTimezone();
    const payload: Record<string, unknown> = {
      systemPrompt: args.persona.systemPrompt,
      clientMetadata: { personaId: args.persona.id, timezone },
    };
    if (args.defaultBackend) {
      payload['defaultBackend'] = args.defaultBackend;
    }
    return this.request(id, 'session.create', 'session.created', payload).then((reply) => {
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
      const summaries = (reply['summaries'] ?? []) as Array<{
        id: string;
        startSeq: number;
        endSeq: number;
        summaryText: string;
        tokenCount: number;
        summaryModel: string;
        createdAt: string;
      }>;
      const persisted: PersistedMessage[] = collapseTurns(messages);
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
          summaries: summaries.map((s) => ({
            id: s.id,
            startSeq: s.startSeq,
            endSeq: s.endSeq,
            summaryText: s.summaryText,
            summaryModel: s.summaryModel,
            createdAt: s.createdAt,
          })),
        },
      };
    });
  }

  /**
   * Fetch the originals of a compacted seq range — used by the UI
   * to populate an expanded summary block. The returned messages
   * are run through the same collapseTurns logic so a multi-step
   * assistant turn inside the range renders as one bubble with the
   * full toolActivity timeline rather than as several intermediate
   * "let me check..." chunks.
   */
  fetchMessageRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
    correlationId = uuid(),
  ): Promise<PersistedMessage[]> {
    return this.request(
      correlationId,
      'messages.fetch_range',
      'messages.range',
      { sessionId, startSeq, endSeq },
    ).then((reply) => {
      const rows = (reply['messages'] ?? []) as Array<{
        id: string;
        turnId: string;
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: unknown;
        text: string;
        seq: number;
        createdAt: string;
        metadata: { backend?: string; modelId?: string } | null;
      }>;
      return collapseTurns(rows);
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
        const toolCallId = frame['toolCallId'] as string | undefined;
        return {
          type: 'turn.agent',
          correlationId: turnId,
          payload: {
            phase: 'command_started',
            command: name,
            summary: this.toolStartedSummary(name, frame['input']),
            ...(toolCallId ? { toolCallId } : {}),
          },
        };
      }

      case 'turn.tool_use_completed': {
        const toolName =
          (frame['toolName'] as string | undefined) ?? 'tool';
        const toolCallId = frame['toolCallId'] as string | undefined;
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
            ...(toolCallId ? { toolCallId } : {}),
          },
        };
      }

      case 'turn.tool_use_failed': {
        const toolCallId = frame['toolCallId'] as string | undefined;
        const errorMessage =
          (frame['error'] as string | undefined) ?? 'unknown';
        return {
          type: 'turn.agent',
          correlationId: turnId,
          payload: {
            phase: 'command_failed',
            command: (frame['toolName'] as string | undefined) ?? 'tool',
            summary: `Tool failed: ${errorMessage}`,
            errorMessage,
            ...(toolCallId ? { toolCallId } : {}),
          },
        };
      }

      case 'turn.done': {
        const finish =
          (frame['finishReason'] as string | undefined) ?? 'stop';
        const stopReasonRaw = frame['stopReason'] as string | undefined;
        const stopReason: 'completed' | 'step-budget' | 'repeat-tool-call' | undefined =
          stopReasonRaw === 'completed' ||
          stopReasonRaw === 'step-budget' ||
          stopReasonRaw === 'repeat-tool-call'
            ? stopReasonRaw
            : undefined;
        const stopDetail = frame['stopDetail'] as string | undefined;
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
            ...(stopReason ? { stopReason } : {}),
            ...(stopDetail ? { stopDetail } : {}),
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
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      if (name === 'search_web' && typeof obj['query'] === 'string') {
        return `Searching: "${obj['query']}"`;
      }
      if (name === 'fetch_page' && typeof obj['url'] === 'string') {
        return `Reading: ${shortenUrl(obj['url'] as string)}`;
      }
      if (name === 'browse' && typeof obj['url'] === 'string') {
        return `Browsing: ${shortenUrl(obj['url'] as string)}`;
      }
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
