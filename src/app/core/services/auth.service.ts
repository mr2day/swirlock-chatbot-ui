import { Injectable, NgZone, effect, inject, signal } from '@angular/core';
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
  /**
   * Flips to `true` once the initial getUser check has completed. The
   * auto-redirect effect waits for this so it doesn't yank the user
   * off `/chat` during boot before the stored token has been
   * inspected.
   */
  private readonly bootComplete = signal(false);
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
    // Silent renew is DISABLED. The IdP issues 10-year access tokens
    // (see swirlock-idp-base/src/idp/oidc-provider.factory.ts), so
    // there is nothing to refresh on a normal session. Keeping the
    // automatic silent-renew loop on costs us nothing in the happy
    // path but signs the user out cold every time a refresh attempt
    // fails — and refresh attempts fail for arbitrary reasons (brief
    // network drop, IdP rolling its keys, the user being offline for
    // a minute on a phone). This is a personal chatbot, not a bank.
    automaticSilentRenew: false,
    loadUserInfo: false,
  });

  constructor() {
    this.mgr.events.addUserLoaded((u) => this.setUser(u));
    this.mgr.events.addUserUnloaded(() => this.setUser(null));
    // The two former silent-renew event handlers (addAccessTokenExpired,
    // addSilentRenewError) are intentionally not registered. With
    // automaticSilentRenew off and a 10-year token TTL there's nothing
    // left for them to do; their previous bodies were the source of
    // the "signed out for no reason" complaints.

    if (this.isNative()) {
      void this.bindNativeDeepLinks();
    }

    void this.mgr
      .getUser()
      .then((u) => {
        // 10-year tokens — a stored, non-expired user just gets
        // restored. Stored-but-expired (which would have to mean the
        // user came back ten years later, or the IdP rolled its keys)
        // is treated as signed-out; the user will hit the regular
        // login redirect from the app shell when they try to use a
        // protected route.
        if (u && !u.expired) {
          this.consumeLogoutPending();
          this.setUser(u);
        } else {
          this.setUser(null);
        }
      })
      .finally(() => {
        this.readyResolve?.();
        this.readyResolve = null;
        this.bootComplete.set(true);
      });

    // Whenever the user is in a signed-out state AFTER boot, route
    // them to the landing page. The landing page is the only thing
    // they're allowed to see when signed out. Skipped for the auth
    // callback routes (which need to render to complete the redirect
    // dance) and skipped when we're already on `/`.
    effect(() => {
      if (!this.bootComplete()) return;
      if (this.isAuthenticated()) return;
      const path = window.location.pathname;
      if (path.startsWith('/auth/')) return;
      if (path === '/' || path === '') return;
      void this.router.navigateByUrl('/');
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
