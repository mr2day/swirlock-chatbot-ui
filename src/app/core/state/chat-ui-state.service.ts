import { Injectable, computed, signal } from '@angular/core';

/**
 * Minimal public-facing description of a backend, mirroring the
 * server's `backends.list` reply. Re-declared here so the state
 * service doesn't depend on internal service shapes (would create
 * import cycles).
 */
export interface BackendDescriptor {
  name: string;
  displayName: string;
  modelId: string;
  location: 'local' | 'cloud';
}

/**
 * Single source of truth for the orthogonal UI state axes that
 * BackendService, SessionService, and the chat-page components
 * all reference. Holds the variables that were previously scattered
 * across multiple services with implicit assumptions about each
 * other — the source of the repeated picker / new-chat / session
 * regressions.
 *
 * Three orthogonal axes:
 *
 *   1. Session axis        — is a session open, what backend is pinned on it
 *   2. Pre-selection axis  — did the user pick a backend pre-session
 *   3. Discovery axis      — what backends are available + which is the runtime default
 *
 * The derived signal `effectiveBackend` is the authoritative answer
 * to "what backend will serve the next turn." Read this — never
 * recompute the resolution chain in components or services. Order:
 *
 *   session backend (when active) → pending pre-selection → runtime default
 *
 * Mutation flow: owner services (`BackendService`, `SessionService`)
 * push state in via the explicit setter methods. State never pulls
 * from its sources — that direction would re-introduce the implicit
 * coupling we're trying to remove.
 */
@Injectable({ providedIn: 'root' })
export class ChatUiState {
  // --- session axis ---
  private readonly _activeSessionId = signal<string | null>(null);
  private readonly _activeSessionBackend = signal<string | null>(null);

  // --- pre-selection axis ---
  private readonly _pendingBackend = signal<string | null>(null);

  // --- discovery axis ---
  private readonly _availableBackends = signal<readonly BackendDescriptor[]>([]);
  private readonly _runtimeDefault = signal<string | null>(null);

  // --- readonly views ---
  readonly activeSessionId = this._activeSessionId.asReadonly();
  readonly activeSessionBackend = this._activeSessionBackend.asReadonly();
  readonly pendingBackend = this._pendingBackend.asReadonly();
  readonly availableBackends = this._availableBackends.asReadonly();
  readonly runtimeDefault = this._runtimeDefault.asReadonly();

  // --- derived ---
  readonly hasActiveSession = computed(() => this._activeSessionId() !== null);

  /**
   * The backend that will actually serve the next turn. Resolution
   * order: active session's pinned backend → user's pre-selection
   * → runtime default. Returns null only when none of the three are
   * set (first paint, before `backends.list` resolves).
   */
  readonly effectiveBackend = computed<string | null>(
    () =>
      this._activeSessionBackend() ??
      this._pendingBackend() ??
      this._runtimeDefault(),
  );

  // --- mutators (owner services call these) ---

  /**
   * Owned by SessionService. Pass null on session close. Call once
   * per active-session change; the state service does not de-dup.
   */
  setActiveSession(
    sessionId: string | null,
    sessionBackend: string | null,
  ): void {
    this._activeSessionId.set(sessionId);
    this._activeSessionBackend.set(sessionBackend);
  }

  /**
   * Owned by BackendService. Called when the user clicks a model in
   * the sidebar picker. Persistence (localStorage) is the caller's
   * responsibility — this service holds in-memory state only.
   */
  setPendingBackend(name: string | null): void {
    this._pendingBackend.set(name);
  }

  /**
   * Owned by BackendService. Called after a successful
   * `backends.list` reply.
   */
  setDiscovery(
    available: readonly BackendDescriptor[],
    runtimeDefault: string | null,
  ): void {
    this._availableBackends.set(available);
    this._runtimeDefault.set(runtimeDefault);
  }

  /**
   * Test hook. Resets every axis to its initial state. Used only by
   * the eval harness; do not call from production code.
   */
  __resetForEval(): void {
    this._activeSessionId.set(null);
    this._activeSessionBackend.set(null);
    this._pendingBackend.set(null);
    this._availableBackends.set([]);
    this._runtimeDefault.set(null);
  }
}
