import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.waitReady();
  if (auth.isAuthenticated()) return true;
  await auth.login();
  return false;
};

/**
 * For routes that should only render for *unauthenticated* visitors
 * (e.g. the landing page). Authenticated users are sent straight to /chat.
 */
export const guestOnlyGuard: CanActivateFn = async (): Promise<true | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.waitReady();
  return auth.isAuthenticated() ? router.parseUrl('/chat') : true;
};
