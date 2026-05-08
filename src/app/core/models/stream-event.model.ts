import type { ErrorBody } from './error-envelope.model';
import type { SubmitTurnRequest } from './chat.model';

export interface SubmitTurnStreamMessage {
  type: 'turn.submit';
  correlationId: string;
  payload: {
    sessionId: string;
    request: SubmitTurnRequest;
  };
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
  turnRoute?: string;
  shouldRetrieve?: boolean;
  shouldThink?: boolean;
  intent?: string;
  freshness?: string;
  planReason?: string;
}

export type ChatStreamEvent =
  | {
      type: 'turn.accepted' | 'turn.started';
      correlationId: string;
      payload: Record<string, never>;
    }
  | {
      type: 'turn.queued';
      correlationId: string;
      payload: QueueWaitInfo;
    }
  | {
      type: 'turn.retrieval';
      correlationId: string;
      payload: { event: RetrievalStreamEvent };
    }
  | {
      type: 'turn.location_required';
      correlationId: string;
      payload: { requestedAt: string; timeoutMs: number };
    }
  | {
      type: 'turn.classifying';
      correlationId: string;
      payload: { step?: number };
    }
  | {
      type: 'turn.agent';
      correlationId: string;
      payload: {
        phase:
          | 'classifying'
          | 'command_started'
          | 'command_completed'
          | 'plan';
        command?: string;
        summary: string;
        data?: unknown;
      };
    }
  | {
      type: 'turn.thinking';
      correlationId: string;
      payload: { text: string };
    }
  | {
      type: 'turn.chunk';
      correlationId: string;
      payload: { text: string };
    }
  | {
      type: 'turn.done';
      correlationId: string;
      payload: {
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
  | {
      type: 'error';
      correlationId: string;
      error: ErrorBody;
    };
