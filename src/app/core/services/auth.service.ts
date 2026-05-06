import { Injectable, inject, signal } from '@angular/core';
import { RUNTIME_CONFIG } from '../config/runtime-config';

const STORAGE_KEY = 'gigi.bearerToken';

/**
 * Bearer token holder.
 *
 * For local development the token defaults to the dev value baked into
 * `RuntimeConfig` (which mirrors the orchestrator's
 * `service.config.cjs`). Users can override it from the settings panel
 * later; the override persists in `localStorage`.
 *
 * Future authentication flows (rotated bearer secrets, mTLS,
 * deployment-chosen mechanism) replace this service. The rest of the app
 * only depends on the public `token()` and `authHeader()` methods.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly _token = signal<string>(this.loadInitial());

  readonly token = this._token.asReadonly();

  setToken(value: string): void {
    const trimmed = value.trim();
    this._token.set(trimmed);
    try {
      if (trimmed.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, trimmed);
      }
    } catch {
      /* ignore */
    }
  }

  /** `Bearer <token>` header value, ready to drop into a `Headers` map. */
  authHeader(): string {
    return `Bearer ${this._token()}`;
  }

  private loadInitial(): string {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored.length > 0) return stored;
    } catch {
      /* ignore */
    }
    return this.cfg.bearerToken;
  }
}
