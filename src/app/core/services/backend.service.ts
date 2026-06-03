import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ChatStreamService,
  type AgentBackend,
  type AgentBackendInfo,
} from './chat-stream.service';
import { SessionService } from './session.service';
import { ChatUiState } from '../state/chat-ui-state.service';
import { BACKEND_PREFERENCE_KEY } from '../storage-keys';

/**
 * Backend wire identifier — must match swirlock-agent-runtime's
 * BackendId. Re-exported here so UI components import the type from
 * one place.
 */
export type BackendName = AgentBackend;

export interface BackendInfo {
  name: BackendName;
  displayName: string;
  modelId: string;
  location: 'local' | 'cloud';
}

/**
 * Backend operations layer. The state itself lives in `ChatUiState`;
 * this service owns the side-effects (WS round-trips, localStorage
 * persistence) and re-exposes the relevant slices of state with
 * historical names so existing components keep working.
 *
 * Selection resolution lives entirely in `ChatUiState.effectiveBackend`
 * (single source of truth, no recomputation here). The picker
 * dropdown writes to `chatUiState.setPendingBackend` for both the
 * pre-session case and the active-session case; for the active-
 * session case it ALSO round-trips through `session.set_backend` so
 * the agent persists the change to the session row.
 */
@Injectable({ providedIn: 'root' })
export class BackendService {
  private readonly stream = inject(ChatStreamService);
  private readonly session = inject(SessionService);
  private readonly state = inject(ChatUiState);

  private readonly _loaded = signal<boolean>(false);
  private readonly _switching = signal<boolean>(false);

  readonly loaded = this._loaded.asReadonly();
  readonly switching = this._switching.asReadonly();

  // Re-expose ChatUiState slices under the historical names so
  // existing component imports (`backend.backends()`,
  // `backend.runtimeDefault()`) keep working without modification.
  readonly backends = computed<BackendInfo[]>(() =>
    this.state.availableBackends().map((b) => ({
      name: b.name as BackendName,
      displayName: b.displayName,
      modelId: b.modelId,
      location: b.location,
    })),
  );
  readonly runtimeDefault = computed<BackendName | null>(
    () => this.state.runtimeDefault() as BackendName | null,
  );
  readonly pendingDefault = computed<BackendName | null>(
    () => this.state.pendingBackend() as BackendName | null,
  );

  constructor() {
    // Seed the pre-selection from localStorage at construction time.
    // The state service holds in-memory state only; persistence lives
    // here so the state stays framework-agnostic and testable.
    const stored = readStoredPreference();
    if (stored) {
      this.state.setPendingBackend(stored);
    }
  }

  /**
   * The backend that will serve the next turn. Reads
   * `ChatUiState.effectiveBackend` directly — the resolution chain
   * (session → pending → runtime) lives there and nowhere else.
   */
  readonly selectedName = computed<BackendName | null>(
    () => this.state.effectiveBackend() as BackendName | null,
  );

  readonly selected = computed<BackendInfo | null>(() => {
    const name = this.selectedName();
    if (!name) return null;
    return this.backends().find((b) => b.name === name) ?? null;
  });

  readonly others = computed<BackendInfo[]>(() => {
    const active = this.selectedName();
    return this.backends().filter((b) => b.name !== active);
  });

  /**
   * Friendly display name for a backend id (e.g. `anthropic-opus` →
   * `Claude Opus 4.7`), looked up against the cached `backends.list`
   * response. Used by message bubbles to label per-turn attribution
   * with the same human-readable string the picker shows, rather
   * than the raw provider model id. Returns null when the backend
   * list hasn't loaded yet so callers can fall back to the modelId.
   */
  displayNameFor(name: BackendName): string | null {
    return this.backends().find((b) => b.name === name)?.displayName ?? null;
  }

  /**
   * Fetches the agent's backend list. Safe to call multiple times;
   * each call replaces the cached list in `ChatUiState` so a runtime
   * reconfig is visible without a UI reload.
   */
  async refresh(): Promise<void> {
    try {
      const res = await this.stream.listBackends();
      this.state.setDiscovery(
        res.backends.map((b) => toDescriptor(b)),
        res.defaultBackend,
      );
      this._loaded.set(true);
    } catch {
      // Agent unreachable or unknown error — leave discovery empty.
      // The message-bubble falls back to the plain modelId label.
    }
  }

  /**
   * Pick a backend. Always updates the pre-selection (sticky pref).
   * When a session is active, also round-trips through
   * `session.set_backend` so the agent persists the choice on the
   * session row. When no session is active, the pre-selection alone
   * is enough — the next `session.create` reads it and passes it as
   * `defaultBackend`.
   */
  async select(name: BackendName): Promise<void> {
    if (!this.backends().some((b) => b.name === name)) {
      throw new Error(`unknown backend: ${name}`);
    }
    if (this.selectedName() === name) return; // no-op

    // Always update the pre-selection (sticky preference).
    this.state.setPendingBackend(name);
    writeStoredPreference(name);

    const activeId = this.state.activeSessionId();
    if (!activeId) {
      // No active session — pre-selection alone is enough. The next
      // `session.create` reads localStorage and passes the picked
      // backend as `defaultBackend`.
      return;
    }

    // Active session — round-trip through the agent to update the
    // session's pinned backend. SessionService.setActiveSessionBackend
    // updates `_sessions`, whose effect (in SessionService) mirrors
    // the change into `state.activeSessionBackend`.
    this._switching.set(true);
    try {
      await this.session.setActiveSessionBackend(name);
    } finally {
      this._switching.set(false);
    }
  }
}

function toDescriptor(b: AgentBackendInfo) {
  return {
    name: b.name,
    displayName: b.displayName,
    modelId: b.defaultModelId,
    location: b.location,
  };
}

function readStoredPreference(): string | null {
  try {
    return localStorage.getItem(BACKEND_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPreference(name: string): void {
  try {
    localStorage.setItem(BACKEND_PREFERENCE_KEY, name);
  } catch {
    // localStorage unavailable (private mode, quota) — preference
    // becomes session-scoped instead of persistent. Not fatal.
  }
}
