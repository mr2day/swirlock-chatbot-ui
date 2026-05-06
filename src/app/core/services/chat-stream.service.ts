import { Injectable, inject } from '@angular/core';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import type { SubmitTurnRequest } from '../models/chat.model';
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
  /** Cancels the active turn. Until cancel_turn exists, this closes the socket. */
  cancel(): void;
}

interface ActiveTurn {
  correlationId: string;
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
}

interface SessionSocket {
  ws: WebSocket;
  activeTurn: ActiveTurn | null;
  queued: SubmitTurnStreamMessage[];
}

/**
 * Session-scoped WebSocket client for the v3 Chat Orchestrator streaming
 * endpoint (`/v2/chat/sessions/:sessionId/turns/stream`).
 *
 * A chat session keeps one WebSocket open and sends multiple `submit_turn`
 * messages over it. The socket is closed when the session is no longer active
 * or when the user cancels the active turn.
 */
@Injectable({ providedIn: 'root' })
export class ChatStreamService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly auth = inject(AuthService);
  private readonly sockets = new Map<string, SessionSocket>();

  openTurn(args: {
    sessionId: string;
    text: string;
    correlationId?: string;
    thinking?: boolean;
    forceThinking?: boolean;
    includeDiagnostics?: boolean;
    onEvent: (event: ChatStreamEvent) => void;
    onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
  }): StreamHandle {
    const correlationId = args.correlationId ?? uuid();
    const socket = this.sessionSocket(args.sessionId);

    if (socket.activeTurn) {
      args.onEvent(this.localError(correlationId, 'A turn is already active'));
      return { cancel: () => undefined };
    }

    const activeTurn: ActiveTurn = {
      correlationId,
      onEvent: args.onEvent,
      onClose: args.onClose,
    };
    socket.activeTurn = activeTurn;

    const envelope: SubmitTurnStreamMessage = {
      type: 'submit_turn',
      correlationId,
      request: this.buildRequest(args),
    };

    this.sendOrQueue(socket, envelope);

    return {
      cancel: () => {
        const current = this.sockets.get(args.sessionId);
        if (!current || current.activeTurn !== activeTurn) return;
        this.closeSession(args.sessionId, 1000, 'cancelled by user');
      },
    };
  }

  closeSession(sessionId: string, code = 1000, reason = 'session inactive'): void {
    const socket = this.sockets.get(sessionId);
    if (!socket) return;
    this.sockets.delete(sessionId);
    if (
      socket.ws.readyState === WebSocket.OPEN ||
      socket.ws.readyState === WebSocket.CONNECTING
    ) {
      socket.ws.close(code, reason);
    }
  }

  private sessionSocket(sessionId: string): SessionSocket {
    const existing = this.sockets.get(sessionId);
    if (
      existing &&
      (existing.ws.readyState === WebSocket.OPEN ||
        existing.ws.readyState === WebSocket.CONNECTING)
    ) {
      return existing;
    }

    const url =
      `${this.cfg.wsBaseUrl.replace(/\/$/, '')}` +
      `/v2/chat/sessions/${encodeURIComponent(sessionId)}/turns/stream` +
      `?token=${encodeURIComponent(this.auth.token())}`;
    const ws = new WebSocket(url);
    const socket: SessionSocket = {
      ws,
      activeTurn: null,
      queued: [],
    };
    this.sockets.set(sessionId, socket);

    ws.addEventListener('open', () => {
      for (const envelope of socket.queued.splice(0)) {
        ws.send(JSON.stringify(envelope));
      }
    });

    ws.addEventListener('message', (msg) => {
      const active = socket.activeTurn;
      if (!active) return;
      try {
        const evt = JSON.parse(msg.data as string) as ChatStreamEvent;
        active.onEvent(evt);
        if (evt.type === 'done' || evt.type === 'error') {
          socket.activeTurn = null;
        }
      } catch {
        /* swallow malformed frames; the orchestrator never sends them */
      }
    });

    ws.addEventListener('close', (ev) => {
      if (this.sockets.get(sessionId) === socket) {
        this.sockets.delete(sessionId);
      }
      const active = socket.activeTurn;
      socket.activeTurn = null;
      active?.onClose?.({
        clean: ev.wasClean,
        code: ev.code,
        reason: ev.reason,
      });
    });

    ws.addEventListener('error', () => {
      const active = socket.activeTurn;
      active?.onEvent(this.localError(active.correlationId));
    });

    return socket;
  }

  private sendOrQueue(
    socket: SessionSocket,
    envelope: SubmitTurnStreamMessage,
  ): void {
    if (socket.ws.readyState === WebSocket.OPEN) {
      socket.ws.send(JSON.stringify(envelope));
      return;
    }
    socket.queued.push(envelope);
  }

  private buildRequest(args: {
    text: string;
    thinking?: boolean;
    forceThinking?: boolean;
    includeDiagnostics?: boolean;
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
      options: {
        ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
        ...(args.forceThinking ? { forceThinking: true } : {}),
        ...(args.includeDiagnostics ? { includeDiagnostics: true } : {}),
      },
    };
  }

  private localError(
    correlationId: string,
    message = 'WebSocket transport error',
  ): ChatStreamEvent {
    return {
      type: 'error',
      meta: {
        requestId: uuid(),
        correlationId,
        apiVersion: 'v2',
        servedAt: new Date().toISOString(),
      },
      error: {
        code: 'transport_error',
        message,
        retryable: true,
      },
    };
  }
}
