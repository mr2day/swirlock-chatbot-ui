import type { ApiMeta } from './api-meta.model';
import type { CitationRef } from './stream-event.model';

/* ---------- Sessions ---------- */

export interface CreateSessionResponseData {
  sessionId: string;
  createdAt: string;
  status: 'active';
  /** Backend the agent pinned on the new session (its
   *  AGENT_DEFAULT_BACKEND when the client didn't specify one). */
  defaultBackend: string | null;
}

export interface CreateSessionResponse {
  meta: ApiMeta;
  data: CreateSessionResponseData;
}

/**
 * Returns the session header plus the full message history. Used by
 * the UI to rehydrate a session after a reload.
 */
export interface GetSessionResponseData {
  sessionId: string;
  personaId: string | null;
  personaName: string | null;
  /** Backend currently pinned on this session. New turns use it
   *  unless the client overrides per-turn. */
  defaultBackend: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  messages: PersistedMessage[];
}

export interface GetSessionResponse {
  meta: ApiMeta;
  data: GetSessionResponseData;
}

export interface PersistedImageRef {
  imageId: string;
  mimeType: string | null;
}

export interface PersistedMessage {
  messageId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** User-attached images on this message (only set for user-role messages). */
  images?: PersistedImageRef[];
  /**
   * Citations / source list attached to this assistant turn. Set only
   * for assistant-role messages whose answer round used SEARCH
   * evidence.
   */
  citations?: CitationRef[];
  /** Which backend + model produced this assistant turn. Null for
   *  user messages and for legacy rows without attribution. */
  attribution?: { backend: string; modelId: string };
  /**
   * Reconstructed tool-activity timeline for this assistant turn,
   * derived from the structured tool_use / tool_result parts in the
   * persisted multi-part content. Empty for turns that didn't call
   * any tools. Present so a reloaded conversation retains the same
   * "what the agent did" record the user saw live.
   */
  toolActivity?: import('./chat-message.model').ToolActivityEntry[];
}

export interface DeleteSessionResponse {
  meta: ApiMeta;
  data: { sessionId: string; deleted: boolean };
}

/* ---------- Turns ---------- */

export interface UserLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt?: string;
}
