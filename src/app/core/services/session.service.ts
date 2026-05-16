import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type {
  ChatMessage,
  ChatMessageImage,
  SessionSummary,
} from '../models/chat-message.model';
import type { PersistedImageRef } from '../models/chat.model';
import type { RetrievalStreamEvent } from '../models/stream-event.model';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import { AuthService } from './auth.service';
import { ChatStreamService, StreamHandle } from './chat-stream.service';
import { LocationService } from './location.service';
import { PersonaService } from './persona.service';

// Per-account localStorage scopes. Pre-auth (dev-token era) keys
// `gigi.sessions` and `gigi.activeSessionId` are deleted on first boot
// of the authenticated build so they cannot leak between identities.
const LEGACY_SESSIONS_KEY = 'gigi.sessions';
const LEGACY_ACTIVE_SESSION_KEY = 'gigi.activeSessionId';
const SESSIONS_KEY_PREFIX = 'gigi.sessions.';
const ACTIVE_SESSION_KEY_PREFIX = 'gigi.activeSessionId.';
const LOCAL_USER_DISPLAY = 'You';

try {
  localStorage.removeItem(LEGACY_SESSIONS_KEY);
  localStorage.removeItem(LEGACY_ACTIVE_SESSION_KEY);
} catch {
  /* ignore */
}

/**
 * Maps the RAG Engine's verbose retrieval event types to short, friendly
 * progress labels the chat UI can show inline ("Searching the web…",
 * "Reading sources…"). Returning `null` means: don't surface this event.
 */
/**
 * Generic per-event-type labels. Provider-specific live.* events also fall
 * through {@link buildRetrievalLabel} so each provider can show
 * distinct copy.
 */
const RETRIEVAL_LABELS: Record<string, string | null> = {
  'retrieval.started': 'Starting retrieval…',
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
  'evidence.chunk': null,
  'retrieval.completed': 'Retrieval complete',
  'retrieval.failed': 'Retrieval failed',
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  exa: 'the web (Exa)',
};

function buildRetrievalLabel(
  event: RetrievalStreamEvent,
): string | null | undefined {
  const provider =
    typeof event.data?.['provider'] === 'string'
      ? (event.data['provider'] as string)
      : undefined;
  if (provider) {
    const friendly = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
    switch (event.type) {
      case 'live.search.started':
        return `Searching ${friendly}…`;
      case 'live.search.completed':
        return `Search of ${friendly} done`;
      case 'live.extract.started':
        return `Reading sources from ${friendly}…`;
      case 'live.extract.completed':
        return `Sources from ${friendly} read`;
      default:
        break;
    }
  }
  return RETRIEVAL_LABELS[event.type];
}

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
  private readonly stream = inject(ChatStreamService);
  private readonly persona = inject(PersonaService);
  private readonly location = inject(LocationService);
  private readonly auth = inject(AuthService);
  private readonly cfg = inject(RUNTIME_CONFIG);

  private readonly _sessions = signal<SessionSummary[]>([]);
  private readonly _activeId = signal<string | null>(null);
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

  constructor() {
    // Reload (or clear) the local cache whenever the authenticated user
    // changes. Persona changes are NOT auto-watched here — see the
    // commentary on `switchPersona()` below for why.
    effect(() => {
      const sub = this.currentSub();
      untracked(() => {
        this.cancelStream();
        if (!sub) {
          this._sessions.set([]);
          this._activeId.set(null);
          this._messages.set([]);
          return;
        }
        const personaId = this.persona.activeId();
        this._sessions.set(this.loadSessions(sub, personaId));
        void this.refreshSessionsFromServer(sub, personaId);
      });
    });
  }

  /**
   * User-driven persona switch from the topbar. Clears the active
   * conversation, swaps the persona theme/avatar/favicon, and reloads
   * the sidebar with the new persona's sessions.
   *
   * Persona changes are NOT routed through a generic effect on
   * `persona.activeId()` because there are two distinct callers with
   * opposite intents:
   *
   *   - the topbar switcher (this method) — clear the active session,
   *     start fresh in the new persona;
   *   - back-nav into an existing session that belongs to a different
   *     persona (handled inside `openSession`) — keep the session
   *     open, just sync the chrome to match.
   *
   * An effect on the signal can't tell the two apart, so it ends up
   * clobbering the second case. Calling the two paths explicitly
   * keeps the wiring honest.
   */
  switchPersona(personaId: string): void {
    if (personaId === this.persona.activeId()) return;
    this.cancelStream();
    const previousSessionId = this._activeId();
    if (previousSessionId) {
      this.stream.closeSession(previousSessionId);
    }
    this.persona.setActive(personaId);
    this._activeId.set(null);
    this._messages.set([]);
    const sub = this.currentSub();
    if (sub) {
      this._sessions.set(this.loadSessions(sub, personaId));
      void this.refreshSessionsFromServer(sub, personaId);
    }
    this.persistActiveId();
  }

  /**
   * Fetches the active persona's sessions from the orchestrator and
   * writes them into the local store. Sessions live server-side; the
   * localStorage copy is a per-(user, persona) cache that's wrong as
   * soon as the user signs in on a different device.
   */
  private async refreshSessionsFromServer(
    sub: string,
    personaId: string,
  ): Promise<void> {
    try {
      const { sessions } = await this.stream.listSessions({ personaId });
      if (this.currentSub() !== sub) return;
      if (this.persona.activeId() !== personaId) return;
      this._sessions.set(sessions);
      this.persistSessions();
    } catch (err) {
      console.warn('[session] failed to load sessions from server', err);
    }
  }

  private currentSub(): string | null {
    const user = this.auth.currentUser();
    const sub = (user?.profile as { sub?: unknown } | undefined)?.sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  }

  async newSession(): Promise<string> {
    this._error.set(null);
    this._loading.set(true);
    const previousSessionId = this._activeId();
    if (previousSessionId) {
      this.stream.closeSession(previousSessionId);
    }
    const sub = this.currentSub();
    if (!sub) {
      this._error.set('Not signed in.');
      this._loading.set(false);
      throw new Error('Not signed in.');
    }
    try {
      const persona = this.persona.active();
      const modelId = await this.stream.getModelId();
      const systemPrompt = persona.systemPromptTemplate.replace(
        /\$\{model\}/g,
        modelId,
      );
      const res = await this.stream.createSession({
        userId: sub,
        displayName: LOCAL_USER_DISPLAY,
        persona: { id: persona.id, name: persona.name, systemPrompt },
      });
      const sessionId = res.data.sessionId;
      const summary: SessionSummary = {
        sessionId,
        personaId: persona.id,
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
      const res = await this.stream.getSession(sessionId);

      // The URL is the source of truth for which conversation is
      // open. If that conversation belongs to a different persona
      // than the topbar currently shows (typical case: phone back
      // button into a session of a previously-active persona), sync
      // the chrome — theme, avatar, favicon, sidebar list — to match
      // the session. We do this INSTEAD of routing through
      // `switchPersona()` because we explicitly do NOT want to clear
      // the active session we're about to display.
      const sessionPersonaId = res.data.personaId;
      if (
        sessionPersonaId &&
        sessionPersonaId !== this.persona.activeId()
      ) {
        this.persona.setActive(sessionPersonaId);
        const sub = this.currentSub();
        if (sub) {
          this._sessions.set(this.loadSessions(sub, sessionPersonaId));
          void this.refreshSessionsFromServer(sub, sessionPersonaId);
        }
      }

      const messages: ChatMessage[] = res.data.messages.map((m) => {
        const images = this.rehydrateImageRefs(m.images);
        return {
          localId: uuid(),
          messageId: m.messageId,
          turnId: m.turnId,
          role: m.role === 'system' ? 'assistant' : m.role,
          content: m.content,
          thinking: '',
          status: 'done',
          createdAt: m.createdAt,
          ...(images.length > 0 ? { images } : {}),
        };
      });
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
      await this.stream.deleteSession(sessionId);
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
  async sendStream(
    text: string,
    options: {
      forceThinking?: boolean;
      images?: { id: string; dataUrl: string; mimeType: string; name: string }[];
    } = {},
  ): Promise<void> {
    const sessionId = this._activeId();
    if (!sessionId) {
      this._error.set('No active session. Start a new chat first.');
      return;
    }
    if (this._streaming()) return;
    this._error.set(null);

    const images = options.images ?? [];
    const now = new Date().toISOString();
    const userMsg: ChatMessage = {
      localId: uuid(),
      role: 'user',
      content: text,
      thinking: '',
      status: 'done',
      createdAt: now,
      ...(images.length > 0
        ? {
            images: images.map((i) => ({
              id: i.id,
              dataUrl: i.dataUrl,
              mimeType: i.mimeType,
              name: i.name,
            })),
          }
        : {}),
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

    const userLocation =
      this.location.getStoredPermission() === 'granted'
        ? (await this.location.fetchCurrentLocation()) ?? undefined
        : undefined;

    this.currentStream = this.stream.openTurn({
      sessionId,
      text,
      forceThinking: options.forceThinking === true,
      includeDiagnostics: true,
      ...(images.length > 0 ? { images } : {}),
      ...(userLocation ? { userLocation } : {}),
      onEvent: (evt) => {
        switch (evt.type) {
          case 'turn.accepted':
          case 'turn.classifying':
            this.patchAssistant({
              status: 'classifying',
              retrievalStatus: undefined,
            });
            break;
          case 'turn.queued':
            this.patchAssistant({ status: 'queued' });
            break;
          case 'turn.started':
            this.patchAssistant({
              status: 'streaming',
              retrievalStatus: undefined,
              agentStatus: undefined,
            });
            break;
          case 'turn.retrieval':
            this.applyRetrievalEvent(evt.payload.event);
            break;
          case 'turn.agent':
            this.applyAgentEvent(evt.payload);
            break;
          case 'turn.location_required':
            void this.handleLocationRequired(evt.correlationId);
            break;
          case 'turn.thinking':
            this.appendAssistantThinking(evt.payload.text);
            this.patchAssistant({ status: 'thinking' });
            break;
          case 'turn.chunk':
            this.appendAssistantContent(evt.payload.text);
            this.patchAssistant({
              status: 'streaming',
              retrievalStatus: undefined,
              agentStatus: undefined,
            });
            break;
          case 'turn.done':
            this.patchAssistant({
              messageId: evt.payload.assistantMessage.messageId,
              turnId: evt.payload.turnId,
              content: evt.payload.assistantMessage.content,
              createdAt: evt.payload.assistantMessage.createdAt,
              status: 'done',
              retrievalStatus: undefined,
              agentStatus: undefined,
              citations: evt.payload.citations,
              diagnostics: evt.payload.diagnostics,
            });
            this._streaming.set(false);
            this.currentStream = null;
            this._sessions.update((list) =>
              list.map((s) =>
                s.sessionId === sessionId
                  ? { ...s, updatedAt: evt.payload.assistantMessage.createdAt }
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
              agentStatus: undefined,
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

  /** Forget the current user's local cache. Server keeps its own copy. */
  clearLocalCache(): void {
    const sessionId = this._activeId();
    if (sessionId) {
      this.stream.closeSession(sessionId);
    }
    const sub = this.currentSub();
    try {
      if (sub) {
        localStorage.removeItem(SESSIONS_KEY_PREFIX + sub);
        localStorage.removeItem(ACTIVE_SESSION_KEY_PREFIX + sub);
      }
    } catch {
      /* ignore */
    }
    this._sessions.set([]);
    this._activeId.set(null);
    this._messages.set([]);
    this.currentStream = null;
    this._streaming.set(false);
  }

  /**
   * Called when the orchestrator emits `turn.location_required` for the
   * active turn. If the user has previously granted location, fetch silently
   * and respond. Otherwise put the assistant message into an
   * `awaiting_location` state so the bubble can render the permission card.
   */
  private async handleLocationRequired(correlationId: string): Promise<void> {
    const stored = this.location.getStoredPermission();

    if (stored === 'granted') {
      const fetched = await this.location.fetchCurrentLocation();
      if (fetched) {
        this.stream.sendLocationResponse(correlationId, {
          available: true,
          location: fetched,
        });
        this.patchAssistant({
          status: 'retrieving',
          retrievalStatus: 'Using your location…',
        });
      } else {
        this.stream.sendLocationResponse(correlationId, {
          available: false,
          reason: 'unavailable',
        });
        this.patchAssistant({
          status: 'retrieving',
          retrievalStatus: 'Continuing without location…',
          locationPrompt: {
            correlationId,
            pending: false,
            resolution: 'unavailable',
          },
        });
      }
      return;
    }

    if (stored === 'denied') {
      this.stream.sendLocationResponse(correlationId, {
        available: false,
        reason: 'denied',
      });
      this.patchAssistant({
        status: 'retrieving',
        retrievalStatus: 'Continuing without location…',
        locationPrompt: {
          correlationId,
          pending: false,
          resolution: 'denied',
        },
      });
      return;
    }

    this.patchAssistant({
      status: 'awaiting_location',
      retrievalStatus: undefined,
      locationPrompt: { correlationId, pending: true },
    });
  }

  /**
   * Called by the location-permission card when the user clicks Allow.
   * Stores the grant in localStorage, fetches coords, and replies to the
   * orchestrator so the paused turn can continue.
   */
  async grantLocation(correlationId: string): Promise<void> {
    this.location.setStoredPermission('granted');
    const fetched = await this.location.fetchCurrentLocation();
    if (fetched) {
      this.stream.sendLocationResponse(correlationId, {
        available: true,
        location: fetched,
      });
      this.patchAssistant({
        status: 'retrieving',
        retrievalStatus: 'Using your location…',
        locationPrompt: { correlationId, pending: false, resolution: 'granted' },
      });
      return;
    }
    this.stream.sendLocationResponse(correlationId, {
      available: false,
      reason: 'unavailable',
    });
    this.patchAssistant({
      status: 'retrieving',
      retrievalStatus: 'Continuing without location…',
      locationPrompt: {
        correlationId,
        pending: false,
        resolution: 'unavailable',
      },
    });
  }

  /**
   * Called by the location-permission card when the user clicks Deny.
   */
  denyLocation(correlationId: string): void {
    this.location.setStoredPermission('denied');
    this.stream.sendLocationResponse(correlationId, {
      available: false,
      reason: 'denied',
    });
    this.patchAssistant({
      status: 'retrieving',
      retrievalStatus: 'Continuing without location…',
      locationPrompt: { correlationId, pending: false, resolution: 'denied' },
    });
  }

  /**
   * Surfaces orchestrator agent activity ({@code turn.agent}) so the bubble
   * can show the user what the agent is doing between control steps.
   * `command_started` (e.g. "Searching: 'current weather'") wins over
   * `command_completed` and `plan` summaries.
   */
  private applyAgentEvent(payload: {
    phase:
      | 'classifying'
      | 'command_started'
      | 'command_completed'
      | 'plan';
    command?: string;
    summary: string;
  }): void {
    if (payload.phase === 'command_completed') {
      // Final retrieval/RAG events already cover this; leave the
      // retrievalStatus alone but clear stale agentStatus.
      this.patchAssistant({ agentStatus: undefined });
      return;
    }
    this.patchAssistant({
      agentStatus: payload.summary,
    });
  }

  private applyRetrievalEvent(event: RetrievalStreamEvent): void {
    if (event.type === 'retrieval.completed' || event.type === 'retrieval.failed') {
      // Retrieval phase is over. Clear the retrieval label and let the
      // orchestrator's next signal (turn.classifying for the agent's next
      // control step, or turn.started for the streaming final answer) drive
      // the UI from here. Without this reset, the last retrieval label
      // would linger for several seconds while the agent decides next steps.
      this.patchAssistant({
        status: 'classifying',
        retrievalStatus: undefined,
      });
      return;
    }
    const label = buildRetrievalLabel(event);
    if (label === null) return; // mapped intentionally to "no surface"
    if (label === undefined) return; // unknown event types are not surfaced as raw strings
    this.patchAssistant({
      status: 'retrieving',
      retrievalStatus: label,
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

  private sessionsKey(sub: string, personaId: string): string {
    return `${SESSIONS_KEY_PREFIX}${sub}.${personaId}`;
  }

  private activeIdKey(sub: string, personaId: string): string {
    return `${ACTIVE_SESSION_KEY_PREFIX}${sub}.${personaId}`;
  }

  private loadSessions(sub: string, personaId: string): SessionSummary[] {
    try {
      const raw = localStorage.getItem(this.sessionsKey(sub, personaId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SessionSummary[]) : [];
    } catch {
      return [];
    }
  }

  private persistSessions(): void {
    const sub = this.currentSub();
    if (!sub) return;
    const personaId = this.persona.activeId();
    try {
      localStorage.setItem(
        this.sessionsKey(sub, personaId),
        JSON.stringify(this._sessions()),
      );
    } catch {
      /* ignore */
    }
  }

  private persistActiveId(): void {
    const sub = this.currentSub();
    if (!sub) return;
    const personaId = this.persona.activeId();
    try {
      const id = this._activeId();
      if (id) localStorage.setItem(this.activeIdKey(sub, personaId), id);
      else localStorage.removeItem(this.activeIdKey(sub, personaId));
    } catch {
      /* ignore */
    }
  }

  /**
   * Returns the HTTP base URL for fetching image bytes from the
   * orchestrator. Derived from the WS base URL — `wss://api...` →
   * `https://api...` — so a single piece of runtime config covers
   * both transports.
   */
  private apiHttpBaseUrl(): string {
    return this.cfg.wsBaseUrl
      .replace(/^wss:/i, 'https:')
      .replace(/^ws:/i, 'http:')
      .replace(/\/$/, '');
  }

  /**
   * Turns the persisted image refs the orchestrator returns on
   * `session.get` into the `ChatMessageImage` shape the message-bubble
   * renders. The `dataUrl` field is reused as the `src` for the
   * <img> — when the message came back from the DB it carries an
   * `https://api…/images/<id>` URL; when the user just pasted a
   * fresh image it carries the original `data:` URL. The browser
   * handles both transparently.
   */
  private rehydrateImageRefs(
    refs: PersistedImageRef[] | undefined,
  ): ChatMessageImage[] {
    if (!refs || refs.length === 0) return [];
    const base = this.apiHttpBaseUrl();
    return refs.map((r) => ({
      id: r.imageId,
      dataUrl: `${base}/images/${r.imageId}`,
      mimeType: r.mimeType ?? 'image/jpeg',
    }));
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
