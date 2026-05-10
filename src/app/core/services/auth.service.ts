import { Injectable, inject, signal } from '@angular/core';
import { Log, User, UserManager } from 'oidc-client-ts';
import { RUNTIME_CONFIG } from '../config/runtime-config';

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
      .then((u) => {
        if (u && !u.expired) this.setUser(u);
        else this.setUser(null);
      })
      .finally(() => {
        this.readyResolve?.();
        this.readyResolve = null;
      });
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

  async login(): Promise<void> {
    await this.mgr.signinRedirect({ state: { returnTo: location.pathname + location.search } });
  }

  async completeLogin(): Promise<{ returnTo: string }> {
    const user = await this.mgr.signinRedirectCallback();
    this.setUser(user);
    const state = (user.state ?? null) as { returnTo?: string } | null;
    return { returnTo: state?.returnTo || '/' };
  }

  async logout(): Promise<void> {
    await this.mgr.signoutRedirect();
  }

  private setUser(u: User | null): void {
    this._user.set(u);
    this.isAuthenticated.set(!!u && !u.expired);
  }
}
