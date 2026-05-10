import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-auth-callback',
  standalone: true,
  template: `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#9aa0a6;font:14px system-ui,sans-serif;">
      Signing you in…
    </div>
  `,
})
export class AuthCallback {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  constructor() {
    this.auth
      .completeLogin()
      .then(({ returnTo }) => this.router.navigateByUrl(returnTo || '/'))
      .catch((err: unknown) => {
        console.error('[auth] signin callback failed', err);
        this.router.navigateByUrl('/');
      });
  }
}
