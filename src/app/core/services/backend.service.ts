import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatStreamService } from './chat-stream.service';

const STORAGE_KEY = 'gigi.selectedBackend';

export type BackendName = 'ollama' | 'anthropic';

export interface BackendInfo {
  name: BackendName;
  displayName: string;
  modelId: string;
  location: 'local' | 'cloud';
}

/**
 * Tracks the list of LLM backends the orchestrator's LLM Host has
 * been configured to serve and the user's chosen backend for this
 * session. The chosen backend is sent on every `turn.submit` so the
 * LLM Host routes each turn to the right adapter.
 *
 * Backends are fetched once on app boot. The user's selection is
 * persisted in localStorage so it survives reloads. When the
 * persisted backend is no longer offered by the host (e.g. an
 * Anthropic key was removed), the service silently falls back to
 * the host's reported default.
 */
@Injectable({ providedIn: 'root' })
export class BackendService {
  private readonly stream = inject(ChatStreamService);

  private readonly _backends = signal<BackendInfo[]>([]);
  private readonly _defaultBackend = signal<BackendName | null>(null);
  private readonly _selectedName = signal<BackendName | null>(
    this.loadInitial(),
  );
  private readonly _loaded = signal<boolean>(false);

  readonly backends = this._backends.asReadonly();
  readonly defaultBackend = this._defaultBackend.asReadonly();
  readonly loaded = this._loaded.asReadonly();

  readonly selectedName = computed<BackendName | null>(() => {
    const persisted = this._selectedName();
    const fallback = this._defaultBackend();
    const offered = this._backends().map((b) => b.name);
    if (persisted && offered.includes(persisted)) return persisted;
    return fallback;
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
   * Asks the orchestrator for the LLM Host's configured backends.
   * Safe to call multiple times — the second call replaces the
   * cached list (so model swaps on the host become visible without
   * a UI reload).
   */
  async refresh(): Promise<void> {
    try {
      const res = await this.stream.listBackends();
      if (res.backends.length === 0) {
        // Host reported zero backends — keep loaded=false so the
        // message-bubble falls back to its static modelId label.
        return;
      }
      this._backends.set(res.backends);
      this._defaultBackend.set(res.defaultBackend);
      this._loaded.set(true);
    } catch {
      // Older orchestrators don't speak backends.list. Keep
      // loaded=false so the message-bubble falls back to its static
      // modelId label and friends-on-older-builds see no change.
    }
  }

  select(name: BackendName): void {
    if (!this._backends().some((b) => b.name === name)) return;
    this._selectedName.set(name);
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* storage unavailable; ignore */
    }
  }

  private loadInitial(): BackendName | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'ollama' || stored === 'anthropic') return stored;
    } catch {
      /* ignore */
    }
    return null;
  }
}
