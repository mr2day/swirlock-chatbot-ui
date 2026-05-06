import type { ApiMeta } from './api-meta.model';

export type RequestPriority = 'interactive' | 'background' | 'maintenance';

export interface RequestContext {
  callerService: string;
  priority?: RequestPriority;
  requestedAt: string;
  timeoutMs?: number;
  debug?: boolean;
}

export interface TextInputPart {
  type: 'text';
  text: string;
}

export interface ImageInputPart {
  type: 'image';
  imageId?: string;
  imageUrl?: string;
  mimeType?: string;
}

export type InputPart = TextInputPart | ImageInputPart;

/* ---------- Sessions ---------- */

export interface CreateSessionRequest {
  requestContext: RequestContext;
  participant: { userId: string; displayName?: string };
  app: { appId: string; personaId?: string };
  client?: { channel?: string; clientVersion?: string };
}

export interface CreateSessionResponseData {
  sessionId: string;
  createdAt: string;
  status: 'active';
}

export interface CreateSessionResponse {
  meta: ApiMeta;
  data: CreateSessionResponseData;
}

/**
 * Orchestrator extension beyond the v3 OpenAPI: returns the session header
 * plus the full message history. Used by the UI to rehydrate a session
 * after a reload.
 */
export interface GetSessionResponseData {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  messages: PersistedMessage[];
}

export interface GetSessionResponse {
  meta: ApiMeta;
  data: GetSessionResponseData;
}

export interface PersistedMessage {
  messageId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface DeleteSessionResponse {
  meta: ApiMeta;
  data: { sessionId: string; deleted: boolean };
}

/* ---------- Turns ---------- */

export interface SubmitTurnRequest {
  requestContext: RequestContext;
  clientTurnId?: string;
  message: { parts: InputPart[]; occurredAt: string };
  options?: {
    responseMode?: 'blocking';
    maxOutputTokens?: number;
    includeDiagnostics?: boolean;
    thinking?: boolean;
  };
}

export interface SubmitTurnResponseData {
  sessionId: string;
  turnId: string;
  assistantMessage: {
    messageId: string;
    content: string;
    createdAt: string;
  };
  citations?: Array<{
    evidenceId: string;
    sourceTitle: string;
    sourceUrl?: string;
  }>;
  diagnostics?: {
    retrievalUsed: boolean;
    memoryFragmentCount: number;
    retrievalMode: 'none' | 'local_rag' | 'live_web' | 'local_and_live';
  };
}

export interface SubmitTurnResponse {
  meta: ApiMeta;
  data: SubmitTurnResponseData;
}
