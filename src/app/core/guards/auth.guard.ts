import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.waitReady();
  if (auth.isAuthenticated()) return true;
  await auth.login();
  return false;
};
