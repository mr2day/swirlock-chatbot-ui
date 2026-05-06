import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  ChatMessage,
  SessionSummary,
} from '../models/chat-message.model';
import type { RetrievalStreamEvent } from '../models/stream-event.model';
import { ChatApiService } from './chat-api.service';
import { ChatStreamService, StreamHandle } from './chat-stream.service';
import { PersonaService } from './persona.service';

const SESSIONS_KEY = 'gigi.sessions';
const ACTIVE_SESSION_KEY = 'gigi.activeSessionId';
const LOCAL_USER_ID = 'dev-user';
const LOCAL_USER_DISPLAY = 'You';

/**
 * Maps the RAG Engine's verbose retrieval event types to short, friendly
 * progress labels the chat UI can show inline ("Searching the web…",
 * "Reading sources…"). Returning `null` means: don't surface this event.
 */
const RETRIEVAL_LABELS: Record<string, string | null> = {
  'retrieval.started': 'Starting retrieval…',
  'utility_llm.retrieval_support.started': 'Planning the search…',
  'utility_llm.retrieval_support.completed': 'Search plan ready',
  'query.normalized': 'Refining the query…',
  'embedding.query.started': 'Generating query embedding…',
  'embedding.query.completed': 'Query embedding ready',
  'local.search.started': 'Searching local knowledge…',
  'local.search.completed': 'Local search done',
  'retrieval.policy.decided': null,
  'live.search.started': 'Searching the web…',
  'live.search.completed': 'Web search done',
  'live.extract.started': 'Reading sources…',
  'live.extract.completed': 'Sources read',
  'utility_llm.extraction_summaries.started': 'Summarizing sources…',
  'utility_llm.extraction_summaries.completed': 'Summaries ready',
  'evidence.chunk': null,
  'utility_llm.evidence_synthesis.started': 'Synthesizing evidence…',
  'utility_llm.evidence_synthesis.completed': 'Evidence ready',
  'retrieval.completed': 'Retrieval complete',
  'retrieval.failed': 'Retrieval failed',
};

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

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New chat';
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 60).trimEnd() + '…';
}

/**
 * Owns the in-memory state for the chat UI.
 *
 * The orchestrator is the canonical store for sessions and messages;
 * this service caches lightweight session summaries in localStorage so
 * the sidebar can render instantly on reload, and asks the orchestrator
 * for full message history when a session is opened. Streaming turns
 * are funneled through {@link ChatStreamService} and reduced into the
 * `messages` signal as events arrive.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ChatApiService);
  private readonly stream = inject(ChatStreamService);
  private readonly persona = inject(PersonaService);

  private readonly _sessions = signal<SessionSummary[]>(this.loadSessions());
  private readonly _activeId = signal<string | null>(this.loadActiveId());
  private readonly _messages = signal<ChatMessage[]>([]);
  private readonly _streaming = signal<boolean>(false);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  private currentStream: StreamHandle | null = null;

  readonly sessions = this._sessions.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly messages = this._messages.asReadonly();
  readonly isStreaming = this._streaming.asReadonly();
  readonly isLoading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasActiveSession = computed(() => this._activeId() !== null);

  async newSession(): Promise<string> {
    this._error.set(null);
    this._loading.set(true);
    const previousSessionId = this._activeId();
    if (previousSessionId) {
      this.stream.closeSession(previousSessionId);
    }
    try {
      const res = await this.api.createSession({
        userId: LOCAL_USER_ID,
        displayName: LOCAL_USER_DISPLAY,
        personaId: this.persona.active().id,
      });
      const sessionId = res.data.sessionId;
      const summary: SessionSummary = {
        sessionId,
        title: 'New chat',
        createdAt: res.data.createdAt,
        updatedAt: res.data.createdAt,
      };
      this._sessions.update((list) => [summary, ...list]);
      this._activeId.set(sessionId);
      this._messages.set([]);
      this.persistSessions();
      this.persistActiveId();
      return sessionId;
    } catch (err) {
      this._error.set(this.errorMessage(err));
      throw err;
    } finally {
      this._loading.set(false);
    }
  }

  async openSession(sessionId: string): Promise<void> {
    if (this._activeId() === sessionId && this._messages().length > 0) return;
    const previousSessionId = this._activeId();
    this.cancelStream();
    if (previousSessionId && previousSessionId !== sessionId) {
      this.stream.closeSession(previousSessionId);
    }
    this._error.set(null);
    this._loading.set(true);
    this._activeId.set(sessionId);
    this._messages.set([]);
    this.persistActiveId();
    try {
      const res = await this.api.getSession(sessionId);
      const messages: ChatMessage[] = res.data.messages.map((m) => ({
        localId: uuid(),
        messageId: m.messageId,
        turnId: m.turnId,
        role: m.role === 'system' ? 'assistant' : m.role,
        content: m.content,
        thinking: '',
        status: 'done',
        createdAt: m.createdAt,
      }));
      this._messages.set(messages);

      const firstUser = messages.find((m) => m.role === 'user');
      const title = firstUser ? deriveTitle(firstUser.content) : 'New chat';
      this._sessions.update((list) =>
        list.map((s) =>
          s.sessionId === sessionId
            ? {
                ...s,
                title,
                createdAt: res.data.createdAt,
                updatedAt: res.data.updatedAt,
              }
            : s,
        ),
      );
      this.persistSessions();
    } catch (err) {
      this._error.set(this.errorMessage(err));
    } finally {
      this._loading.set(false);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this._error.set(null);
    this.stream.closeSession(sessionId);
    try {
      await this.api.deleteSession(sessionId);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 404) {
        this._error.set(this.errorMessage(err));
        throw err;
      }
    }
    this._sessions.update((list) => list.filter((s) => s.sessionId !== sessionId));
    if (this._activeId() === sessionId) {
      this.cancelStream();
      this._activeId.set(null);
      this._messages.set([]);
    }
    this.persistSessions();
    this.persistActiveId();
  }

  /**
   * Submits a user turn to the active session over the streaming WS and
   * reduces every event into `_messages`. Call {@link cancelStream} to
   * stop generation early — the orchestrator's `AbortController` then
   * tears the upstream Model Host stream down.
   */
  sendStream(text: string, options: { forceThinking?: boolean } = {}): void {
    const sessionId = this._activeId();
    if (!sessionId) {
      this._error.set('No active session. Start a new chat first.');
      return;
    }
    if (this._streaming()) return;
    this._error.set(null);

    const now = new Date().toISOString();
    const userMsg: ChatMessage = {
      localId: uuid(),
      role: 'user',
      content: text,
      thinking: '',
      status: 'done',
      createdAt: now,
    };
    const assistantMsg: ChatMessage = {
      localId: uuid(),
      role: 'assistant',
      content: '',
      thinking: '',
      status: 'classifying',
      createdAt: now,
    };
    this._messages.update((list) => [...list, userMsg, assistantMsg]);

    if (this._messages().filter((m) => m.role === 'user').length === 1) {
      const title = deriveTitle(text);
      this._sessions.update((list) =>
        list.map((s) =>
          s.sessionId === sessionId ? { ...s, title, updatedAt: now } : s,
        ),
      );
      this.persistSessions();
    }

    this._streaming.set(true);

    this.currentStream = this.stream.openTurn({
      sessionId,
      text,
      forceThinking: options.forceThinking === true,
      includeDiagnostics: true,
      onEvent: (evt) => {
        switch (evt.type) {
          case 'accepted':
            this.patchAssistant({ status: 'classifying' });
            break;
          case 'queued':
            this.patchAssistant({ status: 'queued' });
            break;
          case 'started':
            this.patchAssistant({ status: 'streaming' });
            break;
          case 'retrieval':
            this.applyRetrievalEvent(evt.data);
            break;
          case 'thinking':
            this.appendAssistantThinking(evt.data.text);
            this.patchAssistant({ status: 'thinking' });
            break;
          case 'chunk':
            this.appendAssistantContent(evt.data.text);
            this.patchAssistant({ status: 'streaming', retrievalStatus: undefined });
            break;
          case 'done':
            this.patchAssistant({
              messageId: evt.data.assistantMessage.messageId,
              turnId: evt.data.turnId,
              content: evt.data.assistantMessage.content,
              createdAt: evt.data.assistantMessage.createdAt,
              status: 'done',
              retrievalStatus: undefined,
              citations: evt.data.citations,
              diagnostics: evt.data.diagnostics,
            });
            this._streaming.set(false);
            this.currentStream = null;
            this._sessions.update((list) =>
              list.map((s) =>
                s.sessionId === sessionId
                  ? { ...s, updatedAt: evt.data.assistantMessage.createdAt }
                  : s,
              ),
            );
            this.persistSessions();
            break;
          case 'error':
            this.patchAssistant({
              status: 'error',
              errorMessage: evt.error.message,
              retrievalStatus: undefined,
            });
            this._streaming.set(false);
            this.currentStream = null;
            this._error.set(evt.error.message);
            break;
        }
      },
      onClose: () => {
        this._streaming.set(false);
        this.currentStream = null;
        const last = this._messages()[this._messages().length - 1];
        if (
          last?.role === 'assistant' &&
          last.status !== 'done' &&
          last.status !== 'error'
        ) {
          this.patchAssistant({ status: 'cancelled', retrievalStatus: undefined });
        }
      },
    });
  }

  cancelStream(): void {
    this.currentStream?.cancel();
    this.currentStream = null;
  }

  clearActiveView(): void {
    if (this._activeId() === null && this._messages().length === 0) return;
    const sessionId = this._activeId();
    this.cancelStream();
    if (sessionId) {
      this.stream.closeSession(sessionId);
    }
    this._activeId.set(null);
    this._messages.set([]);
    this.persistActiveId();
  }

  /** Forget local cache. Server keeps its own copy. */
  clearLocalCache(): void {
    const sessionId = this._activeId();
    if (sessionId) {
      this.stream.closeSession(sessionId);
    }
    try {
      localStorage.removeItem(SESSIONS_KEY);
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch {
      /* ignore */
    }
    this._sessions.set([]);
    this._activeId.set(null);
    this._messages.set([]);
    this.currentStream = null;
    this._streaming.set(false);
  }

  private applyRetrievalEvent(event: RetrievalStreamEvent): void {
    const label = RETRIEVAL_LABELS[event.type];
    if (label === null) return; // mapped intentionally to "no surface"
    const display = label ?? event.type;
    this.patchAssistant({
      status: 'retrieving',
      retrievalStatus: display,
    });
  }

  private patchAssistant(patch: Partial<ChatMessage>): void {
    this._messages.update((list) => {
      if (list.length === 0) return list;
      const idx = list.length - 1;
      const last = list[idx];
      if (last.role !== 'assistant') return list;
      const updated = { ...last, ...patch };
      const next = list.slice();
      next[idx] = updated;
      return next;
    });
  }

  private appendAssistantContent(text: string): void {
    this._messages.update((list) => {
      if (list.length === 0) return list;
      const idx = list.length - 1;
      const last = list[idx];
      if (last.role !== 'assistant') return list;
      const next = list.slice();
      next[idx] = { ...last, content: last.content + text };
      return next;
    });
  }

  private appendAssistantThinking(text: string): void {
    this._messages.update((list) => {
      if (list.length === 0) return list;
      const idx = list.length - 1;
      const last = list[idx];
      if (last.role !== 'assistant') return list;
      const next = list.slice();
      next[idx] = { ...last, thinking: last.thinking + text };
      return next;
    });
  }

  private loadSessions(): SessionSummary[] {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SessionSummary[]) : [];
    } catch {
      return [];
    }
  }

  private loadActiveId(): string | null {
    try {
      return localStorage.getItem(ACTIVE_SESSION_KEY);
    } catch {
      return null;
    }
  }

  private persistSessions(): void {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(this._sessions()));
    } catch {
      /* ignore */
    }
  }

  private persistActiveId(): void {
    try {
      const id = this._activeId();
      if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
      else localStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  private errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'error' in err) {
      const inner = (err as { error?: { error?: { message?: string } } }).error;
      const msg = inner?.error?.message;
      if (typeof msg === 'string') return msg;
    }
    if (err instanceof Error) return err.message;
    return 'Unexpected error';
  }
}
