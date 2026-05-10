import { Injectable, inject, signal } from '@angular/core';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  GetSessionResponse,
  SubmitTurnRequest,
} from '../models/chat.model';
import type { ApiMeta } from '../models/api-meta.model';
import type {
  ChatStreamEvent,
  SubmitTurnStreamMessage,
} from '../models/stream-event.model';
import { AuthService } from './auth.service';

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

interface V4Envelope<TPayload = unknown> {
  type: string;
  correlationId: string;
  payload?: TPayload;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

interface ActiveTurn {
  sessionId: string;
  correlationId: string;
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
}

interface PendingRequest<TPayload> {
  successType: string;
  resolve: (envelope: V4Envelope<TPayload>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable({ providedIn: 'root' })
export class ChatStreamService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly auth = inject(AuthService);
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly queued: V4Envelope[] = [];
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private activeTurn: ActiveTurn | null = null;
  private readonly _modelId = signal<string | null>(null);
  readonly modelId = this._modelId.asReadonly();
  private modelStatusInflight: Promise<string> | null = null;

  /**
   * Asks the orchestrator for the LLM model id (e.g. `gemma3:12b`). The
   * orchestrator forwards the request to the LLM host and returns the
   * value unchanged. Cached after the first resolution.
   */
  async getModelId(): Promise<string> {
    const cached = this._modelId();
    if (cached) return cached;
    if (this.modelStatusInflight) return this.modelStatusInflight;
    this.modelStatusInflight = this.requestResponse<{ modelId: string }>(
      'model.status',
      'model.status',
      uuid(),
      {},
    )
      .then((res) => {
        this._modelId.set(res.modelId);
        return res.modelId;
      })
      .finally(() => {
        this.modelStatusInflight = null;
      });
    return this.modelStatusInflight;
  }

  createSession(args: {
    userId: string;
    displayName?: string;
    persona: { name: string; systemPrompt: string };
    correlationId?: string;
  }): Promise<CreateSessionResponse> {
    const correlationId = args.correlationId ?? uuid();
    const request: CreateSessionRequest = {
      requestContext: {
        callerService: this.cfg.appId,
        priority: 'interactive',
        requestedAt: new Date().toISOString(),
      },
      participant: {
        userId: args.userId,
        ...(args.displayName ? { displayName: args.displayName } : {}),
      },
      app: {
        appId: this.cfg.appId,
      },
      persona: args.persona,
      client: {
        channel: this.cfg.clientChannel,
        clientVersion: this.cfg.clientVersion,
      },
    };

    return this.requestResponse(
      'session.create',
      'session.created',
      correlationId,
      { request },
    ).then((payload) => ({
      meta: this.meta(correlationId),
      data: payload as CreateSessionResponse['data'],
    }));
  }

  getSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<GetSessionResponse> {
    return this.requestResponse(
      'session.get',
      'session.snapshot',
      correlationId,
      { sessionId },
    ).then((payload) => ({
      meta: this.meta(correlationId),
      data: payload as GetSessionResponse['data'],
    }));
  }

  deleteSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<DeleteSessionResponse> {
    return this.requestResponse(
      'session.delete',
      'session.deleted',
      correlationId,
      { sessionId },
    ).then((payload) => ({
      meta: this.meta(correlationId),
      data: payload as DeleteSessionResponse['data'],
    }));
  }

  openTurn(args: {
    sessionId: string;
    text: string;
    correlationId?: string;
    thinking?: boolean;
    forceThinking?: boolean;
    includeDiagnostics?: boolean;
    userLocation?: import('../models/chat.model').UserLocation;
    onEvent: (event: ChatStreamEvent) => void;
    onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
  }): StreamHandle {
    const correlationId = args.correlationId ?? uuid();

    if (this.activeTurn) {
      args.onEvent(this.localError(correlationId, 'A turn is already active'));
      return { cancel: () => undefined };
    }

    const activeTurn: ActiveTurn = {
      sessionId: args.sessionId,
      correlationId,
      onEvent: args.onEvent,
      onClose: args.onClose,
    };
    this.activeTurn = activeTurn;

    const envelope: SubmitTurnStreamMessage = {
      type: 'turn.submit',
      correlationId,
      payload: {
        sessionId: args.sessionId,
        request: this.buildRequest(args),
      },
    };

    this.sendOrQueue(envelope);

    return {
      cancel: () => {
        if (this.activeTurn !== activeTurn) return;
        this.sendOrQueue({ type: 'cancel', correlationId });
      },
    };
  }

  closeSession(_sessionId: string): void {
    // v5 keeps one app-level socket open; switching sessions does not close it.
  }

  private requestResponse<TPayload>(
    type: string,
    successType: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<TPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`${type} timed out`));
      }, 30000);

      this.pending.set(correlationId, {
        successType,
        resolve: (envelope) => resolve(envelope.payload as TPayload),
        reject,
        timer,
      });

      this.sendOrQueue({ type, correlationId, payload });
    });
  }

  private socket(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }
    if (this.connecting) return this.connecting;

    const url =
      `${this.cfg.wsBaseUrl.replace(/\/$/, '')}` +
      `/v5/chat?token=${encodeURIComponent(this.auth.token())}`;
    const connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        this.ws = ws;
        for (const envelope of this.queued.splice(0)) {
          ws.send(JSON.stringify(envelope));
        }
        resolve(ws);
      });

      ws.addEventListener('message', (msg) => {
        this.handleMessage(msg.data);
      });

      ws.addEventListener('close', (ev) => {
        if (this.ws === ws) this.ws = null;
        this.failPending(new Error('WebSocket closed'));
        const active = this.activeTurn;
        this.activeTurn = null;
        active?.onClose?.({
          clean: ev.wasClean,
          code: ev.code,
          reason: ev.reason,
        });
      });

      ws.addEventListener('error', () => {
        const active = this.activeTurn;
        active?.onEvent(this.localError(active.correlationId));
        reject(new Error('WebSocket transport error'));
      });
    }).finally(() => {
      this.connecting = null;
    });

    this.connecting = connecting;
    return connecting;
  }

  private handleMessage(raw: unknown): void {
    let envelope: V4Envelope;
    try {
      envelope = JSON.parse(String(raw)) as V4Envelope;
    } catch {
      return;
    }

    const pending = this.pending.get(envelope.correlationId);
    if (pending) {
      if (envelope.type === 'error') {
        clearTimeout(pending.timer);
        this.pending.delete(envelope.correlationId);
        pending.reject(new Error(envelope.error?.message ?? 'Request failed'));
        return;
      }
      if (envelope.type === pending.successType) {
        clearTimeout(pending.timer);
        this.pending.delete(envelope.correlationId);
        pending.resolve(envelope);
        return;
      }
    }

    const active = this.activeTurn;
    if (!active || active.correlationId !== envelope.correlationId) return;

    const event = this.toChatStreamEvent(envelope);
    if (!event) return;
    active.onEvent(event);
    if (event.type === 'turn.done' || event.type === 'error') {
      this.activeTurn = null;
    }
  }

  private toChatStreamEvent(envelope: V4Envelope): ChatStreamEvent | null {
    const base = {
      correlationId: envelope.correlationId,
      payload: envelope.payload as never,
    };
    switch (envelope.type) {
      case 'turn.accepted':
      case 'turn.classifying':
      case 'turn.queued':
      case 'turn.started':
      case 'turn.retrieval':
      case 'turn.location_required':
      case 'turn.thinking':
      case 'turn.chunk':
      case 'turn.done':
      case 'turn.agent':
        return { type: envelope.type, ...base } as ChatStreamEvent;
      case 'error':
        return {
          type: 'error',
          correlationId: envelope.correlationId,
          error: envelope.error ?? {
            code: 'transport_error',
            message: 'Request failed',
            retryable: true,
          },
        };
      default:
        return null;
    }
  }

  private sendOrQueue(envelope: V4Envelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
      return;
    }
    this.queued.push(envelope);
    void this.socket();
  }

  private buildRequest(args: {
    text: string;
    thinking?: boolean;
    forceThinking?: boolean;
    includeDiagnostics?: boolean;
    userLocation?: import('../models/chat.model').UserLocation;
  }): SubmitTurnRequest {
    return {
      requestContext: {
        callerService: this.cfg.appId,
        priority: 'interactive',
        requestedAt: new Date().toISOString(),
      },
      clientTurnId: uuid(),
      message: {
        parts: [{ type: 'text', text: args.text }],
        occurredAt: new Date().toISOString(),
      },
      ...(args.userLocation ? { userLocation: args.userLocation } : {}),
      options: {
        ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
        ...(args.forceThinking ? { forceThinking: true } : {}),
        ...(args.includeDiagnostics ? { includeDiagnostics: true } : {}),
      },
    };
  }

  sendLocationResponse(
    correlationId: string,
    response:
      | {
          available: true;
          location: import('../models/chat.model').UserLocation;
        }
      | { available: false; reason: 'denied' | 'unavailable' },
  ): void {
    this.sendOrQueue({
      type: 'turn.location_response',
      correlationId,
      payload: response,
    });
  }

  private localError(
    correlationId: string,
    message = 'WebSocket transport error',
  ): ChatStreamEvent {
    return {
      type: 'error',
      correlationId,
      error: {
        code: 'transport_error',
        message,
        retryable: true,
      },
    };
  }

  private failPending(error: Error): void {
    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(correlationId);
      pending.reject(error);
    }
  }

  private meta(correlationId: string): ApiMeta {
    return {
      requestId: uuid(),
      correlationId,
      apiVersion: 'v5',
      servedAt: new Date().toISOString(),
    };
  }
}
