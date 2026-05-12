import { Injectable, inject, signal } from '@angular/core';
import { Log, User, UserManager } from 'oidc-client-ts';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import { PersonaService } from './persona.service';

const LOGOUT_PENDING_KEY = 'gigi.logoutPending';

Log.setLogger(console);
Log.setLevel(Log.WARN);

/**
 * Wraps oidc-client-ts UserManager to drive the Authorization Code + PKCE
 * flow against the Swirlock Identity Provider.
 *
 * Public surface:
 * - `isAuthenticated()` signal — whether there is a non-expired access token.
 * - `token()` returns the current access token (empty string if signed out).
 * - `currentUser()` signal — the User object, or null.
 * - `login()` redirects the browser to the IdP for sign-in/registration.
 * - `completeLogin()` is called from the /auth/callback route.
 * - `logout()` redirects to the IdP for RP-initiated logout.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly persona = inject(PersonaService);
  private readonly _user = signal<User | null>(null);
  readonly currentUser = this._user.asReadonly();
  readonly isAuthenticated = signal(false);
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise = new Promise<void>((r) => (this.readyResolve = r));

  private readonly mgr = new UserManager({
    authority: this.cfg.idpIssuer,
    client_id: this.cfg.oidcClientId,
    redirect_uri: this.cfg.oidcRedirectUri,
    post_logout_redirect_uri: this.cfg.oidcPostLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid profile offline_access',
    extraQueryParams: { resource: this.cfg.oidcResource },
    extraTokenParams: { resource: this.cfg.oidcResource },
    automaticSilentRenew: true,
    loadUserInfo: false,
  });

  constructor() {
    this.mgr.events.addUserLoaded((u) => this.setUser(u));
    this.mgr.events.addUserUnloaded(() => this.setUser(null));
    this.mgr.events.addAccessTokenExpired(() => {
      void this.mgr.signinSilent().catch(() => this.setUser(null));
    });
    this.mgr.events.addSilentRenewError((err) => {
      console.warn('[auth] silent renew failed', err);
      this.setUser(null);
    });

    void this.mgr
      .getUser()
      .then(async (u) => {
        if (u && !u.expired) {
          this.consumeLogoutPending();
          this.setUser(u);
          return;
        }
        this.setUser(null);
        // If the user just cancelled an RP-initiated logout, the IdP
        // session cookie is still alive but oidc-client-ts has already
        // wiped our local user state (it calls removeUser() inside
        // signoutRedirect before navigating). A prompt=none redirect
        // re-hydrates the user without any IdP UI flash.
        if (this.consumeLogoutPending() && !location.pathname.startsWith('/auth/')) {
          try {
            await this.mgr.signinRedirect({
              prompt: 'none',
              extraQueryParams: {
                resource: this.cfg.oidcResource,
                persona: this.persona.activeId(),
              },
            });
          } catch (err) {
            console.warn('[auth] silent re-login after cancelled logout failed', err);
          }
        }
      })
      .finally(() => {
        this.readyResolve?.();
        this.readyResolve = null;
      });
  }

  private consumeLogoutPending(): boolean {
    try {
      if (sessionStorage.getItem(LOGOUT_PENDING_KEY) === '1') {
        sessionStorage.removeItem(LOGOUT_PENDING_KEY);
        return true;
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return false;
  }

  waitReady(): Promise<void> {
    return this.readyPromise;
  }

  token(): string {
    return this._user()?.access_token ?? '';
  }

  /**
   * `Bearer <token>` header value — kept for compatibility with services
   * that wanted a header-ready string.
   */
  authHeader(): string {
    return `Bearer ${this.token()}`;
  }

  async login(returnTo?: string): Promise<void> {
    const target = returnTo ?? location.pathname + location.search;
    await this.mgr.signinRedirect({
      state: { returnTo: target },
      extraQueryParams: {
        resource: this.cfg.oidcResource,
        persona: this.persona.activeId(),
      },
    });
  }

  async completeLogin(): Promise<{ returnTo: string }> {
    const user = await this.mgr.signinRedirectCallback();
    this.setUser(user);
    const state = (user.state ?? null) as { returnTo?: string } | null;
    return { returnTo: state?.returnTo || '/' };
  }

  async logout(): Promise<void> {
    try {
      sessionStorage.setItem(LOGOUT_PENDING_KEY, '1');
    } catch {
      /* sessionStorage unavailable */
    }
    await this.mgr.signoutRedirect({
      extraQueryParams: { persona: this.persona.activeId() },
    });
  }

  async completeLogout(): Promise<void> {
    try {
      sessionStorage.removeItem(LOGOUT_PENDING_KEY);
    } catch {
      /* sessionStorage unavailable */
    }
    try {
      await this.mgr.signoutRedirectCallback();
    } catch {
      await this.mgr.removeUser();
    }
    this.setUser(null);
  }

  private setUser(u: User | null): void {
    this._user.set(u);
    this.isAuthenticated.set(!!u && !u.expired);
  }
}
