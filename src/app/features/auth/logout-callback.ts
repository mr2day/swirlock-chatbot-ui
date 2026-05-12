import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-logout-callback',
  standalone: true,
  template: `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#9aa0a6;font:14px system-ui,sans-serif;">
      Signing you out…
    </div>
  `,
})
export class LogoutCallback {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  constructor() {
    void this.auth.completeLogout().finally(() => {
      void this.router.navigateByUrl('/');
    });
  }
}
