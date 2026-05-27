import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ChatStreamService,
  type AgentBackend,
  type AgentBackendInfo,
} from './chat-stream.service';
import { SessionService } from './session.service';
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
 * Read-only view + selection helper for the LLM backends the agent
 * exposes.
 *
 * The list of backends comes from the agent's `backends.list` reply
 * verbatim — no display names hardcoded client-side. The currently-
 * selected backend is derived from the **active session's**
 * `defaultBackend` field, NOT from localStorage: the session is the
 * source of truth, and the model picker is just a display +
 * selection wrapper around `session.set_backend` calls. When the
 * user switches the model, the call round-trips through the WS;
 * the displayed selection only updates after the agent confirms.
 *
 * The picker shows the agent runtime's runtime default
 * (`AGENT_DEFAULT_BACKEND`) as the pre-selection when no session is
 * active yet (landing page, between sessions).
 */
@Injectable({ providedIn: 'root' })
export class BackendService {
  private readonly stream = inject(ChatStreamService);
  private readonly session = inject(SessionService);

  private readonly _backends = signal<BackendInfo[]>([]);
  private readonly _runtimeDefault = signal<BackendName | null>(null);
  private readonly _loaded = signal<boolean>(false);
  private readonly _switching = signal<boolean>(false);
  // User's pre-selection (when they pick a model in the sidebar before
  // any session is active). Initialized from localStorage so the
  // preference is sticky across reloads. Applied as `defaultBackend`
  // on the next `session.create`.
  private readonly _pendingDefault = signal<BackendName | null>(
    readStoredPreference(),
  );

  readonly backends = this._backends.asReadonly();
  readonly runtimeDefault = this._runtimeDefault.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly switching = this._switching.asReadonly();
  readonly pendingDefault = this._pendingDefault.asReadonly();

  /**
   * The backend currently in effect for the next turn:
   *   - the active session's `defaultBackend` when one is set
   *   - the runtime's default backend otherwise
   *   - null until backends.list has resolved at least once
   */
  readonly selectedName = computed<BackendName | null>(() => {
    const activeSession = this.session.activeSession();
    const sessionBackend = activeSession?.defaultBackend ?? null;
    if (sessionBackend) {
      return sessionBackend as BackendName;
    }
    // No active session: fall back to the user's pre-selection (set
    // by clicking the picker without a session open), then to the
    // runtime's configured default.
    return this._pendingDefault() ?? this._runtimeDefault();
  });

  readonly selected = computed<BackendInfo | null>(() => {
    const name = this.selectedName();
    if (!name) return null;
    return this._backends().find((b) => b.name === name) ?? null;
  });

  readonly others = computed<BackendInfo[]>(() => {
    const active = this.selectedName();
    return this._backends().filter((b) => b.name !== active);
  });

  /**
   * Fetches the agent's backend list. Safe to call multiple times;
   * each call replaces the cached list so a runtime reconfig is
   * visible without a UI reload.
   */
  async refresh(): Promise<void> {
    try {
      const res = await this.stream.listBackends();
      this._backends.set(
        res.backends.map((b) => toBackendInfo(b)),
      );
      this._runtimeDefault.set(res.defaultBackend);
      this._loaded.set(true);
    } catch {
      // Agent unreachable or unknown error — leave the picker empty;
      // the message-bubble will fall back to its plain modelId label.
    }
  }

  /**
   * Switches the active session to the given backend. Sends
   * `session.set_backend` and waits for the reply before resolving;
   * the UI's selectedName signal updates as soon as the session's
   * defaultBackend changes in SessionService state.
   *
   * Throws when there is no active session or the agent rejects the
   * change.
   */
  async select(name: BackendName): Promise<void> {
    if (!this._backends().some((b) => b.name === name)) {
      throw new Error(`unknown backend: ${name}`);
    }
    if (this.selectedName() === name) return; // no-op
    const activeId = this.session.activeId();
    if (!activeId) {
      // No active session — record the pre-selection locally; the
      // next `session.create` reads it and passes it as
      // `defaultBackend` so the new session honors the choice.
      this._pendingDefault.set(name);
      writeStoredPreference(name);
      return;
    }
    this._switching.set(true);
    try {
      await this.session.setActiveSessionBackend(name);
      // Also update the pre-selection so a fresh "New chat" after
      // this point keeps using the same backend by default.
      this._pendingDefault.set(name);
      writeStoredPreference(name);
    } finally {
      this._switching.set(false);
    }
  }
}

function toBackendInfo(b: AgentBackendInfo): BackendInfo {
  return {
    name: b.name,
    displayName: b.displayName,
    modelId: b.defaultModelId,
    location: b.location,
  };
}

function readStoredPreference(): BackendName | null {
  try {
    return localStorage.getItem(BACKEND_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPreference(name: BackendName): void {
  try {
    localStorage.setItem(BACKEND_PREFERENCE_KEY, name);
  } catch {
    // localStorage unavailable (private mode, quota) — preference
    // becomes session-scoped instead of persistent. Not fatal.
  }
}
