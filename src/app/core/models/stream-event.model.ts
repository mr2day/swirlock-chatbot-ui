import type { ApiMeta } from './api-meta.model';
import type { ErrorBody } from './error-envelope.model';
import type { SubmitTurnRequest } from './chat.model';

/**
 * First and only client → server message on the streaming WebSocket.
 * Mirrors `SubmitTurnStreamMessage` in the v3 contract.
 */
export interface SubmitTurnStreamMessage {
  type: 'submit_turn';
  correlationId: string;
  request: SubmitTurnRequest;
}

export interface QueueWaitInfo {
  position: number;
  requestsAhead: number;
  queueDepth: number;
  defaultPriority: boolean;
  priority?: number;
  averageRequestDurationMs?: number;
  estimatedWaitMs?: number;
  estimatedStartAt?: string;
}

/**
 * Retrieval progress event forwarded from the upstream RAG Engine.
 * The orchestrator wraps each RAG SSE event in a `retrieval` envelope
 * so the chat client can render ChatGPT-style "searching the web…"
 * progress without speaking the RAG API directly.
 */
export interface RetrievalStreamEvent {
  type: string;
  sequence: number;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface CitationRef {
  evidenceId: string;
  sourceTitle: string;
  sourceUrl?: string;
}

export interface DoneDiagnostics {
  retrievalUsed: boolean;
  memoryFragmentCount: number;
  retrievalMode: string;
}

export interface ChatStreamAcceptedEvent {
  type: 'accepted';
  meta: ApiMeta;
}
export interface ChatStreamQueuedEvent {
  type: 'queued';
  meta: ApiMeta;
  data: QueueWaitInfo;
}
export interface ChatStreamStartedEvent {
  type: 'started';
  meta: ApiMeta;
}
export interface ChatStreamRetrievalEvent {
  type: 'retrieval';
  meta: ApiMeta;
  data: RetrievalStreamEvent;
}
export interface ChatStreamThinkingEvent {
  type: 'thinking';
  meta: ApiMeta;
  data: { text: string };
}
export interface ChatStreamChunkEvent {
  type: 'chunk';
  meta: ApiMeta;
  data: { text: string };
}
export interface ChatStreamDoneEvent {
  type: 'done';
  meta: ApiMeta;
  data: {
    sessionId: string;
    turnId: string;
    assistantMessage: {
      messageId: string;
      content: string;
      createdAt: string;
    };
    finishReason: 'stop' | 'length' | 'error';
    citations?: CitationRef[];
    diagnostics?: DoneDiagnostics;
  };
}
export interface ChatStreamErrorEvent {
  type: 'error';
  meta: ApiMeta;
  error: ErrorBody;
}

export type ChatStreamEvent =
  | ChatStreamAcceptedEvent
  | ChatStreamQueuedEvent
  | ChatStreamStartedEvent
  | ChatStreamRetrievalEvent
  | ChatStreamThinkingEvent
  | ChatStreamChunkEvent
  | ChatStreamDoneEvent
  | ChatStreamErrorEvent;
