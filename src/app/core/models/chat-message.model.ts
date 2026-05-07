import type { CitationRef, DoneDiagnostics } from './stream-event.model';

/**
 * In-memory message shape used by the chat UI. Distinct from the
 * orchestrator's persisted shape because it carries transient streaming
 * state that the server has no concept of (e.g. live thinking text,
 * partial chunks, retrieval progress, error markers on a failed turn).
 */
export type ChatMessageStatus =
  | 'pending'
  | 'classifying'
  | 'queued'
  | 'retrieving'
  | 'awaiting_location'
  | 'thinking'
  | 'streaming'
  | 'done'
  | 'error'
  | 'cancelled';

export interface LocationPromptState {
  correlationId: string;
  /** True while the inline card is awaiting the user's Allow/Deny click. */
  pending: boolean;
  /** Set once the user resolves the prompt, so we can show a small footnote. */
  resolution?: 'granted' | 'denied' | 'unavailable';
}

export interface ChatMessage {
  /** Stable client-side id; replaced with `messageId` after persistence. */
  localId: string;
  /** Server-assigned message id once the orchestrator emits `done`. */
  messageId?: string;
  /** Server-assigned turn id once the orchestrator emits `done`. */
  turnId?: string;
  role: 'user' | 'assistant';
  /** Visible message content. Streams in chunk-by-chunk for assistant. */
  content: string;
  /** Accumulated `thinking` text streamed by the upstream Model Host. */
  thinking: string;
  /** Lifecycle for spinner/stop button decisions. */
  status: ChatMessageStatus;
  /** Friendly current-phase label derived from RAG `retrieval` events. */
  retrievalStatus?: string;
  /** Inline location-permission prompt state when the orchestrator asked for location. */
  locationPrompt?: LocationPromptState;
  /** RAG evidence surfaced on `done`. */
  citations?: CitationRef[];
  /** Optional diagnostics surfaced on `done` when requested. */
  diagnostics?: DoneDiagnostics;
  /** Error text if the turn failed mid-stream. */
  errorMessage?: string;
  /** Wall-clock timestamp the message was created on the client. */
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
