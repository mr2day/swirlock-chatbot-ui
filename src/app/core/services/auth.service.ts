import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Log,
  type OidcClient,
  type SigninRequest,
  type SignoutRequest,
  User,
  UserManager,
} from 'oidc-client-ts';
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
 *
 * Native (Capacitor) shell: the same UserManager is used, but the
 * /authorize and /session/end navigations happen in a system browser
 * (Chrome Custom Tabs on Android) rather than the webview. When the
 * IdP redirects to the `gigi://auth/(callback|logout-callback)`
 * custom-scheme URL, Android routes it back to the app via an intent
 * filter and the deep-link handler completes the flow.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly cfg = inject(RUNTIME_CONFIG);
  private readonly persona = inject(PersonaService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly _user = signal<User | null>(null);
  readonly currentUser = this._user.asReadonly();
  readonly isAuthenticated = signal(false);
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise = new Promise<void>((r) => (this.readyResolve = r));

  /**
   * One unified OIDC client (`application_type: native` on the IdP)
   * backs both web and Capacitor shells. The IdP's redirect-uri
   * validator accepts mixed https + custom-scheme URIs under the
   * native app type, and we patched its interaction policy to skip
   * the always-prompt-consent check that native would normally
   * trigger. The only thing that differs per platform here is the
   * redirect URI we hand to the IdP for this particular flow.
   */
  private get redirectUri(): string {
    if (this.isNative()) return 'gigi://auth/callback';
    // Derive from the actual origin the SPA was served from so
    // `ng serve` (http://localhost:4200) and the production host
    // (https://gigi-the-robot.com) both work without a rebuild. The
    // IdP client has all matching URIs registered.
    return `${location.origin}/auth/callback`;
  }
  private get postLogoutRedirectUri(): string {
    if (this.isNative()) return 'gigi://auth/logout-callback';
    return `${location.origin}/auth/logout-callback`;
  }

  private readonly mgr = new UserManager({
    authority: this.cfg.idpIssuer,
    client_id: this.cfg.oidcClientId,
    redirect_uri: this.redirectUri,
    post_logout_redirect_uri: this.postLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid profile offline_access',
    extraQueryParams: { resource: this.cfg.oidcResource },
    extraTokenParams: { resource: this.cfg.oidcResource },
    // Silent renew works on both web and native. On web it uses a
    // hidden iframe to /authorize; on native (where iframes can't
    // reliably reach the IdP) oidc-client-ts automatically uses the
    // refresh_token grant against /token instead, since we have
    // offline_access in scope.
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

    if (this.isNative()) {
      void this.bindNativeDeepLinks();
    }

    void this.mgr
      .getUser()
      .then(async (u) => {
        if (u && !u.expired) {
          this.consumeLogoutPending();
          this.setUser(u);
          return;
        }
        // Persisted user has an expired access token but might still
        // have a valid refresh token (we issue 1-year refresh tokens
        // and rotate on each use). Try to silently refresh before
        // declaring the user logged out — otherwise reopening the app
        // after an hour shows the landing page even though we have
        // everything we need to renew.
        if (u?.refresh_token) {
          try {
            const renewed = await this.mgr.signinSilent();
            if (renewed) {
              this.consumeLogoutPending();
              this.setUser(renewed);
              return;
            }
          } catch (err) {
            console.warn('[auth] silent renew on boot failed', err);
          }
        }
        this.setUser(null);
        // If the user just cancelled an RP-initiated logout, the IdP
        // session cookie is still alive but oidc-client-ts has already
        // wiped our local user state (it calls removeUser() inside
        // signoutRedirect before navigating). A prompt=none redirect
        // re-hydrates the user without any IdP UI flash. Native shell
        // skips this since silent renew can't run in a custom-tab flow.
        if (
          !this.isNative() &&
          this.consumeLogoutPending() &&
          !location.pathname.startsWith('/auth/')
        ) {
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

  private isNative(): boolean {
    return (
      typeof window !== 'undefined' &&
      (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor?.isNativePlatform?.() === true
    );
  }

  private async bindNativeDeepLinks(): Promise<void> {
    const { App } = await import('@capacitor/app');
    await App.addListener('appUrlOpen', (event) => {
      const url = event.url || '';
      if (!url.startsWith('gigi://auth/')) return;
      this.zone.run(() => void this.handleNativeAuthCallback(url));
    });
  }

  private async handleNativeAuthCallback(url: string): Promise<void> {
    const { Browser } = await import('@capacitor/browser');
    await Browser.close().catch(() => undefined);
    try {
      if (url.startsWith('gigi://auth/callback')) {
        await this.completeLogin(url);
        await this.router.navigateByUrl('/chat');
      } else if (url.startsWith('gigi://auth/logout-callback')) {
        await this.completeLogout(url);
        await this.router.navigateByUrl('/');
      }
    } catch (err) {
      console.warn('[auth] native callback failed', err);
    }
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
    const target = returnTo ?? (this.isNative() ? '/chat' : location.pathname + location.search);
    if (this.isNative()) {
      await this.startNativeFlow('signin', { returnTo: target });
      return;
    }
    await this.mgr.signinRedirect({
      state: { returnTo: target },
      extraQueryParams: {
        resource: this.cfg.oidcResource,
        persona: this.persona.activeId(),
      },
    });
  }

  async completeLogin(url?: string): Promise<{ returnTo: string }> {
    const user = await this.mgr.signinRedirectCallback(url);
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
    if (this.isNative()) {
      await this.startNativeFlow('signout');
      return;
    }
    await this.mgr.signoutRedirect({
      extraQueryParams: { persona: this.persona.activeId() },
    });
  }

  async completeLogout(url?: string): Promise<void> {
    try {
      sessionStorage.removeItem(LOGOUT_PENDING_KEY);
    } catch {
      /* sessionStorage unavailable */
    }
    try {
      await this.mgr.signoutRedirectCallback(url);
    } catch {
      await this.mgr.removeUser();
    }
    this.setUser(null);
  }

  private async startNativeFlow(
    kind: 'signin' | 'signout',
    options: { returnTo?: string } = {},
  ): Promise<void> {
    const { Browser } = await import('@capacitor/browser');
    const extraQueryParams = {
      ...(kind === 'signin' ? { resource: this.cfg.oidcResource } : {}),
      persona: this.persona.activeId(),
    };
    // `createSigninRequest`/`createSignoutRequest` aren't exposed on
     // UserManager; reach through to the underlying OidcClient so we
     // can grab the IdP URL without triggering a webview navigation.
    const client = (this.mgr as unknown as { _client: OidcClient })._client;
    const req: SigninRequest | SignoutRequest =
      kind === 'signin'
        ? await client.createSigninRequest({
            redirect_uri: this.redirectUri,
            state: options.returnTo ? { returnTo: options.returnTo } : undefined,
            extraQueryParams,
          })
        : await client.createSignoutRequest({
            post_logout_redirect_uri: this.postLogoutRedirectUri,
            extraQueryParams,
          });
    await Browser.open({ url: req.url, presentationStyle: 'popover' });
  }

  private setUser(u: User | null): void {
    this._user.set(u);
    this.isAuthenticated.set(!!u && !u.expired);
  }
}
