import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  GetSessionResponse,
} from '../models/chat.model';
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

/**
 * REST client for the v3 Chat Orchestrator. Wraps the three HTTP
 * operations exposed by `swirlock-chat-orchestrator`:
 *   - POST   /v2/chat/sessions
 *   - GET    /v2/chat/sessions/:sessionId
 *   - DELETE /v2/chat/sessions/:sessionId
 *
 * Turn submission is streaming-only in the current orchestrator
 * implementation; see {@link ChatStreamService}.
 */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly http = inject(HttpClient);
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly auth = inject(AuthService);

  createSession(args: {
    userId: string;
    displayName?: string;
    personaId: string;
    correlationId?: string;
  }): Promise<CreateSessionResponse> {
    const correlationId = args.correlationId ?? uuid();
    const body: CreateSessionRequest = {
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
        personaId: args.personaId,
      },
      client: {
        channel: this.cfg.clientChannel,
        clientVersion: this.cfg.clientVersion,
      },
    };
    return firstValueFrom(
      this.http.post<CreateSessionResponse>(
        `${this.cfg.apiBaseUrl}/v2/chat/sessions`,
        body,
        { headers: this.headers(correlationId) },
      ),
    );
  }

  getSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<GetSessionResponse> {
    return firstValueFrom(
      this.http.get<GetSessionResponse>(
        `${this.cfg.apiBaseUrl}/v2/chat/sessions/${sessionId}`,
        { headers: this.headers(correlationId) },
      ),
    );
  }

  deleteSession(
    sessionId: string,
    correlationId = uuid(),
  ): Promise<DeleteSessionResponse> {
    return firstValueFrom(
      this.http.delete<DeleteSessionResponse>(
        `${this.cfg.apiBaseUrl}/v2/chat/sessions/${sessionId}`,
        { headers: this.headers(correlationId) },
      ),
    );
  }

  private headers(correlationId: string): HttpHeaders {
    return new HttpHeaders({
      Authorization: this.auth.authHeader(),
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
    });
  }
}
