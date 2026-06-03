import type { ErrorBody } from './error-envelope.model';

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
      /** Per-turn attribution from the agent — which backend/model is
       *  going to serve this turn. Carried into ChatMessage.attribution
       *  on the assistant placeholder so per-message attribution is
       *  visible immediately, before the turn streams. */
      payload: { backend?: string; modelId?: string };
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
          | 'command_failed'
          | 'plan';
        command?: string;
        summary: string;
        data?: unknown;
        /** Present on command_* phases. Stable id from the provider's
         *  tool_use block. Identifies which entry to update when the
         *  matching `command_completed` / `command_failed` arrives, so
         *  parallel tool calls don't clobber each other. */
        toolCallId?: string;
        /** Only set on `command_failed`. Surfaced inline in the timeline
         *  so the user sees what went wrong. */
        errorMessage?: string;
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
        // Why the agent loop ended. 'completed' = model emitted a final
        // answer naturally. Anything else = a safety rail fired (the
        // assistant message may be empty or partial); UI renders an
        // inline indicator. Absent on legacy server builds.
        stopReason?:
          | 'completed'
          | 'step-budget'
          | 'repeat-tool-call';
        stopDetail?: string;
        citations?: CitationRef[];
        diagnostics?: DoneDiagnostics;
      };
    }
  | {
      type: 'error';
      correlationId: string;
      error: ErrorBody;
    };
