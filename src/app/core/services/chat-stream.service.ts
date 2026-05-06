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
  /** Closes the WebSocket. The orchestrator interprets this as a cancel. */
  cancel(): void;
}

/**
 * WebSocket client for the v3 Chat Orchestrator streaming endpoint
 * (`/v2/chat/sessions/:sessionId/turns/stream`).
 *
 * Browsers cannot set `Authorization` on `new WebSocket()`, so the bearer
 * token is appended as `?token=<...>` (one of the three transports
 * allowed by `API_CONVENTIONS.md#websocket-authentication`).
 *
 * The handle returned by {@link openTurn} lets callers cancel the
 * generation by closing the socket; the orchestrator's `AbortController`
 * tears the upstream Model Host stream down so we don't keep paying for
 * tokens after the user navigates away or hits Stop.
 */
@Injectable({ providedIn: 'root' })
export class ChatStreamService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly auth = inject(AuthService);

  openTurn(args: {
    sessionId: string;
    text: string;
    correlationId?: string;
    thinking?: boolean;
    includeDiagnostics?: boolean;
    onEvent: (event: ChatStreamEvent) => void;
    onClose?: (info: { clean: boolean; code?: number; reason?: string }) => void;
  }): StreamHandle {
    const correlationId = args.correlationId ?? uuid();
    const url =
      `${this.cfg.wsBaseUrl.replace(/\/$/, '')}` +
      `/v2/chat/sessions/${encodeURIComponent(args.sessionId)}/turns/stream` +
      `?token=${encodeURIComponent(this.auth.token())}`;

    const ws = new WebSocket(url);

    const request: SubmitTurnRequest = {
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
        thinking: args.thinking ?? true,
        ...(args.includeDiagnostics ? { includeDiagnostics: true } : {}),
      },
    };
    const envelope: SubmitTurnStreamMessage = {
      type: 'submit_turn',
      correlationId,
      request,
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(envelope));
    });

    ws.addEventListener('message', (msg) => {
      try {
        const evt = JSON.parse(msg.data as string) as ChatStreamEvent;
        args.onEvent(evt);
      } catch {
        /* swallow malformed frames; the orchestrator never sends them */
      }
    });

    ws.addEventListener('close', (ev) => {
      args.onClose?.({ clean: ev.wasClean, code: ev.code, reason: ev.reason });
    });

    ws.addEventListener('error', () => {
      // Synthesize an error event so the UI can react. Browsers do not
      // surface details on the `error` event for security reasons; the
      // close event that follows will carry whatever info exists.
      args.onEvent({
        type: 'error',
        meta: {
          requestId: uuid(),
          correlationId,
          apiVersion: 'v2',
          servedAt: new Date().toISOString(),
        },
        error: {
          code: 'transport_error',
          message: 'WebSocket transport error',
          retryable: true,
        },
      });
    });

    return {
      cancel: () => {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1000, 'cancelled by user');
        }
      },
    };
  }
}
